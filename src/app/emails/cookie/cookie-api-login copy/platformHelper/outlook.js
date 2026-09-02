import logger from "../../../../../utils/logger.js";

// ── Outlook Service Error Detection ──────────────────────────────────────────
// Extracted from processRow WAITINGOPTIONS in route.js (lines 4355-4385).
// Detects "There's a temporary problem with the service." after clicking Send Code.

/**
 * Checks if the Outlook service error message is present on the page.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
export async function detectServiceError(page) {
    const outlookServiceErrorText = "There's a temporary problem with the service.";
    return page.evaluate((errorText) => {
        return document.body.innerText.includes(errorText);
    }, outlookServiceErrorText).catch(() => false);
}

// ── Microsoft URL Stabilization ──────────────────────────────────────────────
// Extracted from checkAccountAccess in route.js (lines 1083-1101).
// Microsoft resolves email submission asynchronously — the page may bounce through
// sso_reload=true, a common/login hand-off, or login.live.com oauth20_authorize.srf.
// Waits for the URL to stabilize (same URL for ~3s) before further state detection.

/**
 * Waits for the page URL to stabilize after a Microsoft email submission.
 * @param {import('puppeteer').Page} page
 * @param {string} instanceId
 * @param {number} [maxWaitMs=15000] - Maximum time to wait for stabilization
 * @returns {Promise<string>} The final stabilized URL
 */
export async function waitForUrlStabilize(page, instanceId, maxWaitMs = 15000) {
    const urlStableDeadline = Date.now() + maxWaitMs;
    let lastUrl = page.url();
    let stableForMs = 0;
    while (Date.now() < urlStableDeadline && stableForMs < 3000) {
        const probeUrl = page.url();
        if (probeUrl === lastUrl) {
            stableForMs += 800;
        } else {
            lastUrl = probeUrl;
            stableForMs = 0;
            logger.debug(`[checkAccountAccess][${instanceId}] Post-email URL transitioned to: ${probeUrl}`);
        }
        if (stableForMs >= 3000) break;
        await new Promise(res => setTimeout(res, 800));
    }
    await Promise.race([
        page.waitForFunction(() => document.readyState === 'complete').catch(() => null),
        new Promise(res => setTimeout(res, 3000))
    ]);
    return page.url();
}

// ── Microsoft Login Host Detection ───────────────────────────────────────────
// Extracted from processRow WAITINGPASSWORD in route.js (lines 3209-3236).
// Pure function to check if a URL belongs to a Microsoft login host.

const MICROSOFT_LOGIN_HOSTS = ['login.live.com', 'login.microsoftonline.com'];

/**
 * Checks if the given URL is on a Microsoft login host.
 * @param {string} url
 * @returns {boolean}
 */
export function isOnMicrosoftLoginHost(url) {
    if (!url) return false;
    return MICROSOFT_LOGIN_HOSTS.some(host => url.includes(host));
}

// ── Outlook Tab Whitelist ────────────────────────────────────────────────────
// These domains are allowed to open new tabs without being auto-closed.
// Extracted from processRow browser setup in route.js (lines 2394-2404).

export const MICROSOFT_TAB_WHITELIST = [
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
