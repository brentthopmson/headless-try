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
│  │  UI components       │  │  API dispatch layer    │  │  Browser automation│
│  │  Dashboard, modals   │  │  Sheet read/write      │  │  Cookie injection │  │
│  │  Feature flags       │  │  OAuth token refresh   │  │  Profile download │  │
│  │  Secured API calls   │  │  Pause/stop flags      │  │  Session mgmt    │  │
│  └──────────┬──────────┘  └───────────┬────────────┘  └────────┬────────┘  │
│             │                         │                         │           │
│             │  POST /backend-function  │  POST /shootEmails      │           │
│             └─────────────────────────>│  POST /composeAIMessage  │           │
│                                        │  POST /pauseShoot        │           │
│                                        │  POST /stopShoot         │           │
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
│                                        /campaign/interact-inbox    │           │
└──────────────────────────────────────────────────────────────────────────┘
```

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
│  ├── settings (JSON: accounts, targetLink, socialStrategyPrompt) │
│  └── status (draft, running, paused, completed)                  │
│                                                                   │
│  LIMITS SHEET                                                    │
│  └── Action limits per platform (follow, like, coldMessage, etc.)│
└─────────────────────────────────────────────────────────────────┘
```

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
    │                           │                        │
    │  { success, data: {       │                        │
    │    contacts, personal,    │                        │
    │    financial, activities } │                        │
    │  }                        │                        │
    │<──────────────────────────│<───────────────────────│
```

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
    │  1. getHubRowByBrowserId() → hub sheet
    │  2. resolveShootSession(browserId)
    │     ├── Read hub sheet: driveUrl, browserIdentity, cookies
    │     ├── If driveUrl → download profile → hybrid launch
    │     └── Else → CDP cookies + identity
    │  3. For each contact:
    │     a. checkSendAllowed() (rate limit)
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

### Flow: AI Compose
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

### Flow: Social DM Shoot
```
Frontend → handleShootContacts() →
    functionName: 'shootEmails' (social variant)

Apps Script → shootEmails() →
    resolveEngineUrl("socials/send-message")

Engine: /socials/send-message/route.js
    │
    │  1. getCookieForProfile(profileId) → cookie sheet
    │     Returns: { cookies, platform, browserIdentity, driveUrl }
    │  2. For each recipient (round-robin profiles):
    │     a. checkActionAllowed(platform, "coldMessage")
    │     b. Hybrid session:
    │        ├── If driveUrl → downloadAndExtractProfile()
    │        └── Else → CDP cookies + identity
    │     c. executeWorkflow(page, workflow, context)
    │        └── Platform-specific: navigate → new message →
    │            fill recipient → fill message → click send
    │     d. updateAccountUsage()
    │  3. Flush CSV back to Drive
    │  4. Cleanup profileDirs
```

### Shoot Modal Data Flow
```
ShootContactsModal
    │
    │  contacts = useMemo(() => {
    │    // Fetch extract data (handles Drive pointers)
    │    const raw = fetchedExtractData || item[extractKey];
    │    const extract = safeParseJSON(raw);
    │    if (category === 'WIRE') return extract.contacts || [];
    │    if (category === 'SOCIAL') return extract.followers || [];
    │  }, [item, fetchedExtractData]);
    │
    │  useExtractData(item.wireExtract) →
    │    ├── If Drive pointer → fetch /api/drive-csv?fileId=xxx
    │    ├── If HTTP URL → fetch directly
    │    └── If inline JSON → use as-is
```

### Key Files
- `ShootContactsModal.tsx` — 5-step wizard (select → link → analyze → review → send)
- `emails/send-email/route.js` — Email shoot engine
- `emails/compose-email/route.js` — AI compose engine
- `socials/send-message/route.js` — Social DM shoot engine
- `socials/_shared/routeHelper.js` — `resolveShootSession`, `resolveSocialSession`
- `campaign/_shared/wireSender.js` — `sendViaBrowser` (campaign wire send)
- `campaign/_shared/smtpSender.js` — `sendViaSMTP` (campaign SMTP send)

---

## Flow 4: Campaign

### Purpose
Automated bulk outreach across multiple contacts and accounts, with pipeline stages.

### Pipeline Stages
```
1. UPLOAD        → Import contacts from CSV
2. ENRICH        → Validate/enhance contact data
3. SEARCH        → Find contacts on social platforms
4. INTERACT      → Follow, like, engage with content
5. INBOX         → Send DMs via social platforms
6. SHOOT         → Send emails via browser or SMTP
7. ACTIVITIES    → Monitor and engage with notifications
```

### Flow: Campaign Execution
```
Frontend (CampaignModal)
    │
    │  Execute Pipeline →
    │  securedApi.callBackendFunction({
    │    functionName: 'runCampaignPipeline',
    │    campaignId
    │  })
    │
    ▼
Apps Script → CAMPAIGN.js → executeCampaign()
    │
    │  requireSetting("allowShooting")
    │  Check campaign status (not paused)
    │  resolveEngineUrl("/api/execute-campaign")
    │
    ▼
Engine: /campaign/execute-campaign/route.js
    │
    │  For each pipeline stage:
    │
    │  WIRE EMAIL DELIVERY:
    │  ├── getSocialProfileCookies(profileId) → cookie sheet
    │  │   Returns: { cookies, platform, browserIdentity, driveUrl }
    │  ├── sendViaBrowser(email, subject, message, cookies, provider, {
    │  │     browserIdentity, driveUrl, profileId
    │  │   })
    │  │   └── resolveSocialSession(profile) → hybrid session
    │  └── OR sendViaSMTP() (no browser needed)
    │
    │  SOCIAL CAMPAIGN:
    │  ├── getSocialProfileCookies(profileId) → cookie sheet
    │  ├── Build task payloads with:
    │  │   { cookieJSON, browserIdentity, driveUrl, profileId,
    │  │     platform, operation, searchQuery, ... }
    │  ├── Dispatch to social interact routes:
    │  │   ├── search-interact  → resolveSocialSession()
    │  │   ├── page-interact    → resolveSocialSession()
    │  │   ├── inbox-interact   → resolveSocialSession()
    │  │   └── activities-interact → resolveSocialSession()
    │  └── Each route cleans up profileDir after execution
    │
    │  INBOX INTERACTION:
    │  ├── getHubRows(accountIds) → hub sheet
    │  │   Returns: { accountId, cookieJSON, browserIdentity, driveUrl }
    │  ├── resolveSocialSession() per account
    │  ├── scanInbox() → read messages
    │  ├── AI relevance pass → decide which to reply to
    │  └── Generate and send replies
    │
    ▼
Campaign status: running → paused → completed
```

### Campaign Pause/Resume
```
pauseCampaign() →
  Updates campaign status to "paused" in sheet
  Engine checks isCampaignPaused() between stages

resumeCampaign() →
  Updates status to "running"
  Re-calls executeCampaign() to continue from checkpoint
```

### Key Files
- `campaign/execute-campaign/route.js` — Main campaign engine (946 lines)
- `campaign/interact-inbox/route.js` — AI inbox interaction
- `campaign/_shared/wireSender.js` — Browser-based email send
- `campaign/_shared/smtpSender.js` — SMTP email send
- `campaign/_shared/pipelineUtils.js` — CSV parsing, pause checks, presets
- `socials/search-interact/route.js` — Social search + follow/like
- `socials/page-interact/route.js` — Social profile scraping
- `socials/inbox-interact/route.js` — Social DM sending
- `socials/activities-interact/route.js` — Social notification engagement

---

## Session Resolution Summary

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

**All routes now use the hybrid session approach.** Every browser launch either:
1. Downloads the Drive profile + applies identity fingerprint, OR
2. Falls back to CDP cookie injection + identity fingerprint

---

## Key Functions Reference

### Engine Helpers (`socials/_shared/routeHelper.js`)
- `downloadAndExtractProfile(driveUrl, browserId)` — Downloads ZIP from Drive, extracts to temp dir
- `launchBrowserWithSession(cookieJSON, headless, options)` — Launches Chrome with cookies/profile/identity
- `resolveShootSession(browserId)` — Full hybrid session for email shoots (reads hub sheet)
- `resolveSocialSession(profile)` — Full hybrid session for social/campaign (accepts profile object)
- `executeWorkflow(page, workflow, context, config)` — Generic workflow executor for social DMs
- `DOMHelpers` — `randomDelay`, `clickElement`, `typeText`, `scrollDown`

### Apps Script (`POST.js`)
- `shootEmails(params)` — Forwards to `/emails/send-email`
- `composeAIMessage(params)` — Forwards to `/emails/compose-email`
- `pauseShoot / resumeShoot / stopShoot` — PropertiesService flags
- `cleanupShootFlags / cleanupOldShootFlags` — Garbage collection

### Frontend
- `ShootContactsModal` — 5-step wizard with `useExtractData` hook for Drive fetch
- `useExtractData` hook — Detects Drive pointers, fetches via `/api/drive-csv`
- `securedApi.callBackendFunction()` — Authenticated POST to Apps Script
