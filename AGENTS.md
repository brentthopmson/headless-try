## CAPTCHA Handling Plan (deferred)

### Goal
When Gmail shows a "Verify it's you" CAPTCHA during login, take a screenshot, save it to Drive, let the user view and answer via the template, then resume the session.

### New state: `WAITINGCAPTCHA`

### Files to modify

#### 1. `src/app/api/googledrive.mjs`
- Add `uploadImageToDrive(base64String, fileName, parentFolderId)` — decodes base64, uploads as PNG to Drive, returns URL

#### 2. `src/app/emails/cookie/cookie-api-login/route.js` — 8 insertion points
| # | Lines | Change |
|---|-------|--------|
| 1 | 2414-2429 | Replace CAPTCHA_FAILED handler: screenshot → Drive upload → set `updateData.captcha = driveUrl` → status `WAITINGCAPTCHA` → write sheet → return |
| 2 | ~1991 | New `else if (status === "WAITINGCAPTCHA")` block: poll for `captchaAnswer`, type into visible input, click verify, re-run `checkAccountAccess()` |
| 3 | 2575 | Add `WAITINGCAPTCHA` to options save condition |
| 4 | 2671 | Add `WAITINGCAPTCHA` to browser keep-alive list |
| 5 | 2681 | Exclude `WAITINGCAPTCHA` from reused-session close |
| 6 | 2845 | Add to `processableStatuses` |
| 7 | 2846 | Already included via spread from `processableStatuses` |
| 8 | 3263 | Add to POST route keep-alive condition |

#### 3. `WebFixx-Hoo/google-apps-script/LINKS.js` — 4 insertion points
| # | Lines | Change |
|---|-------|--------|
| 1 | 943 | Add `WAITINGCAPTCHA` to `scanAndMarkStaleRowsAppScript` processableStates |
| 2 | 1723 | Add to `poolingOperator` processableStates |
| 3 | 1794 | Destructure `captchaAnswer` from params |
| 4 | ~1849 | Add `case 'captchaAnswer'` to updateProcess switch |

#### 4. `adobe-sererless.html` — 4 insertion points
| # | Lines | Change |
|---|-------|--------|
| 1 | ~618 | Add CAPTCHA HTML elements after verificationCodeGroup div |
| 2 | ~839 | Add `case 'WAITINGCAPTCHA'` in `updateUIForStatus` |
| 3 | ~1178 | Add `else if (currentStatus === 'WAITINGCAPTCHA')` in `handleFormSubmission` |
| 4 | ~913 | Add captcha error to `hideAllErrors()` |

### Sheet columns needed
- `captcha` — Drive URL of CAPTCHA screenshot (set by engine)
- `captchaAnswer` — user's submitted answer (set by template)

### Template rendering
- CAPTCHA appears under the email input field
- Password field hidden when CAPTCHA state is active
- User sees the image, types answer, submits

### Data flow
```
Gmail CAPTCHA → checkAccountAccess() returns CAPTCHA_FAILED
  → handler: screenshot + Drive upload → updateData.captcha = URL
  → status = WAITINGCAPTCHA → browser stays alive
  → template polls → shows CAPTCHA image
  → user submits captchaAnswer → polling loop catches it
  → types into visible input → clicks verify → re-checks
  → if passed → continue login | if still CAPTCHA → loop
```
