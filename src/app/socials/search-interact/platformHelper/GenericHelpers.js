// Generic (non-TikTok) engagement helpers for search-interact.
// Each platform differs in DOM/UI, but the *shape* is shared:
// navigate → like (verified) → open comments → extract → AI → post (verified).
// TikTok uses its own runner (platformHelper/TikTokHelpers.js + routeHelper.js).
// These helpers work off platformConfigs.selectors / extractors so YouTube/X/
// Instagram/Facebook/Quora share one implementation with per-platform config.

import logger from '../../../../utils/logger.js';

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

export async function navigateAndWaitGeneric(page, url, { waitSelector = null, timeoutMs = 20000, label = 'page' } = {}) {
    // A failed goto is a settled failure — never report ok:true on a page
    // that never loaded (callers mark the keyword pending).
    const navErr = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }).catch((e) => e);
    if (navErr && navErr instanceof Error) {
        logger.warn(`[genericNav] Navigation failed (${label}): ${navErr.message}`);
        return { ok: false, state: 'nav_failed', error: navErr.message, url: '' };
    }
    if (!waitSelector) {
        await page.waitForTimeout ? await new Promise(r => setTimeout(r, 1200)) : await new Promise(r => setTimeout(r, 1200));
        return { ok: true, state: 'loaded', url: page.url() };
    }
    const ok = await page.waitForSelector(waitSelector, { timeout: timeoutMs, visible: true }).then(() => true).catch(() => false);
    if (!ok) logger.warn(`[genericNav] waitSelector not found (${label}): ${waitSelector} @ ${page.url()}`);
    return { ok, state: ok ? 'ready' : 'unknown', url: page.url() };
}

export async function isPostLikedGeneric(page, likeSelector) {
    return safe(() => page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return { liked: false, why: 'no-like-btn', pressed: null };
        const pressed = el.getAttribute('aria-pressed');
        if (pressed === 'true') return { liked: true, why: 'aria-pressed=true', pressed };
        if (pressed === 'false') return { liked: false, why: 'aria-pressed=false', pressed };
        const label = (el.getAttribute('aria-label') || '').toLowerCase();
        if (/unlike|liked|remove this/i.test(label)) return { liked: true, why: `label:${label}` };
        const cls = (el.className || '').toString().toLowerCase();
        if (/liked|pressed|active|selected|reacted/.test(cls)) return { liked: true, why: `class:${cls.slice(0, 40)}` };
        const pressed2 = el.getAttribute('aria-selected');
        if (pressed2 === 'true') return { liked: true, why: 'aria-selected=true' };
        return { liked: false, why: 'no-pressed-signal', pressed: null };
    }, likeSelector), { liked: false, why: 'eval-failed' });
}

export function isConfidentlyUnlikedGeneric(sig) {
    // Only call it "unliked" when the signal is definitive (button exists and
    // pressed=false with no liked class). Never toggle when uncertain.
    return !sig?.liked && sig?.why === 'aria-pressed=false';
}

export async function genericLike(page, likeSelector, logPrefix = '[genericLike]') {
    const before = await isPostLikedGeneric(page, likeSelector);
    if (before.liked) { logger.info(`${logPrefix} already liked (${before.why})`); return { liked: true, already: true }; }
    const clicked = await page.click(likeSelector, { timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) return { liked: false, reason: 'like-click-failed' };
    await new Promise(r => setTimeout(r, 1000));
    const after = await isPostLikedGeneric(page, likeSelector);
    // Fire-and-forget like (TikTok rule): if the toggle came back off, leave it.
    return { liked: after.liked, already: false, why: after.why || before.why };
}

export async function ensureCommentsVisibleGeneric(page, platformConfig) {
    const s = platformConfig.selectors || {};
    // 1) Probe with the platform's OWN comment box + comments extractor —
    // the generic TikTok/YT probe misses IG/FB/Quora/X comment surfaces.
    const probe = () => page.evaluate((args) => {
        const composer = args.commentBox ? !!document.querySelector(args.commentBox) : false;
        const items = args.commentItem ? document.querySelectorAll(args.commentItem).length : 0;
        return { composer, items };
    }, { commentBox: s.commentBox || s.replyTextBox || null, commentItem: s.commentItem || null }).catch(() => ({ composer: false, items: 0 }));
    let p = await probe();
    if (p.composer || p.items > 0) return { ok: true, state: p.items ? 'list' : 'composer' };

    // 2) Click the platform's comment entry (IG icon, FB Comment, Quora Add comment, X reply).
    const clickSels = [s.commentButton, s.commentItem && s.commentButton, "button[aria-label*='comment' i]"].filter(Boolean);
    for (const sel of clickSels) {
        const ok = await page.click(sel, { timeout: 2000 }).then(() => true).catch(() => false);
        if (ok) { await new Promise(r => setTimeout(r, 1500)); break; }
    }
    // 3) Scroll toward the comments area (YouTube/X comments live below the fold).
    await page.evaluate(() => { window.scrollBy(0, 800); }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    p = await probe();
    // Even if the probe missed (lazy render), main-comment posting below can
    // still succeed via the platform composer — report ok when composer exists.
    return { ok: !!(p.composer || p.items), state: p.items ? 'list' : 'composer' };
}

export async function extractCommentsGeneric(page, platformConfig) {
    const ext = platformConfig.extractors?.comments;
    if (!ext?.selector || !ext?.parseFunction) return [];
    try {
        const parseFunc = new Function('items', 'return (' + ext.parseFunction + '\n)(items);');
        const out = await page.$$eval(ext.selector, parseFunc);
        return Array.isArray(out) ? out.filter(c => c && c.text) : [];
    } catch (e) {
        logger.warn(`[genericExtract] comments extractor failed: ${e.message}`);
        return [];
    }
}

export async function postCommentGeneric(page, { commentBox, commentSubmit, text }) {
    const value = String(text || '').trim();
    if (!value) return { posted: false, reason: 'empty-text' };
    // Focus + clear composer. IG is a plain <textarea> (Ctrl+A/Backspace still
    // works); others are contenteditable. Handle textareas via fill() first.
    const isTextarea = await page.evaluate((sel) => document.querySelector(sel)?.tagName === 'TEXTAREA', commentBox).catch(() => false);
    const box = await page.$(commentBox).catch(() => null);
    if (!box) return { posted: false, reason: 'composer-not-found' };
    await box.click({ timeout: 3000 }).catch(() => {});
    if (isTextarea) {
        await box.fill('').catch(() => {});
        await box.type(value, { delay: 8 }).catch(() => {});
    } else {
        const keys = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.keyboard.down(keys).catch(() => {});
        await page.keyboard.down('Control').catch(() => {});
        await page.keyboard.press('a').catch(() => {});
        await page.keyboard.up('Control').catch(() => {});
        await page.keyboard.up(keys).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
        await page.keyboard.type(value, { delay: 8 }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 600));
    const submit = commentSubmit ? await page.$(commentSubmit).catch(() => null) : null;
    if (!submit) return { posted: false, reason: 'submit-not-found' };
    // Prefer the platform's own click (it understands disabled states).
    const clicked = await submit.click({ timeout: 3000 }).then(() => true).catch(async () => pathClick(page, commentSubmit));
    if (!clicked) return { posted: false, reason: 'submit-click-failed' };
    await new Promise(r => setTimeout(r, 1500));
    const after = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || el.textContent || el.value || '').trim() : '(gone)';
    }, commentBox).catch(() => '(gone)');
    const posted = after.length === 0 || after === '(gone)' || !after.includes(value.slice(0, 30));
    logger.info(`[genericPost] postCommentGeneric posted=${posted} after="${String(after).slice(0, 40)}"`);
    return { posted, reason: posted ? 'composer-cleared' : 'composer-not-cleared' };
}

async function pathClick(page, selector) {
    try {
        const bb = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, selector);
        if (!bb) return false;
        await page.mouse.click(bb.x, bb.y);
        return true;
    } catch { return false; }
}
