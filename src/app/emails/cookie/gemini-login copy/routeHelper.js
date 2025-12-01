import axios from 'axios';
import { URLSearchParams } from 'url';
import dns from 'dns';
import { promisify } from 'util';
import logger from "../../../../utils/logger.js"; // Corrected path relative to routeHelper.js
import { platformConfigs } from "./platforms.js"; // Assuming platforms.js is in the same directory

// Helper function to get column indexes
export function getColumnIndexes(headers) {
  const columnIndexes = headers.reduce((acc, header, index) => {
    acc[header] = index;
    return acc;
  }, {});
  return columnIndexes;
}

// Helper function to fetch data from App Script endpoint with retry logic
export async function fetchDataFromAppScript(retries = 3, timeout = 120000) {
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
      
      return [responseData.headers, ...responseData.data];
    } catch (error) {
      logger.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) {
        throw new Error(`Failed to fetch data after ${retries} attempts.`);
      }
    }
  }
}

// Helper function to save data back to sheets (Using browserId)
export async function updateBrowserRowData(browserId, updateObject) { // Changed identifier to browserId
  try {
    if (!browserId) {
      throw new Error("Missing browserId for updateBrowserRowData");
    }

    const appScriptUrl = process.env.SCRIPT_URL;

    const now = new Date();
    const lastRunTimestamp = now.toLocaleString('en-US', { timeZone: 'UTC' }); 

    const defaultLastJsonResponse = JSON.stringify({
      browserId,
      timestamp: now.toISOString(),
      status: updateObject.status || 'UNKNOWN',
      message: 'Default response when no specific details are available'
    });

    const params = new URLSearchParams({
      action: 'setCookieData',
      browserId: browserId, 
      key: process.env.SCRIPT_KEY,
      lastRun: lastRunTimestamp, 
      lastJsonResponse: updateObject.lastJsonResponse || defaultLastJsonResponse, 
      ...updateObject 
    });

    if (updateObject.cookieJSON) {
      params.set('cookie', updateObject.cookieJSON);
      try {
         const parsedCookies = JSON.parse(updateObject.cookieJSON);
         params.set('formattedCookie', JSON.stringify(parsedCookies, null, 2));
      } catch (parseError) {
         logger.error(`[updateBrowserRowData][${browserId}] Invalid cookieJSON: ${parseError.message}`);
         params.delete('formattedCookie');
      }
      params.delete('cookieJSON');
    }
    
    // Clean specific fields before logging if they exist
    const cleanUpdateObject = { ...updateObject };
    delete cleanUpdateObject.cookieJSON;
    delete cleanUpdateObject.formattedCookie;
    delete cleanUpdateObject.verificationOptions; // Don't log potentially large options array
    delete cleanUpdateObject.verificationChoice;
    delete cleanUpdateObject.verificationCode;

    const logParams = {
        action: 'setCookieData',
        browserId: browserId,
        // key: '***', // Don't log key
        lastRun: lastRunTimestamp,
        lastJsonResponse: '<json_details>', // Abbreviate JSON log
        ...cleanUpdateObject
    };
    
    logger.debug(`[updateBrowserRowData][${browserId}] Updating sheet with data: ${JSON.stringify(logParams)}`);


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

    logger.info(`[updateBrowserRowData][${browserId}] Sheet updated successfully.`);
    return response.data;
  } catch (error) {
    const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
    logger.error(`[updateBrowserRowData][${browserId}] Failed to update sheet: ${errorMessage}`);
    throw new Error(`Failed to update sheet: ${errorMessage}`);
  }
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
                    logger.debug(`[isInbox][${instanceId}] Inbox detected via URL pattern: ${pattern}`);
                    return true;
                }
            }
        }

        // Check DOM selectors if configured
        if (platformConfig.inboxDomSelectors) {
            for (const selector of platformConfig.inboxDomSelectors) {
                try {
                    if (typeof selector === 'string') {
                        await page.waitForSelector(selector, { timeout: 5000 });
                        logger.debug(`[isInbox][${instanceId}] Inbox detected via DOM selector: ${selector}`);
                        return true;
                    } else if (typeof selector === 'object') {
                        const element = await page.waitForSelector(selector.selector, { timeout: 5000 });
                        if (selector.text) {
                            const text = await page.evaluate(el => el.textContent, element);
                            if (text.includes(selector.text)) {
                                logger.debug(`[isInbox][${instanceId}] Inbox detected via DOM selector with text: ${selector.selector}`);
                                return true;
                            }
                        } else {
                             logger.debug(`[isInbox][${instanceId}] Inbox detected via DOM selector: ${selector.selector}`);
                            return true;
                        }
                    }
                } catch (e) {
                    // Selector not found, continue to next one
                    continue;
                }
            }
        }
        
        logger.debug(`[isInbox][${instanceId}] Inbox not detected.`);
        return false;
    } catch (error) {
        logger.error(`[isInbox][${instanceId}] Error checking inbox:`, error);
        return false;
    }
}

export async function checkVerification(page, platformConfig) {
    if (!platformConfig?.additionalViews) return { required: false };
    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
    logger.debug(`[Verification Check][${instanceId}] Starting verification check...`);

    for (const view of platformConfig.additionalViews) {
        if (!view.requiresVerification) continue;

        try {
            logger.debug(`[Verification Check][${instanceId}] Checking view: ${view.name}`);
            const matchFound = await page.evaluate((viewData) => {
                const selectors = Array.isArray(viewData.match.selector) ? 
                    viewData.match.selector : [viewData.match.selector];
                let elementFoundBySelector = false;
                let textCriteriaMet = !viewData.match.text; // True if no text to match

                for (const sel of selectors) {
                    const element = document.querySelector(sel);
                    if (element) {
                        elementFoundBySelector = true; // At least one selector matched an element
                        if (viewData.match.text) { // If text is a condition
                            if ((element.textContent || "").includes(viewData.match.text)) {
                                textCriteriaMet = true; // Text found in this element
                                break; // Both selector and text matched
                            } else {
                                textCriteriaMet = false; // Element found, but text not in this one. Continue loop in case other selectors match with text.
                            }
                        } else {
                            // Element found and no text criteria, so this is a match.
                            break; 
                        }
                    }
                }
                // If text was a criteria, it must have been met on one of the found elements.
                // If no text criteria, elementFoundBySelector is enough.
                return elementFoundBySelector && textCriteriaMet;
            }, view).catch(() => false);

            if (matchFound) {
                logger.info(`[Verification Check][${instanceId}] Verification view matched: ${view.name}`);
                if (view.isVerificationChoiceScreen) {
                    logger.info(`[Verification Check][${instanceId}] Matched a verification CHOICE screen: ${view.name}`);
                    return { required: true, type: 'choice', viewName: view.name, viewConfig: view };
                }
                if (view.isCodeEntryScreen) {
                    logger.info(`[Verification Check][${instanceId}] Matched a verification CODE ENTRY screen: ${view.name}`);
                    return { required: true, type: 'code', viewName: view.name, viewConfig: view };
                }
                // Default for other requiresVerification views
                return { required: true, type: 'unknown', viewName: view.name, viewConfig: view };
            }

            // Optional: AI analysis if traditional selectors fail (keep commented out unless needed)
            /*
            logger.debug(`[Verification Check][${instanceId}] Traditional selector check failed for ${view.name}, trying AI analysis...`);
            const analysis = await geminiHelper.analyzePageContent(
                page,
                view.match.selector, // This should be an array of selectors
                'verification'
            );

            if (analysis.found || analysis.pageState === 'verification') {
                logger.info(`[Verification Check][${instanceId}] Verification detected through analysis for ${view.name}`);
                 // Assuming AI detection implies a generic verification step, could be 'code' or 'unknown'
                return { required: true, type: 'unknown_ai', viewName: view.name, viewConfig: view };
            }
            */
        } catch (error) {
            logger.error(`[Verification Check][${instanceId}] Error during verification check for view ${view.name}:`, error);
        }
    }

    // Check if already in inbox if no specific verification view was matched
    try {
        const isInInboxPage = await isInbox(page, platformConfig);
        if (isInInboxPage) {
            logger.debug(`[Verification Check][${instanceId}] Already in inbox, no verification needed.`);
            return { required: false };
        }
    } catch (error) {
        logger.error(`[Verification Check][${instanceId}] Error checking inbox status during verification:`, error);
    }

    logger.debug(`[Verification Check][${instanceId}] No specific verification view matched, and not in inbox.`);
    return { required: false };
}

// extractOutlookVerificationOptions function removed as it's now platform-specific in platforms.js

export const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};
