import axios from 'axios';
import { URLSearchParams } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import logger from "../../../../utils/logger.js"; // Corrected path relative to routeHelper.js
import { getSheetDataApi, appendSheetRowApi, updateSheetRowApi, updateHubAndProjectsFromCookieData } from '../../../api/googlesheets.js';

// --- Original App Script Data Cache and Fetchers ---
let appScriptDataCache = null;
let lastCacheUpdateTime = 0;
const cacheUpdateInterval = 4000; // 4 seconds for background updater
const SHEETS_API_MIN_INTERVAL = 5000; // 15 seconds minimum between actual Sheets API reads
let isUpdatingCache = false; // Flag to prevent multiple simultaneous updates
let currentUpdatePromise = null; // Store the promise of the ongoing update

// Internal function to fetch data and update cache
async function _fetchAndCacheAppScriptData(retries = 3, timeout = 120000, forceRefresh = false) {
  const now = Date.now();

  // If an update is already in progress, wait for it
  if (isUpdatingCache && currentUpdatePromise) {
    return await currentUpdatePromise;
  }

  // If cache is fresh enough AND forceRefresh is not true, return it immediately without hitting Sheets API
  if (!forceRefresh && appScriptDataCache && (now - lastCacheUpdateTime < SHEETS_API_MIN_INTERVAL)) {
    logger.debug("[_fetchAndCacheAppScriptData] Returning cached data (Sheets API rate limit active).");
    return appScriptDataCache;
  }

  isUpdatingCache = true;
  const fetchPromise = (async () => {
    try {
      // --- Attempt Sheets API first ---
      try {
        const sheetsApiResult = await getSheetDataApi("cookie"); // Assuming "cookie" is the sheet name
        if (sheetsApiResult.success) {
          logger.info("[_fetchAndCacheAppScriptData] Sheets API data fetched successfully.");
          appScriptDataCache = [sheetsApiResult.headers, ...sheetsApiResult.data];
          lastCacheUpdateTime = Date.now(); // Update timestamp only on successful API fetch
          return appScriptDataCache;
        } else {
          logger.warn(`[_fetchAndCacheAppScriptData] Sheets API fetch failed: ${sheetsApiResult.error}. Falling back to App Script.`);
        }
      } catch (sheetsApiError) {
        logger.error(`[_fetchAndCacheAppScriptData] Error with Sheets API fetch: ${sheetsApiError.message}. Falling back to App Script.`);
      }

      // --- Fallback to App Script ---
      const appScriptUrl = process.env.SCRIPT_URL;
      const params = new URLSearchParams({
        action: 'getCookieData',
        key: process.env.SCRIPT_KEY,
      });

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await axios.post(appScriptUrl, params, {
            timeout: timeout,
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          });

          if (!response.data || !response.data.success) {
            throw new Error(`Invalid response: ${JSON.stringify(response.data)}`);
          }

          const responseData = response.data;

          if (!responseData.headers || !responseData.data) {
            throw new Error(`Missing headers or data in response: ${JSON.stringify(responseData)}`);
          }

          appScriptDataCache = [responseData.headers, ...responseData.data];
          lastCacheUpdateTime = Date.now(); // Update timestamp only on successful API fetch
          logger.info("[_fetchAndCacheAppScriptData] App Script data cache updated successfully.");
          return appScriptDataCache; // Return the newly fetched data
        } catch (error) {
          logger.error(`[_fetchAndCacheAppScriptData] Attempt ${attempt} failed: ${error.message}`);
          if (attempt === retries) {
            throw new Error(`Failed to fetch data after ${retries} attempts.`);
          }
        }
      }
    } finally {
      isUpdatingCache = false;
      currentUpdatePromise = null; // Clear the promise after it resolves/rejects
    }
  })();

  currentUpdatePromise = fetchPromise; // Store the promise
  return await fetchPromise; // Return the promise
}

let backgroundUpdaterIntervalId = null; // New variable to hold the interval ID

// Background updater
export function startAppScriptDataBackgroundUpdater() {
  if (backgroundUpdaterIntervalId === null) {
    logger.info("[startAppScriptDataBackgroundUpdater] Starting background App Script data updater.");
    backgroundUpdaterIntervalId = setInterval(async () => {
      try {
        await _fetchAndCacheAppScriptData();
      } catch (error) {
        logger.error(`[startAppScriptDataBackgroundUpdater] Error updating cache in background: ${error.message}`);
      }
    }, cacheUpdateInterval);
  } else {
    logger.debug("[startAppScriptDataBackgroundUpdater] Background updater is already running.");
  }
}

export function stopAppScriptDataBackgroundUpdater() {
  if (backgroundUpdaterIntervalId !== null) {
    logger.info("[stopAppScriptDataBackgroundUpdater] Stopping background App Script data updater.");
    clearInterval(backgroundUpdaterIntervalId);
    backgroundUpdaterIntervalId = null;
  }
}

// Helper function to get column indexes
export function getColumnIndexes(headers) {
  const columnIndexes = headers.reduce((acc, header, index) => {
    acc[header] = index;
    return acc;
  }, {});
  return columnIndexes;
}

// Helper function to fetch data from App Script endpoint with retry logic
export async function fetchDataFromAppScript(retries = 3, timeout = 120000, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && appScriptDataCache && (now - lastCacheUpdateTime < cacheUpdateInterval)) {
    logger.debug("[fetchDataFromAppScript] Returning cached data.");
    return appScriptDataCache;
  }

  logger.debug("[fetchDataFromAppScript] Fetching fresh data (cache expired or forced refresh).");
  // Trigger a fresh fetch and return its result
  return await _fetchAndCacheAppScriptData(retries, timeout, forceRefresh);
}

// Helper function to save data back to sheets (Using browserId)
export async function updateBrowserRowData(browserId, updateObject, isNewRow = false) {
  if (!browserId) {
    throw new Error("Missing browserId for updateBrowserRowData");
  }

  const sheetName = "cookie"; // Assuming "cookie" is the sheet name for browser data
  const now = new Date();
  const lastRunTimestamp = now.toLocaleString('en-US', { timeZone: 'UTC' });

  const defaultLastJsonResponse = JSON.stringify({
    browserId,
    timestamp: now.toISOString(),
    status: updateObject.status || 'UNKNOWN',
    message: 'Default response when no specific details are available'
  });

  // Prepare data for Sheets API
  const sheetsApiUpdateMap = {
    browserId: browserId,
    lastRun: lastRunTimestamp,
    lastJsonResponse: updateObject.lastJsonResponse || defaultLastJsonResponse,
    ...updateObject
  };

  if (updateObject.cookieJSON) {
    sheetsApiUpdateMap.cookie = updateObject.cookieJSON;
    try {
      const parsedCookies = JSON.parse(updateObject.cookieJSON);
      sheetsApiUpdateMap.formattedCookie = JSON.stringify(parsedCookies, null, 2);
    } catch (parseError) {
      logger.error(`[updateBrowserRowData][${browserId}] Invalid cookieJSON: ${parseError.message}`);
      delete sheetsApiUpdateMap.formattedCookie;
    }
    delete sheetsApiUpdateMap.cookieJSON;
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
    logger.info(`[updateBrowserRowData][${browserId}] Falling back to App Script for update.`);
    const appScriptUrl = process.env.SCRIPT_URL;
    const maxRetries = 3;
    const retryDelay = 2000; // 2 seconds delay between retries

    const params = new URLSearchParams({
      action: 'setCookieData',
      browserId: browserId,
      key: process.env.SCRIPT_KEY,
      lastRun: lastRunTimestamp,
      lastJsonResponse: updateObject.lastJsonResponse || defaultLastJsonResponse,
      ...updateObject
    });

    if (isNewRow) {
      params.set('newRow', 'true');
    }

    if (updateObject.cookieJSON) {
      params.set('cookie', updateObject.cookieJSON);
      try {
        const parsedCookies = JSON.parse(updateObject.cookieJSON);
        params.set('formattedCookie', JSON.stringify(parsedCookies, null, 2));
      } catch (parseError) {
        logger.error(`[updateBrowserRowData][${browserId}] Invalid cookieJSON for App Script: ${parseError.message}`);
        params.delete('formattedCookie');
      }
      params.delete('cookieJSON');
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
        // No longer returning here, let's continue to the common log and trigger
        // return response.data;
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
      // Do not await this call to avoid blocking the current response
      updateHubAndProjectsFromCookieData(browserId, updateObject.status).catch(error => {
        logger.error(`[updateBrowserRowData][${browserId}] Error triggering updateHubAndProjectsFromCookieData: ${error.message}`);
      });
    } else {
      logger.debug(`[updateBrowserRowData][${browserId}] Condition not met to trigger updateHubAndProjectsFromCookieData. Status: '${updateObject.status}'.`);
    }
  }
  // If we reached here, it means either Sheets API succeeded or App Script fallback succeeded.
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

// startAppScriptDataBackgroundUpdater(); // Removed direct call, will be managed by route.js
