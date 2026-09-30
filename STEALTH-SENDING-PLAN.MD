# Stealth Sending Plan (Approved)

Status: **Phase 3 IMPLEMENTED — stealth mandatory (no flag), reply filter + Sent/Trash
purge wired across 3 repos, pending 4-platform canary** (revised 2026-09-30).
Related: `ARCHITECTURE.md` · production session-death fix (see Appendix A).
Scope now: **full parity — Gmail, Outlook, Yahoo, AOL** (see D5 revision);
**campaign + shoot reply filter** (D11); **Sent+Trash purge** (D3 revision).

---

## 1. Goal

Send outbound mail from the standalone shoot path in a way that looks like normal
human conversation — no blast patterns, no thread-resurrection artifacts, no Sent-folder
fingerprints that spam filters and Google's risk model associate with automation.

## 2. Locked Decisions (do not re-litigate)

| # | Decision | Notes |
|---|----------|-------|
| D1 | **Score threads + new-message fallback** | Reply in-thread only when the existing thread scores eligible; otherwise send a fresh new message (current behavior). |
| D2 | **Mute thread** after interaction | Mute — NOT archive, NOT label. Muted threads leave the inbox without tripping "archived after reply" patterns. |
| D3 | **Delete sent copy AND purge from Trash** *(revised 2026-09-30)* | Remove our outgoing message from Sent **and then delete it from Trash/Deleted Items** so zero copy remains in the account (Q3: purge both). Gmail: `Delete forever`; Outlook: delete from Deleted Items (permanent); Yahoo/AOL: delete from Trash. Recipient's copy and thread structure untouched. |
| D4 | **Standalone shoot: stealth ALWAYS ON** *(revised 2026-09-30)* | Lives in `src/app/emails/send-email/route.js` (+ `compose-email/route.js`). **No feature flag, no `SETTINGS.stealthSending` row** — the dashboard shoot always attempts reply-in-thread (threshold = module default 60), falling back to fresh compose. Campaign = direct fresh compose **only** (no thread logic) + post-send Sent/Trash purge on wire sends + reply-filter pre-pass (D6/D11). |
| D5 | **Full parity: Gmail + Outlook + Yahoo + AOL** *(revised 2026-09-30)* | Thread scoring/reply/mute/sent-copy implemented for all four platforms. AOL shares Yahoo's implementation (same white-label UI). Gmail uses URL search; Outlook uses URL search with typed-search fallback; Yahoo/AOL use typed search. |
| D6 | **Campaigns: hygiene only, no thread logic** *(revised 2026-09-30)* | Campaign sends stay direct fresh compose (`sendViaBrowser`) — no scoring/reply/mute. Added: post-send **Sent+Trash purge** after each wire send (try/caught, send stays counted); pre-loop **reply-filter install** (D11); SMTP send path and `scheduleViaBrowser` untouched (SMTP creates no Sent copy; scheduled wire copies can't be purged later — known limitation). |
| D7 | **Fix D (realGeo bypass): DEFERRED** | Not part of this work. |
| D8 | **Session launch = same-profile + CDP inject** | Supersedes the old "clean relaunch" idea — see Appendix A. Clean relaunch with identical cookies was measured to stop at `v3/signin/accountchooser`; the profile-backed launch reaches Inbox. |
| D9 | **Yahoo/AOL mute = skip + honest log** *(2026-09-30)* | No native conversation mute on Yahoo/AOL. Reply and Sent-copy deletion still run; the mute step returns `skipped` and is logged. Never an error, never Trash-as-substitute. |
| D10 | **All-4 canary gate** *(revised 2026-09-30)* | There is **no flag to hold OFF** (D4) — stealth is on by default for the shoot, so the canary is the trust gate before production use: Gmail, Outlook, Yahoo and AOL must each pass a local canary (1 account × 3 threads). Outlook mute/Ignore variant and Yahoo/AOL Sent-delete selectors are unverified until seen live. |
| D11 | **Reply filter (campaign + shoot)** *(2026-09-30)* | Inbound replies must never land in the normal inbox. One filter installed per run, keyed on a subject identifier: shoot = subject with `{{tokens}}` stripped (`buildFilterPattern`); campaign = bare `campaignId` (every campaign subject carries `[campaignId]`). Destination = archive/label folder, **user-configurable** at setup (shoot modal + campaign setup), **empty → default `Campaign-Replies`**. Gmail: Skip Inbox + Apply label; Outlook/Yahoo/AOL: move to folder. Best-effort/log-only — a failed install never blocks sends. |

## 3. Current Baseline (what exists today)

- `src/app/emails/send-email/route.js` — the standalone shoot.
  - `resolveShootSession(browserId)` → persistent profile + identity.
  - `sendSingleEmail(page, config, recipient, subject, body)` — always opens
    `config.composeUrl` and fills To/Subject/Body → Send (`route.js:48-90`).
  - `scheduleSingleEmail(...)` — native Gmail "Schedule send" (`route.js:94+`).
  - Rate limiting via `sendRateLimiter` + humanized `DOMHelpers.randomDelay`.
- `src/app/emails/compose-email/route.js` — second compose-based sender (same pattern).
- `src/app/emails/inbox-interact/route.js` — **empty stub (0 lines)**; the natural home
  for thread-interaction primitives if they need to be shared.
- No thread logic exists: nothing reads, scores, replies into, mutes, or cleans up threads.

## 4. Design

### 4.1 Thread scoring (all platforms — shared pure module)

Before composing, query the account's existing threads for this recipient:

- Gmail search: `from:{recipient} to:{me} newer_than:30d` (scoped by project rules
  if a subject prefix exists: `subject:(...)`).
- Score components (weights tunable):
  - **Recency** — last message < 7d strongest, decays to 0 at 30d.
  - **Bidirectionality** — we already replied in the thread (+), one-sided inbound only (neutral).
  - **Subject continuity** — incoming subject matches the campaign/topic line (+).
  - **Thread depth** — ≤ 6 messages (+), > 10 (−; looks like resurrecting a cold thread).
- **Threshold** (start at 60/100, tune from evidence): score ≥ threshold → reply in-thread;
  below → new-message fallback. Any query error, ambiguity (multiple matching threads),
  or missing support → **fallback to new message** (fail open to current behavior).

### 4.2 Reply-in-thread flow

1. Open the winning thread from search results (click the conversation, not a compose box).
2. Reply via Gmail's Reply affordance into the quoted composer; type body; Send.
   Gmail itself sets `In-Reply-To` / `References` — never hand-forge headers.
3. Keep existing humanization: `DOMHelpers.randomDelay` between steps, typing delays,
   one send at a time, rate-limiter check before the branch is even taken.

### 4.3 New-message fallback

Identical to today's `sendSingleEmail` — compose URL → To/Subject/Body → Send.
No code path changes for: Outlook/Hotmail (D5), scoring failures, schedule-send mode
(scheduled sends always use new message in v1 — scheduling into an existing thread is
out of scope until scoring is proven).

### 4.4 Mute thread (after any in-thread reply)

- Gmail UI: conversation → ⋮ (More) → Mute. Thread gets the `Muted` label and stops
  appearing in the inbox; future inbound to it does not resurface it.
- Only mute the thread we replied into. Never bulk-mute, never mute on fallback path
  (there is no thread), never touch threads we did not interact with.

### 4.5 Delete the sent copy, then purge it from Trash *(revised 2026-09-30)*

- After a successful in-thread reply (and after each campaign wire send): open the
  message in **Sent**, delete **that message**, then **phase 2** — find it in
  Trash/Deleted Items and delete it permanently (D3/Q3: zero copy remains).
  - Gmail: Sent search → Message options → `Delete this message`; Trash search →
    Message options → `Delete forever`.
  - Outlook: Sent search (URL + typed fallback) → row delete; Deleted Items search
    → row delete (permanent in OWA).
  - Yahoo/AOL: Sent nav → matching row → row delete; Trash nav → matching row →
    row delete.
- Locate phases poll/retry (rows lag right after a send) before declaring failure.
- Guarantees: recipient's copy untouched, thread structure untouched. Never delete
  the whole conversation; never delete inbox-side copies.
- `deleteSentMessage` returns `{status, trashPurged, trashReason?}` — purge failure
  never fails the send (already counted).

### 4.6 Outlook / Yahoo / AOL *(revised 2026-09-30)*

Same four-step flow as Gmail (score → reply → mute → delete Sent copy), platform differences:

- **Outlook**: URL search (`outlook.live.com/mail/0/search?q=...`) with typed
  search-box fallback; mute step tries `Mute` then `Ignore` menu items (UI variant
  is canary-dependent); Sent copy deleted via Sent-folder search → row delete,
  then purged from Deleted Items.
- **Yahoo/AOL**: typed search from inbox; **mute skipped, logged (D9)**; Sent copy
  deleted via Sent nav → matching row → row delete, then purged from Trash.
- Score module, threshold and fail-open fallback are shared and platform-agnostic.
  **There is no feature flag** (D4) — the shoot always attempts stealth first.

## 5. Implementation Steps *(built + revised 2026-09-30)*

1. **Thread scoring module** — `src/app/emails/_shared/threadScore.js` ✅
   (CJS like `src/utils/cfCheck.js` so jest can `require` it; pure
   `scoreThread`/`decideAction`, fail-open: no-threads / below-threshold /
   ambiguous-within-10 / missing-direction → `new`). Unit tests:
   `__test__/threadScore.test.js` (20 tests, green).
2. **Thread ops** — `src/app/emails/_shared/threadOps.js` ✅
   (`findThreads` per platform with candidate enrichment for direction+depth,
   `replyInThread` — throws with `replySendAttempted` flag so a post-send
   failure never double-sends —, `muteThread` — D9 skip on Yahoo/AOL —,
   `deleteSentMessage` = Sent delete **+ `purgeFromTrash`** with locate retry,
   orchestrator `attemptStealthSend` which never throws; returns
   `mode/score/mute/sentCopy/trashPurged`).
   Selectors added to `_shared/platforms.js` for all four platforms
   (`trashNavLink` on Yahoo + AOL).
3. **Wire into `send-email/route.js`** ✅ — always-on (no flag):
   - `replyFolder` param destructured; `filterFolder = resolveFolderName(replyFolder)`;
   - after `resolveShootSession`: `ensureReplyFilter(page, platform,
     buildFilterPattern(subject), filterFolder, log)` once per shoot (log-only);
   - mode `now` → `attemptStealthSend` first → reply path records
     `mode/score/mute/sentCopy/trashPurged`; fallback → `sendSingleEmail`
     unchanged. Schedule mode → existing path, zero changes.
4. **Reply-filter module** — `src/app/emails/_shared/replyFilter.js` ✅ +
   pure helpers in `replyFilterMatch.cjs` (CJS for jest). `ensureReplyFilter`
   per platform (Gmail filters UI / Outlook rules UI / Yahoo+AOL settings
   filters), never throws, returns `installed|exists|skipped|failed` + reason.
   Tests: `__test__/replyFilter.test.js` (7, green).
5. **Campaign hygiene** ✅ — `wireSender.sendViaBrowser`: after
   `incrementSendCount` → try/catch `deleteSentMessage` (Sent + Trash purge,
   log-only). `execute-campaign/route.js`: pre-loop own session via wire
   account → `ensureReplyFilter(page, provider, campaignId, replyFolder, log)`;
   no session → warn, continue.
6. **Config / UI** ✅ — **no `SETTINGS.stealthSending` flag** (D4 revision;
   `getSetting` import removed). Reply folder is user-set:
   Hub `ShootContactsModal` (input beside subject → both submit payloads →
   `dashboard/page.tsx` → `shootEmails` param), Hub `CampaignModal`
   (`formData.replyFolder` → `buildStrategyContext` → Apps Script
   `createNewCampaign settingsData` / `updateCampaign` wholesale store →
   sheet settings column → engine `settings.replyFolder`). Empty → default
   `Campaign-Replies` (`resolveFolderName`). Apps Script:
   `POST.js shootEmails` destructure + engine payload, `CAMPAIGN.js settingsData`.
7. **Do not touch**: SMTP sender, `scheduleSingleEmail`/`scheduleViaBrowser`
   behavior, rate limits, hub usage updates. ✅ (unchanged)

## 6. Verification

- Unit: `threadScore` decisions ✅ (recency decay, threshold edges, ambiguous thread → fallback, missing direction → fallback; `npx jest threadScore` = 20/20);
  `replyFilter` pure helpers ✅ (`npx jest replyFilter` = 7/7: token strip, default
  folder, 60-char cap, non-string safety).
- Syntax + route compile ✅ (`node --check` all touched files in all 3 repos,
  GET `/emails/send-email` + `/campaign/execute-campaign` → 405).
- Manual canary — **required per platform before trusting in prod (D10)**, 1 account × 3 threads each on Gmail, Outlook, Yahoo, AOL:
  - eligible thread → reply lands in-thread, thread muted (Yahoo/AOL: mute logged `skipped`), Sent copy gone **and Trash/Deleted Items empty of it** (`trashPurged=true` in results), inbox clean;
  - ineligible thread → exact current new-message behavior;
  - shoot with custom reply folder ×3 → filter installed once, replies land in
    the folder (not inbox), blank folder name → logged default `Campaign-Replies`;
  - campaign wire send ×2 → sent copy purged from Sent **and** Trash;
  - failure mid-flow → error surfaced, no partial mute/delete (each post-step is
    independently try/caught and logged); reply-send failure falls back to fresh
    compose, post-send failure counts as sent (never double-sends);
  - schedule mode → unchanged behavior on all four platforms.
- Evidence review after canary: open the muted thread, confirm recipient view intact; check results payload for `mode/score/mute/sentCopy/trashPurged`.

## 7. Deferred / Out of Scope

- Fix D — realGeo bypass (D7).
- Reply-into-thread for scheduled sends.
- ~~Outlook thread logic (explicitly never, D5)~~ — superseded: D5 revised to full parity (2026-09-30).
- ~~Campaigns/SMTP untouched (D6)~~ — superseded: hygiene added (purge + reply filter); SMTP send path itself still untouched.
- Risk-model research beyond this plan (Appendix A captures what was learned).

### Known limitations (documented, accepted)

- `interact-inbox` / AI inbox watcher scans the **inbox only** — replies routed
  into the reply folder are invisible to it (by design: normal inbox stays clean;
  follow-up AI over filtered replies is a future feature).
- **Scheduled wire sends** (`scheduleViaBrowser`) leave a Sent copy at schedule
  time that cannot be purged by this run (native Schedule Send — no page session
  at send moment).
- **SMTP-only campaigns** create no Sent copy (nothing to purge); the reply
  filter still applies if a wire account session exists, otherwise it's skipped
  with a warning.

---

## Appendix A — Production Session-Death Fix (completed, context for D8)

Dokploy/Linux symptom: logins succeeded, extraction ended `completed-no-data`.

Root cause (confirmed in prod logs + local forensics):

1. **Capture gap** — `page.cookies(...getCookieCaptureUrls(domain))` is page-scoped:
   for gmail it captured only mail.google.com + gmail.com (20 cookies) and silently
   omitted the parent-domain auth cookies on `accounts.google.com` (LSID, ACCOUNT_CHOOSER,
   `__Host-1PLSID/3PLSID`, …). Measured impact: missing cookies move Google's response
   from `accountchooser` down to `identifier`.
2. **Profile unreadable on Dokploy** — uploaded Chromium-154 profiles contain no usable
   `os_crypt` key on the (Windows) reader side → 0 readable auth cookies → injection was
   skipped entirely (`routeHelper.js` pre-fix) → 8 sign-in redirects → no data.
3. **Silent cookie drops** — `sameSite:"None"` + `secure:false` is dropped by Chrome with
   no error; expired cookies (e.g. `__Secure-1PSIDRTS` / `__Secure-STRP`, ~15-minute TTL)
   are refused by `Network.setCookies` without an error.
4. **Profile state matters** — a clean relaunch with a *complete, identical* cookie set
   stopped at `v3/signin/accountchooser` (missing cached Accept-CH client-hints etc.),
   while the same cookies inside the original profile reached `Inbox (…)`.

Shipped fixes:

- **Capture**: `captureMergedCookies()` (platformHelper) merges page-scoped cookies with
  `Network.getAllCookies`, family-filtered by registrable domain; wired at all 7 capture
  sites in `cookie-api-login/route.js`.
- **Launch**: `launchBrowserWithSession` fallback now relaunches **with the same
  userDataDir** (profile state preserved) + forced CDP injection; healthy profiles and
  non-gmail platforms unchanged.
- **Injection**: `sanitizeCookiesForInjection()` (drops expired, normalizes sameSite) +
  `injectCookiesViaCDP()` (per-cookie raw CDP, post-set verification, honest
  missing/failure logs) — used by routeHelper, smartExtract `createTab`, and
  electron `test-session`.
- **Launcher (`app.asar`)**: applies saved `browserIdentity` (UA/CH, timezone, locale,
  viewport, webdriver flag), skips expired cookies, and after navigation **verifies the
  final URL** — `ServiceLogin`/`accountchooser`/`identifier` now reports an honest error
  instead of "Session opened!". Backup: `app.asar.bak-20260929`.
- Smoke-tested end-to-end: fallback fired, 3 expired (RTS/STRP) dropped, 46/46 injected
  and verified.
