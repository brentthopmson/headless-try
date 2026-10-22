import logger from '../../../utils/logger.js';
import { DOMHelpers } from '../../socials/_shared/routeHelper.js';
import { applyIdentityToPage } from '../../../utils/identity.js';

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

function getCriticalSelector(url) {
    if (url.includes('mail.google.com') && (url.includes('#inbox') || url.includes('#search/')))
        return 'tr[role="row"], div[role="main"]';
    if (url.includes('contacts.google.com'))
        return 'div.XXcuqd, div[role="main"]';
    if (url.includes('myaccount.google.com'))
        return 'h1, [data-rid]';
    return null;
}

async function gotoRobust(page, url, timeout = 60000) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const start = Date.now();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
            const selector = getCriticalSelector(url);
            if (selector) {
                try { await page.waitForSelector(selector, { timeout: 10000 }); }
                catch { /* loaded but selector missing */ }
            }
            logger.info(`[smartExtract] nav OK ${url} in ${Date.now() - start}ms`);
            await DOMHelpers.randomDelay(1000, 2000);
            return;
        } catch (e) {
            if (attempt === 0) {
                logger.warn(`[smartExtract] nav retry ${url} (attempt 1 failed: ${e.message})`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }
            logger.warn(`[smartExtract] nav FAIL ${url}: ${e.message} | actual=${page.url()}`);
            throw e;
        }
    }
}

async function createTab(browser, cookieJSON) {
    const tab = await browser.newPage();
    if (browser.identity) await applyIdentityToPage(tab, browser.identity);
    const cookies = typeof cookieJSON === 'string' ? JSON.parse(cookieJSON) : cookieJSON;
    await tab.setCookie(...cookies);
    return tab;
}

const SIGN_IN_PATTERNS = [
    /signin/i, /ServiceLogin/i, /challenge/i, /accounts\.google\.com\/(?:identifier|v3|signin)/i,
    /login/i, /oidc/i, /auth\/signin/i,
];

function isSignInPage(pageUrl) {
    return SIGN_IN_PATTERNS.some(p => p.test(pageUrl)) || pageUrl.includes('accounts.google.com/v3/signin');
}

export {
    sleep,
    getCriticalSelector,
    gotoRobust,
    createTab,
    SIGN_IN_PATTERNS,
    isSignInPage,
};
