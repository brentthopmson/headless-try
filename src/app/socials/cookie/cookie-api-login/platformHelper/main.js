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
// so the listener must not close them during that window.
const warmUrls = new Set();
let warmOpening = false;

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
    warmOpening = !!v;
}

function isWarmOpening() {
    return warmOpening;
}

// For tests: reset module state between cases.
function __resetWarmState() {
    warmUrls.clear();
    warmOpening = false;
}

// [{ method, url }] from config.loginMethods, in declared order.
function warmTabUrls(config) {
    const methods = config && config.loginMethods;
    if (!methods || typeof methods !== 'object') return [];
    return Object.keys(methods)
        .map(method => ({ method, url: methods[method] && methods[method].url }))
        .filter(e => !!e.url);
}

/**
 * Open one tab per configured login method. The primary page becomes the tab
 * for the FIRST method (no extra tab). Returns { method: page }.
 * setupPage(page) lets route.js apply UA/viewport to newly created tabs.
 */
async function openWarmTabs({ browser, primaryPage, config, logger, setupPage } = {}) {
    const tabs = {};
    const entries = warmTabUrls(config);
    if (!browser || entries.length === 0) return tabs;

    entries.forEach(e => markWarmUrl(e.url));
    const prevWarmOpening = warmOpening;
    setWarmOpening(true);
    try {
        let usePrimary = !!(primaryPage && !primaryPage.isClosed());
        for (const { method, url } of entries) {
            let p = null;
            try {
                if (usePrimary) {
                    p = primaryPage;
                    usePrimary = false;
                    if (typeof p.goto === 'function' && p.url() !== url) {
                        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(e => {
                            logger && logger.warn(`[WarmTabs] primary.goto(${url}) failed: ${e.message}`);
                        });
                    }
                } else {
                    p = await browser.newPage();
                    if (typeof setupPage === 'function') await setupPage(p);
                    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    } finally {
        setWarmOpening(prevWarmOpening);
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
async function runQrLogin({ page, config, logger, onQrData, getMethod, isLoggedIn, timeoutMs, recaptureMs } = {}) {
    const qr = (config && config.qr) || {};
    const deadline = Date.now() + (timeoutMs || qr.timeoutMs || 8 * 60 * 1000);
    const interval = recaptureMs || qr.recaptureMs || 25000;
    let iterations = 0;

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
    openWarmTabs,
    activateWarmTab,
    closeOtherTabs,
    captureQrDataUrl,
    runQrLogin,
};
