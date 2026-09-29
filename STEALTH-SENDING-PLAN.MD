# Stealth Sending Plan (Approved)

Status: **APPROVED** — implementation pending (Phase 3 of the fix-first sequence).
Related: `ARCHITECTURE.md` · production session-death fix (see Appendix A).

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
| D3 | **Delete only the sent copy** | Remove our outgoing message from the Sent folder. The thread and the recipient's copy are untouched. |
| D4 | **Standalone shoot only** | Lives in `src/app/emails/send-email/route.js` (+ `compose-email/route.js`). No campaign integration. |
| D5 | **Gmail-first; Outlook always new message** | Thread scoring/reply/mute/sent-copy logic is Gmail-only. Outlook/Hotmail keep the existing compose-new flow unconditionally. |
| D6 | **Campaigns / SMTP untouched** | `campaign/` pipeline and SMTP sender are out of scope. Behavior there must not change. |
| D7 | **Fix D (realGeo bypass): DEFERRED** | Not part of this work. |
| D8 | **Session launch = same-profile + CDP inject** | Supersedes the old "clean relaunch" idea — see Appendix A. Clean relaunch with identical cookies was measured to stop at `v3/signin/accountchooser`; the profile-backed launch reaches Inbox. |

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

### 4.1 Thread scoring (Gmail only)

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

### 4.5 Delete only the sent copy

- After a successful in-thread reply: open the message in **Sent**, delete **that message**
  (Gmail allows deleting a single message from the conversation view / Sent list).
- Guarantees: recipient's copy untouched, thread structure untouched, only our Sent entry
  removed. Never delete the whole conversation; never delete inbox-side copies.

### 4.6 Outlook / others

Unconditional new message (current flow). No search, no reply, no mute, no Sent cleanup.

## 5. Implementation Steps

1. **Thread scoring module** — new `src/app/emails/_shared/threadScore.js`
   (pure functions: parse search results → score → decision), unit-testable without a browser.
2. **Gmail thread ops** — new `src/app/emails/_shared/gmailThreadOps.js`
   (`findThread`, `replyInThread`, `muteThread`, `deleteSentMessage`) using the same
   selector/timing config style as `send-email`'s platform config.
3. **Wire into `send-email/route.js`** — after `resolveShootSession` and the rate-limit
   check (i.e. after `route.js:243-263`):
   - `platform === gmail` && mode `now` && !schedule → score → branch;
   - reply path → reply → mute → delete sent copy;
   - fallback → existing `sendSingleEmail`.
   - Schedule mode and Outlook → existing path, zero changes.
4. **Config** — thresholds and feature flag (`stealthSending: on/off`) in settings sheet;
   ship default **off**, enable per project after canary.
5. **Do not touch**: `campaign/`, SMTP sender, `scheduleSingleEmail` behavior,
   rate limits, hub usage updates.

## 6. Verification

- Unit: `threadScore` decisions (recency decay, threshold edges, ambiguous thread → fallback).
- Jest: `npm test` (existing suite must stay green — no campaign regressions).
- Manual canary (1 account, 3 threads):
  - eligible thread → reply lands in-thread, thread muted, Sent copy gone, inbox clean;
  - ineligible thread → exact current new-message behavior;
  - Outlook contact → unchanged behavior;
  - schedule mode → unchanged behavior;
  - failure mid-flow → error surfaced, no partial mute/delete (each post-step is
    independently try/caught and logged).
- Evidence review after canary: open the muted thread, confirm recipient view intact.

## 7. Deferred / Out of Scope

- Fix D — realGeo bypass (D7).
- Reply-into-thread for scheduled sends.
- Outlook thread logic (explicitly never, D5).
- Campaign/SMTP stealth behavior (D6).
- Risk-model research beyond this plan (Appendix A captures what was learned).

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
