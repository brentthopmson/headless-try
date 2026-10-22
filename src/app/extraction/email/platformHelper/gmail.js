import logger from '../../../../utils/logger.js';
import { FINANCIAL_TERMS } from '../../shared/constants.js';
import { gotoRobust, isSignInPage, sleep } from '../../shared/browser.js';
import { sanitizeContactFields, contactDedupKey, dedupeContacts } from '../../shared/contacts.js';

function financialSearchUrl(platform, term) {
    if (platform === 'gmail') {
        return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`;
    }
    // Note: Outlook search is handled via UI-based search in performOutlookSearch(), not URL-based
    return `https://outlook.live.com/mail/0/search?query=${encodeURIComponent(term)}`;
}

export async function collectContacts(page, email, maxContacts = Infinity) {
    const contacts = [];
    const seen = new Set();

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

            // Wait for contact list to render — primary selector with fallbacks
            let hasContactList = false;
            const listSelectors = [
                'div.XXcuqd[role="presentation"]',
                '[role="main"] div[role="row"]',
                '[role="main"] [data-email]',
            ];
            for (let sIdx = 0; sIdx < listSelectors.length && !hasContactList; sIdx++) {
                try {
                    await page.waitForSelector(listSelectors[sIdx], { timeout: sIdx === 0 ? 20000 : 8000 });
                    hasContactList = true;
                } catch (e) { /* try next selector */ }
            }
            if (!hasContactList) {
                const skipDiag = await page.evaluate(() => ({
                    title: document.title,
                    url: location.href,
                    rows: document.querySelectorAll('[role="row"]').length,
                    dataEmail: document.querySelectorAll('[data-email]').length,
                    xx: document.querySelectorAll('div.XXcuqd').length,
                }));
                logger.warn(`[smartExtract] contacts ${url}: no contact list after waits — skipping (title="${skipDiag.title}", url="${skipDiag.url}", rows=${skipDiag.rows}, dataEmail=${skipDiag.dataEmail}, xx=${skipDiag.xx})`);
                continue;
            }
            logger.info(`[smartExtract] contacts ${url}: contact list appeared`);

            const pageTitle = await page.title();
            const pageUrl = page.url();
            let pageDiag = {};

            // Gmail contacts safety guards: 400 passes per page, 5000 total contacts.
            // Scrolling continues until 3 consecutive passes yield nothing new.
            let noGrowth = 0;
            for (let i = 0; i < 400; i++) {
                const batch = await page.evaluate(() => {
                    const ROW_SEL = 'div.XXcuqd[role="presentation"], [role="row"], [role="listitem"]';

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

                    const out = [];
                    const outSeen = new Set();
                    const push = (name, email, phone, company) => {
                        const key = (email || name || '').toLowerCase();
                        if (!key || outSeen.has(key)) return;
                        outSeen.add(key);
                        out.push({ name: name || '', email: email || '', phone: phone || '', company: company || '' });
                    };

                    // Primary: walk every contact NAME node (div.AYDrSb) — find its owning
                    // row. XXcuqd[role=presentation] is a GROUP box holding ~9 names, so a
                    // loose scope would collapse the whole group into one contact: accept
                    // closest() rows only when they are tight (<=2 names), else climb for
                    // the nearest ancestor holding this name + its email chip.
                    const tightScope = (startEl) => {
                        let n = startEl;
                        for (let d = 0; d < 5 && n && n !== document.body; d++, n = n.parentElement) {
                            if (n.querySelectorAll && n.querySelectorAll('div.AYDrSb').length <= 2 && n.querySelector('[data-email]')) return n;
                        }
                        return null;
                    };
                    let unmatched = 0;
                    let chain = '';
                    const nameEls = Array.from(document.querySelectorAll('div.AYDrSb'));
                    for (const nameEl of nameEls) {
                        const name = nameEl.textContent?.trim() || '';
                        let scope = nameEl.closest(ROW_SEL);
                        if (scope && scope.querySelectorAll('div.AYDrSb').length > 2) scope = null;
                        if (!scope) scope = tightScope(nameEl);
                        if (!scope) {
                            unmatched++;
                            if (!chain) {
                                const parts = [];
                                let n = nameEl;
                                for (let d = 0; d < 6 && n && n !== document.body; d++, n = n.parentElement) {
                                    const cls = n.className ? '.' + String(n.className).trim().split(/\s+/).slice(0, 2).join('.') : '';
                                    const role = n.getAttribute ? n.getAttribute('role') : null;
                                    parts.push(n.tagName.toLowerCase() + cls + (role ? `[role=${role}]` : ''));
                                }
                                chain = parts.join(' < ');
                            }
                        }
                        if (!scope) scope = nameEl.parentElement;
                        if (!scope) continue;
                        const email = scope.querySelector('[data-email]')?.getAttribute('data-email') || '';
                        const phone = scope.querySelector('[aria-describedby*="phone-column"]')?.textContent?.trim() || '';
                        const company = scope.querySelector('[aria-describedby*="generated-tagline-column"]')?.textContent?.trim() || '';
                        if (name || email) push(name, email, phone, company);
                    }

                    // Safety net: rows carrying an email but no name node picked up above
                    for (const el of document.querySelectorAll('[data-email]')) {
                        const email = el.getAttribute('data-email') || '';
                        if (!email) continue;
                        let scope = el.closest(ROW_SEL);
                        if (scope && scope.querySelectorAll('div.AYDrSb').length > 2) scope = null;
                        if (!scope) scope = tightScope(el);
                        if (!scope) scope = el.parentElement;
                        const name = scope?.querySelector('div.AYDrSb')?.textContent?.trim() || '';
                        const phone = scope?.querySelector('[aria-describedby*="phone-column"]')?.textContent?.trim() || '';
                        const company = scope?.querySelector('[aria-describedby*="generated-tagline-column"]')?.textContent?.trim() || '';
                        if (email || name) push(name, email, phone, company);
                    }

                    diag.matchedRows = document.querySelectorAll(ROW_SEL).length;
                    diag.unmatched = unmatched;
                    diag.chain = chain;
                    diag.outCount = out.length;
                    diag.firstName = out[0] ? `${out[0].name} <${out[0].email}>` : 'NONE';
                    return { out, diag };
                });

                if (i === 0) {
                    pageDiag = batch.diag;
                    logger.info(`[smartExtract] contacts ${url}: XXcuqd=${batch.diag.XXcuqd}, AYDrSb=${batch.diag.AYDrSb}, dataEmail=${batch.diag.dataEmail}, phoneCol=${batch.diag.phoneCol}, roleRow=${batch.diag.roleRow}, matchedRows=${batch.diag.matchedRows}, batchOut=${batch.out.length}, outCount=${batch.diag.outCount}, unmatched=${batch.diag.unmatched}, allDivs=${batch.diag.allDivs}, title="${batch.diag.title}"`);
                    logger.info(`[smartExtract] contacts ${url} firstName: ${batch.diag.firstName}`);
                    if (batch.diag.chain) {
                        logger.warn(`[smartExtract] contacts ${url} unmatched-name ancestor chain: ${batch.diag.chain}`);
                    }
                }

                let added = 0, skippedDedup = 0;
                for (const c of batch.out) {
                    // Sanitize first: pull emails out of junk names + strip Google
                    // UI phrases, then dedup by normalized email from EITHER field
                    // so dirty rows collapse onto their clean counterparts.
                    const { name, email } = sanitizeContactFields(c.name || '', c.email || '');
                    const key = contactDedupKey(name, email, c.phone || '');
                    if (!key || seen.has(key)) { skippedDedup++; continue; }
                    seen.add(key);
                    added++;
                    contacts.push({
                        name,
                        email,
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
                if (added > 0) noGrowth = 0; else noGrowth++;

                if (i === 0 || added > 0 || noGrowth >= 3) {
                    logger.info(`[smartExtract] contacts ${url} i=${i}: batchOut=${batch.out.length}, added=${added}, skippedDedup=${skippedDedup}, totalSoFar=${contacts.length}, noGrowth=${noGrowth}`);
                }

                if (contacts.length >= maxContacts) break;
                if (contacts.length >= 5000) {
                    logger.warn(`[smartExtract] contacts ${url}: safety guard hit (5000 contacts) — stopping this page`);
                    break;
                }
                if (noGrowth >= 3) break;
                if (noGrowth >= 1) await sleep(3000);   // lazy batch load at list bottom

                await page.evaluate(() => {
                    window.scrollBy(0, 1400);
                    // The contacts list often scrolls an INNER container, not the window —
                    // scroll every genuinely scrollable container on the page.
                    for (const el of document.querySelectorAll('div, main, section, [role="main"], [role="list"], [role="grid"], [role="treegrid"]')) {
                        if (el.scrollHeight > el.clientHeight + 150 && el.clientHeight > 250) {
                            el.scrollBy(0, 1400);
                        }
                    }
                });
                await sleep(1500);
                const nextBtn = await page.$('button[aria-label*="next" i], [class*="next"] button, [role="button"][aria-label*="next" i]');
                if (nextBtn) {
                    try { await nextBtn.click(); } catch (e) { /* noop */ }
                    await sleep(1800);
                }
            }
        } catch (e) {
            logger.warn(`[smartExtract] contacts extraction failed for ${url}: ${e.message}`);
        }
    }

    // Final sanitize + dedupe pass across all contact pages (main/frequent/other)
    const deduped = dedupeContacts(contacts);
    if (deduped.length !== contacts.length) {
        logger.info(`[smartExtract] contacts dedupe: ${contacts.length} -> ${deduped.length} (removed ${contacts.length - deduped.length} duplicates/dirty rows)`);
    }
    return deduped.slice(0, maxContacts);
}

async function collectGmailEmailTexts(page, maxEmails = 30, terms = FINANCIAL_TERMS, gmailBodyState = { remaining: 0 }) {
    const emails = [];
    const seen = new Set();
    const MAX_PASSES = 400; // per-search scroll safety guard (no-growth stop in practice)

    for (const term of terms) {
        if (emails.length >= maxEmails) break;
        try {
            const searchUrl = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(term)}`;
            await gotoRobust(page, searchUrl);
            if (isSignInPage(page.url())) {
                logger.warn(`[smartExtract] Gmail search redirected to sign-in: ${page.url()}`);
                break;
            }
            try {
                await page.waitForSelector('tr[role="row"], .zA, .zE', { timeout: 10000 });
            } catch (e) {
                logger.warn(`[smartExtract] Gmail search "${term}": no rows after 10s`);
            }

            // Phase 1 — scroll the result list until 3 passes yield nothing new
            const termRows = [];   // { text, href }
            const termSeen = new Set();
            let noGrowth = 0;
            for (let pass = 0; pass < MAX_PASSES; pass++) {
                if (emails.length + termRows.length >= maxEmails) break;
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
                    let sampleHtml = '';
                    for (const el of items) {
                        const sender = el.querySelector('span.zF')?.getAttribute('email')
                            || el.querySelector('span.zF')?.textContent?.trim() || '';
                        const subject = el.querySelector('span.bog')?.textContent?.trim() || '';
                        const snippet = el.querySelector('span.bqe')?.textContent?.trim() || '';
                        const date = el.querySelector('td.xW span[title]')?.getAttribute('title')
                            || el.querySelector('span.xW')?.textContent?.trim() || '';
                        const anchor = el.querySelector('a[href*="thread-f:"], a[href*="thread-"], a[href*="inbox/"], a[href*="all/"], a[href*="sent/"], a[href*="starred/"]');
                        let href = anchor?.getAttribute('href') || '';
                        if (href) {
                            const hashIdx = href.indexOf('#');
                            href = hashIdx >= 0 ? href.slice(hashIdx) : '';
                        }
                        // Gmail search rows often carry NO anchor — the thread id lives
                        // base64-encoded in the row's jslog click metadata:
                        //   jslog="... 1:WyIjdGhyZWFkLWY6MTIzNDU2..." → ["#thread-f:123456", ...]
                        if (!href) {
                            const jm = (el.getAttribute('jslog') || '').match(/1:(Wy[A-Za-z0-9+/=]+)/);
                            if (jm) {
                                try {
                                    const decoded = atob(jm[1].replace(/-/g, '+').replace(/_/g, '/'));
                                    const arr = JSON.parse(decoded);
                                    if (Array.isArray(arr) && typeof arr[0] === 'string' && arr[0][0] === '#') href = arr[0];
                                } catch (e) { /* not a thread-id payload */ }
                            }
                        }
                        const legacyId = el.getAttribute('data-legacy-id') || '';
                        if (!href && !legacyId && !sampleHtml) {
                            sampleHtml = (el.outerHTML || '').slice(0, 600);
                        }
                        const text = [sender, subject, snippet, date].filter(Boolean).join(' | ');
                        if (text && !seenInner.has(text)) {
                            seenInner.add(text);
                            out.push({ text, href, legacyId });
                        }
                    }
                    return { out, diag, sampleHtml };
                });

                let added = 0;
                for (const r of rows.out) {
                    const key = r.text.slice(0, 120);
                    if (termSeen.has(key)) continue;
                    termSeen.add(key);
                    termRows.push(r);
                    added++;
                }
                if (pass === 0) {
                    const hrefCount = rows.out.filter(r => r.href || r.legacyId).length;
                    logger.info(`[smartExtract] Gmail search "${term}": totalItems=${rows.diag.totalItems}, firstBatch=${rows.out.length}, linkable=${hrefCount}/${rows.out.length}`);
                    if (hrefCount === 0 && rows.sampleHtml) {
                        logger.warn(`[smartExtract] Gmail search "${term}" sample row: ${rows.sampleHtml}`);
                    }
                }
                if (added > 0) noGrowth = 0; else noGrowth++;
                if (noGrowth >= 3) break;
                if (noGrowth >= 1) await sleep(3000);
                await page.evaluate(() => window.scrollBy(0, 1500));
                await sleep(1500);
            }

            // Phase 2 — open each message and read its full body (budget-guarded)
            let opened = 0, bodyFailed = 0, budgetHit = 0, noLink = 0;
            for (const r of termRows) {
                if (emails.length >= maxEmails) break;
                // Row already collected by an earlier batch (searches overlap heavily) —
                // skip before opening so bodies aren't fetched twice.
                if (seen.has(r.text.slice(0, 120))) continue;
                let text = r.text;
                const frag = r.href
                    ? r.href
                    : (r.legacyId ? `#inbox/${r.legacyId}` : '');
                if (frag) {
                    if (gmailBodyState.remaining > 0) {
                        gmailBodyState.remaining--;
                        try {
                            await gotoRobust(page, `https://mail.google.com/mail/u/0/${frag}`);
                            let body = await readGmailBody(page);
                            if (!body && frag.startsWith('#thread-f:')) {
                                // Router may not accept the internal thread-f form —
                                // fall back to the classic inbox message-id URL.
                                const alt = '#inbox/' + frag.slice(frag.indexOf(':') + 1);
                                await gotoRobust(page, `https://mail.google.com/mail/u/0/${alt}`);
                                body = await readGmailBody(page);
                            }
                            if (body) text = `${text}\n${body}`;
                            opened++;
                        } catch (e) {
                            bodyFailed++;
                        }
                        await sleep(700);
                    } else {
                        budgetHit++;
                    }
                } else {
                    noLink++;
                }
                const key = text.slice(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                emails.push(text);
            }
            logger.info(`[smartExtract] Gmail search "${term}": collected=${termRows.length}, bodiesOpened=${opened}, bodyFailed=${bodyFailed}, noLink=${noLink}, budgetLeft=${gmailBodyState.remaining}, total=${emails.length}`);
            if (budgetHit > 0) {
                logger.warn(`[smartExtract] Gmail search "${term}": body budget exhausted — ${budgetHit} messages kept as list snippets only`);
            }
        } catch (e) {
            logger.warn(`[smartExtract] Gmail search failed for ${term}: ${e.message}`);
        }
    }
    logger.info(`[smartExtract] collectGmailEmailTexts done: total=${emails.length} (maxEmails=${maxEmails}, bodyBudgetLeft=${gmailBodyState.remaining})`);
    return emails;
}

export async function collectFinancialTexts(page, email, { maxEmails = 30, terms = FINANCIAL_TERMS, gmailBodyState = { remaining: 0 } } = {}) {
    return collectGmailEmailTexts(page, maxEmails, terms, gmailBodyState);
}

let _gmailBodyDiagCount = 0;
async function readGmailBody(page) {
    try {
        // Broad wait — the message BODY classes changed across Gmail builds, so wait
        // for the container first and let evaluate sort out the actual text holder.
        await page.waitForSelector('div[role="article"], .a3s, .adn, div[role="lang"]', { timeout: 10000 });
    } catch (e) { /* best-effort below */ }
    const res = await page.evaluate(() => {
        const article = document.querySelector('div[role="article"]');
        const el = document.querySelector('div[role="article"] .a3s')
            || document.querySelector('.ii.gt .a3s')
            || document.querySelector('.a3s')
            || document.querySelector('div[role="lang"]')
            || document.querySelector('.adm');
        let text = (el?.innerText || '').trim();
        if (!text && article) text = (article.innerText || '').trim();
        return {
            text,
            url: location.href,
            title: document.title,
            hasArticle: !!article,
            articleLen: (article?.innerText || '').length,
            a3s: document.querySelectorAll('.a3s').length,
            adn: document.querySelectorAll('.adn').length,
        };
    });
    if (_gmailBodyDiagCount < 3) {
        _gmailBodyDiagCount++;
        if (res.text) {
            logger.info(`[smartExtract] readGmailBody #${_gmailBodyDiagCount} OK: len=${res.text.length}, a3s=${res.a3s}, adn=${res.adn}, url=${res.url}, head="${res.text.slice(0, 140)}"`);
        } else {
            logger.warn(`[smartExtract] readGmailBody #${_gmailBodyDiagCount} EMPTY: url=${res.url}, title="${res.title}", hasArticle=${res.hasArticle}, articleLen=${res.articleLen}, a3s=${res.a3s}, adn=${res.adn}`);
        }
    }
    return res.text;
}

export async function collectPersonalInfo(page, email = '') {
    let raw = '';
    const titleName = '';

    try {
        logger.info(`[smartExtract] personal info: navigating to myaccount.google.com/personal-info`);
        await page.goto('https://myaccount.google.com/personal-info', { waitUntil: 'networkidle2', timeout: 30000 });
        const currentUrl = page.url();
        const pageTitle = await page.title();

        if (currentUrl.includes('myaccount.google.com') && !isSignInPage(currentUrl)) {
            logger.info(`[smartExtract] personal info nav OK: url=${currentUrl}, title="${pageTitle}"`);
            await sleep(2000);
            raw = await page.evaluate(() => document.body.textContent.trim().slice(0, 6000));
            logger.info(`[smartExtract] personal info raw length: ${raw.length} chars`);
        } else {
            logger.warn(`[smartExtract] personal info: could not reach myaccount.google.com (landed at ${currentUrl})`);
            return {
                earlyResult: {
                    name: '',
                    recoveryEmail: '',
                    phone: '',
                    birthday: '',
                    gender: '',
                    altEmails: [],
                    storageUsed: '',
                    createdAt: '',
                    _diag: { url: currentUrl, title: pageTitle, error: 'redirected away from myaccount.google.com' },
                },
            };
        }
    } catch (e) {
        logger.warn(`[smartExtract] personal info nav failed: ${e.message}`);
        return {
            earlyResult: {
                name: '',
                recoveryEmail: '',
                phone: '',
                birthday: '',
                gender: '',
                altEmails: [],
                storageUsed: '',
                createdAt: '',
                _diag: { error: e.message },
            },
        };
    }

    const domResult = await page.evaluate(() => {
        const pick = (selectors) => {
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el && el.textContent.trim()) return el.textContent.trim();
                } catch (e) { /* invalid selector, skip */ }
            }
            return '';
        };

        const name = pick([
            'h1',
            '[data-rid="10090"] .qqVS5',
            '[data-rid="10090"]',
            '[class*="name"]:not([class*="google"]):not([class*="logo"])',
        ]);
        const email = pick([
            'a[href*="mailto:"]',
            '[data-rid="203"] .qqVS5',
            '[data-rid="203"]',
            '[href*="recovery"]',
            'input[type="email"]',
            '[aria-label*="email" i]',
        ]);
        const phone = pick([
            'a[href*="tel:"]',
            '[data-rid="204"] .qqVS5',
            '[data-rid="204"]',
            '[href*="phone"]',
            '[aria-label*="phone" i]',
            '[class*="phone"]',
        ]);
        const birthday = pick([
            '[data-rid="205"] .qqVS5',
            '[data-rid="205"]',
            '[aria-label*="birthday" i]',
            '[aria-label*="Birth" i]',
        ]);
        const gender = pick([
            '[data-rid="206"] .qqVS5',
            '[data-rid="206"]',
            '[aria-label*="gender" i]',
            '[aria-label*="Gender" i]',
        ]);

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
    });

    return { raw, titleName, domResult };
}

export async function collectBoxSummary(page, email) {
    const inboxUrl = 'https://mail.google.com/mail/u/0/#inbox';
    try {
        await gotoRobust(page, inboxUrl);
        if (isSignInPage(page.url())) {
            logger.warn(`[smartExtract] box summary redirected to sign-in: ${page.url()}`);
            return { totalEmails: 0, unreadEmails: 0, folders: [], labels: [], _diag: { error: 'sign-in redirect' } };
        }
        try {
            await page.waitForSelector('tr[role="row"], .zA, .zE', { timeout: 10000 });
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

        const titleMatch = document.title.match(/\((\d+)\)/);
        unreadEmails = titleMatch ? parseInt(titleMatch[1]) || 0 : 0;

        const rows = document.querySelectorAll('tr[role="row"]');
        totalEmails = rows.length;
        diag.trRoleRow = rows.length;
        diag.zA = document.querySelectorAll('.zA').length;
        diag.zE = document.querySelectorAll('.zE').length;
        diag.roleRowAll = document.querySelectorAll('[role="row"]').length;

        document.querySelectorAll('a[href*="#inbox"], a[href*="#sent"], a[href*="#drafts"], a[href*="#starred"], a[href*="#snoozed"], a[href*="#trash"], a[href*="#spam"]').forEach(el => {
            const t = (el.textContent || '').trim();
            if (t && t.length < 40) folders.push(t);
        });

        document.querySelectorAll('div[role="navigation"] [role="link"]').forEach(el => {
            const t = (el.textContent || '').trim();
            if (t && t.length < 40 && !folders.includes(t)) folders.push(t);
        });

        return {
            totalEmails,
            unreadEmails,
            folders: folders.slice(0, 30),
            labels: labels.slice(0, 30),
            _diag: diag,
        };
    });

    logger.info(`[smartExtract] box diag: title="${result._diag.title}", trRoleRow=${result._diag.trRoleRow || 0}, zA=${result._diag.zA || 0}, folders=${result.folders.length}, labels=${(result.labels || []).length}, total=${result.totalEmails}, unread=${result.unreadEmails}`);
    return result;
}

export async function collectRecentEmails(page, email, { limit = 50, bodyState = { remaining: 0 } } = {}) {
    const emails = [];
    const seen = new Set();
    const gmailItems = [];
    const gmailItemSeen = new Set();

    for (const view of ['inbox', 'sent']) {
        if (gmailItems.length >= limit) break;
        try {
            const url = `https://mail.google.com/mail/u/0/#${view}`;
            await gotoRobust(page, url);
            if (isSignInPage(page.url())) {
                logger.warn(`[smartExtract] activities view redirected to sign-in: ${page.url()}`);
                break;
            }
            await sleep(1500);

            let noGrowth = 0;
            for (let pass = 0; pass < 120 && gmailItems.length < limit; pass++) {
                const batch = await page.evaluate(() => {
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
                            const anchor = el.querySelector('a[href*="thread-f:"], a[href*="thread-"], a[href*="inbox/"], a[href*="all/"], a[href*="sent/"], a[href*="starred/"]');
                            let href = anchor?.getAttribute('href') || '';
                            if (href) {
                                const hashIdx = href.indexOf('#');
                                href = hashIdx >= 0 ? href.slice(hashIdx) : '';
                            }
                            if (!href) {
                                const jm = (el.getAttribute('jslog') || '').match(/1:(Wy[A-Za-z0-9+/=]+)/);
                                if (jm) {
                                    try {
                                        const decoded = atob(jm[1].replace(/-/g, '+').replace(/_/g, '/'));
                                        const arr = JSON.parse(decoded);
                                        if (Array.isArray(arr) && typeof arr[0] === 'string' && arr[0][0] === '#') href = arr[0];
                                    } catch (e) { /* not a thread-id payload */ }
                                }
                            }
                            const legacyId = el.getAttribute('data-legacy-id') || '';
                            const text = [sender, subject, snippet, date].filter(Boolean).join(' | ');
                            if (text && !seenInner.has(text)) { seenInner.add(text); out.push({ text, href, legacyId }); }
                        });
                    });
                    return out.slice(0, 60);
                });

                let added = 0;
                for (const r of batch) {
                    const key = r.text.slice(0, 120);
                    if (gmailItemSeen.has(key)) continue;
                    gmailItemSeen.add(key);
                    gmailItems.push(r);
                    added++;
                    if (gmailItems.length >= limit) break;
                }
                if (added > 0) noGrowth = 0; else noGrowth++;
                if (gmailItems.length >= limit) break;
                if (noGrowth >= 3) break;
                if (noGrowth >= 1) await sleep(3000);
                await page.evaluate(() => window.scrollBy(0, 1500));
                await sleep(1500);
            }
            logger.info(`[smartExtract] activities gmail ${view}: collected=${gmailItems.length}/${limit}`);
        } catch (e) {
            logger.warn(`[smartExtract] activities view failed ${view}: ${e.message}`);
        }
    }

    if (gmailItems.length > 0) {
        let opened = 0, bodyFailed = 0, budgetHit = 0, noLink = 0;
        for (const r of gmailItems) {
            if (emails.length >= limit) break;
            let text = r.text;
            const frag = r.href
                ? r.href
                : (r.legacyId ? `#inbox/${r.legacyId}` : '');
            if (frag) {
                if (bodyState.remaining > 0) {
                    bodyState.remaining--;
                    try {
                        await gotoRobust(page, `https://mail.google.com/mail/u/0/${frag}`);
                        let body = await readGmailBody(page);
                        if (!body && frag.startsWith('#thread-f:')) {
                            const alt = '#inbox/' + frag.slice(frag.indexOf(':') + 1);
                            await gotoRobust(page, `https://mail.google.com/mail/u/0/${alt}`);
                            body = await readGmailBody(page);
                        }
                        if (body) text = `${text}\n${body}`;
                        opened++;
                    } catch (e) {
                        bodyFailed++;
                    }
                    await sleep(700);
                } else {
                    budgetHit++;
                }
            } else {
                noLink++;
            }
            const key = text.slice(0, 120);
            if (seen.has(key)) continue;
            seen.add(key);
            emails.push(text);
        }
        logger.info(`[smartExtract] activities gmail: items=${gmailItems.length}, bodiesOpened=${opened}, bodyFailed=${bodyFailed}, noLink=${noLink}, budgetLeft=${bodyState.remaining}, out=${emails.length}`);
        if (budgetHit > 0) {
            logger.warn(`[smartExtract] activities gmail: body budget exhausted - ${budgetHit} kept as snippets only`);
        }
    }

    return emails;
}
