// Pure platform resolution for socials login — CJS so jest can require() it
// (same interop pattern as threadScore.js / replyFilterMatch.cjs). platformConfigs,
// logger and DNS are all injected by route.js; this module imports nothing.

function cleanKey(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function pickConfiguredPlatform(value, configs) {
    const key = cleanKey(value);
    if (!key || !configs || !configs[key]) return '';
    return key;
}

function domainOf(email) {
    if (!email || typeof email !== 'string' || !email.includes('@')) return '';
    const domain = email.split('@')[1].toLowerCase();
    return domain || '';
}

function matchPlatformByMx(domain, mxRecords, configs) {
    const d = cleanKey(domain);
    if (!d || !configs) return '';
    const exchanges = (mxRecords || [])
        .map(mx => cleanKey(mx && mx.exchange))
        .filter(Boolean);
    return Object.keys(configs).find(key => {
        const cfg = configs[key];
        const keywords = cfg && cfg.mxKeywords;
        if (!Array.isArray(keywords) || keywords.length === 0) return false;
        return keywords.some(kw => {
            const k = cleanKey(kw);
            if (!k) return false;
            return d.includes(k) || exchanges.some(mx => mx.includes(k));
        });
    }) || '';
}

/**
 * Resolve the platform for a login row.
 * Precedence: platform param → strictly → email domain/MX → 'unknown'.
 * Returns { platform, source: 'platform'|'strictly'|'mx'|'none', domain, mxRecords }.
 * DNS runs only on the email legacy path (via injected resolveMxFn).
 */
async function resolvePlatform(options) {
    const opts = options || {};
    const { platform, strictly, email, mxRecords, configs, resolveMxFn } = opts;
    const initialMx = Array.isArray(mxRecords) ? mxRecords : [];

    const fromPlatform = pickConfiguredPlatform(platform, configs);
    if (fromPlatform) {
        return { platform: fromPlatform, source: 'platform', domain: domainOf(email), mxRecords: initialMx };
    }

    const fromStrictly = pickConfiguredPlatform(strictly, configs);
    if (fromStrictly) {
        return { platform: fromStrictly, source: 'strictly', domain: domainOf(email), mxRecords: initialMx };
    }

    const domain = domainOf(email);
    if (!domain) {
        return { platform: 'unknown', source: 'none', domain: '', mxRecords: initialMx };
    }

    let mx = initialMx;
    if (mx.length === 0 && typeof resolveMxFn === 'function') {
        try {
            mx = (await resolveMxFn(domain)) || [];
        } catch (e) {
            mx = [];
        }
    }

    const legacy = matchPlatformByMx(domain, mx, configs);
    return {
        platform: legacy || 'unknown',
        source: legacy ? 'mx' : 'none',
        domain,
        mxRecords: mx,
    };
}

// ---------------------------------------------------------------------------
// Runtime: warm tabs + QR login. CJS with injected deps (browser/page are
// puppeteer objects; logger injected) so jest can drive them with fakes.
// ---------------------------------------------------------------------------

// Module-level state shared with route.js's targetcreated listener:
// while openWarmTabs is creating tabs they are about:blank (URL not yet warm),
// so the listener must not close them during that window. Depth counter, not a
// boolean: concurrent processRow runs each toggle it, and restoring a single
// flag from one run would close a sibling run's still-opening tabs (observed:
// phone warm tab killed mid-open → "Page.navigate: Target closed").
const warmUrls = new Set();
let warmOpeningDepth = 0;

function markWarmUrl(url) {
    if (url) warmUrls.add(String(url));
}

function isWarmUrl(url) {
    const u = String(url == null ? '' : url);
    if (!u || u === 'about:blank' || u === 'about:blank#blocked') return false;
    for (const w of warmUrls) {
        if (u === w || u.startsWith(w.endsWith('/') ? w : w + '/') || u.startsWith(w)) return true;
    }
    return false;
}

function setWarmOpening(v) {
    if (v) warmOpeningDepth += 1;
    else warmOpeningDepth = Math.max(0, warmOpeningDepth - 1);
}

function isWarmOpening() {
    return warmOpeningDepth > 0;
}

// For tests: reset module state between cases.
function __resetWarmState() {
    warmUrls.clear();
    warmOpeningDepth = 0;
}

// [{ method, url }] from config.loginMethods, in declared order.
function warmTabUrls(config) {
    const methods = config && config.loginMethods;
    if (!methods || typeof methods !== 'object') return [];
    return Object.keys(methods)
        .map(method => ({ method, url: methods[method] && methods[method].url }))
        .filter(e => !!e.url);
}

// https://www.tiktok.com/login/qrcode?x#y -> https://tiktok.com/login/qrcode
function normalizeWarmUrl(u) {
    if (typeof u !== 'string' || !u) return '';
    try {
        const x = new URL(u);
        if (!x.host) return ''; // about:blank, data:, etc.
        let host = x.host.toLowerCase();
        if (host.startsWith('www.')) host = host.slice(4);
        return 'https://' + host + x.pathname.replace(/\/+$/, '');
    } catch (e) {
        return u.split(/[?#]/)[0].replace(/\/+$/, '');
    }
}

/**
 * Which warm-method entry does a live page URL belong to?
 * Exact normalized match wins; otherwise the longest entry that is a prefix
 * of the page URL (handles query strings / path continuations).
 * Returns { method, url } or null.
 */
function matchWarmEntry(pageUrl, entries) {
    const n = normalizeWarmUrl(pageUrl);
    if (!n) return null;
    let best = null;
    let bestLen = -1;
    for (const e of entries) {
        const ne = normalizeWarmUrl(e.url);
        if (!ne) continue;
        if (n === ne) return e;
        if (n.startsWith(ne + '/') && ne.length > bestLen) { best = e; bestLen = ne.length; }
    }
    return best;
}

/**
 * Open one tab per configured login method. The primary page becomes the tab
 * for the FIRST method (no extra tab). Returns { method: page }.
 * setupPage(page) lets route.js apply UA/viewport to newly created tabs.
 *
 * foregroundMethods (optional): methods whose navigation must complete before
 * this resolves. All other methods' gotos float (fire-and-forget with error
 * handling) so the caller's flow — e.g. QR capture — starts as soon as its own
 * tab is ready instead of waiting for every warm tab. newPage() is always
 * awaited: the targetcreated listener needs the warmOpening flag at creation
 * time; navigation itself creates no new targets, so floating gotos are safe.
 *
 * On session reuse the browser may already hold tabs from a previous run:
 * those pages are ADOPTED (matched by URL) instead of duplicated, and any
 * leftover duplicate warm tabs are closed, so the session keeps exactly one
 * tab per method.
 */
async function openWarmTabs({ browser, primaryPage, config, logger, setupPage, foregroundMethods } = {}) {
    const tabs = {};
    const entries = warmTabUrls(config);
    if (!browser || entries.length === 0) return tabs;

    const fgSet = (Array.isArray(foregroundMethods) && foregroundMethods.length > 0)
        ? new Set(foregroundMethods) : null;
    const floating = [];

    entries.forEach(e => markWarmUrl(e.url));
    setWarmOpening(true);
    try {
        const primary = (primaryPage && !primaryPage.isClosed()) ? primaryPage : null;
        const claimed = new Set();
        const adopted = {};   // method -> { page, nav }

        const urlOf = p => { try { return p.url(); } catch (e) { return ''; } };
        const existing = (await browser.pages().catch(() => []))
            .filter(p => { try { return !p.isClosed(); } catch (e) { return false; } });

        // 1) Primary already sitting on a warm method URL keeps that method.
        if (primary) {
            const hit = matchWarmEntry(urlOf(primary), entries);
            if (hit && !adopted[hit.method]) {
                adopted[hit.method] = { page: primary, nav: false };
                claimed.add(primary);
            }
        }
        // 2) Adopt one existing page per remaining method (URL match).
        for (const e of entries) {
            if (adopted[e.method]) continue;
            const p = existing.find(pg => pg !== primary && !claimed.has(pg) && matchWarmEntry(urlOf(pg), entries) === e);
            if (p) {
                adopted[e.method] = { page: p, nav: false };
                claimed.add(p);
            }
        }
        // 3) Primary (still unclaimed) anchors the first method without a tab.
        if (primary && !claimed.has(primary)) {
            const target = entries.find(e => !adopted[e.method]);
            if (target) {
                adopted[target.method] = { page: primary, nav: urlOf(primary) !== target.url };
                claimed.add(primary);
            } else {
                // Every method already has a tab: swap primary into the first
                // slot so it is never left behind as an extra tab.
                const first = entries[0];
                const displaced = adopted[first.method];
                adopted[first.method] = { page: primary, nav: urlOf(primary) !== first.url };
                claimed.add(primary);
                if (displaced && displaced.page !== primary) claimed.delete(displaced.page);
            }
        }
        // 4) Close leftover duplicates: open pages on a warm method URL that
        //    no method adopted (pollution from earlier duplicate runs).
        for (const p of existing) {
            if (claimed.has(p)) continue;
            if (matchWarmEntry(urlOf(p), entries)) {
                await p.close().catch(() => {});
            }
        }
        // 5) Assign/adopted pages (navigating if stale) + create missing tabs.
        // Foreground methods are awaited; the rest float — their rejections are
        // handled below, so openWarmTabs resolves after only the caller's own
        // tab navigated (QR capture no longer waits for email/phone loads).
        for (const { method, url } of entries) {
            let p = null;
            try {
                const a = adopted[method];
                if (a) {
                    p = a.page;
                    if (a.nav && typeof p.goto === 'function') {
                        const nav = p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
                            logger && logger.warn(`[WarmTabs] ${method}.goto(${url}) failed: ${e.message}`);
                        });
                        if (fgSet && !fgSet.has(method)) floating.push(nav);
                        else await nav;
                    }
                } else {
                    p = await browser.newPage();
                    if (typeof setupPage === 'function') await setupPage(p);
                    const nav = p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    if (fgSet && !fgSet.has(method)) {
                        floating.push(nav.catch(e => {
                            logger && logger.warn(`[WarmTabs] Failed to open '${method}' (${url}): ${e.message}`);
                            // Don't leave a zombie about:blank tab behind (the listener kept
                            // it open while warmOpening was set).
                            if (p && p !== primaryPage && typeof p.isClosed === 'function' && !p.isClosed()) {
                                return p.close().catch(() => {});
                            }
                        }));
                    } else {
                        await nav;
                    }
                }
                tabs[method] = p;
            } catch (e) {
                logger && logger.warn(`[WarmTabs] Failed to open '${method}' (${url}): ${e.message}`);
                // Don't leave a zombie about:blank tab behind (the listener kept
                // it open while warmOpening was set).
                if (p && p !== primaryPage && typeof p.isClosed === 'function' && !p.isClosed()) {
                    await p.close().catch(() => {});
                }
            }
        }
        // floating gotos stay in flight after this resolves — safe: navigation
        // creates no targetcreated events, so releasing warmOpening below only
        // affects new tabs, and every floating promise has its own handler.
    } finally {
        setWarmOpening(false);
    }
    return tabs;
}

/** Bring the tab for `method` to front and return it (or null). */
async function activateWarmTab(tabs, method) {
    const p = tabs && tabs[method];
    if (!p || (typeof p.isClosed === 'function' && p.isClosed())) return null;
    try { await p.bringToFront(); } catch (e) { /* best effort */ }
    return p;
}

/** Close every page except keepPage (used after QR success / method settle). */
async function closeOtherTabs(browser, keepPage, logger) {
    if (!browser) return;
    try {
        const pages = await browser.pages();
        for (const p of pages) {
            if (p !== keepPage && !p.isClosed()) {
                await p.close().catch(e => logger && logger.warn(`[WarmTabs] close failed: ${e.message}`));
            }
        }
    } catch (e) {
        logger && logger.warn(`[WarmTabs] closeOtherTabs failed: ${e.message}`);
    }
}

/**
 * Capture the QR image from the current page.
 * Tries each selector: inline dataUrl (canvas.toDataURL / img.src / CSS
 * background-image), falling back to an element screenshot.
 * Returns a data URL string or null.
 */
async function captureQrDataUrl(page, selectors, logger) {
    if (!page || typeof page.$ !== 'function') return null;
    const sels = Array.isArray(selectors) && selectors.length ? selectors : ['canvas'];
    for (const sel of sels) {
        try {
            const el = await page.$(sel);
            if (!el) continue;
            const inline = await el.evaluate(node => {
                try {
                    if (node.tagName === 'CANVAS' && typeof node.toDataURL === 'function') {
                        const d = node.toDataURL('image/png');
                        return d && d.length > 100 ? d : null;
                    }
                    if (node.tagName === 'IMG' && node.src && node.src.startsWith('data:')) return node.src;
                    const bg = window.getComputedStyle(node).backgroundImage;
                    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
                    if (m && m[1] && m[1] !== 'none') return m[1];
                } catch (e) { /* fall through */ }
                return null;
            });
            if (inline) return inline;
            const buf = await el.screenshot({ type: 'png' });
            if (buf && buf.length) return 'data:image/png;base64,' + Buffer.from(buf).toString('base64');
        } catch (e) {
            logger && logger.debug(`[QrCapture] '${sel}' failed: ${e.message}`);
        }
    }
    return null;
}

/**
 * QR login wait loop. Injected callbacks:
 *   onQrData(dataUrl)  — persist to sheet/cache (called each capture)
 *   getMethod()        — fresh loginMethod; returning non-'qr' exits early so
 *                        processRow falls back to the credential path
 *   isLoggedIn()       — success detection (URL pattern + session cookie/inbox)
 * Result shape matches checkAccountAccess so processRow's tail maps it to
 * COMPLETED / WAITINGEMAIL uniformly.
 */
async function runQrLogin({ page, config, logger, onQrData, getMethod, isLoggedIn, detectChallenge, timeoutMs, recaptureMs } = {}) {
    const qr = (config && config.qr) || {};
    const deadline = Date.now() + (timeoutMs || qr.timeoutMs || 8 * 60 * 1000);
    const interval = recaptureMs || qr.recaptureMs || 25000;
    let iterations = 0;

    // Wait for the QR element before the first capture so a page-load race
    // doesn't burn the whole first recapture cycle (first attempt used to miss
    // → 25s blind sleep while the template showed an empty QR).
    const firstSel = (Array.isArray(qr.selectors) && qr.selectors[0]) || 'canvas';
    if (page && typeof page.waitForSelector === 'function') {
        await page.waitForSelector(firstSel, { visible: true, timeout: 15000 }).catch(() => {});
    }

    while (Date.now() < deadline) {
        iterations++;

        if (typeof getMethod === 'function') {
            try {
                const m = await getMethod();
                if (m && m !== 'qr') {
                    return {
                        methodChanged: m,
                        emailExists: false,
                        accountAccess: false,
                        reachedInbox: false,
                        requiresVerification: false,
                        verificationState: null,
                        verificationOptions: [],
                        message: `Login method switched to '${m}' during QR wait.`
                    };
                }
            } catch (e) {
                logger && logger.debug(`[QrLogin] getMethod failed: ${e.message}`);
            }
        }

        // Post-scan challenge probe (e.g. TikTok "Verify it's really you").
        // Returns a full checkAccountAccess-shaped result to exit the QR loop,
        // or null/undefined to keep capturing (no challenge / probe failed).
        if (typeof detectChallenge === 'function') {
            try {
                const challenge = await detectChallenge();
                // INFO (not debug): this is the only proof the probe is wired —
                // silence here means detectChallenge never runs.
                logger && logger.info(`[QrLogin] iter=${iterations} challenge=${challenge ? (challenge.verificationState || 'hit') : 'null'}`);
                if (challenge) return challenge;
            } catch (e) {
                logger && logger.warn(`[QrLogin] detectChallenge failed: ${e.message}`);
            }
        }

        if (typeof isLoggedIn === 'function') {
            try {
                if (await isLoggedIn()) {
                    return {
                        emailExists: true,
                        accountAccess: true,
                        reachedInbox: true,
                        requiresVerification: false,
                        verificationState: null,
                        verificationOptions: [],
                        viewName: null,
                        message: 'QR login successful.'
                    };
                }
            } catch (e) {
                logger && logger.debug(`[QrLogin] isLoggedIn failed: ${e.message}`);
            }
        }

        const dataUrl = await captureQrDataUrl(page, qr.selectors, logger);
        if (dataUrl && typeof onQrData === 'function') {
            try { await onQrData(dataUrl); }
            catch (e) { logger && logger.warn(`[QrLogin] onQrData failed: ${e.message}`); }
        } else if (iterations === 1) {
            logger && logger.warn('[QrLogin] QR element not found on first capture attempt.');
        }

        await new Promise(r => setTimeout(r, interval));
    }

    return {
        emailExists: false,
        accountAccess: false,
        reachedInbox: false,
        requiresVerification: false,
        verificationState: null,
        verificationOptions: [],
        message: 'QR login timed out. Please enter your credentials instead.'
    };
}

module.exports = {
    cleanKey,
    pickConfiguredPlatform,
    domainOf,
    matchPlatformByMx,
    resolvePlatform,
    markWarmUrl,
    isWarmUrl,
    setWarmOpening,
    isWarmOpening,
    __resetWarmState,
    warmTabUrls,
    normalizeWarmUrl,
    matchWarmEntry,
    openWarmTabs,
    activateWarmTab,
    closeOtherTabs,
    captureQrDataUrl,
    runQrLogin,
};
