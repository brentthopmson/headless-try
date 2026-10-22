import logger from '../../../../utils/logger.js';
import { isFreeMicrosoftDomain } from '../../../emails/cookie/cookie-api-login/platformHelper/index.js';
import { FINANCIAL_TERMS } from '../../shared/constants.js';
import { gotoRobust, isSignInPage, sleep } from '../../shared/browser.js';
import { dedupeContacts } from '../../shared/contacts.js';

function getOutlookBaseUrl(email) {
    const domain = email?.split('@')[1]?.toLowerCase() || '';
    return isFreeMicrosoftDomain(domain)
        ? 'https://outlook.live.com/mail'
        : 'https://outlook.office.com/mail';
}

async function extractContactsFromOutlookInbox(page, email, maxContacts = Infinity) {
    const contacts = [];
    const byEmail = new Map();
    const selfEmail = (email || '').trim().toLowerCase();
    const MAX_ITEMS = 500;        // absolute guard for both phases
    const BODY_CONTACT_CAP = 50;  // per-message cap so one huge thread can't eat the budget
    let selfSkips = 0;
    const SCROLLER = 'div[data-testid="virtuoso-scroller"]';
    const SCROLL_STEP = 400;      // below row pitch so virtuoso renders contiguously

    // role/source stack comma-separated on repeat encounters.
    // returns 'new' | 'dup' | 'self' | 'skip'
    const addContact = (name, mail, date, role, source, subject) => {
        const key = (mail || '').trim().toLowerCase();
        if (!key) return 'skip';
        if (key === selfEmail) { selfSkips++; return 'self'; }
        const existing = byEmail.get(key);
        if (existing) {
            existing.interactionCount = (existing.interactionCount || 1) + 1;
            if (!existing.name && name) existing.name = name.trim();
            const stack = (field, val) => {
                if (!val) return;
                const list = (existing.otherData[field] || '').split(',').filter(Boolean);
                if (!list.includes(val)) existing.otherData[field] = [...list, val].join(',');
            };
            stack('role', role);
            stack('source', source);
            if (!existing.otherData.subject && subject) existing.otherData.subject = subject;
            return 'dup';
        }
        const contact = {
            name: (name || '').trim(),
            email: key,
            lastInteractionDate: (date || '').trim(),
            relationshipSummary: '',
            interactionCount: 1,
            otherData: { phoneNumbers: [], company: '', notes: '', role: role || '', source: source || '', subject: subject || '' },
        };
        byEmail.set(key, contact);
        contacts.push(contact);
        return 'new';
    };

    const scrollDown = async () => {
        const r = await page.evaluate((sel, step) => {
            const scroller = document.querySelector(sel)
                || document.querySelector('[role="main"] div[style*="overflow"]')
                || document.querySelector('div[class*="scroll"]')
                || document.querySelector('[class*="SQLrst"]')
                || document.querySelector('div[role="main"]');
            if (!scroller || scroller === document.documentElement) {
                window.scrollBy(0, step);
                return { found: false, before: -1, after: -1 };
            }
            const before = scroller.scrollTop;
            scroller.scrollBy(0, step);
            return { found: true, before, after: scroller.scrollTop };
        }, SCROLLER, SCROLL_STEP);
        await sleep(700);
        return r;
    };

    // Navigation clicks the real folder treeitem
    // (div[role="treeitem"][data-folder-name="inbox"|"sent items"]) so the SPA
    // switches folder state properly; URL nav is only a fallback. URL-only nav
    // left the big virtualized sent list in a state where Phase B rows never
    // rendered (last run: 22 click misses in 58ms).
    const clickFolder = async (folderName, folderPath, label) => {
        let outcome = 'missing';
        try {
            outcome = await page.evaluate((name) => {
                const cands = [...document.querySelectorAll(`div[role="treeitem"][data-folder-name="${name}"]`)];
                const el = cands.find(e => e.offsetParent !== null) || cands[0];
                if (!el) return 'missing';
                el.scrollIntoView({ block: 'center' });
                (el.querySelector('[role="link"]') || el).click();
                return 'clicked';
            }, folderName);
        } catch (e) {
            logger.warn(`[smartExtract] contacts(${label}) folder click threw: ${e.message}`);
        }
        if (outcome === 'clicked') {
            try {
                await page.waitForFunction(({ name, path }) => {
                    const sel = `div[role="treeitem"][data-folder-name="${name}"]`;
                    const picked = [...document.querySelectorAll(sel)]
                        .some(e => e.getAttribute('aria-selected') === 'true');
                    const href = location.href.toLowerCase();
                    const inSearch = href.includes('search'); // search views must not count as confirmed
                    const urlOk = location.pathname.toLowerCase().includes(path);
                    const rowsOk = document.querySelectorAll('div[data-index]').length > 0;
                    return rowsOk && !inSearch && (urlOk || picked);
                }, { timeout: 15000 }, { name: folderName, path: folderPath.split('/').pop() });
                await sleep(800); // virtualized list settle
                logger.info(`[smartExtract] contacts(${label}) folder clicked: data-folder-name="${folderName}" confirmed`);
                return;
            } catch (_) {
                logger.warn(`[smartExtract] contacts(${label}) folder click not confirmed in 15s — falling back to URL nav`);
            }
        } else {
            logger.warn(`[smartExtract] contacts(${label}) no element with data-folder-name="${folderName}" — falling back to URL nav`);
        }
        await gotoRobust(page, `${getOutlookBaseUrl(email)}/${folderPath}`);
        // URL-only nav leaves the list in a state where rows never render (the
        // 19:00 run: sent folder URL nav → 0 rows, scroller never moved). Re-click
        // the treeitem now that the URL is out of any search state.
        try {
            await sleep(1500);
            const again = await page.evaluate((name) => {
                const cands = [...document.querySelectorAll(`div[role="treeitem"][data-folder-name="${name}"]`)];
                const el = cands.find(e => e.offsetParent !== null) || cands[0];
                if (!el) return 'missing';
                (el.querySelector('[role="link"]') || el).click();
                return 'clicked';
            }, folderName);
            if (again === 'clicked') {
                await page.waitForFunction(({ name, path }) => {
                    const sel = `div[role="treeitem"][data-folder-name="${name}"]`;
                    const picked = [...document.querySelectorAll(sel)]
                        .some(e => e.getAttribute('aria-selected') === 'true');
                    const href = location.href.toLowerCase();
                    const inSearch = href.includes('search');
                    const urlOk = location.pathname.toLowerCase().includes(path);
                    const rowsOk = document.querySelectorAll('div[data-index]').length > 0;
                    return rowsOk && !inSearch && (urlOk || picked);
                }, { timeout: 12000 }, { name: folderName, path: folderPath.split('/').pop() });
                await sleep(800);
                logger.info(`[smartExtract] contacts(${label}) treeitem re-click after URL nav confirmed`);
            }
        } catch (_) {
            logger.warn(`[smartExtract] contacts(${label}) treeitem re-click after URL nav not confirmed — continuing anyway`);
        }
    };

    // Runs Phase A + Phase B against one folder (inbox, then sent-items).
    const scanFolder = async (folderPath, label) => {
        // Escape leftover search views (financial/personal phases run searches
        // first). The treeitem confirm rejects while location still has ?search=,
        // which then falls onto the known-bad URL-nav path (0 rows rendered).
        try {
            const inSearch = await page.evaluate(() => location.href.toLowerCase().includes('search'));
            if (inSearch) {
                logger.info(`[smartExtract] contacts(${label}) leaving search view before folder nav`);
                await gotoRobust(page, `${getOutlookBaseUrl(email)}/${folderPath}`);
                await sleep(1200);
            }
        } catch (_) { /* best effort */ }
        try {
            await clickFolder(folderPath === '0/sent-items' ? 'sent items' : 'inbox', folderPath, label);
        } catch (e) {
            logger.warn(`[smartExtract] contacts(${label}) nav failed: ${e.message}`);
            return;
        }
        // Wait for rows to render — Outlook uses virtual scrolling so the DOM
        // needs time to populate after navigation.
        try {
            await page.waitForSelector('div[data-index]', { timeout: 15000 });
        } catch (_) {
            await sleep(5000);
        }
        // One nav retry if the folder rendered nothing (blank/blank-state list).
        try {
            const empty = await page.evaluate(() => document.querySelectorAll('div[data-index]').length === 0);
            if (empty) {
                logger.warn(`[smartExtract] contacts(${label}) folder rendered no rows — retrying folder nav`);
                await clickFolder(folderPath === '0/sent-items' ? 'sent items' : 'inbox', folderPath, label);
                await page.waitForSelector('div[data-index]', { timeout: 15000 }).catch(() => {});
            }
        } catch (_) { /* best effort */ }

        // ================= Phase A: list scan (From, unbounded scroll) =================
        const items = new Map(); // stable item key -> row info
        const listSeen = new Set(); // keys already counted in Phase A (no double interactionCount)
        let setSize = 0;
        let noGrowth = 0;
        let listAdded = 0;

        for (let pass = 0; pass < MAX_ITEMS; pass++) {
            const batch = await page.evaluate(() => {
                const rows = [];
                document.querySelectorAll('div[data-index]').forEach((row) => {
                    const di = row.getAttribute('data-index');
                    if (di === null) return;
                    const senderEl = row.querySelector('span[title*="@"]');
                    const timeEl = row.querySelector('span.qq2gS');
                    rows.push({
                        di,
                        key: row.getAttribute('data-item-index') || di,
                        email: senderEl ? (senderEl.getAttribute('title') || '').trim() : '',
                        name: senderEl ? (senderEl.textContent || '').trim() : '',
                        subject: row.querySelector('.TtcXM')?.textContent?.trim() || '',
                        date: (timeEl && (timeEl.getAttribute('title') || timeEl.textContent || '').trim()) || '',
                        unread: !!row.querySelector('.DLvHz') || (row.getAttribute('aria-label') || '').toLowerCase().startsWith('unread'),
                    });
                });
                // Prefer the message row's setsize (sent folder first row carries the
                // real 2362) — a bare [aria-setsize] query can hit the folders pane
                // or a stale element from the previous folder (last run: 35).
                const sizeEl = document.querySelector('div[data-index][aria-setsize]')
                    || document.querySelector('[aria-setsize]');
                const setSize = parseInt(sizeEl?.getAttribute('aria-setsize') || '0', 10) || 0;
                return { rows, setSize };
            });

            if (batch.setSize > setSize) setSize = batch.setSize;
            const prevCount = items.size;
            for (const r of batch.rows) {
                items.set(r.key, r);
                if (r.email && !listSeen.has(r.key) && addContact(r.name, r.email, r.date, 'from', 'list', r.subject) === 'new') listAdded++;
                if (r.email) listSeen.add(r.key);
            }

            const grew = items.size !== prevCount;
            if (!grew) noGrowth++; else noGrowth = 0;
            if (pass === 0 || grew) {
                logger.info(`[smartExtract] list scan ${label} ${pass + 1}: items=${items.size}/${setSize || '?'} contacts=${contacts.length}`);
            }

            if (setSize > 0 && items.size >= setSize) break; // whole folder covered
            if (items.size >= MAX_ITEMS) break;              // absolute guard
            if (noGrowth >= 3) break;                        // 3 scrolls with nothing new
            if (noGrowth >= 1) await sleep(3000);            // lazy batch load at folder bottom

            const scr = await scrollDown();
            if (pass === 0 && scr.found && scr.after === scr.before) {
                logger.warn(`[smartExtract] list scan ${label}: scroller did not move on first scroll (scrollTop=${scr.before}) — suspect wrong/blank scroller`);
            }
        }

        const readCount = [...items.values()].filter(r => !r.unread).length;
        logger.info(`[smartExtract] Phase A(${label}): items=${items.size} setSize=${setSize} read=${readCount} listContacts=${listAdded} contacts=${contacts.length}`);

        // ================= Phase B: reading pane (To/Cc/Bcc + body) =================
        // Every READ message (never unread → no state flip). No click budget:
        // progress is bounded by the same termination rules as Phase A.
        const processed = new Set();
        let opened = 0, headerTo = 0, headerCc = 0, bodyAdds = 0, paneFails = 0, clickMisses = 0, emptyVisible = 0;
        let prevSig = null;
        let passNoGrowth = 0;

        if (readCount > 0) {
            // back to top so every row passes through the viewport
            await page.evaluate((sel) => {
                const scroller = document.querySelector(sel) || document.querySelector('div[role="main"]');
                if (scroller) scroller.scrollTop = 0; else window.scrollTo(0, 0);
            }, SCROLLER);
            // Rows must be back in the DOM before clicking — the virtualized list
            // can blank out after a long jump to top (last run: all 22 Phase B
            // clicks missed because div[data-index] was absent for the whole phase).
            let rowsReady = false;
            for (let w = 0; w < 4 && !rowsReady; w++) {
                try {
                    await page.waitForSelector('div[data-index]', { timeout: 5000 });
                    rowsReady = true;
                } catch (_) {
                    await scrollDown(); // nudge the scroller to re-render
                }
            }
            if (!rowsReady) {
                logger.warn(`[smartExtract] Phase B(${label}): message rows never re-rendered after scroll-to-top — Phase B skipped (list contacts kept)`);
                return;
            }
            await sleep(1500);

            // Opens one read row in the reading pane, waits until the pane shows
            // THIS conversation, then extracts From/To/Cc/Bcc + mined body emails.
            const openAndExtract = async (v) => {
                const clicked = await page.evaluate((idx) => {
                    const row = document.querySelector(`div[data-index="${idx}"]`);
                    if (!row) return false;
                    row.scrollIntoView({ block: 'center' });
                    (row.querySelector('[role="option"]') || row).click();
                    return true;
                }, v.di);
                if (!clicked) {
                    // Row not in DOM — keep it pending so the catch-up round can
                    // retry after a re-render (previously it was marked processed,
                    // silently dropping the whole folder's Phase B).
                    clickMisses++;
                    return;
                }
                processed.add(v.key);

                // wait until the pane shows THIS conversation
                // (sig = From texts + subject texts + received time)
                try {
                    await page.waitForFunction((prev) => {
                        const root = document.querySelector('#ItemReadingPaneContainer') || document;
                        const froms = [...root.querySelectorAll('span[id$="_FROM"]')].map(e => (e.textContent || '').trim()).join('~');
                        if (!froms) return false;
                        const subs = [...root.querySelectorAll('[id$="_SUBJECT"]')].map(e => (e.textContent || '').trim()).filter(Boolean).join('~');
                        const when = [...root.querySelectorAll('[data-testid="SentReceivedSavedTime"]')].map(e => (e.textContent || '').trim()).filter(Boolean).join('~');
                        return prev === null || (froms + '||' + subs + '||' + when) !== prev;
                    }, { timeout: 8000 }, prevSig);
                } catch (_) {
                    paneFails++;
                    return;
                }
                await sleep(400);

                // expand hidden recipients ("+N others")
                await page.evaluate(() => {
                    document.querySelectorAll('[id^="plusOthers"]').forEach(btn => { try { btn.click(); } catch (_) { /* noop */ } });
                });
                await sleep(400);

                const msg = await page.evaluate(() => {
                    const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
                    const PAIR_RE = /([^<>;]+?)\s*<\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\s*>/g;
                    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
                    const root = document.querySelector('#ItemReadingPaneContainer') || document;

                    const parsePairs = (raw) => {
                        const out = [];
                        const seen = new Set();
                        if (!raw) return out;
                        let m;
                        PAIR_RE.lastIndex = 0;
                        while ((m = PAIR_RE.exec(raw)) !== null) {
                            const mail = m[2].toLowerCase();
                            if (seen.has(mail)) continue;
                            seen.add(mail);
                            const name = clean(m[1])
                                .replace(/^(from|to|cc|bcc)\s*:\s*/i, '')
                                .replace(/^[\s,;:'"]+/, '')
                                .replace(/[\s,;:'"]+$/, '');
                            out.push({ name, email: m[2] });
                        }
                        let e;
                        EMAIL_RE.lastIndex = 0;
                        while ((e = EMAIL_RE.exec(raw)) !== null) {
                            const mail = e[0].toLowerCase();
                            if (seen.has(mail)) continue;
                            seen.add(mail);
                            out.push({ name: '', email: e[0] });
                        }
                        return out;
                    };

                    const holderText = (suffix) => {
                        const parts = [];
                        root.querySelectorAll(`[id$="${suffix}"]`).forEach((holder) => {
                            holder.querySelectorAll('[aria-label]').forEach(el => {
                                const a = el.getAttribute('aria-label') || '';
                                if (a.includes('@') || /^(to|cc|bcc):/i.test(a)) parts.push(a);
                            });
                            const txt = clean(holder.textContent);
                            if (txt) parts.push(txt);
                        });
                        return parts.join(' ');
                    };

                    const from = [];
                    root.querySelectorAll('span[id$="_FROM"]').forEach(el => {
                        const raw = clean(el.textContent) || clean(el.getAttribute('aria-label'));
                        parsePairs(raw).forEach(p => from.push(p));
                    });
                    const to = parsePairs(holderText('_TO'));
                    const cc = parsePairs(holderText('_CC'));
                    const bcc = parsePairs(holderText('_BCC'));

                    let subject = '';
                    root.querySelectorAll('[id$="_SUBJECT"]').forEach(el => {
                        const t = clean(el.textContent);
                        if (t && !subject) subject = t;
                    });
                    if (!subject) subject = clean(root.querySelector('span[role="heading"][aria-level="3"]')?.textContent);
                    const date = clean(root.querySelector('[data-testid="SentReceivedSavedTime"]')?.textContent);

                    const body = [];
                    root.querySelectorAll('div[aria-label="Message body"]').forEach((bodyEl) => {
                        parsePairs(bodyEl.textContent || '').forEach(p => body.push(p));
                        bodyEl.querySelectorAll('a[href^="mailto:"]').forEach(a => {
                            const mail = (a.getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
                            if (mail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) body.push({ name: clean(a.textContent), email: mail });
                        });
                    });

                    const fromsTxt = [...root.querySelectorAll('span[id$="_FROM"]')].map(e => (e.textContent || '').trim()).join('~');
                    const subsTxt = [...root.querySelectorAll('[id$="_SUBJECT"]')].map(e => (e.textContent || '').trim()).filter(Boolean).join('~');
                    const whenTxt = [...root.querySelectorAll('[data-testid="SentReceivedSavedTime"]')].map(e => (e.textContent || '').trim()).filter(Boolean).join('~');

                    return { from, to, cc, bcc, subject, date, body: body.slice(0, 60), sig: fromsTxt + '||' + subsTxt + '||' + whenTxt };
                });

                for (const p of msg.from) addContact(p.name, p.email, msg.date, 'from', 'header', msg.subject);
                for (const p of msg.to) { if (addContact(p.name, p.email, msg.date, 'to', 'header', msg.subject) === 'new') headerTo++; }
                for (const p of msg.cc) { if (addContact(p.name, p.email, msg.date, 'cc', 'header', msg.subject) === 'new') headerCc++; }
                for (const p of msg.bcc) addContact(p.name, p.email, msg.date, 'bcc', 'header', msg.subject);
                let perMsgBody = 0;
                for (const p of msg.body) {
                    if (perMsgBody >= BODY_CONTACT_CAP || contacts.length >= maxContacts) break;
                    if (addContact(p.name, p.email, msg.date, '', 'body', msg.subject) === 'new') { bodyAdds++; perMsgBody++; }
                }

                opened++;
                prevSig = msg.sig;
                if (opened % 10 === 0) {
                    logger.info(`[smartExtract] Phase B(${label}) progress: opened=${opened}/${readCount} contacts=${contacts.length} to=${headerTo} cc=${headerCc} body=${bodyAdds}`);
                }
            };

            for (let pass = 0; pass < MAX_ITEMS && contacts.length < maxContacts && passNoGrowth < 3; pass++) {
                const visible = await page.evaluate(() => {
                    const out = [];
                    document.querySelectorAll('div[data-index]').forEach((row) => {
                        const di = row.getAttribute('data-index');
                        if (di === null) return;
                        out.push({
                            di,
                            key: row.getAttribute('data-item-index') || di,
                            unread: !!row.querySelector('.DLvHz') || (row.getAttribute('aria-label') || '').toLowerCase().startsWith('unread'),
                        });
                    });
                    return out;
                });

                if (!visible.length) {
                    emptyVisible++;
                    logger.warn(`[smartExtract] Phase B(${label}) pass ${pass + 1}: no rows in DOM (emptyVisible=${emptyVisible})`);
                    if (emptyVisible >= 3) {
                        logger.warn(`[smartExtract] Phase B(${label}): rows vanished repeatedly — main loop aborted, catch-up will retry`);
                        break;
                    }
                    await scrollDown();
                    await sleep(2000);
                    continue;
                }
                emptyVisible = 0;

                const before = processed.size;

                for (const v of visible) {
                    if (contacts.length >= maxContacts) break;
                    if (v.unread || processed.has(v.key)) continue;
                    await openAndExtract(v);
                    if (opened === 0 && paneFails >= 2) {
                        logger.warn(`[smartExtract] Outlook reading pane never appeared (${label}) — Phase B aborted, list contacts kept`);
                        passNoGrowth = 3;
                        break;
                    }
                }

                if (processed.size === before) passNoGrowth++; else passNoGrowth = 0;
                if (processed.size >= readCount) break;
                if (contacts.length >= maxContacts) break;
                if (passNoGrowth >= 1) await sleep(3000); // slow-load retry for virtualized rows

                await scrollDown();
            }

            // catch-up: read rows the viewport passes never showed. Two rounds —
            // the second re-renders the list (scroll-to-top) so rows whose click
            // previously missed (clickMisses) become clickable.
            if (contacts.length < maxContacts) {
                const missing = () => [...items.values()].filter(r => !r.unread && !processed.has(r.key));
                let round = missing();
                if (round.length) logger.info(`[smartExtract] Phase B(${label}) catch-up: trying ${round.length} rows missed by the viewport`);
                for (let attempt = 0; attempt < 2 && round.length && contacts.length < maxContacts; attempt++) {
                    if (attempt > 0) {
                        logger.info(`[smartExtract] Phase B(${label}) catch-up retry: re-rendering list for ${round.length} pending rows (clickMisses=${clickMisses})`);
                        await page.evaluate((sel) => {
                            const scroller = document.querySelector(sel) || document.querySelector('div[role="main"]');
                            if (scroller) scroller.scrollTop = 0;
                        }, SCROLLER);
                        try { await page.waitForSelector('div[data-index]', { timeout: 8000 }); } catch (_) { /* proceed anyway */ }
                        await sleep(1200);
                        round = missing();
                        if (!round.length) break;
                    }
                    for (const t of round) {
                        if (contacts.length >= maxContacts) break;
                        await openAndExtract(t);
                        if (opened === 0 && paneFails >= 2) break;
                    }
                    if (opened === 0 && paneFails >= 2) break;
                    round = missing();
                }
            }
        }

        logger.info(`[smartExtract] Phase B(${label}): opened=${opened}/${readCount} to=${headerTo} cc=${headerCc} bodyAdds=${bodyAdds} paneFails=${paneFails} clickMisses=${clickMisses} selfSkips=${selfSkips} contacts=${contacts.length}`);
    };

    try {
        await scanFolder('0/inbox', 'inbox');
        if (contacts.length < maxContacts) await scanFolder('0/sent-items', 'sent');
    } catch (e) {
        logger.warn(`[smartExtract] outlook contacts extraction failed: ${e.message}`);
    }

    // Final sanitize + dedupe pass (byEmail already keys by email; this also
    // normalizes dirty display names picked up from mail headers).
    return dedupeContacts(contacts).slice(0, maxContacts);
}

export { extractContactsFromOutlookInbox as collectContacts };

async function performOutlookSearch(page, terms, email, maxEmails = 30, bodyState = { remaining: 0 }) {
    const emails = [];
    const seen = new Set();
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

    // Wait for search box to appear — with fallback selectors and one
    // re-navigation retry (the box intermittently fails to mount)
    const SEARCH_FALLBACKS = ['#topSearchInput', 'input[placeholder*="Search"]', 'input[placeholder*="Find"]', '[role="searchbox"]', 'input[type="search"]'];
    const findSearchBox = async () => {
        for (const sel of SEARCH_FALLBACKS) {
            try {
                const el = await page.$(sel);
                if (el) {
                    const box = await el.boundingBox();
                    if (box) return sel;
                }
            } catch (_) { /* try next */ }
        }
        return null;
    };
    let searchSelector = await findSearchBox();
    if (!searchSelector) {
        logger.warn(`[smartExtract] Outlook search box not found — retrying after re-navigation`);
        try { await gotoRobust(page, `${base}/0/inbox`); } catch (_) { /* noop */ }
        await sleep(3000);
        searchSelector = await findSearchBox();
    }
    if (!searchSelector) {
        logger.warn(`[smartExtract] Outlook search box not found, skipping`);
        return emails;
    }

    // Shared state for opening read hits to read full bodies (amounts live there)
    let prevBodySig = null;
    let bodiesThisCall = 0;
    // Snippet budget — [body] entries have their own shared budget and must not
    // eat the snippet cap (they inflated it and skipped later search terms)
    const snippetCount = () => emails.filter(e => !e.startsWith('[body]')).length;

    for (const term of terms) {
        if (snippetCount() >= maxEmails) break;
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
            let stall = 0;

            for (let scrollIteration = 0; scrollIteration < 30; scrollIteration++) {
                // Scrape current batch of search results
                const batch = await page.evaluate((existingTexts) => {
                    const items = document.querySelectorAll('div[data-index]');
                    const out = [];
                    const seenInner = new Set();

                    for (const el of items) {
                        // office.com list rows: sender = span[title*="@"], subject = .TtcXM,
                        // date = span.qq2gS[title]; the row aria-label carries
                        // sender+subject+date+preview as a catch-all. Unread rows are
                        // included — merely listing never marks them read.
                        const senderEl = el.querySelector('span[title*="@"]');
                        const sender = senderEl
                            ? `${senderEl.getAttribute('title') || ''} ${senderEl.textContent || ''}`.trim()
                            : (el.querySelector('span[aria-label^="From:"]')?.textContent?.trim() || '');
                        const subject = el.querySelector('.TtcXM')?.textContent?.trim()
                            || el.querySelector('[aria-label="Subject"]')?.textContent?.trim() || '';
                        const timeEl = el.querySelector('span.qq2gS');
                        const date = (timeEl && (timeEl.getAttribute('title') || timeEl.textContent || '').trim())
                            || el.querySelector('[aria-label="Received"]')?.textContent?.trim() || '';
                        const snippet = el.querySelector('[aria-label="Message preview"]')?.textContent?.trim()
                            || el.querySelector('span[aria-label*="preview"]')?.textContent?.trim()
                            || (el.getAttribute('aria-label') || '').trim();
                        const text = [sender, subject, date, snippet].filter(Boolean).join(' | ');
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

                // Scroll the REAL inner scroller in 400px steps (window.scrollBy
                // never moved the virtual list — only the first viewport was captured)
                const prevCount = allRows.length;
                await page.evaluate((sel, step) => {
                    const scroller = document.querySelector(sel)
                        || document.querySelector('[role="main"] div[style*="overflow"]')
                        || document.querySelector('div[class*="scroll"]')
                        || document.querySelector('div[role="main"]');
                    if (scroller && scroller !== document.documentElement) scroller.scrollBy(0, step);
                    else window.scrollBy(0, step);
                }, 'div[data-testid="virtuoso-scroller"]', 400);
                await sleep(900);

                if (allRows.length === prevCount) {
                    stall++;
                    if (stall >= 2) break;       // scrolled twice with nothing new
                    await sleep(2500);           // lazy batch load retry
                } else {
                    stall = 0;
                }
            }

            logger.info(`[smartExtract] Outlook search "${term}": totalItems=${allRows.length} (after scrolling), extracted=${allRows.length}`);
            if (allRows.length) logger.info(`[smartExtract] search "${term}" sample: ${allRows[0].slice(0, 200)}`);
            for (const r of allRows) {
                const key = r.slice(0, 120);
                if (seen.has(key)) continue;
                seen.add(key);
                emails.push(r);
                if (snippetCount() >= maxEmails) break;
            }

            // Pull full body text for some of this term's READ hits — subjects and
            // previews rarely contain amounts, bodies do. Budget is shared across
            // batches; unread rows are never clicked (stealth: no state flip).
            if (bodyState.remaining > 0) {
                const rowRefs = await page.evaluate(() => [...document.querySelectorAll('div[data-index]')].map(r => ({
                    di: r.getAttribute('data-index'),
                    unread: !!r.querySelector('.DLvHz') || (r.getAttribute('aria-label') || '').toLowerCase().startsWith('unread'),
                })).filter(r => r.di !== null));

                for (const ref of rowRefs) {
                    if (bodyState.remaining <= 0) break;
                    if (ref.unread) continue;
                    const ok = await page.evaluate((idx) => {
                        const row = document.querySelector(`div[data-index="${idx}"]`);
                        if (!row) return false;
                        row.scrollIntoView({ block: 'center' });
                        (row.querySelector('[role="option"]') || row).click();
                        return true;
                    }, ref.di);
                    if (!ok) continue;
                    try {
                        await page.waitForFunction((prev) => {
                            const root = document.querySelector('#ItemReadingPaneContainer') || document;
                            const froms = [...root.querySelectorAll('span[id$="_FROM"]')].map(e => (e.textContent || '').trim()).join('~');
                            if (!froms) return false;
                            const subs = [...root.querySelectorAll('[id$="_SUBJECT"]')].map(e => (e.textContent || '').trim()).filter(Boolean).join('~');
                            return prev === null || (froms + '||' + subs) !== prev;
                        }, { timeout: 8000 }, prevBodySig);
                    } catch (_) {
                        continue;
                    }
                    await sleep(300);
                    const bodyData = await page.evaluate(() => {
                        const root = document.querySelector('#ItemReadingPaneContainer') || document;
                        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
                        let subject = '';
                        root.querySelectorAll('[id$="_SUBJECT"]').forEach(el => {
                            const t = clean(el.textContent);
                            if (t && !subject) subject = t;
                        });
                        const bodyEl = root.querySelector('div[aria-label="Message body"]');
                        const body = clean(bodyEl?.textContent || '').slice(0, 2000);
                        const froms = [...root.querySelectorAll('span[id$="_FROM"]')].map(e => (e.textContent || '').trim()).join('~');
                        const subs = [...root.querySelectorAll('[id$="_SUBJECT"]')].map(e => (e.textContent || '').trim()).filter(Boolean).join('~');
                        return { subject, body, sig: froms + '||' + subs };
                    });
                    prevBodySig = bodyData.sig;
                    if (bodyData.body) {
                        const key = ('[body] ' + bodyData.subject + ' ' + bodyData.body).slice(0, 120);
                        if (!seen.has(key)) {
                            seen.add(key);
                            emails.push(`[body] ${bodyData.subject} | ${bodyData.body}`);
                            bodyState.remaining--;
                            bodiesThisCall++;
                            logger.info(`[smartExtract] financial body ${bodiesThisCall} (budget left=${bodyState.remaining}): ${(bodyData.subject || '').slice(0, 80)}`);
                        }
                    }
                }
            }

            // Small delay between searches
            await new Promise(r => setTimeout(r, 1000));
        } catch (e) {
            logger.warn(`[smartExtract] Outlook search failed for ${term}: ${e.message}`);
        }
    }

    return emails;
}

export async function collectFinancialTexts(page, email, { maxEmails = 30, terms = FINANCIAL_TERMS, bodyState = { remaining: 0 } } = {}) {
    return performOutlookSearch(page, terms, email, maxEmails, bodyState);
}

const OUTLOOK_PERSONAL_INFO_SITES = [
    'https://account.microsoft.com/profile',
    'https://account.microsoft.com/account',
];

export async function collectPersonalInfo(page, email = '') {
    let raw = '';
    let titleName = '';

    try {
        const inboxUrl = `${getOutlookBaseUrl(email)}/0/inbox`;
        await page.goto(inboxUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        if (!isSignInPage(page.url())) {
            await sleep(2000);
            try {
                const title = await page.title();
                const tm = title.match(/^Mail\s*-\s*(.+?)\s*-\s*Outlook/i);
                if (tm && tm[1] && !/mail\s*-\s*outlook/i.test(tm[1])) {
                    titleName = tm[1].trim();
                    raw = `Display name: ${titleName}\nMailbox: ${email}\nPage title: ${title}`;
                    logger.info(`[smartExtract] personal info: name from mail title = "${titleName}"`);
                }
            } catch (_) { /* noop */ }
            const clicked = await page.evaluate(() => {
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
                const flyoutRaw = await page.evaluate(() => document.body.textContent.trim().slice(0, 6000));
                if (flyoutRaw.length > (raw || '').length) raw = flyoutRaw;
            }
        }
    } catch (e) {
        logger.warn(`[smartExtract] Outlook mail header extraction failed: ${e.message}`);
    }

    if (!raw || raw.length < 50) {
        for (const url of OUTLOOK_PERSONAL_INFO_SITES) {
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
            '[data-testid="profile-name"]',
            '[data-testid="user-display-name"]',
            '[data-bi-id="full-name"]',
            '#profile.profile-page.personal-section.full-name',
            '[class*="Persona"] span[class*="primaryText"]',
            '[class*="persona"] span[class*="primaryText"]',
            '[class*="profile"] [class*="displayName"]',
            '[class*="profile-card"] [class*="name"]',
            '[aria-label*="Display name"]',
            '[data-testid="me-control"] [class*="primaryText"]',
            '[class*="account-manager"] [class*="name"]',
        ]);
        const emailAddress = pick([
            '[data-bi-id="email-address"]',
            '[data-testid="email-address"]',
            'input[type="email"]',
            '[aria-label*="email" i]',
            'a[href^="mailto:"]',
        ]);
        const phone = pick([
            '[data-bi-id="phone-number"]',
            '[data-testid="phone-number"]',
            '[aria-label*="phone" i]',
            'a[href^="tel:"]',
        ]);
        const birthday = pick([
            '[data-bi-id="birth-date"]',
            '[data-testid="birth-date"]',
            '[aria-label*="birthday" i]',
            '[aria-label*="birth" i]',
        ]);
        const gender = pick([
            '[data-bi-id="gender"]',
            '[data-testid="gender"]',
            '[aria-label*="gender" i]',
        ]);

        return {
            name,
            recoveryEmail: emailAddress,
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
    const inboxUrl = `${getOutlookBaseUrl(email)}/0/inbox`;
    try {
        await gotoRobust(page, inboxUrl);
        if (isSignInPage(page.url())) {
            logger.warn(`[smartExtract] box summary redirected to sign-in: ${page.url()}`);
            return { totalEmails: 0, unreadEmails: 0, folders: [], labels: [], _diag: { error: 'sign-in redirect' } };
        }
        try {
            await page.waitForSelector('div[data-index]', { timeout: 10000 });
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

        const sizeEl = document.querySelector('[aria-setsize]');
        const setSize = sizeEl ? (parseInt(sizeEl.getAttribute('aria-setsize') || '0', 10) || 0) : 0;
        const allRows = document.querySelectorAll('div[data-index]');
        totalEmails = setSize > 0 ? setSize : allRows.length;

        document.querySelectorAll('[role="treeitem"], [role="tree"] li, [class*="folder"], [class*="Folder"]').forEach(el => {
            const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
            if (t && t.length < 40 && !labels.includes(t)) labels.push(t);
        });

        document.querySelectorAll('[role="treeitem"], [aria-label*="Inbox" i]').forEach(el => {
            if (unreadEmails > 0) return;
            const text = (el.textContent || '').trim();
            const label = el.getAttribute('aria-label') || '';
            const combined = text + ' ' + label;
            if (/inbox/i.test(combined)) {
                const m = combined.match(/(\d[\d,]*)\s*(new|unread)/i);
                if (m) unreadEmails = parseInt(m[1].replace(/,/g, '')) || 0;
            }
        });

        if (unreadEmails === 0) unreadEmails = document.querySelectorAll('div[data-index] .DLvHz').length;
        if (totalEmails > 0 && unreadEmails > totalEmails) unreadEmails = totalEmails;

        for (const l of labels) if (!folders.includes(l)) folders.push(l);

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

export async function collectRecentEmails(page, email, { limit = 50 } = {}) {
    const emails = [];
    const seen = new Set();
    const outlookBaseUrl = getOutlookBaseUrl(email);

    for (const view of ['0/inbox', '0/sent']) {
        if (emails.length >= limit) break;
        try {
            await gotoRobust(page, `${outlookBaseUrl}/${view}`);
            if (isSignInPage(page.url())) {
                logger.warn(`[smartExtract] activities view redirected to sign-in: ${page.url()}`);
                break;
            }
            await sleep(1500);

            const seenRows = new Set();
            let noGrowth = 0;
            for (let scrollIteration = 0; scrollIteration < 120; scrollIteration++) {
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

                let addedNow = 0;
                for (const r of batch) {
                    if (!seenRows.has(r)) {
                        seenRows.add(r);
                        addedNow++;
                    }
                }

                if (addedNow > 0) noGrowth = 0; else noGrowth++;
                if (seenRows.size >= limit) break;
                if (noGrowth >= 3) break;
                if (noGrowth >= 1) await sleep(3000);

                await page.evaluate(() => window.scrollBy(0, 1500));
                await sleep(1800);
            }

            for (const r of seenRows) {
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
