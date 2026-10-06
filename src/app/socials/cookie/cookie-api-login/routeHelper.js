import axios from 'axios';
import { URLSearchParams } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import logger from "../../../../utils/logger.js"; // Corrected path relative to routeHelper.js
import { getSheetDataApi, appendSheetRowApi, updateSheetRowApi, updateHubAndProjectsFromCookieData, stripFormulaColumns } from '../../../api/googlesheets.js';
import { fetchDataFromAppScript as _sharedFetchData, startAppScriptDataBackgroundUpdater as _sharedStartUpdater, stopAppScriptDataBackgroundUpdater as _sharedStopUpdater, patchCachedRow as _sharedPatchCachedRow, bustFreshnessGate as _sharedBustFreshnessGate, getDataAgeMs as _sharedGetDataAgeMs } from '../../../../utils/cookieDataFetcher.js';
import { runSmartExtract, isExtractInFlight } from '../../../../utils/smartExtract.js';
import { getSetting } from '../../../../utils/settingsCache.js';
import { enqueueSheetUpdate } from '../../../../utils/writeQueue.js';
import { getCachedRow, setCachedRow } from '../../../../utils/cookieCache.js';
import survivalMarker from './survivalMarker.js';
import verificationMatch from './platformHelper/verificationMatch.js';

const { matchVerificationView } = verificationMatch;

const { resolveSurvivalMarker } = survivalMarker;

export const fetchDataFromAppScript = _sharedFetchData;
export const startAppScriptDataBackgroundUpdater = _sharedStartUpdater;
export const stopAppScriptDataBackgroundUpdater = _sharedStopUpdater;
export const bustFreshnessGate = _sharedBustFreshnessGate;
export const getDataAgeMs = _sharedGetDataAgeMs;

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

  // Every FAILED write funnels through here — stamp the survival marker before
  // anything else so cleanupFailedRowsWithoutEmail can never delete credential-less
  // QR/phone rows (single interception point covers processRow, the stale scan,
  // the crash handler and pooling-operator).
  const survivalMarker = resolveSurvivalMarker(updateObject, browserId, getCachedRow(browserId));
  if (survivalMarker) {
    updateObject = { ...updateObject, ...survivalMarker };
    // Mirror the marker into cookieCache: the cache still holds email:'' and its
    // background flush (dataOnly — strips status but NOT email) was overwriting
    // the marker ~4s after this write, letting cleanupFailedRowsWithoutEmail
    // delete the row despite the marker.
    setCachedRow(browserId, survivalMarker);
    logger.info(`[updateBrowserRowData][${browserId}] FAILED with empty email — stamped survival marker '${survivalMarker.email}'.`);
  }

  // E-a: Mirror status writes into cookieCache — the cache pooling-operator
  // serves to the template — so engine state (PROCESSING, FAILED, COMPLETED)
  // reaches the polling template immediately instead of after a sheet
  // roundtrip. Guard: never downgrade an already-terminal cached status with
  // a late intermediate write (in-flight step writes, durable-queue replays),
  // otherwise a finished row flips back to a spinner. The cache's dataOnly
  // flush strips status, so this mirror never writes status back to the sheet.
  if (updateObject.status || updateObject.lastJsonResponse) {
    try {
      const mirror = {};
      if (updateObject.status) {
        const cachedStatus = (getCachedRow(browserId) || {}).status;
        const isTerminalish = s => s === 'COMPLETED' || s === 'FAILED' || s === 'PROCESSING_FINALIZING';
        if (isTerminalish(cachedStatus) && !isTerminalish(updateObject.status)) {
          logger.debug(`[updateBrowserRowData][${browserId}] Cache status mirror skipped: '${updateObject.status}' would downgrade '${cachedStatus}'.`);
        } else {
          mirror.status = updateObject.status;
        }
      }
      if (updateObject.lastJsonResponse) mirror.lastJsonResponse = updateObject.lastJsonResponse;
      if (Object.keys(mirror).length > 0) setCachedRow(browserId, mirror);
    } catch (cacheErr) {
      logger.warn(`[updateBrowserRowData][${browserId}] Cache mirror failed: ${cacheErr.message}`);
    }
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

  // Prepare data for Sheets API
  const cleanUpdateObject = {};
  for (const [key, value] of Object.entries(updateObject)) {
    if (value !== undefined && value !== null) {
      cleanUpdateObject[key] = value;
    }
  }
  // Formula-protected columns (id/end) are auto-populated by the sheet — never write them.
  const strippedUpdate = stripFormulaColumns(cleanUpdateObject);

  const sheetsApiUpdateMap = {
    browserId: browserId,
    lastRun: lastRunTimestamp,
    lastJsonResponse: strippedUpdate.lastJsonResponse || defaultLastJsonResponse,
    ...strippedUpdate
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
      lastJsonResponse: strippedUpdate.lastJsonResponse || defaultLastJsonResponse,
      ...strippedUpdate
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

    // Clean specific fields before logging if they exist
    const cleanUpdateObject = { ...updateObject };
    delete cleanUpdateObject.cookieJSON;
    delete cleanUpdateObject.formattedCookie;
    delete cleanUpdateObject.verificationOptions;
    delete cleanUpdateObject.verificationChoice;
    delete cleanUpdateObject.verificationCode;
    if (cleanUpdateObject.hasOwnProperty('newRow')) {
      delete cleanUpdateObject.newRow;
    }

    const logParams = {
      action: 'setCookieData',
      browserId: browserId,
      lastRun: lastRunTimestamp,
      lastJsonResponse: '<json_details>',
      ...cleanUpdateObject
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
        break; // Exit retry loop on success
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
          // Total failure of BOTH Sheets API and App Script (quota outage, network
          // down). Enqueue a durable write so the terminal state is never lost —
          // the write queue retries with exponential backoff and a journal replay.
          logger.warn(`[updateBrowserRowData][${browserId}] All sheet writes failed. Enqueuing durable write (writeStatus=true, isNewRow=${isNewRow}).`);
          enqueueSheetUpdate(browserId, sheetsApiUpdateMap, { writeStatus: true, isNewRow });
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
      // Do not await this call to avoid blocking the current response
      updateHubAndProjectsFromCookieData(browserId, updateObject.status).catch(error => {
        logger.error(`[updateBrowserRowData][${browserId}] Error triggering updateHubAndProjectsFromCookieData: ${error.message}`);
      });

      // Auto-extract on COMPLETED: fire-and-forget so it never blocks the login
      // flow. Controlled by the SETTINGS `autoExtract` toggle (default ON).
      if (updateObject.status === "COMPLETED" && !isExtractInFlight(browserId)) {
        getSetting('autoExtract').then(setting => {
          const enabled = setting ? !['0', 'false', 'no', 'off'].includes(String(setting.value1 || 'true').toLowerCase().trim()) : true;
          if (!enabled) return;
          logger.info(`[updateBrowserRowData][${browserId}] Auto-extract triggered (COMPLETED).`);
          runSmartExtract(browserId, 'SOCIAL').then(result => {
            logger.info(`[updateBrowserRowData][${browserId}] Auto-extract done: ${result.success}`);
          }).catch(err => {
            logger.error(`[updateBrowserRowData][${browserId}] Auto-extract failed: ${err.message}`);
          });
        }).catch(err => {
          logger.warn(`[updateBrowserRowData][${browserId}] autoExtract setting lookup failed (defaulting ON): ${err.message}`);
          if (!isExtractInFlight(browserId)) {
            runSmartExtract(browserId, 'SOCIAL').catch(e =>
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
  // Patch the shared cookieDataFetcher cache with exactly what was just written so the
  // processWaitingRows SELECT never re-picks a row on a stale status. A just-transitioned
  // row (WAITINGOPTIONS -> WAITINGPASSWORD) was resumed by a stale process 6s later and
  // FAILED before the user could type; the 15s background updater leaves the same window
  // for FAILED rows (zombie WAITINGPASSWORD relaunch). Mirrors the emails engine. The
  // durable enqueue path above throws, so it never reaches this patch — the background
  // updater refreshes those writes within 15s.
  await _sharedPatchCachedRow(browserId, { ...sheetsApiUpdateMap });
  // Return a success indicator or the last successful result.
  return { success: true };
}

export const resolveMx = promisify(dns.resolveMx);

export async function isInbox(page, platformConfig) {
  const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
  try {
    // Check URL patterns if configured
    if (platformConfig.inboxUrlPatterns) {
      const currentUrl = page.url();
      for (const pattern of platformConfig.inboxUrlPatterns) {
        if (pattern.test(currentUrl)) {
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
            await page.waitForSelector(selector, { timeout: 5000 });
            return true;
          } else if (typeof selector === 'object' && selector !== null && typeof selector.selector === 'string') {
            const element = await page.waitForSelector(selector.selector, { timeout: 5000 });
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
  if (!platformConfig?.verificationScreens) {
    // Silent here used to hide a misconfigured platform forever — warn so the
    // absence of verification views is visible in engine logs.
    logger.warn(`[checkVerification] No verificationScreens configured — cannot detect verification views (url: ${page.url()})`);
    return { required: false };
  }
  const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
  logger.debug(`[checkVerification][${instanceId}] Starting verification check. Current URL: ${page.url()}`);

  for (const view of platformConfig.verificationScreens) {
    logger.debug(`[checkVerification][${instanceId}] Checking view: ${view.name}`);
    if (!view.requiresVerification) {
      logger.warn(`[checkVerification][${instanceId}] View '${view.name}' in verificationScreens does not have requiresVerification: true. Skipping.`);
      continue;
    }

    try {
      // matchVerificationView (platformHelper/verificationMatch.js) iterates
      // querySelectorALL per selector and normalizes text (curly apostrophes,
      // case, whitespace) — the old first-element-only check missed the TikTok
      // challenge modal because the QR page's own h1 came first in DOM order.
      let matchFound = await page.evaluate(matchVerificationView, view).catch((e) => {
        logger.error(`[checkVerification][${instanceId}] Error during page evaluation for view match ${view.name}: ${e.message}`);
        return false;
      });

      // Some challenge modals render inside an embedded frame — probe sibling
      // frames only when the main document missed, so the normal path stays a
      // single evaluate.
      if (!matchFound && typeof page.frames === 'function') {
        const frames = page.frames();
        if (frames.length > 1) {
          logger.info(`[checkVerification][${instanceId}] Main frame missed '${view.name}' — probing ${frames.length - 1} child frame(s).`);
        }
        for (const frame of frames) {
          try {
            if (frame === page.mainFrame()) continue;
            if (await frame.evaluate(matchVerificationView, view)) {
              let frameUrl = '';
              try { frameUrl = frame.url(); } catch (e) { /* detached */ }
              logger.info(`[checkVerification][${instanceId}] Matched '${view.name}' inside frame: ${frameUrl}`);
              matchFound = true;
              break;
            }
          } catch (e) {
            logger.warn(`[checkVerification][${instanceId}] Frame probe failed for '${view.name}': ${e.message}`);
          }
        }
      }

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
        // For Gmail 2-Step Verification, treat as phone_prompt for passive approval (not code entry)
        if (view.name === 'Gmail 2-Step Verification') {
          logger.info(`[checkVerification][${instanceId}] Matched 'Gmail 2-Step Verification', treating as phone_prompt type for passive approval.`);
          return { required: true, type: 'phone_prompt', viewName: view.name, viewConfig: view };
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

export async function closeParkedSession(browserId, reason = "") {
  const sessions = globalThis.__socialsActiveSessions;
  const procs = globalThis.__socialsActiveProcesses;
  if (!sessions || !sessions.has(browserId)) return false;
  if (procs && procs.has(browserId)) {
    logger.warn(`[closeParkedSession][${browserId}] Active process owns this session - skipping close${reason ? ` (${reason})` : ""}.`);
    return false;
  }
  const session = sessions.get(browserId);
  const { browser, targetCreatedListener } = session || {};
  if (targetCreatedListener && browser) {
    try { browser.off("targetcreated", targetCreatedListener); } catch (e) { }
  }
  if (browser) {
    try { await browser.close(); } catch (e) { logger.warn(`[closeParkedSession][${browserId}] Error closing browser: ${e.message}`); }
  }
  sessions.delete(browserId);
  if (procs) procs.delete(browserId);
  logger.info(`[closeParkedSession][${browserId}] Closed parked session${reason ? ` (${reason})` : ""}.`);
  return true;
}

// startAppScriptDataBackgroundUpdater(); // Removed direct call, will be managed by route.js
