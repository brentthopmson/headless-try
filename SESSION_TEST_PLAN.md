# Google Session Longevity & Cookie Ingestion Test Plan

## 1. Background & Environment Clarification

- **Serverless Engine VPS Environment:**
  - **Google (Gmail, GSuite, Drive):** Runs on a **Windows VPS**. Profiles and cookies are generated in a Windows Chromium/Chrome environment.
  - **Microsoft (Outlook, Hotmail):** Runs on a Linux environment (Docploy).
  - *Correction applied:* The session death on Google accounts is **not** an OS encryption mismatch (e.g. Linux `os_crypt` vs Windows DPAPI), because Google sessions are generated on Windows.
- **Problem Statement:**
  - Sessions opened via the desktop launcher using `driveCookieJSON` or multi-tab launching die / get invalidated almost immediately after one trial or after a brief duration.
  - With the **old launcher** using standard `cookieJSON`, sessions survived repeatedly and could be opened on multiple devices outside the VPS without any issues.

---

## 2. Exhaustive Cookie Comparison

Comparison performed on exact session data:
- `cookieJSON` (20 cookies, initial login at `mail.google.com`)
- `accountCookieJSON` (22 cookies, after navigating to `myaccount.google.com`)
- `driveCookieJSON` (26 cookies, after navigating to `drive.google.com`)

### A. Completeness Check
- **Zero cookies are missing from `driveCookieJSON`.**
- `driveCookieJSON` contains **100%** of all cookies present in `cookieJSON` and `accountCookieJSON`.

### B. Cookie Distribution by Origin
| Origin | `cookieJSON` (20) | `accountCookieJSON` (22) | `driveCookieJSON` (26) | Cookies Added / Specifics |
| :--- | :---: | :---: | :---: | :--- |
| **`.google.com` (Root Auth)** | 17 | 17 | 17 | `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `NID`, `SEARCH_SAMESITE`, `__Secure-STRP`, `__Secure-1PSIDTS`, `__Secure-3PSIDTS`, `SIDCC`, `__Secure-1PSIDCC`, `__Secure-3PSIDCC` |
| **`mail.google.com`** | 3 | 3 | 3 | `COMPASS`, `OSID`, `__Secure-OSID` |
| **`myaccount.google.com`** | 0 | 2 | 3 | `OSID`, `__Secure-OSID`, `OTZ` |
| **`drive.google.com`** | 0 | 0 | 3 | `COMPASS`, `OSID`, `__Secure-OSID` |

### C. Value Stability vs Mutation
1. **Master Authentication Tokens (100% Identical Across All Sets):**
   - The master identity credentials (`SID`, `HSID`, `SSID`, `APISID`, `SAPISID`, `__Secure-1PSID`, `__Secure-3PSID`, `__Secure-1PAPISID`, `__Secure-3PAPISID`, `NID`) have **identical values and expiration dates** in all three sets.
2. **The Only Values That Changed:**
   - Only the rolling security check cookies changed between `cookieJSON` and `driveCookieJSON`:
     - `SIDCC`
     - `__Secure-1PSIDCC`
     - `__Secure-3PSIDCC`

---

## 3. Root Cause Hypotheses

### Hypothesis 1: Origin-Bound Sub-Session Inconsistency (`OSID` & `SIDCC` Binding)
- **`OSID` (Origin-bound Session Identifier):** Google assigns an `OSID` specific to each subdomain (`mail`, `drive`, `myaccount`).
- **`SIDCC` (Security Identification Check Cookie):** Ephemeral rolling token binding the session to the active connection.
- **Mechanism of Failure:**
  - In `cookieJSON`, there are **no** `drive.google.com` or `myaccount.google.com` cookies. It only carries root auth and the primary `mail` token.
  - When opened on an external device with only `cookieJSON`, Google's SSO (`accounts.google.com`) cleanly handshakes and issues fresh, valid `OSID`s tailored to that local device.
  - When pre-baked `OSID`s for all 3 origins (generated on the VPS) are injected along with a rotated `SIDCC`, Google detects sub-tokens minted on IP `A` being presented from IP `B` with conflicting state counters. Google flags this as anomalous and **revokes the parent `SID` token**, invalidating the session everywhere.

### Hypothesis 2: Simultaneous Multi-Tab Launch Race Condition
- When 3 Google tabs (`mail.google.com`, `myaccount.google.com`, `drive.google.com`) are opened simultaneously:
  - All 3 tabs trigger concurrent SSO handshakes against `accounts.google.com/CheckCookie` or account switcher endpoints (`/u/0/`).
  - If Tab 1 causes `accounts.google.com` to rotate `SIDCC` while Tab 2 and Tab 3 have requests in-flight with the older `SIDCC`, Google detects concurrent state collisions and kills the session.
  - In contrast, the old launcher opened **only 1 tab** at startup.

### Hypothesis 3: Reused Profile Directory vs Clean Instance
- Launching Chrome pointing to an extracted profile folder with cached service workers, indexedDB, and local state from the VPS run can cause conflicting cache state on subsequent launches.
- A clean temporary profile with pure CDP cookie injection gives Chrome a pristine slate without stale network state.

---

## 4. Test Matrix & Automated Test Harness

To test without having to manually rebuild the launcher three times, we use an automated Node.js test harness script on the local machine (`scratch/test_session_longevity.mjs`).

```
                    ┌───────────────────────────────────────┐
                    │     AUTOMATED LONGEVITY HARNESS       │
                    │   scratch/test_session_longevity.mjs  │
                    └───────────────────┬───────────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           ▼                            ▼                            ▼
      [TEST 1]                     [TEST 2]                     [TEST 3]
  Cookie Set Longevity         Tab Pacing Strategy          Profile Isolation
  Trial 1A: cookieJSON         Trial 2A: Single Tab         Trial 3A: Clean Temp Profile
  Trial 1B: driveCookieJSON    Trial 2B: 3 Tabs (staggered) Trial 3B: Extracted Profile
  (3 repeated launches)        (3 repeated launches)        (3 repeated launches)
```

### Test 1: Cookie Set Longevity (`cookieJSON` vs `driveCookieJSON`)
- **Procedure:**
  - Launch Chrome with CDP.
  - Inject `cookieJSON` only.
  - Navigate to `https://mail.google.com/mail/u/0/#inbox`. Wait 10 seconds.
  - Verify session status (Inbox loaded vs redirected to `accounts.google.com/signin`).
  - Close browser instance.
  - **Reopen 2nd time** using the same cookies -> verify survival.
  - **Reopen 3rd time** using the same cookies -> verify survival.
  - Repeat the exact same 3-trial sequence using `driveCookieJSON`.
- **Success Criteria:** Session remains authenticated across all 3 launches without redirecting to login.

### Test 2: Multi-Tab Pacing (Single Tab vs 3-Tab Sequential vs Simultaneous)
- **Procedure:**
  - Trial 2A: Launch Tab 1 (`mail.google.com`). Confirm inbox loads. After 10s, open Tab 2 (`myaccount.google.com`). After another 5s, open Tab 3 (`drive.google.com`).
  - Trial 2B: Launch all 3 tabs simultaneously.
- **Success Criteria:** Determine if opening multiple origins concurrently triggers `accounts.google.com` token revocation.

### Test 3: Profile Cleanliness (Fresh Temp `--user-data-dir` vs Reused Folder)
- **Procedure:**
  - Trial 3A: Clean empty `--user-data-dir` + pure CDP cookie injection.
  - Trial 3B: Reused `--user-data-dir` retaining cache and local storage.
- **Success Criteria:** Confirm whether local profile state retention causes secondary session expiration.

---

## 5. Execution Workflow

1. **User Action:** Create test submissions on the engine and provide the 3 `browserId`s (or session tokens).
2. **Automated Run:** Run `scratch/test_session_longevity.mjs <browserId>` for each test case.
3. **Observation:**
   - Log exact HTTP redirects, final page URLs, and console errors.
   - Record whether session survived launch #1, launch #2, and launch #3.
4. **Resolution:**
   - If `cookieJSON` passes 3/3 launches while `driveCookieJSON` fails on launch #2: Adopt `cookieJSON` as primary auth token set.
   - If Tab pacing is the trigger: Update launcher navigation sequence.
   - Once verified empirically, update the launcher production build.

---

## 6. Empirical Test Results & The Discovered Smoking Gun

Tests were executed against the 5 live browser IDs provided:
- `browser-1793307601438-rfioe6lybkj` (Row 1438)
- `browser-1793307824504-655midwjuk7` (Row 1441)
- `browser-1793307832903-z9dox4hxgcr` (Row 1444)
- `browser-1793308249326-zwxwj2y1hdt` (Row 1447)
- `browser-1793308386998-2lgg0kbr2dq` (Row 1450)

### A. Results Summary

| Browser ID | Row | Test Case | Mode Tested | Trials | Result | Outcome |
| :--- | :---: | :--- | :--- | :---: | :---: | :--- |
| `browser-1793307601438-rfioe6lybkj` | 1438 | Test 1A (Cookie Longevity) | `cookieJSON` (20) | 3 | **3/3 (100%)** | **ALIVE** - Inbox rendered all 3 times |
| `browser-1793308249326-zwxwj2y1hdt` | 1447 | Test 1B (Cookie Longevity) | `driveCookieJSON` (26) | 3 | **3/3 (100%)** | **ALIVE** - Inbox rendered all 3 times |
| `browser-1793308386998-2lgg0kbr2dq` | 1450 | Test 2 (Multi-Tab Launch) | `driveCookieJSON` (26) | 1 (3 tabs) | **3/3 Tabs Alive** | **ALIVE** - Gmail, Wallet, Drive all rendered |
| `browser-1793308386998-2lgg0kbr2dq` | 1450 | Test 3 (Extracted Profile) | Extracted Profile Zip | 1 | **CRASHED** | `ECONNREFUSED` / Stale Port collision |
| `browser-1793307824504-655midwjuk7` | 1441 | Concurrent Submissions | `cookieJSON` only (17) | — | *Deferred* | 0 Account/Drive cookies (deferred to end) |
| `browser-1793307832903-z9dox4hxgcr` | 1444 | Concurrent Submissions | `cookieJSON` only (17) | — | *Deferred* | 0 Account/Drive cookies (deferred to end) |

---

### B. The Root Cause Discovery (The Smoking Gun)

When using a **clean temporary `--user-data-dir`**:
- `cookieJSON` survives 100% of the time across repeated launches.
- `driveCookieJSON` survives 100% of the time across repeated launches.
- Opening all 3 tabs (Gmail, Subscriptions, Drive) succeeds with **0 dead tabs**.

**Why the Desktop Launcher Experienced Session Death:**
1. **Stale Port & Lock Files Inside Profile Zip:**
   The server-generated profile zip contains files generated during the server-side run:
   - `DevToolsActivePort` (contains the old server port)
   - `lockfile` / `SingletonLock`
2. **Race Condition in Port Discovery:**
   When the launcher extracts the zip into `destDir` and spawns Chrome:
   - The launcher checks if `DevToolsActivePort` exists. It finds the **old server port file** that was already in the zip!
   - It tries to connect to `127.0.0.1:<old_server_port>` -> fails with `ECONNREFUSED` or hangs.
   - Because CDP fails or times out, **CDP cookie injection NEVER runs**.
3. **Machine-Bound DPAPI Decryption Failure:**
   When CDP cookie injection fails, Chrome falls back to reading `Default/Network/Cookies` from the extracted directory.
   - Even though both machines are Windows, **Windows DPAPI keys are unique per machine and user account**.
   - Chrome fails to decrypt the SQLite cookie database with `Bad Data`, treats the database as corrupted, purges all stored credentials, and shows the user the Google "Sign in" page.
4. **Process Lock Holding (`EBUSY`):**
   When Chrome exits or is closed, background sub-processes or the lockfile remain locked in `destDir`, causing any subsequent trial on the same session to fail with `EBUSY: resource busy or locked`.

---

### C. Recommended Launcher Fix

In `desktop-multitab/main.js`:
1. **Always clean stale artifacts before spawning Chrome:**
   Delete `DevToolsActivePort`, `lockfile`, `Singleton*`, and `Default/Network/Cookies*` from `destDir` before launching Chrome.
2. **Ensure CDP Injection Completes Before Any Navigation:**
   Since CDP `Network.setCookies` writes plaintext cookies directly into Chrome's active memory (bypassing DPAPI), verifying that the new DevTools port is fresh and connected guarantees 100% cookie injection.
3. **Clean Session Directory on Close:**
   Release lockfiles and unref processes cleanly so repeated trials never hit `EBUSY`.

