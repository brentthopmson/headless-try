# WebFixx Application Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         THREE CODEBASES                                   │
│                                                                          │
│  ┌─────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐  │
│  │  Frontend (Next.js)  │  │  Apps Script (GAS)    │  │  Engine (Next.js)│  │
│  │  WebFixx             │  │  WebFixx-Hoo          │  │  offline-headless│  │
│  │                      │  │                        │  │                  │  │
│  │  UI components       │  │  API dispatch layer    │  │  Browser automation│ │
│  │  Dashboard, modals   │  │  Sheet read/write      │  │  Cookie injection │  │
│  │  Feature flags       │  │  OAuth token refresh   │  │  Profile download │  │
│  │  Secured API calls   │  │  Pause/stop flags      │  │  Session mgmt    │  │
│  │  Campaign page poll  │  │                        │  │  Limits gating   │  │
│  └──────────┬──────────┘  └───────────┬────────────┘  └────────┬────────┘  │
│             │                         │                         │           │
│             │  POST /backend-function  │  POST /shootEmails      │           │
│             └─────────────────────────>│  POST /composeAIMessage  │           │
│                                        │  POST /pauseShoot        │           │
│                                        │  POST /stopShoot         │           │
│                                        │  POST /runCampaignPipeline│          │
│                                        └─────────────────────────>│           │
│                                                                   │           │
│                                        Engine endpoints:          │           │
│                                        /emails/send-email         │           │
│                                        /emails/compose-email      │           │
│                                        /socials/send-message      │           │
│                                        /socials/search-interact   │           │
│                                        /socials/page-interact     │           │
│                                        /socials/inbox-interact    │           │
│                                        /socials/activities-interact│          │
│                                        /campaign/execute-campaign  │           │
│                                        /campaign/pipeline-orchestrator│       │
│                                        /campaign/interact-inbox    │           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Every engine entry point runs through the three-tier limits model before it
touches a browser — see [Limits & Rate Governance](#limits--rate-governance).**

---

## Data Flow: Google Sheets

```
┌─────────────────────────────────────────────────────────────────┐
│                    GOOGLE SHEETS DATABASE                         │
│                                                                   │
│  HUB SHEET (main data store)                                     │
│  ├── browserId / submissionId    (unique identifiers)            │
│  ├── email                       (account email)                 │
│  ├── formattedCookie / cookieJSON (session cookies)              │
│  ├── driveUrl                    (Drive profile ZIP URL)         │
│  ├── browserIdentity             (fingerprint JSON)              │
│  ├── interactionStatus           (ACTIVE/WAITING/RATE_LIMITED/   │
│  │                                CANCELLED — ACCOUNT tier state) │
│  ├── interactionUsage            (JSON per-action counters —     │
│  │                                ACCOUNT tier usage)             │
│  ├── wireExtract / socialExtract / bankExtract (extraction data)│
│  ├── fullAccess / verifyAccess / cookieAccess (flags)            │
│  ├── lastShotAt / shotHistory    (shoot tracking)                │
│  └── status                      (current state)                 │
│                                                                   │
│  COOKIE SHEET (login sessions)                                   │
│  ├── browserId                   (matches hub)                   │
│  ├── email / domain / category                                    │
│  ├── cookieJSON / formattedCookie                                │
│  ├── browserIdentity             (fingerprint JSON)              │
│  ├── driveUrl                    (profile ZIP URL)               │
│  └── status                      (WAITINGCODE, COMPLETED, etc.)  │
│                                                                   │
│  CAMPAIGNS SHEET                                                 │
│  ├── campaignId / id                                              │
│  ├── settings (JSON: accounts, targetLink, socialStrategyPrompt, │
│  │             staged/status flags, …)                            │
│  └── status (draft, running, paused, completed, Limit Reached)    │
│                                                                   │
│  USERS SHEET (USER tier)                                         │
│  ├── userId                                                      │
│  ├── plan (LEGEND / VETERAN / OG / NEWBEE / FREE)                │
│  ├── usage (JSON: monthly *Usage counters {hourly,daily,          │
│  │           monthly,total} — resets monthly)                    │
│  ├── campaignConcurrentLimit (per-user override)                 │
│  └── concurrentActiveCampaigns                                   │
│                                                                   │
│  LIMITS SHEET (PLATFORM policy + CAMPAIGN caps + plan rows)      │
│  ├── platform rows: platform + one column per ACTION_TYPE,       │
│  │   each cell = {"hourly":n,"daily":n,"monthly":n,"cap":n}      │
│  │   (follow, unfollow, coldMessage, likesOnPost, extract, …)    │
│  ├── campaign row (category=campaign): validateLimit,            │
│  │   enrichLimit, personalizeLimit, shootCampaignLimit,          │
│  │   interactionLimit, accountSendPerRunLimit,                   │
│  │   campaignConcurrentLimit                                     │
│  └── plan rows (plan=NAME): *Limit columns = monthly USER quota  │
│      (smtpCheckerLimit, senderLimit, verifyLoginLimit,           │
│       extractionLimit, shootContactsLimit, validateLimit, …)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## Session Management: The Hybrid Approach

Every route that launches a browser uses the **hybrid session** approach:

```
resolveSocialSession(profile) or resolveShootSession(browserId)
│
├── 1. Read session data from sheet
│   ├── cookieJSON (cookies)
│   ├── browserIdentity (fingerprint)
│   └── driveUrl (profile ZIP)
│
├── 2. If driveUrl exists → Download profile from Drive
│   ├── Extract ZIP to temp directory
│   ├── Launch Chrome with --user-data-dir (profile directory)
│   ├── Apply identity fingerprint (user-agent, window size)
│   ├── SKIP CDP cookie injection (cookies come from SQLite DB)
│   └── Return { browser, page, profileDir }
│
└── 3. If no driveUrl → Fallback to CDP injection
    ├── Launch Chrome with random temp directory
    ├── Parse cookieJSON
    ├── Inject via page.setCookie()
    ├── Apply identity fingerprint (if available)
    └── Return { browser, page, profileDir: null }
```

**Why hybrid?** The Drive profile contains the full browser state (localStorage, IndexedDB, service workers, cookies in SQLite DB). CDP injection only sets HTTP cookies. Google detects missing state and may reject the session. The identity fingerprint ensures the browser looks identical to the original login.

---

## Flow 1: Verification (cookie-api-login)

### Purpose
Log into a platform (Gmail, Outlook, etc.) via headless browser, capture cookies, save to sheets.

### Flow
```
Frontend                    Apps Script               Engine
    │                           │                        │
    │  callBackendFunction(     │                        │
    │    'cookie-api-login',    │                        │
    │    { browserId, email,    │                        │
    │      password, platform } │                        │
    │  )                        │                        │
    │──────────────────────────>│                        │
    │                           │  POST /emails/cookie/  │
    │                           │  cookie-api-login      │
    │                           │───────────────────────>│
    │                           │                        │
    │                           │  Engine:               │
    │                           │  1. Launch browser     │
    │                           │  2. Navigate to login  │
    │                           │  3. Enter email        │
    │                           │  4. Enter password     │
    │                           │  5. Handle verification│
    │                           │  6. Capture cookies    │
    │                           │  7. Save to cookie     │
    │                           │     sheet + hub sheet  │
    │                           │  8. Upload profile to  │
    │                           │     Drive              │
    │                           │  9. Save browserIdentity│
    │                           │                        │
    │  { status: COMPLETED,     │                        │
    │    cookieJSON, driveUrl } │                        │
    │<──────────────────────────│<───────────────────────│
    │                           │                        │
```

### USER tier gate (new processes only)
A fresh login attempt must carry a user identity. Before launching, the route
runs `checkUserQuota(userId, { keys: ['verifyLoginUsage'] })` (plan-row
`verifyLoginLimit`, monthly) and immediately increments
`updateUserUsage(userId, 'verifyLoginUsage')` as a reservation. Status checks
and resume polls on an existing `browserId` are **not** counted. Missing /
`"N/A"` userId on a new process logs a warning and fails open; the dedicated
`true-login/verify-login*` routes instead fail **closed with `403
verify_login_identity_required`**.

### Session State Machine
```
WAITING_EMAIL → WAITING_PASSWORD → WAITINGCODE → PROCESSING → COMPLETED
                                  ↗ WAITING_OPTIONS
                    CAPTCHA_FAILED
                    RETRY_TECHNICAL
                    FAILED
```

### Key Files
- `emails/cookie/cookie-api-login/route.js` — Main login flow
- `emails/cookie/cookie-api-login/routeHelper.js` — `checkAccountAccess`, `checkVerification`, `handleAdditionalViews`
- `emails/cookie/cookie-api-login/platforms.js` — Platform configs (Gmail, Outlook selectors)

### Pause/Resume
- `pauseShoot` → sets `PropertiesService` flag `shoot_pause_{browserId}`
- `resumeShoot` → deletes the flag
- `stopShoot` → sets `shoot_stop_{browserId}` flag
- Engine polls these flags between processing steps

---

## Flow 2: Extraction (smartExtract)

### Purpose
After login, extract data from the platform: contacts, emails, financial info, personal info.

### Flow
```
Frontend                    Apps Script               Engine
    │                           │                        │
    │  callBackendFunction(     │                        │
    │    'runSmartExtract',     │                        │
    │    { browserId, category }│                        │
    │  )                        │                        │
    │──────────────────────────>│                        │
    │                           │  POST /emails/extract  │
    │                           │───────────────────────>│
    │                           │                        │
    │                           │  Engine:               │
    │                           │  0. LIMITS GATE        │
    │                           │     resolveAccountGate │
    │                           │     → platform 'extract'│
    │                           │     → user daily quota │
    │                           │  1. resolveSession()   │
    │                           │     ├── Read cookie    │
    │                           │     │   sheet          │
    │                           │     ├── Get driveUrl   │
    │                           │     ├── Get browserId  │
    │                           │     │   entity         │
    │                           │     └── Get cookieJSON │
    │                           │  2. Download profile   │
    │                           │     from Drive         │
    │                           │  3. Launch browser     │
    │                           │     with profile +     │
    │                           │     identity           │
    │                           │  4. Run 7 sequential   │
    │                           │     phases:            │
    │                           │     a. Box Summary     │
    │                           │     b. Personal Info   │
    │                           │     c. Contacts (2     │
    │                           │        pages)          │
    │                           │     d. Financial       │
    │                           │     e. Activities      │
    │                           │  5. Save to Drive as   │
    │                           │     JSON file          │
    │                           │  6. Write reference to │
    │                           │     hub sheet          │
    │                           │  7. Increment account  │
    │                           │     'extract' + user   │
    │                           │     'extract' usage    │
    │                           │                        │
    │  { success, data: {       │                        │
    │    contacts, personal,    │                        │
    │    financial, activities } │                        │
    │  }                        │                        │
    │<──────────────────────────│<───────────────────────│
    │                           │                        │
```

### Limits Gate (runs BEFORE any browser launch)
`runSmartExtract` evaluates three tiers before downloading the profile:

1. **ACCOUNT** — `resolveAccountGate(browserId, platform)`: `CANCELLED` blocks
   outright; `RATE_LIMITED` blocks until every configured platform action is back
   under policy (then auto-recovers to `ACTIVE` and continues).
2. **PLATFORM** — `checkActionAllowed(platform, 'extract', usage)` against the
   `extract` column of the Limits sheet (missing/0 = unlimited).
3. **USER** — `checkUserQuota(userId, { keys: ['extractionUsage'] })` against
   the plan row's `extractionLimit` (monthly, 0/missing = unlimited).

On block the run fails fast (`extractStatus = 'failed'`) — no browser is ever
launched. After extraction completes (even an empty payload), usage is
incremented: `updateAccountUsage(browserId, 'extract')` and
`updateUserUsage(userId, 'extractionUsage')`.

A per-`browserId` in-flight guard (`__extractInFlight`) prevents auto-extract
and manual extract from racing the same profile.

### Session Resolution (extraction-specific)
```javascript
// smartExtract.js — resolveSession()
const session = await resolveSession(browserId);
// Returns: { browserId, email, domain, platform, cookieJSON,
//            driveUrl, browserIdentity, ... }

// Launch with full profile + identity
const { browser, page } = await launchBrowserWithSession(
  cookieJSON, undefined,
  { userDataDir: profileDir, identity: session.browserIdentity }
);
```

### Key Files
- `utils/smartExtract.js` — `resolveSession`, `extractWire`, `extractSocial`, `runSmartExtract`
- `socials/_shared/routeHelper.js` — `downloadAndExtractProfile`, `launchBrowserWithSession`
- `socials/_shared/accountGate.js` — `resolveAccountGate` (ACCOUNT tier)
- `socials/_shared/limits.js` — `checkActionAllowed`, `checkUserQuota`

### Data Output
Extraction saves to **Drive** as `HUB_FOLDER_ID/{browserId}/wireExtract.json` (or social/bank). The hub sheet cell stores a reference: `{"fileId":"xxx","fileName":"wireExtract.json","size":12345}`.

---

## Flow 3: Shooting (Standalone)

### Purpose
Send emails or social DMs to extracted contacts using the saved session.

### Flow: Email Shoot
```
Frontend (ShootContactsModal)
    │
    │  Step 1: Select contacts from extracted data
    │  Step 2: Choose link injection (project/redirect)
    │  Step 3: AI analysis (optional — composeAIMessage per contact)
    │  Step 4: Review drafts
    │  Step 5: Execute sends
    │
    │  handleShootContacts() →
    │  securedApi.callBackendFunction({
    │    functionName: 'shootEmails',
    │    browserId, contacts, subject, body,
    │    method, mailMerge, linkType, linkId
    │  })
    │
    ▼
Apps Script → POST.js → shootEmails()
    │
    │  resolveEngineUrl("emails/send-email")
    │  UrlFetchApp.fetch(engineUrl, { payload })
    │
    ▼
Engine: /emails/send-email/route.js
    │
    │  0. requireFeature('allowShooting')      ← feature flag gate
    │  0b. hub interactionStatus gate          ← ACCOUNT tier
    │      (CANCELLED / RATE_LIMITED → 409 { accountBlocked: true })
    │  1. getHubRowByBrowserId() → hub sheet
    │  2. resolveShootSession(browserId)
    │     ├── Read hub sheet: driveUrl, browserIdentity, cookies
    │     ├── If driveUrl → download profile → hybrid launch
    │     └── Else → CDP cookies + identity
    │  3. For each contact:
    │     a. checkSendAllowed() (rate limit — mailbox windows)
    │     b. applyMailMerge() (replace {{variables}})
    │     c. sendSingleEmail(page, config, recipient, subject, body)
    │        ├── Navigate to composeUrl
    │        ├── Fill To, Subject, Body
    │        ├── Click Send (fallback: Ctrl+Enter)
    │        └── Random delay between sends
    │     d. incrementSendCount()
    │  4. Update hub: lastShotAt, shotHistory
    │  5. Cleanup: close browser, remove profileDir
    │
    ▼
{ success: true, sent: N, failed: M, results: [...] }
```

### Flow: Social DM Shoot
```
Frontend → handleShootContacts() →
    functionName: 'shootEmails' (social variant)

Apps Script → shootEmails() →
    resolveEngineUrl("socials/send-message")

Engine: /socials/send-message/route.js
    │
    │  0. resolveAccountGate(profileId, platform)   ← ACCOUNT tier
    │  1. getCookieForProfile(profileId) → cookie sheet
    │     Returns: { cookies, platform, browserIdentity, driveUrl }
    │  2. For each recipient (round-robin profiles):
    │     a. checkActionAllowed(platform, "coldMessage", usage)
    │        └── block → updateAccountStatus(RATE_LIMITED) + throw
    │     b. Hybrid session:
    │        ├── If driveUrl → downloadAndExtractProfile()
    │        └── Else → CDP cookies + identity
    │     c. executeWorkflow(page, workflow, context)
    │        └── Platform-specific: navigate → new message →
    │            fill recipient → fill message → click send
    │     d. updateAccountUsage(profileId, "coldMessage")
    │  3. Flush CSV back to Drive
    │  4. Cleanup profileDirs
```

### Shoot Modal Data Flow & Contact Retrieval
```
ShootContactsModal
    │
    │  1. Ingest account row: item[extractKey] (e.g. item.wireExtract or item.socialExtract)
    │
    │  2. Resolve Drive pointers via useExtractData hook:
    │     ├── Drive pointer detected (JSON has fileId):
    │     │   └── GET /api/drive-csv?fileId={fileId} → fetches full JSON from Drive
    │     ├── Direct HTTP URL:
    │     │   └── fetch(url)
    │     └── Inline JSON:
    │         └── Use directly as-is
    │
    │  3. Normalize & extract contacts list via useMemo:
    │     const raw = fetchedExtractData || item[extractKey];
    │     const extract = safeParseJSON(raw);
    │     ├── If category === 'WIRE'   → extract.contacts || []
    │     └── If category === 'SOCIAL' → extract.followers || []
    │
    │  4. Populate 5-Step Shooting Wizard:
    │     ├── Step 1: Select contacts
    │     ├── Step 2: Choose link injection (project / redirect link)
    │     ├── Step 3: AI analysis / personalized message draft
    │     ├── Step 4: Review drafts & schedule settings
    │     └── Step 5: Execute sends via securedApi.callBackendFunction('shootEmails')
```

#### Drive Pointer & Tiered Sheet Storage Architecture
Because Google Sheets imposes a strict ~48KB cell and transport limit, large contact extracts are persisted using a tiered storage model:
1. **Full Payload in Drive:** `smartExtract` saves the complete extraction JSON to Google Drive (`HUB_FOLDER_ID/{browserId}/wireExtract.json`).
2. **Tiered Reference in Hub Cell:**
   - **Full pointer with preview:** `{"fileId": "...", "fileName": "wireExtract.json", "size": 12345, "emails": [...], "contacts": [...]}`
   - **Truncated fallback (> 36KB):** Drops `contacts`, retaining only `emails`.
   - **Minimal pointer (> 36KB):** Stores pure Drive metadata: `{"fileId": "...", "fileName": "...", "size": ...}`.
   - **Upload failure fallback:** Writes a compacted inline payload `compactExtractForCell(data)`.
3. **Frontend Hydration:** When `ShootContactsModal` mounts, `useExtractData` checks if `fileId` is present. If found, it routes through the Next.js proxy `/api/drive-csv?fileId=...` to download and re-hydrate the full dataset transparently.

---

### Session Resolution Comparison: Email Shoot vs. Social DM Shoot

While both email and social DM shoots use the hybrid session pattern, their credential retrieval and browser runtime configurations differ:

| Dimension | Email Shoot (`send-email`) | Social DM Shoot (`send-message`) |
| :--- | :--- | :--- |
| **Primary Route** | `/emails/send-email/route.js` | `/socials/send-message/route.js` |
| **Credential Source** | **Hub Sheet** (`getSheetDataApi('hub')`) | **Cookie Sheet** (`getSheetDataApi('cookie')`) |
| **Lookup Identifier** | `browserId` / `submissionId` | `profileId` (from `activeProfileIds` list) |
| **Helper Called** | `resolveShootSession(browserId)` | `resolveSocialSession(profile)` |
| **Caller Input** | Raw string ID: `browserId` | Pre-parsed profile object: `{ cookies, browserIdentity, driveUrl, platform, profileId }` |
| **Multi-Account Handling** | Single account session for entire batch | Supports round-robin rotation across multiple profiles |
| **CDP Cookie Injection (Hybrid)** | **Skipped for Gmail** if `userDataDir` is present (prevents token corruption); injected for Microsoft/Outlook | Injected along with persistent `userDataDir` |
| **Session Lifecycle** | Single browser session kept open across all recipients; closed at batch completion | Browser opened per account/recipient attempt and closed in `finally` block |

#### Gmail vs. Outlook Hybrid Launch Nuance (`launchBrowserWithSession`)
```javascript
const platform = (options.platform || '').toLowerCase();
const isGmail = platform === 'gmail';
const shouldInjectCDPCookies = cookieJSON && (!options.userDataDir || !isGmail);

if (shouldInjectCDPCookies) {
    const cookies = await loadBrowserSession(cookieJSON);
    await page.setCookie(...cookies);
} else if (options.userDataDir) {
    // Gmail: restores cookies directly from Chrome SQLite DB inside profileDir.
    // Overwriting them via CDP clobbers session tokens and causes re-authentication prompts.
}
```

---

### Rate Limiting & Send Count Tracking

To prevent mailbox bans and API throttling, the engine applies layered rate limiting and organic pacing delays during email shoots:

#### 1. Sliding-Window Counters (`utils/sendRateLimiter.js`)
- **Global Counter Map:** Maintained in `globalThis.__sendRateLimiter.counters` keyed by the **sending account** (browserId for wireSender, SMTP user for SMTP sends, browserId for standalone sends):
  - `hourly: { count, windowStart }` (1-hour sliding window, 3,600,000 ms)
  - `daily: { count, windowStart }` (24-hour window, 86,400,000 ms)
  - `monthly: { count, windowStart }` (30-day window)
  - `total`
- **Hub persistence (restore-once):** Before the first check for an account in
  this process, `checkSendAllowed` lazily restores counters from the hub sheet
  (`restoreUsageFromHub`, tracked via a `restoredIds` set so it runs once per
  account). Counter increments fire-and-forget persist back via
  `persistUsageToHub`, which tries the key columns `browserId`, `submissionId`,
  then `email` — so restarts and serverless cold starts never reset a mailbox's
  window budget.
- **Dynamic Limits Sheet Sync:** Send thresholds are read from the `LIMITS` sheet (`coldMessage` column) and cached for 5 minutes (TTL). Defaults: `{ hourly: 20, daily: 500, monthly: 15000 }`.
- **Pre-Send Guard (`checkSendAllowed`):**
  - Evaluated before each contact.
  - If limit exceeded, returns `allowed: false` with calculated `retryAfterMs`.
  - The shoot loop records status `"rate_limited"` and immediately terminates the batch to protect account reputation.
- **Counter Increment (`incrementSendCount`):** Called immediately after successful dispatch; persists usage to hub.

#### 2. Pacing Delays & Human Emulation
- **Inter-Message Jitter:**
  - **Send Now Mode:** Reads platform timing range `config.timing.betweenSends` (`[30000, 60000]` ms for Gmail and Outlook). Delays between consecutive sends:
    $$\text{delay} = 30000 + \text{random}() \times 30000 \quad \text{(30 to 60 seconds)}$$
    Applies an additional randomized jitter via `DOMHelpers.randomDelay(delayMs, delayMs + 1000)`.
  - **Schedule Send Mode:** Applies a fixed 60,000 ms (1 minute) pause between schedule operations.
- **Intra-Message Delays:**
  - Navigation wait: 4,000–5,000 ms (`afterNavigate`)
  - Keystroke delay: 10–30 ms per character (typing recipient, subject, body)
  - Pre-send pause: 1,500–2,000 ms (`afterFill`)
  - Post-send buffer: 2,000–3,000 ms before closing or resetting compose view.

---

### Post-Shoot Persistence: Hub Sheet Updates

Upon loop completion (and cleanup of temporary profile directories in `finally`), the engine updates the Hub Sheet row for the given `browserId` via `updateSheetRow("hub", "browserId", browserId, ...)`:

1. **`lastShotAt`**: Current ISO 8601 timestamp (e.g. `2026-10-05T12:08:18.123Z`).
2. **`shotHistory`**: Serialized JSON array capturing all successful or scheduled transmissions:
   ```json
   [
     {
       "email": "recipient@example.com",
       "method": "manual",
       "sentAt": "2026-10-05T12:06:45.000Z",
       "scheduledFor": null,
       "status": "sent",
       "projectId": "proj_123"
     }
   ]
   ```

---

### Key Files (Shooting)
- `ShootContactsModal.tsx` — 5-step wizard with `useExtractData` hook for Drive fetch
- `emails/send-email/route.js` — Email shoot engine (feature/status gates, rate checking, pacing, stealth replies, hub updates)
- `socials/send-message/route.js` — Social DM shoot engine (account status gate + `coldMessage` policy check)
- `socials/_shared/routeHelper.js` — `resolveShootSession`, `resolveSocialSession`, `launchBrowserWithSession`
- `utils/sendRateLimiter.js` — Sliding window counters, hub restore/persist, Limits sheet cache, `checkSendAllowed`, `incrementSendCount`
- `campaign/_shared/wireSender.js` — `sendViaBrowser` / `scheduleViaBrowser` (campaign wire send, sender keyed by `profileId`)
- `campaign/_shared/smtpSender.js` — `sendViaSMTP` (campaign SMTP send, sender keyed by `smtp.user`)

---

## Flow 4: AI Compose

### Purpose
Read mailbox history for a recipient and generate a relationship-aware draft.

### Flow
```
Frontend → handleComposeAI() →
    functionName: 'composeAIMessage',
    { browserId, contactEmail, linkType, linkId }

Apps Script → composeAIMessage() →
    resolveEngineUrl("emails/compose-email")

Engine: /emails/compose-email/route.js
    │
    │  1. resolveShootSession(browserId) → hybrid session
    │  2. readMailboxHistory(page, config, contactEmail)
    │     ├── Gmail: URL-based search
    │     └── Outlook: DOM search bar
    │  3. analyzeRelationship(threads)
    │     └── cold / warm / followup / reengagement
    │  4. composeAIMessage() → MultiProviderAI generates
    │  5. Return { subject, body, context }
```

### Key Files
- `emails/compose-email/route.js` — AI compose engine
- `utils/multiProviderAI.js` — Multi-provider AI generation

---

## Flow 5: Inbox AI Interaction (interact-inbox)

### Purpose
Scan an email inbox for inbound messages, decide with AI which deserve a reply, and send replies from the browser session — the engine behind "interaction-only" campaigns (keyword discovery + AI replies) and a standalone endpoint.

### Flow
```
POST /campaign/interact-inbox  { campaignId }
    │
    │  1. getCampaignLimits() → interactionLimit (plan cap)
    │  2. isCampaignPaused() checks between messages
    │  3. Per interaction account: resolveSocialSession()
    │     ├── Gmail:  INBOX_CONFIGS.gmail selectors (unread rows,
    │     │           sender/subject/snippet, reply button)
    │     └── Outlook: INBOX_CONFIGS.outlook selectors
    │  4. Scan inbox rows → for each candidate:
    │     a. replyCount >= maxReplies || planInteractionLimit → stop
    │     b. MultiProviderAI relevance decision (reply / skip)
    │     c. Compose reply → fill body → send (keyboard fallback)
    │  5. Update campaign settings (interactionStatus, counts)
    │  6. Failure → notifyCampaignFailure()
    ▼
{ success, replyCount, details }
```

**Dispatch:** the orchestrator routes the `interact` stage to this endpoint
when the campaign is interaction-only (`campaignMode: "interactions-only"`, or
interaction accounts + `emailKeywords`/`emailStrategyPrompt` with no contact
file); otherwise the `interact` stage runs `/campaign/interact-campaign`.

### Key Files
- `campaign/interact-inbox/route.js` — AI inbox watcher (per-provider selectors, relevance pass, reply loop)
- `campaign/interact-campaign/route.js` — interaction stage for contact-file campaigns

---

## Flow 6: Pipeline Orchestrator

### Purpose
The single stage machine that advances a running campaign through
`validate → enrich → personalize → execute → interact`. One invocation = one
stage step; callers re-poll.

### Stage Table
```
STAGE_ORDER = ["validate", "enrich", "personalize", "execute", "interact"]

stage         route                             statusField             timeout
validate      /campaign/validate-campaign       validationStatus        600s
enrich        /campaign/enrich-campaign         enrichmentStatus        300s
personalize   /campaign/personalize-campaign    personalizationStatus   300s
execute       /campaign/execute-campaign        (uses campaign status)  600s
interact      /campaign/interact-campaign       interactionStatus       300s
              ↳ or /campaign/interact-inbox for interaction-only campaigns
```

### Flow
```
Caller (frontend 60s poll via GAS runCampaignPipeline,
        or a completing stage POSTing back to the orchestrator)
    │
    ▼
POST /campaign/pipeline-orchestrator  { campaignId }
    │
    │  1. Load campaign settings; skip if paused
    │  2. USER tier:   checkConcurrentLimit(userId) → 429 concurrentLimit
    │                  (per-start quota removed — campaignStart gate gone)
    │  3. Mail merge pre-step (once, non-fatal on failure)
    │  4. resolveCurrentStage(settings)
    │     ├── all staged stages complete → { completed: true }
    │     ├── status=processing          → { waitingStage } (wait)
    │     ├── status=failed              → auto-reset status, re-run stage
    │     └── execute stage done when campaign status is
    │         completed / "Limit Reached"
    │  5. acquireCampaignLock(campaignId, serverlessId) → skip if locked
    │  6. triggerStage(): set statusField=processing, POST stage route
    │     ├── stage ≠ execute requires fileUrl (except interaction-only)
    │     ├── 1 retry; timeout → no retry (route may still be running)
    │     └── failure → notifyCampaignFailure()
    │  7. Re-resolve → if next stage ready, trigger it in the same call
    │     (chaining); otherwise return and wait for the next poll
    ▼
{ success, message, waitingStage? | dispatchedStage? | completed? }
```

**Multi-server:** stages support dispatch to worker servers
(`dispatchToServers` / `findMyAssignment` / `mergeAndFlush`); the orchestrator
returns `{ dispatched: true, servers }` and workers report back.

**Metering limitation (documented):** worker servers receive only
`campaignId` — identity falls back to `getCampaignSettings(campaignId).userId`
— and the coordinator exits before workers finish. Stage usage
(`validateUsage` / `enrichUsage` / `personalizeUsage`) is therefore
incremented only when the coordinator itself completes the stage;
multi-server runs are not metered (fail-open direction, accepted).

### Key Files
- `campaign/pipeline-orchestrator/route.js` — stage machine, locks, concurrent gate, chaining
- `campaign/_shared/pipelineUtils.js` — `getCampaignSettings`, `updateCampaignSettings`, `isCampaignPaused`, CSV helpers, presets
- `utils/campaignLock.js` — per-campaign lock (serverless-safe)
- `utils/multiServerDispatcher.js` — multi-server dispatch/merge

---

## Flow 7: Campaigns (Centerpiece)

### Purpose
Automated bulk outreach across contacts and accounts, driven by the orchestrator
(Flow 6). The `execute` stage has two personalities — **7A email** and
**7B social** — and the four social interaction routes also run standalone as
**7C independent interaction flows**.

```
┌────────────────────────────────────────────────────────────┐
│ FLOW 7 — CAMPAIGN EXECUTE                                   │
│                                                              │
│  pipeline-orchestrator (Flow 6)                              │
│      │                                                       │
│      ▼                                                       │
│  /campaign/execute-campaign                                  │
│      ├── feature gate: allowShooting                         │
│      ├── USER pre-flight (email only):                       │
│      │      checkUserQuota(keys:[shootCampaignUsage])        │
│      ├── CAMPAIGN caps: shootCampaignLimit (0 = block)       │
│      │                                                       │
│      ├── 7A email rows ──► wire profile ACCOUNT gate         │
│      │      │                ├─ per-row USER quota           │
│      │      │                │   (shootCampaignUsage)        │
│      │      │                ├─ SMTP config validation gate  │
│      │      │                │   (smtpCheckerUsage)          │
│      │      │                ├─ pickSmtpWithinCap()          │
│      │      │                │   (accountSendPerRunLimit)    │
│      │      │                ├─ sendViaBrowser / sendViaSMTP  │
│      │      │                └─ updateUserUsage(             │
│      │      │                     shootCampaignUsage)       │
│      │                                                       │
│      └── 7B social tasks ─► per-profile ACCOUNT gate         │
│              │                  ├─ per-task USER quota        │
│              │                  │   (interactionUsage)        │
│              │                  ├─ handler = processXxxTask   │
│              │                  │    (7C gates run inside)    │
│              │                  ├─ LIMIT errors → SKIPPED     │
│              │                  └─ updateUserUsage(           │
│              │                       interactionUsage)       │
│                                                              │
│  7C search-interact / page-interact /                        │
│     inbox-interact / activities-interact                     │
│     (also callable standalone — same gates)                  │
└────────────────────────────────────────────────────────────┘
```

### 7A: Email Execute

```
POST /campaign/execute-campaign  (channel = email)
    │
    │  requireFeature('allowShooting')                 ← feature flag
    │  checkUserQuota(userId,                          ← USER pre-flight
    │    { keys:['shootCampaignUsage'] })              (channel = email only)
    │  shootCampaignLimit <= 0 → { limitReached: true }← CAMPAIGN cap (fail-closed)
    │
    │  SMTP config validation (deliveryMethod smtp/mixed):
    │    checkUserQuota(keys:['smtpCheckerUsage']) → {limitReached} stop
    │    ...validate each config... → updateUserUsage(smtpCheckerUsage)
    │
    │  Wire profile ACCOUNT gate (settings.accounts[0] || wireAccount):
    │    resolveAccountGate(wireProfileId, platform)
    │    blocked → { limitReached, accountBlocked }    ← skip account, never FAILED
    │
    │  Reply-filter setup (best-effort, own short-lived session)
    │
    │  for each deduplicated row:
    │    ├── isCampaignPaused()          → stop (paused)
    │    ├── checkUserQuota(             → limitReached, stop (USER monthly)
    │    │     keys:['shootCampaignUsage'])
    │    ├── sentCount >= shootCampaignLimit → limitReached, stop (CAMPAIGN)
    │    ├── sentCount >= 30             → Vercel timeout safety stop
    │    ├── pickSmtpWithinCap(seed)     → nil when every account hit
    │    │     accountSendPerRunLimit (default 5) → break, limitReached
    │    ├── schedule mode → scheduleViaBrowser (per-row sendDate/sendTime
    │    │                    or scheduleStartTime + sentCount×60s spacing)
    │    └── send-now mode → sendViaSMTP / sendViaBrowser
    │         └── success → updateUserUsage(userId, 'shootCampaignUsage')
    │                       + noteSmtpSend(account)  ← USER + run-cap accounting
    │
    │  Update hub: lastShotAt, shotHistory
    ▼
{ success, sent, delivered, failed, limitReached, analytics }
```

### 7B: Social Execute

```
POST /campaign/execute-campaign  (channel = social)
    │
    │  requireFeature('allowInteraction')              ← feature flag
    │  (no whole-run USER pre-flight — quota is per task, monthly)
    │  shootCampaignLimit <= 0 → { limitReached: true }← CAMPAIGN cap
    │
    │  for each active profile:
    │    resolveAccountGate(profileId, platform)        ← ACCOUNT tier
    │    blocked → skip profile (campaign continues with the rest)
    │
    │  tasksToExecute = pendingSocialTasks.slice(0, shootCampaignLimit)
    │
    │  for each task:
    │    ├── isCampaignPaused()            → stop (paused)
    │    ├── checkUserQuota(keys:          → break (USER monthly)
    │    │     ['interactionUsage'])             → limitReached
    │    ├── handler = ROUTE_MAP[task.operation]  (processSearchInteractTask,
    │    │             processPageInteractTask, processInboxInteractTask,
    │    │             processActivitiesInteractTask — the 7C functions)
    │    ├── result.status = "FAILED"              → failedCount++
    │    ├── thrown isLimitSkipError(message)      → SKIPPED,
    │    │      skippedLimitCount++ (account/platform limit — NOT a failure)
    │    └── success → executedCount++,
    │           updateUserUsage(userId, 'interactionUsage')
    │           ← USER monthly accounting
    │
    │  Live CSV flush after every task:
    │    outcome = anyFailed ? "failed" : anySkipped ? "skipped" : "executed"
    │
    │  DM step (sendToAll): one send-message dispatch per batch
    │
    │  limitReached = executedCount < pendingSocialTasks.length
    │                 || executedCount >= shootCampaignLimit
    │  finalStatus  = paused ? "paused" : limitReached ? "Limit Reached" : "completed"
    ▼
{ success, queuedTasks, executed, failed, skippedLimit, analytics }
```

**Skip-account-continue-campaign:** when an account's limits block a task, the
task is recorded `SKIPPED` (with the account marked `RATE_LIMITED` in the hub
if it was a platform-policy block) and the campaign moves on — skips never
count as failures.

### 7C: Independent Interaction Flows

The four social routes are the task handlers used by 7B, and each also runs
standalone (Task page / direct POST). Identical gates apply either way:

| Route | Workflow keys consumed | Platform actions counted |
|---|---|---|
| `/socials/search-interact` | `search` (read-only), engagement: `interactWithVideo` / `interactWithPost` | read-only → **0**; engagement → `likesOnPost`, `commentOnPost` |
| `/socials/page-interact` | `scrapeProfile` (read-only), engagement: `followUser` / `interactWithProfile` | read-only → **0**; engagement → `follow`, `like`, `comment` |
| `/socials/activities-interact` | `readNotifications` (read-only), engagement: `engageWithNotifications` / `followBack` | read-only → **0**; engagement → `like`, `comment` |
| `/socials/inbox-interact` | `readInbox` (read-only), `sendMessage` (cold message) | read-only → **0**; sends → `coldMessage` |

Per-route gate order (before browser launch):

```
1. resolveAccountGate(profileId, platform)      ← ACCOUNT status
     blocked → throw accountGateError()  ("blocked by account limits")
2. operationConsumes(operationRaw, engagementMode)?
     consumes = true  →
       checkActionAllowed(platform, action, accountUsage)   ← PLATFORM policy
         blocked → throw ("blocked by platform limits")
         route catch → updateAccountStatus(RATE_LIMITED)
     consumes = false →
       no quota check, and NO usage increment after success
3. browser launch → executeWorkflow → increment only the executed keys
   (actionsForExecutedKeys → toLimitActions → updateAccountUsage)
```

Read/scrape runs therefore never touch quota — both for the check and for the
increment.

### Key Files
- `campaign/execute-campaign/route.js` — 7A + 7B engine (gates, loops, CSV flush, analytics)
- `campaign/pipeline-orchestrator/route.js` — Flow 6 stage machine
- `socials/search-interact/route.js` — `processSearchInteractTask` (+ POST handler)
- `socials/page-interact/route.js` — `processPageInteractTask`
- `socials/inbox-interact/route.js` — `processInboxInteractTask`
- `socials/activities-interact/route.js` — `processActivitiesInteractTask`
- `campaign/_shared/wireSender.js` — browser email send (sender = `profileId`)
- `campaign/_shared/smtpSender.js` — SMTP send (sender = `smtp.user`)

### Campaign Pause/Resume
```
pauseCampaign()  → campaign status = "paused"; every loop checks
                   isCampaignPaused() per task/row/stage and stops
resumeCampaign() → status = "running" (feature flag allowShooting checked
                   in the frontend); next orchestrator poll continues
                   from the checkpoint (lastProcessedRow / staged flags)
```

---

## Cadence & Scheduling

### Campaign driver cadence
```
Frontend campaign page (poll ≈ every 60s while status = running)
    │  finds next staged stage that is not completed/processing
    ▼
securedApi.callBackendFunction('runCampaignPipeline')
    ▼
Apps Script → POST /campaign/pipeline-orchestrator
    ▼
one stage step (validate | enrich | personalize | execute | interact)
    │
    ├─ stage completes → posts BACK to /campaign/pipeline-orchestrator
    │                    (self-chaining advances the next stage quickly)
    └─ timeout / waiting → next 60s poll picks it up
```
- One orchestrator invocation = one step; locks (`acquireCampaignLock`) make
  overlapping calls harmless (they return `{ locked: true }`).
- Stage timeouts: validate/execute 600s, others 300s; one retry (30s backoff);
  timeout is never retried — the route may still be running, so the poll just
  waits for the status flag to move.

### Send scheduling
| Mode | Behavior |
|---|---|
| **Send now** | Sends immediately with organic inter-send jitter (30–60s) + intra-message delays (typing, post-send buffer) |
| **Schedule** | `scheduleViaBrowser` uses the mailbox's native "Schedule Send". Per-row `sendDate`/`sendTime` columns win; otherwise `scheduleStartTime + sentCount × 60s` spaces scheduled mails one minute apart |

### Rolling windows & recovery
- Platform action counters roll on hour / day / month boundaries — enforced
  inside `incrementUsage` (counter resets when `hour/day/month` stamp changes).
- Mailbox windows (`sendRateLimiter`) are explicit sliding windows
  (`windowStart` + duration), persisted to the hub.
- `RATE_LIMITED` accounts auto-recover to `ACTIVE` the first time a gate
  observes that every configured action is back under policy.

### Checkpoints
- Email execute resumes from `settings.lastProcessedRow`.
- Social execute caps a batch at `shootCampaignLimit` and records
  `limitReached` so the campaign stops cleanly instead of re-queueing work.
- Stage progress lives in `settings.*Staged` / `*Status` flags (Flow 6).

---

## Limits & Rate Governance

### Tier model

```
┌─────────────────────────────────────────────────────────────────────┐
│                                                                      │
│  PLATFORM  — policy.  Limits sheet rows, one JSON cell per action:  │
│              {"hourly":n,"daily":n,"monthly":n,"cap":n}              │
│              evaluateActionPolicy()  ·  FAIL-OPEN (0/missing = run)  │
│                                                                      │
│  ACCOUNT   — state.   hub interactionUsage (per-action counters) +   │
│              interactionStatus (ACTIVE / WAITING / RATE_LIMITED /    │
│              CANCELLED), keyed by submissionId/browserId.            │
│              resolveAccountGate() + incrementUsage()  ·  auto-recover│
│              `interactionUsage._limits` = reserved per-account       │
│              override that REPLACES platform policy when present     │
│              (Q7=B) — read by checkActionAllowed and sendRateLimiter.│
│                                                                      │
│  USER      — quota.   users sheet: `plan` + monthly `*Usage`        │
│              counters, matched against a Limits PLAN row's          │
│              `*Limit` columns (uniform *Limit → *Usage rule).       │
│              checkUserQuota(userId, {keys:[…]}) · FAIL-OPEN         │
│              (0/missing plan/row = unlimited); verify-login* alone  │
│              is identity-FAIL-CLOSED (403 when userId absent).      │
│                                                                      │
│  CAMPAIGN  — plan caps. Limits campaign row: validateLimit,          │
│              enrichLimit, personalizeLimit, shootCampaignLimit,      │
│              interactionLimit, campaignConcurrentLimit,              │
│              accountSendPerRunLimit.                                 │
│              getCampaignLimits() · FAIL-CLOSED (0 = block);         │
│              interactionLimit/accountSendPerRunLimit empty →        │
│              defaults 10 / 5 (protect accounts+SMTPs).              │
│                                                                      │
│  (MAILBOX  — sliding windows in sendRateLimiter, thresholds from the │
│   side)      Limits coldMessage column, persisted to hub; effective  │
│              limits = account `_limits` override when present, else  │
│              platform policy; `no_limits_for_platform` only when     │
│              both are absent.)                                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

Core logic lives in `socials/_shared/limitsCore.js` (pure, unit-tested) and is
wired to sheets by `socials/_shared/limits.js` + `socials/_shared/hubUpdater.js`;
account status gating lives in `socials/_shared/accountGate.js`.

### Enforcement matrix

| Entry point | PLATFORM policy | ACCOUNT state | USER quota | CAMPAIGN caps | On block |
|---|:-:|:-:|:-:|:-:|---|
| `POST */cookie/cookie-api-login` (new process) | — | — | ✔ `verifyLoginUsage` | — | `429 {limitReached}` (missing userId → warn, fail-open) |
| `GET true-login/verify-login*` | — | — | ✔ `verifyLoginUsage` | — | **`403 verify_login_identity_required`** (no userId) / `429` |
| `POST /campaign/pipeline-orchestrator` | — | — | — (start gate removed) | ✔ concurrent | `429 {concurrentLimit}` |
| `POST /campaign/execute-campaign` — **7A email** | — | ✔ wire profile gate before loop | ✔ entry + per row → `shootCampaignUsage`; SMTP validation → `smtpCheckerUsage` | ✔ `shootCampaignLimit` (0 = block) + `accountSendPerRunLimit` (default 5) | `{limitReached, accountBlocked}` — never `FAILED` |
| `POST /campaign/execute-campaign` — **7B social** | via handlers | ✔ per profile → account skipped | ✔ per task → `interactionUsage` | ✔ caps queued tasks | task `SKIPPED` (`isLimitSkipError`), campaign continues |
| `POST /socials/search-interact` **7C** | ✔ executed-key actions (read → 0) | ✔ status gate | — | — | throw `blocked by … limits`; platform block → hub `RATE_LIMITED` |
| `POST /socials/page-interact` **7C** | ✔ engagement-aware | ✔ | — | — | same |
| `POST /socials/activities-interact` **7C** | ✔ executed-key | ✔ | — | — | same |
| `POST /socials/inbox-interact` **7C** | ✔ `coldMessage` for sends | ✔ | — | — | same |
| `POST /socials/send-message` | ✔ `coldMessage` (real usage; block → hub `RATE_LIMITED`) | ✔ per profile | ✔ per recipient → `senderUsage` | ✔ per profile `accountSendPerRunLimit` (0 = off) | `4xx {accountBlocked}`; run cap → `limitReached`, break |
| `POST /emails/send-email` | ✔ mailbox windows (`checkSendAllowed` + account `_limits` override) | ✔ hub status → `409 {accountBlocked}` | ✔ `shootContactsUsage` (block → `429 stopAll`) | — | row `rate_limited` / `409` / `429`; feature `allowShooting` |
| `runSmartExtract` (Flow 2) | ✔ `extract` column | ✔ status gate (auto-recover) | ✔ `extractionUsage` (monthly; when session has userId) | — | `extractStatus = failed`, no browser launch |
| `POST /campaign/interact-inbox` | — | — | — | ✔ `interactionLimit` | stops reply loop |
| Campaign wire send (`wireSender`) | — | ✔ (stage gate) | ✔ (loop) | ✔ | see Known Issues (mailbox windows not applied) |

Legend: ✔ = enforced in code · — = not applicable to that entry point.

### Error markers (shared vocabulary)

| Marker | Meaning | Consequence |
|---|---|---|
| `blocked by platform limits` | PLATFORM policy exceeded | Route catch flips hub status → `RATE_LIMITED`; campaign classifies as `SKIPPED` |
| `blocked by account limits` | ACCOUNT gate blocked (CANCELLED / still RATE_LIMITED) | Never re-writes status; campaign classifies as `SKIPPED` |
| `Extraction limit reached (extract): …` | extract column exceeded | Extraction fails fast, no launch; does not flip status |
| `user_monthly_limit: <key> <used>/<limit>` | USER monthly quota exceeded (users `*Usage` vs plan-row `*Limit`) | Campaign stops with `limitReached`; routes return `429 {userMonthlyLimit, limitReached}`; `runSmartExtract` → `extractStatus = failed` |
| `verify_login_identity_required` | `verify-login*` called without a user identity | **`403` fail-closed** — quota bypass not allowed |
| `isLimitSkipError(msg)` | matches the platform/account markers | `FAILED` → `SKIPPED` in execute-campaign |

### Fail-open vs fail-closed

| Check | Failure mode | Rationale |
|---|---|---|
| Platform policy (row/column missing, sheet outage) | **Fail-open** | Never stall the engine on config gaps |
| User quota (plan/plan row/column missing, unknown plan, sheet outage) | **Fail-open** | Adding columns/plans later must not break running campaigns |
| `verify-login*` missing userId | **Fail-closed (403)** | The one place identity absence must not bypass the user tier |
| Account status (read error) | **Fail-open** (allow) | A sheet outage must not freeze every account |
| Account status `CANCELLED` | **Blocked, never recovers** | Explicit opt-out |
| Campaign plan caps (0/missing) | **Fail-closed (block)** | Spend caps must default to "don't spend" |
| `campaignConcurrentLimit` | default **3** when column missing | Matches historical behavior |

### Sheet schema quick reference

**Limits sheet — platform row**

| Column | Cell |
|---|---|
| `platform` | `TIKTOK`, `YOUTUBE`, … (uppercased on read) |
| `category` | `platform` (campaign row uses `campaign`) |
| `likeOnStory`, `likesOnPost`, `likesOnComment`, `commentOnComment`, `commentOnStory`, `commentOnPost`, `follow`, `unfollow`, `coldMessage`, `extract` | `{"hourly":5,"daily":50,"monthly":500,"cap":2000}` — all four keys optional; `0`/empty = unlimited |

**Limits sheet — campaign row** (`category = campaign`)

| Column | Semantics |
|---|---|
| `validateLimit`, `enrichLimit`, `personalizeLimit`, `shootCampaignLimit`, `interactionLimit` | plan caps, **0 = block** (see Known Issues for validate/enrich asymmetry) |
| `campaignConcurrentLimit` | concurrent campaigns per user (default 3) |
| `interactionLimit` (unset) | per-run interaction default **10** when the cell is empty |
| `accountSendPerRunLimit` | max sends per SMTP account per campaign run; empty → default **5**, `0` = off (campaign + standalone sends) |

**Limits sheet — plan row** (`plan = NAME`, e.g. `LEGEND` / `VETERAN` /
`OG` / `NEWBEE` / `FREE`)

| Column | Semantics |
|---|---|
| `plan` | matches the users sheet `plan` column (case-insensitive) |
| `smtpCheckerLimit`, `senderLimit`, `verifyLoginLimit`, `extractionLimit`, `shootContactsLimit`, `validateLimit`, `enrichLimit`, `personalizeLimit`, `shootCampaignLimit`, `interactionLimit` | monthly USER quota — `col.replace(/Limit$/, 'Usage')` keys via `USER_LIMIT_COLUMNS`; `0`/empty = unlimited. Two tiers of identical columns may coexist on one sheet because plan rows are matched only by `plan`, campaign rows only by `category`. |

**Users sheet** — `userId`, `plan` (tier name → Limits plan row), `usage`
(JSON blob: `{ <key>Usage: { hourly, daily, monthly, total, month, year } }`
— `monthly` is the quota counter; it resets when the stored month/year rolls
over).

**Hub sheet (limits columns)** — `interactionStatus`, `interactionUsage` (same
blob shape, written by `updateAccountUsage`). The **cookie sheet's `usage`
column is dead** — never read (see Known Issues).

---

## Account Launch Safety

Every browser launch passes the same pre-flight gauntlet:

```
credentials resolved (resolveSession / getSocialProfileCookies / hub row)
        │
        ▼
feature flag?        requireFeature(allowShooting | allowInteraction | allowExtraction)
        │
        ▼
ACCOUNT status       resolveAccountGate(id, platform)
        │
        ▼
PLATFORM policy      checkActionAllowed(platform, action, interactionUsage)
        │                  (interactionUsage._limits overrides policy)
        ▼
USER quota           checkUserQuota(userId, {keys:['…Usage']})   — monthly;
        │                  verify-login* additionally 403 without userId
        ▼
CAMPAIGN plan caps   getCampaignLimits() (0 = block; run caps 10/5 on unset)
        │
        ▼
browser launch → execute → usage increments → cleanup (profileDir removed in finally)
```

### Account status semantics

| `interactionStatus` | Gate result |
|---|---|
| `ACTIVE` | allow |
| `WAITING` | allow (email login flows own this state — left untouched) |
| missing row / empty | allow |
| `CANCELLED` | **block**, never auto-recovers |
| `RATE_LIMITED` | block **until** every configured platform action is back under policy → auto-recover to `ACTIVE`, allow |

### Mid-campaign behavior (skip account, continue campaign)
- **Social (7B):** per-profile gate blocks → profile skipped; per-task limit
  errors → `SKIPPED` + `skippedLimitCount`, loop continues with other
  profiles/tasks. The campaign only ends `Limit Reached` when work actually
  ran out or a cap was hit.
- **Email (7A):** wire profile gate blocks before the loop → the email stage
  returns `{ limitReached, accountBlocked }` (never `FAILED`); other stages of
  the campaign continue.
- **Auto-recovery:** a `RATE_LIMITED` account that trips the gate on a later
  poll re-evaluates its counters; once the hour/day/month windows have rolled,
  the gate flips it back to `ACTIVE` and the account rejoins the rotation.

### Structural safety guards
- Per-`browserId` extract in-flight guard (auto vs manual extract race).
- Per-campaign orchestrator lock (`acampaignLock`) — overlapping polls no-op.
- `isCampaignPaused()` checked between every task/row/stage.
- Duplicate-recipient dedupe and `SHOOTING_BATCH_SIZE` / 30-send Vercel caps.
- `finally` blocks always close the browser and delete the temp profileDir.

---

## Known Issues & TODO

> Clearly-labeled gaps — deliberate deferrals or known risks. Not bugs of the
> limits work; tracked here so nobody rediscovers them.

1. **No proxy / single-IP rotation.** All browser and SMTP traffic egresses
   from the host's IP. No per-account proxy support exists.
2. **Shared `profileDir` race.** If the same `browserId` is launched
   concurrently (two routes, or auto-extract + manual extract edge cases
   outside the extract guard), both processes use the same downloaded profile
   directory and can corrupt it.
3. **`interactionLimit: 0` semantics are inconsistent.** The interact stage
   treats `0` as "queue nothing" while other caps default-block; paths that
   read it with `|| Infinity` treat `0` as unlimited. Normalize on one
   meaning.
4. **Interaction stage runs once, no re-scan.** The `interact` stage does not
   periodically re-scan for new inbound messages; a campaign that reaches it
   waits for a new poll/manual re-trigger.
5. **Cookie-sheet `usage` column is dead.** Account usage lives only in the
   hub `interactionUsage` JSON; the legacy `usage` column in the cookie sheet
   is never read or written (kept for backward compatibility only).
6. **`allowInteraction` bypass on the campaign path.** The feature flag is
   enforced for standalone social routes, but the campaign execute path only
   hard-gates `allowShooting` — an interaction-only campaign can still reach
   handlers if launched directly. Verify flag coverage when adding new
   campaign channels.
7. **Platform tier fails open when a row is missing.** A typo in a platform
   name (e.g. `TIKTOK` vs `TikTok` — mitigated by uppercase normalization, but
   misspellings survive) silently grants unlimited actions. Consider a config
   linter for the Limits sheet.
8. **Validate/enrich `0` = unlimited asymmetry.** `shootCampaignLimit: 0`
   blocks (fail-closed) while `validateLimit`/`enrichLimit: 0` means
   unlimited (pickLimitNumber semantics). Documented here; harmonizing would
   change budget behavior for existing sheets.
9. **Ad-hoc Task-page launches carry no `userId` for the four interaction
   routes.** `search/page/inbox/activities-interact` receive no user identity
   in their standalone payloads, so the USER tier is enforced only where
   identity exists: execute-campaign loops, extraction, standalone
   `send-message` (body `userId` → cookie-sheet `userId` fallback), shoots,
   and logins. Adding `userId` to the Task-page payload would close the gap
   (frontend contract change).
10. **Campaign wire sends skip mailbox windows.** `wireSender`/`smtpSender`
    do not run through `sendRateLimiter` — only the account status gate and
    the user/plan caps apply on the 7A path; hourly/daily mailbox windows are
    enforced only by the standalone `/emails/send-email` route.
11. **Multi-server validate/enrich/personalize runs are not metered.**
    Worker servers only see `campaignId` and the coordinator returns before
    workers finish, so `validateUsage`/`enrichUsage`/`personalizeUsage` are
    incremented only in single-server completions (fail-open direction).
12. **Backend identity plumbing requires redeploy.** GAS `LINKS.js`
    (`verifyPageVisit` returns `userId`), GAS `POST.js` (`shootEmails` derives
    `userId` from the auth token), and Flask `pagetemplate_handler.py`
    (captures `userId` + injects it into `verify-login*` URLs) live outside
    this repo — deploy GAS via clasp and redeploy Flask before the
    verify-login/shoot identity chain works end-to-end.

---

## Appendix A: Session Resolution Summary

| Route | Session Source | Identity | Drive Profile | Helper |
|-------|---------------|----------|---------------|--------|
| `cookie-api-login` | Creates session | Captures identity | Uploads profile | Direct |
| `smartExtract` | Cookie sheet | ✅ | ✅ | `resolveSession()` |
| `send-email` | Hub sheet | ✅ | ✅ | `resolveShootSession()` |
| `compose-email` | Hub sheet | ✅ | ✅ | `resolveShootSession()` |
| `send-message` | Cookie sheet | ✅ | ✅ | `resolveSocialSession()` |
| `execute-campaign` (wire) | Cookie sheet | ✅ | ✅ | `resolveSocialSession()` via `wireSender` |
| `execute-campaign` (social) | Cookie sheet | ✅ | ✅ | `resolveSocialSession()` via task payloads |
| `interact-inbox` | Hub sheet | ✅ | ✅ | `resolveSocialSession()` |
| `search-interact` | Task payload | ✅ | ✅ | `resolveSocialSession()` |
| `page-interact` | Task payload | ✅ | ✅ | `resolveSocialSession()` |
| `inbox-interact` | Task payload | ✅ | ✅ | `resolveSocialSession()` |
| `activities-interact` | Task payload | ✅ | ✅ | `resolveSocialSession()` |

**All routes use the hybrid session approach.** Every browser launch either:
1. Downloads the Drive profile + applies identity fingerprint, OR
2. Falls back to CDP cookie injection + identity fingerprint

---

## Appendix B: Key Functions Reference

### Limits & Governance (`socials/_shared/`)
- `limitsCore.js` (pure logic, CJS — unit-tested in `__test__/limitsModel.test.js`)
  - `evaluateActionPolicy(policy, usage)` — PLATFORM tier decision (+ tier tags)
  - `evaluateUserQuota(usageBlob, planLimits, {keys})` — USER tier decision (monthly `*Usage` vs plan-row `*Limit`; `{keys:['…Usage']}` narrows, `key` shorthand, no keys = all plan keys)
  - `USER_LIMIT_COLUMNS` — the 10 quota keys; uniform `col.replace(/Limit$/,'Usage')` rule
  - `parsePlanRow(headers, row)` — Limits plan row → `{ <key>Usage: n }` (garbage → 0 = unlimited)
  - `operationConsumes(op, engagementMode)` — does this op touch quota?
  - `actionsForExecutedKeys(keys, operation)` / `toLimitActions(actions)` — exact increments for executed workflows
  - `parseLimitCell`, `pickLimitNumber`, `normalizePolicy`, `normalizeUsage`
- `limits.js`
  - `checkActionAllowed(platform, action, accountUsage)` — PLATFORM gate; honors `accountUsage._limits` override (replaces platform policy)
  - `checkUserQuota(userId, {keys:[…]})` — USER gate via `getUserRecord` → `getPlanLimits` → `evaluateUserQuota` (fail-open; `verify-login*` identity handled at the route, 403)
  - `getPlanLimits(plan)` — Limits plan row (matched by `plan` col) → monthly limits
  - `getCampaignLimits()` — CAMPAIGN per-run caps (fail-closed) incl. `interactionLimit` (unset→10) + `accountSendPerRunLimit` (unset→5, 0=off)
  - `getLimitsSheet(forceRefresh)` — 5-min TTL cache, stale fallback, single-flight
- `accountGate.js`
  - `resolveAccountGate(profileId, platform)` — ACCOUNT status gate with auto-recovery
  - `accountGateError(profileId, gate)` — standard `blocked by account limits` error
  - `isLimitSkipError(message)` — limit-error classifier (SKIPPED vs FAILED)
- `hubUpdater.js`
  - `getAccountUsage` / `updateAccountUsage(action, count=1)` — hub `interactionUsage`
  - `updateAccountStatus(status)` — hub `interactionStatus`
  - `getUserUsage` / `updateUserUsage(userId, action, count=1)` — users `usage` blob (monthly counter, year-aware reset)
  - `getUserRecord(userId)` — single-read `{plan, usage}` (missing → `{plan:"",usage:{}}` fail-open)

### Engine Helpers (`socials/_shared/routeHelper.js`)
- `downloadAndExtractProfile(driveUrl, browserId)` — Downloads ZIP from Drive, extracts to temp dir
- `launchBrowserWithSession(cookieJSON, headless, options)` — Launches Chrome with cookies/profile/identity
- `resolveShootSession(browserId)` — Full hybrid session for email shoots (reads hub sheet)
- `resolveSocialSession(profile)` — Full hybrid session for social/campaign (accepts profile object)
- `executeWorkflow(page, workflow, context, config)` — Generic workflow executor for social DMs
- `DOMHelpers` — `randomDelay`, `clickElement`, `typeText`, `scrollDown`

### Engine Rate Limiter (`utils/sendRateLimiter.js`)
- `checkSendAllowed(platform, accountId)` — sliding hourly/daily/monthly windows; restore-once per account; effective limits = `interactionUsage._limits` override when present, else platform policy
- `incrementSendCount(platform, accountId)` — increments + fire-and-forget hub persist
- `persistUsageToHub` / `restoreUsageFromHub` — key columns `browserId` → `submissionId` → `email`; captures `_limits` override into `accountLimits`
- `detectEmailProvider(hostOrEmail)` — Resolves provider string (`GMAIL`, `MICROSOFT`, `YAHOO`, etc.)

### Google auth token source (`utils/googleTokenSource.js` + `googleTokenSourceCore.js`)
- `resolveRefreshToken()` — sheet-first precedence: SETTINGS row `googleRefreshToken`
  (`settingsValue1`) → last-known value → `.env GOOGLE_DRIVE_REFRESH_TOKEN`.
  The SETTINGS row is read through the App-Script `getData` action (token-
  independent), so a rotation works even when the old refresh token is already
  dead. 60s cache / 30s failure backoff / single-flight; the token value is
  never logged (source + length only).
- Consumers: `getSheetsAuthClient()` (googlesheets.js) and `authenticate()`
  (googledrive.mjs); a changed token rebuilds the cached client without a
  restart. `getCachedRefreshToken()` is the sync pre-flight hint.
- **Rotation (refresh tokens expire ~7 days):** exchange a new code at
  `oauth2.googleapis.com/token` (OAuth Playground client `568458296076-…` —
  same as `GOOGLE_OAUTH2_JSON`) → paste `refresh_token` into the SETTINGS row
  `googleRefreshToken` / `settingsValue1` → picked up within 60s. Optional
  `settingsValue2=expires=<epoch>` logs a warning once past. Env var remains
  bootstrap/fallback only.

### Apps Script (`POST.js`, `LINKS.js`)
- `shootEmails(params)` — Forwards to `/emails/send-email`; derives `userId` from `params.userId` → auth token (`userId|role|ts|random`)
- `verifyPageVisit(params)` (LINKS.js) — returns `{success, userId}` (project-row owner) for the Flask verify-login chain
- `composeAIMessage(params)` — Forwards to `/emails/compose-email`
- `runCampaignPipeline(params)` — Forwards to `/campaign/pipeline-orchestrator`
- `pauseShoot / resumeShoot / stopShoot` — PropertiesService flags
- `cleanupShootFlags / cleanupOldShootFlags` — Garbage collection

### Flask backend (`pagetemplate_handler.py`)
- `verify_page_visit` — passes `userId` through in the response
- `handle_page_template` — regex-injects `userId=` into `verify-login(-lite|-ai)?` URLs before rendering (never double-appends); without it the engine returns `403 verify_login_identity_required`

### Frontend
- `ShootContactsModal` — 5-step wizard with `useExtractData` hook for Drive fetch
- `useExtractData` hook — Detects Drive pointers, fetches via `/api/drive-csv`
- `securedApi.callBackendFunction()` — Authenticated POST to Apps Script
- Campaign page — 60s poll that advances staged stages via `runCampaignPipeline`
