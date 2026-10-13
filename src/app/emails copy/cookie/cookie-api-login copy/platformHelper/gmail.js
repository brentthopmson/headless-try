import logger from "../../../../../utils/logger.js";
import { checkVerification, isInbox, detectGmailEmailError } from '../routeHelper.js';
import { solveImageCaptcha } from '../routeHelper.js';
import { solveRecaptchaV2 } from '../routeHelper.js';
import { solveRecaptchaChallengeWithAI } from '../routeHelper.js';
import { notifyTeam } from "../../../../utils/notifyTeam.js";

// ── Gmail CAPTCHA Handling ───────────────────────────────────────────────────
// Extracted from checkAccountAccess in route.js (lines 1137-1259).
// Handles image CAPTCHA solving + reCAPTCHA Enterprise detection + AI/API solver fallback.

/**
 * Handles CAPTCHA challenges specific to Gmail login flow.
 * @param {object} opts
 * @param {import('puppeteer').Page} opts.page
 * @param {object} opts.platformConfig - Gmail platform config from platforms.js
 * @param {string} opts.instanceId
 * @param {string} opts.platform - 'gmail'
 * @param {string} opts.email
 * @param {string} opts.browserId
 * @returns {Promise<{ok: true} | {ok: false, verificationState: string, emailExists: boolean, accountAccess: boolean, reachedInbox: boolean, requiresVerification: boolean}>}
 */
export async function handleCaptcha({ page, platformConfig, instanceId, platform, email, browserId }) {
    // ── Detect "Couldn't find this account" error (Gmail only) ──
    // Uses URL-based detection instead of DOM querySelector (shadow DOM blocks it).
    const emailErrCheck = await detectGmailEmailError(page, instanceId).catch(() => ({ found: false }));
    if (emailErrCheck.found) {
        logger.info(`[checkAccountAccess][${instanceId}] Email error detected (handleCaptcha): "${emailErrCheck.message}"`);
        return { ok: false, emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: null, message: emailErrCheck.message };
    }

    // Image CAPTCHA solving with retry loop
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

        const stillHasCaptcha = await page.$('#captchaimg').catch(() => null);

        // Email error takes priority — "Couldn't find this account" appears
        // alongside CAPTCHA but is NOT a wrong-CAPTCHA-answer signal.
        // Use URL-based detection (shadow DOM blocks querySelector).
        const emailErrDuringCaptcha = await detectGmailEmailError(page, instanceId).catch(() => ({ found: false }));
        if (emailErrDuringCaptcha.found) {
            logger.info(`[checkAccountAccess][${instanceId}] Email error detected during CAPTCHA: "${emailErrDuringCaptcha.message}". Returning emailExists=false.`);
            return { ok: false, emailExists: false, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: null, message: emailErrDuringCaptcha.message };
        }
        if (stillHasCaptcha) {
            // CAPTCHA answer was wrong (no email error) → retry
            logger.warn(`[checkAccountAccess][${instanceId}] CAPTCHA answer was incorrect (attempt ${captchaAttempt + 1}/${maxCaptchaRetries}). Retrying...`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        logger.info(`[checkAccountAccess][${instanceId}] Text image CAPTCHA solved successfully.`);
        imageCaptchaHandled = true;
        await new Promise(r => setTimeout(r, 2000));
        break;
    }

    // After image CAPTCHA loop, check for reCAPTCHA (Google may show both)
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

            // If still on challenge page, try AI solver first
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
                        return { ok: false, emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
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

    // Check for verification screens after CAPTCHA
    const verificationAfterEmail = await checkVerification(page, platformConfig);
    if (verificationAfterEmail.required) {
        logger.info(`[checkAccountAccess][${instanceId}] Verification screen detected after email submission: ${verificationAfterEmail.viewName}`);
        if (verificationAfterEmail.type === 'captcha') {
            logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA detected via checkVerification. Attempting to solve...`);
            const recaptchaSolved = await solveRecaptchaV2(page, instanceId);
            if (recaptchaSolved) {
                logger.info(`[checkAccountAccess][${instanceId}] reCAPTCHA solved successfully. Continuing...`);
                await new Promise(res => setTimeout(res, 3000));
            } else {
                logger.error(`[checkAccountAccess][${instanceId}] reCAPTCHA solve failed.`);
                notifyTeam({ type: 'CAPTCHA_FAILED', platform, email, browserId, url: page.url(), detail: 'reCAPTCHA solve failed' });
                return { ok: false, emailExists: true, accountAccess: false, reachedInbox: false, requiresVerification: false, verificationState: 'CAPTCHA_FAILED' };
            }
        } else if (verificationAfterEmail.type === 'choice' && typeof platformConfig.extractVerificationOptions === 'function') {
            const options = await platformConfig.extractVerificationOptions(page, platformConfig, verificationAfterEmail.viewName);
            return { ok: false, emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true, verificationState: 'WAITING_OPTIONS', verificationOptions: options, viewName: verificationAfterEmail.viewName };
        } else {
            return { ok: false, emailExists: true, accountAccess: true, reachedInbox: false, requiresVerification: true, verificationState: 'WAITING_CODE', viewName: verificationAfterEmail.viewName };
        }
    }

    return { ok: true };
}

// ── Gmail Post-Option-Click Handler ──────────────────────────────────────────
// Extracted from processRow WAITINGOPTIONS in route.js (lines 4261-4336).
// After clicking a Gmail verification option, determines what happened next.

/**
 * Handles the result of clicking a Gmail verification option.
 * @param {object} opts
 * @param {import('puppeteer').Page} opts.page
 * @param {string} opts.browserId
 * @param {string} opts.instanceId
 * @param {object} opts.platformConfig
 * @param {string[]} opts.currentVerificationOptions
 * @param {string} opts.lastJsonResponseStr - JSON string of current lastJsonResponse
 * @returns {Promise<{action: 'break'|'continue'|'refresh', finalStatus?: string, updateData?: object, currentVerificationOptions?: string[]}>}
 */
export async function handlePostOptionClick({ page, browserId, instanceId, platformConfig, currentVerificationOptions, lastJsonResponseStr }) {
    logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail option clicked. Waiting for page transition.`);
    await new Promise(res => setTimeout(res, 3000));

    const postClickVerification = await checkVerification(page, platformConfig);

    if (postClickVerification.required && postClickVerification.type === 'code') {
        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail transitioned to code entry: ${postClickVerification.viewName}. Setting WAITINGCODE.`);
        const ljpGmail = JSON.parse(lastJsonResponseStr || '{}');
        return {
            action: 'break',
            finalStatus: 'WAITINGCODE',
            updateData: {
                status: 'WAITINGCODE',
                verificationChoice: '',
                lastJsonResponse: JSON.stringify({
                    ...ljpGmail,
                    status: 'WAITING_CODE',
                    verificationState: 'WAITING_CODE',
                    viewName: postClickVerification.viewName,
                    verificationOptions: currentVerificationOptions,
                    message: 'Verification code screen reached.'
                })
            }
        };
    }

    if (postClickVerification.required && postClickVerification.type === 'text_input') {
        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail transitioned to text input: ${postClickVerification.viewName}. Setting WAITINGRECOVERYEMAIL.`);
        return {
            action: 'break',
            finalStatus: 'WAITINGRECOVERYEMAIL',
            updateData: {
                status: 'WAITINGRECOVERYEMAIL',
                verificationChoice: '',
                lastJsonResponse: JSON.stringify({
                    ...JSON.parse(lastJsonResponseStr || '{}'),
                    status: 'WAITING_RECOVERY_EMAIL',
                    verificationState: 'WAITING_RECOVERY_EMAIL',
                    viewName: postClickVerification.viewName,
                    verificationOptions: currentVerificationOptions,
                    message: 'Recovery email confirmation screen reached.'
                })
            }
        };
    }

    if (postClickVerification.required && postClickVerification.type === 'choice') {
        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail still on choice page after click (e.g. account_recovery). Refreshing options.`);
        const refreshedOptions = await platformConfig.extractVerificationOptions(page, platformConfig, postClickVerification.viewName);
        return {
            action: 'refresh',
            updateData: {
                status: 'WAITINGOPTIONS',
                verificationChoice: '',
                verificationOptions: JSON.stringify(refreshedOptions),
                lastJsonResponse: JSON.stringify({
                    ...JSON.parse(lastJsonResponseStr || '{}'),
                    status: 'WAITING_OPTIONS',
                    viewName: postClickVerification.viewName,
                    verificationOptions: refreshedOptions,
                    message: 'Selections refreshed.'
                })
            },
            currentVerificationOptions: refreshedOptions
        };
    }

    // No verification required — check if we reached inbox
    const gmailInbox = await isInbox(page, platformConfig).catch(() => false);
    if (gmailInbox) {
        logger.info(`[processRow][${browserId}][WAITINGOPTIONS] Gmail reached inbox after option click.`);
        return { action: 'break', finalStatus: 'PROCESSING_FINALIZING' };
    }

    logger.warn(`[processRow][${browserId}][WAITINGOPTIONS] Gmail option click: unexpected page state. Continuing poll.`);
    return {
        action: 'continue',
        updateData: {
            status: 'WAITINGOPTIONS',
            verificationChoice: '',
            lastJsonResponse: JSON.stringify({
                ...JSON.parse(lastJsonResponseStr || '{}'),
                status: 'WAITING_OPTIONS',
                message: 'Unexpected state after option click.'
            })
        }
    };
}
