// ==================== TikTok Platform Helpers (search-interact) ====================
// TikTok-specific DOM/behavior methods for the search-interact engagement flow.
// Config (selectors/prompts/workflows/extractors) stays in ../platforms.js.
// Cross-platform primitives (gateAndConsume, postCommentVerified, capturePostFrame)
// live in ../../_shared/routeHelper.js.
// Moved verbatim from the former shared TikTok engagement module.

import axios from 'axios';
import logger from '../../../../utils/logger.js';
import { getSettingsSheet } from '../../../../utils/settingsCache.js';
import { DOMHelpers } from '../../_shared/routeHelper.js';

// ==================== Gemini Audio Transcription ====================

async function resolveGeminiKey() {
    let key = process.env.GOOGLE_GEMINI_API_KEY || '';
    if (key) return key;
    try {
        const sheet = await getSettingsSheet();
        if (sheet && sheet.data) {
            const provIdx = sheet.headers.indexOf('aiProvider');
            const keyIdx = sheet.headers.indexOf('aiKey');
            const statusIdx = sheet.headers.indexOf('aiStatus');
            if (provIdx !== -1 && keyIdx !== -1) {
                const geminiRow = sheet.data.find(r =>
                    (r[provIdx] || '').toLowerCase().trim() === 'gemini' &&
                    (!statusIdx || (r[statusIdx] || '').toUpperCase().trim() === 'ACTIVE')
                );
                if (geminiRow) return geminiRow[keyIdx] || '';
            }
        }
    } catch (e) {
        logger.warn(`[tiktokHelpers] Failed to load Gemini key from settings: ${e.message}`);
    }
    return '';
}

async function transcribeAudioBase64Gemini(audioBase64, mimeType = 'audio/mpeg') {
    const geminiKey = await resolveGeminiKey();
    if (!geminiKey) throw new Error('No Gemini API key found for audio transcription.');
    const payload = {
        contents: [{
            parts: [
                { text: 'Transcribe this audio clip exactly as spoken. Return ONLY the transcribed words, no punctuation, no quotation marks, no explanation. Just the raw spoken text.' },
                { inlineData: { mimeType, data: audioBase64 } }
            ]
        }],
        generationConfig: { maxOutputTokens: 200, temperature: 0.1 }
    };
    const resp = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        payload,
        { timeout: 30000 }
    );
    return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

// ==================== TikTok Audio Captcha ====================
// TikTok's TUX captcha renders on the MAIN page (not an iframe): a
// #captcha-verify-container-main-page with an <audio src="...mp3">, a Play
// button, an "Enter what you hear" input, and a Verify button. It starts on
// audio mode already (the switch button reads "Image" = switch TO image).
// Flow: read audio[src] → download → Gemini transcribe → type → Verify.

export async function isTikTokCaptchaVisible(page) {
    try {
        return await page.evaluate(() => {
            const el = document.querySelector('#captcha-verify-container-main-page');
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    } catch (e) {
        return false;
    }
}

export async function solveTikTokAudioCaptcha(page, logPrefix = '[tiktokCaptcha]') {
    const MAX_ATTEMPTS = 3;
    try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            logger.info(`${logPrefix} Audio captcha attempt ${attempt}/${MAX_ATTEMPTS}...`);

            // Ensure audio mode: switch button label "Audio" means we're on image → click to audio.
            try {
                const switchLabel = await page.evaluate(() => {
                    const btn = document.querySelector('#captcha_switch_button');
                    const label = btn ? btn.querySelector('.TUXButton-label') : null;
                    return label ? label.textContent.trim() : null;
                });
                if (switchLabel === 'Audio') {
                    await page.evaluate(() => document.querySelector('#captcha_switch_button')?.click());
                    await new Promise(r => setTimeout(r, 1500));
                    logger.info(`${logPrefix} Switched from image to audio mode.`);
                }
            } catch (e) { /* already on audio or no switch */ }

            // Read audio src (present with preload=none; may need a refresh).
            let audioUrl = await page.evaluate(() => {
                const el = document.querySelector('#captcha-verify-container-main-page audio');
                return el ? el.getAttribute('src') : null;
            });
            if (!audioUrl) {
                // Click Play to force load, then re-read.
                await page.evaluate(() => {
                    const play = document.querySelector('#captcha-verify-container-main-page button[aria-label="Play"]');
                    play?.click();
                }).catch(() => {});
                await new Promise(r => setTimeout(r, 1500));
                audioUrl = await page.evaluate(() => {
                    const el = document.querySelector('#captcha-verify-container-main-page audio');
                    return el ? el.getAttribute('src') : null;
                });
            }
            if (!audioUrl) {
                logger.warn(`${logPrefix} No audio src found in captcha container.`);
                // Refresh for a new challenge.
                await page.evaluate(() => document.querySelector('#captcha_refresh_button')?.click()).catch(() => {});
                await new Promise(r => setTimeout(r, 1500));
                continue;
            }
            logger.info(`${logPrefix} Audio URL obtained (${audioUrl.length} chars).`);

            // Download + transcribe via Gemini.
            const audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 }).catch(() => null);
            if (!audioResp || !audioResp.data) {
                logger.warn(`${logPrefix} Failed to download captcha audio.`);
                continue;
            }
            const audioBase64 = Buffer.from(audioResp.data).toString('base64');
            let transcribed = '';
            try {
                transcribed = await transcribeAudioBase64Gemini(audioBase64);
            } catch (e) {
                logger.error(`${logPrefix} Gemini transcription failed: ${e.message}`);
                continue;
            }
            if (!transcribed) {
                logger.warn(`${logPrefix} Gemini returned empty transcription.`);
                continue;
            }
            // Strip quotes/punctuation the model sometimes adds.
            const answer = transcribed.replace(/["'.!?]/g, '').trim();
            logger.info(`${logPrefix} Audio transcribed: "${answer}"`);

            // Type into the input (clear first via the clear button if present).
            await page.evaluate((text) => {
                const input = document.querySelector('#captcha-verify-container-main-page input.TUXTextInputCore-input, #captcha-verify-container-main-page input[placeholder="Enter what you hear"]');
                if (!input) return;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) {
                    setter.call(input, '');
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    setter.call(input, text);
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                } else {
                    input.focus();
                    input.value = text;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }, answer);
            logger.info(`${logPrefix} Typed transcription into captcha input.`);
            await new Promise(r => setTimeout(r, 500));

            // Click Verify.
            await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('#captcha-verify-container-main-page button'));
                const verify = buttons.find(b => {
                    const label = b.querySelector('.TUXButton-label');
                    return label && label.textContent.trim() === 'Verify';
                });
                verify?.click();
            });
            logger.info(`${logPrefix} Clicked Verify. Waiting for result...`);
            await new Promise(r => setTimeout(r, 4000));

            const stillVisible = await isTikTokCaptchaVisible(page);
            if (!stillVisible) {
                logger.info(`${logPrefix} Captcha SOLVED.`);
                return true;
            }

            logger.warn(`${logPrefix} Attempt ${attempt} failed (captcha still visible). Refreshing...`);
            await page.evaluate(() => document.querySelector('#captcha_refresh_button')?.click()).catch(() => {});
            await new Promise(r => setTimeout(r, 1500));
        }

        // Final fail → close the captcha and report.
        await page.evaluate(() => document.querySelector('#captcha_close_button')?.click()).catch(() => {});
        logger.warn(`${logPrefix} All ${MAX_ATTEMPTS} attempts failed.`);
        return false;
    } catch (err) {
        logger.error(`${logPrefix} Error: ${err.message}`);
        return false;
    }
}

// ==================== Logged-out Detection ====================
// TikTok renders a login modal when the session has no valid cookies. The
// most stable signal is the h2[data-e2e="login-title"] ("Log in to TikTok").
// Also checks the container class, the modal title id, and a /login URL.

export async function isTikTokLoggedOut(page) {
    try {
        return await page.evaluate(() => {
            const loginTitle = document.querySelector('h2[data-e2e="login-title"]');
            if (loginTitle && loginTitle.textContent.includes('Log in')) return true;
            if (document.querySelector('#login-modal-title')) return true;
            if (document.querySelector("div[class*='DivLoginContainer']")) return true;
            if (location.href.includes('/login')) return true;
            return false;
        });
    } catch (e) {
        return false;
    }
}

// ==================== Page Load / Settle ====================
// TikTok is a React SPA: domcontentloaded fires long before the search
// results / post DOM hydrates. Racing past it caused 0-scraped keywords and
// "next search while previous page still loading". These helpers wait for
// a definitive settled state instead.

const SETTLE_POLL_MS = 400;           // poll interval while waiting
const SETTLE_TIMEOUT_MS = 20000;      // ~20s to reach a settled state (user-confirmed)
const NAV_RETRY_TIMEOUT_MS = 25000;   // retry timeout for a failed goto

// Classify the current page state once the DOM is loaded. Returns one of:
// 'results' | 'post' | 'logged_out' | 'captcha' | 'unknown'.
async function classifyPageState(page, s) {
    try {
        return await page.evaluate((sel) => {
            const visible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            // Captcha first — it overlays everything.
            if (visible(document.querySelector('#captcha-verify-container-main-page'))) return 'captcha';
            // Logged-out login modal.
            const loginTitle = document.querySelector('h2[data-e2e="login-title"]');
            if (loginTitle && loginTitle.textContent.includes('Log in')) return 'logged_out';
            if (visible(document.querySelector('#login-modal-title'))) return 'logged_out';
            if (visible(document.querySelector("div[class*='DivLoginContainer']"))) return 'logged_out';
            if (location.href.includes('/login')) return 'logged_out';
            // Search results rendered.
            if (document.querySelector(sel.results)) return 'results';
            // Opened post page. Image-text photo posts have NO browse-desc
            // caption element (the text is baked into the photo), so don't
            // rely on it alone. The URL never lies about what we loaded, and
            // the post action-bar icons (Like/Comments) are always present.
            if (/tiktok\.com\/@[^/]+\/(photo|video)\//.test(location.href)) return 'post';
            if (document.querySelector("[data-e2e='browse-like-icon'], [data-e2e='browse-comment-icon'], [data-e2e='browse-desc'], [data-e2e='browse-username']")) return 'post';
            return 'unknown';
        }, {
            results: s.searchResultsContainer || s.searchResultItem || "#search_top-item-list",
        });
    } catch (e) {
        return 'unknown';
    }
}

// Dismiss TikTok's cookie-consent banner ("Allow all") if present.
// TikTok ships several consent UIs (legacy div.tiktok-cookie-banner plus newer
// TUX variants) and renders the buttons as <button>, [role=button] or <a>.
// The banner overlays the comment composer/submit and silently swallows posts,
// so find it by class/id AND by visible consent text, then click "Allow all"
// with a REAL mouse (synthetic .click() is ignored by TikTok). Two passes cover
// a second banner appearing after the first is accepted.
const COOKIE_BANNER_SEL = "div[class*='tiktok-cookie-banner'], .tiktok-cookie-banner, div[class*='CookieBanner'], div[class*='cookie-banner'], [id*='cookie-banner' i], [class*='cookie-consent' i], [class*='consent-banner' i]";

export async function dismissCookieBanner(page, logPrefix = '[cookie]') {
    try {
        const findAllow = () => page.evaluate((sel) => {
            const isVisible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return false;
                const cs = getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
            };
            const pickAllow = (root) => {
                const candidates = Array.from(root.querySelectorAll("button, [role='button'], a")).filter(isVisible);
                const label = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
                const allowAll = candidates.find(el => /allow all|accept all/i.test(label(el)));
                if (allowAll) return allowAll;
                const allowish = candidates.find(el => /^(allow|accept|agree|got it|ok)\b/i.test(label(el)));
                if (allowish) return allowish;
                const deny = /decline|reject|manage|settings|learn more|cancel|essential|necessary/i;
                const safe = candidates.find(el => !deny.test(label(el)));
                return safe || candidates[candidates.length - 1] || null;
            };
            const rectOf = (el) => {
                const r = el.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (el.textContent || '').replace(/\s+/g, ' ').trim() };
            };

            // 1) Known class/id selectors.
            const known = Array.from(document.querySelectorAll(sel)).filter(isVisible);
            for (const banner of known) {
                const allow = pickAllow(banner);
                if (allow) return rectOf(allow);
            }

            // 2) Text-based fallback: a compact visible container that talks
            // about TikTok cookies and has a consent button. Cheap short-circuit
            // so the element scan only runs when consent text is actually present.
            const bodyText = (document.body && document.body.innerText) || '';
            if (!/allow cookies|we use cookies|cookies from tiktok|cookie settings|optional cookies/i.test(bodyText)) return null;
            const nodes = Array.from(document.querySelectorAll('div, section, aside'));
            for (const el of nodes) {
                if (!isVisible(el)) continue;
                const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
                if (!text || text.length > 400) continue;
                if (!/allow cookies|we use cookies|cookies from tiktok|cookie settings|optional cookies/i.test(text)) continue;
                const allow = pickAllow(el);
                if (allow) return rectOf(allow);
            }
            return null;
        }, COOKIE_BANNER_SEL).catch(() => null);

        // Fast path: no banner on the page (single evaluate).
        if (!(await findAllow())) return false;

        for (let pass = 0; pass < 2; pass++) {
            const rect = await findAllow();
            if (!rect) return true; // dismissed (or gone)
            const clicked = await DOMHelpers.humanClickAt(page, rect.x, rect.y, { hoverMs: [120, 300] }).catch(() => false);
            logger.info(`${logPrefix} Cookie banner present — clicked "${rect.label}" (${clicked ? 'ok' : 'click-failed'}).`);

            // Poll until gone (~3s).
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
                if (!(await findAllow())) return true;
                await new Promise(r => setTimeout(r, 200));
            }

            // Real-mouse didn't close it — synthetic click on the same target.
            await page.evaluate((sel) => {
                const isVisible = (el) => {
                    if (!el) return false;
                    const r = el.getBoundingClientRect();
                    return r.width >= 1 && r.height >= 1;
                };
                const pickAllow = (root) => {
                    const candidates = Array.from(root.querySelectorAll("button, [role='button'], a")).filter(isVisible);
                    const label = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();
                    const allowAll = candidates.find(el => /allow all|accept all/i.test(label(el)));
                    if (allowAll) return allowAll;
                    const allowish = candidates.find(el => /^(allow|accept|agree|got it|ok)\b/i.test(label(el)));
                    if (allowish) return allowish;
                    const deny = /decline|reject|manage|settings|learn more|cancel|essential|necessary/i;
                    const safe = candidates.find(el => !deny.test(label(el)));
                    return safe || candidates[candidates.length - 1] || null;
                };
                const banners = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                for (const banner of banners) {
                    const allow = pickAllow(banner);
                    if (allow) { allow.click(); return; }
                }
                const bodyText = (document.body && document.body.innerText) || '';
                if (!/allow cookies|we use cookies|cookies from tiktok|cookie settings|optional cookies/i.test(bodyText)) return;
                const nodes = Array.from(document.querySelectorAll('div, section, aside')).filter(isVisible);
                for (const el of nodes) {
                    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
                    if (!text || text.length > 400) continue;
                    if (!/allow cookies|we use cookies|cookies from tiktok|cookie settings|optional cookies/i.test(text)) continue;
                    const allow = pickAllow(el);
                    if (allow) { allow.click(); return; }
                }
            }, COOKIE_BANNER_SEL).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
        }
        return !(await findAllow());
    } catch (e) {
        logger.warn(`${logPrefix} dismissCookieBanner failed: ${e.message}`);
        return false;
    }
}

// Navigate to url and wait for a settled page: goto (with one retry on
// failure) → short hydration pause → poll for a definitive signal
// (results / post / login modal / captcha) up to ~20s.
// Returns { ok, state, url }. ok=false means navigation itself failed.
export async function navigateAndWait(page, url, s, opts = {}) {
    const {
        settleTimeoutMs = SETTLE_TIMEOUT_MS,
        hydrationPauseMs = 1800,
        label = 'page',
        logPrefix = '[engage]',
    } = opts;

    // Goto with one retry — do NOT swallow errors silently.
    let navError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: NAV_RETRY_TIMEOUT_MS,
            });
            navError = null;
            break;
        } catch (e) {
            navError = e;
            logger.warn(`${logPrefix} Navigation to ${label} failed (attempt ${attempt}/2): ${e.message}`);
            if (e.message && (e.message.includes('detached Frame') || e.message.includes('context was destroyed'))) {
                // In-flight navigation or frame swap destroyed execution context — pause and settle frame
                await new Promise(r => setTimeout(r, 1200));
                try { await page.mainFrame(); } catch (_) {}
            }
            if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
        }
    }
    if (navError) {
        return { ok: false, state: 'nav_failed', url: page.url(), error: navError.message };
    }

    // Short hydration pause so React can start rendering, then poll for a
    // definitive signal. We do NOT block on readyState=complete — TikTok
    // keeps analytics/websocket connections open and never reaches it, which
    // used to waste the full 20s budget per navigation. The signal appearing
    // IS the "page loaded enough" proof.
    await new Promise(r => setTimeout(r, hydrationPauseMs));

    // Cookie banner (if any) overlays the composer/submit — clear it first so
    // it can't swallow the post later.
    await dismissCookieBanner(page, logPrefix);

    // Poll for a definitive settled signal.
    const deadline = Date.now() + settleTimeoutMs;
    let state = 'unknown';
    while (Date.now() < deadline) {
        state = await classifyPageState(page, s);
        if (state !== 'unknown') break;
        await new Promise(r => setTimeout(r, SETTLE_POLL_MS));
    }

    const finalUrl = page.url();
    if (state === 'unknown') {
        // Log what the page actually shows so ambiguity is never silent.
        let snippet = '';
        try {
            snippet = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200));
        } catch (e) { /* ignore */ }
        logger.warn(`${logPrefix} ${label} UNRESOLVED after ${settleTimeoutMs}ms: url=${finalUrl} readyState=${await page.evaluate(() => document.readyState).catch(() => '?')} body="${snippet}"`);
    }
    return { ok: true, state, url: finalUrl };
}

// ==================== Comments Tab ====================
// TikTok post pages open on the "You may like" tab. The comment composer and
// comment list only render after switching to the Comments tab. Finds the
// tabbar item whose inner text is "Comments" and clicks it, then waits for
// actual comment ITEMS to render when the action bar says comments exist.
//
// expectedCount: comment count read from the action bar (0 or null = unknown).
// When expectedCount > 0 a visible composer or the "Start the conversation"
// empty state is NOT proof of success — under automation the comment-list API
// sometimes returns nothing and the panel renders empty (user-observed:
// "comment count shows 33 but list is empty; manually it loads").
// Returns { ok, state, items, reason }:
//   state: 'list' | 'composer' | 'empty'
//   reason on !ok: 'comments_tab_not_found' | 'panel_not_hydrated' | 'comments_not_loaded'
// Reads the comments-panel header count ("23.1K comments" → 23100). The
// action-bar browse-comment-count reads 0 on photo posts; the panel header
// is the reliable source once the Comments tab is active.
export async function readCommentsPanelCount(page) {
    try {
        const text = await page.evaluate(() => {
            const el = document.querySelector("div[class*='DivCommentCountContainer'] span, div[class*='DivCommentCountContainer']");
            return el ? (el.textContent || '').trim() : '';
        }).catch(() => '');
        if (!text) return 0;
        const m = text.replace(/,/g, '').match(/([\d.]+)\s*([KMB])?/i);
        if (!m) return 0;
        let n = parseFloat(m[1]);
        if (!isFinite(n)) return 0;
        const suffix = (m[2] || '').toUpperCase();
        if (suffix === 'K') n *= 1000;
        else if (suffix === 'M') n *= 1000000;
        else if (suffix === 'B') n *= 1000000000;
        return Math.round(n);
    } catch (e) {
        return 0;
    }
}

export async function ensureCommentsVisible(page, logPrefix = '[tiktokComments]', expectedCount = null) {
    try {
        // Clear any cookie banner first — it overlays the composer/submit.
        await dismissCookieBanner(page, logPrefix);
        const COMPOSER = "div[data-e2e='comment-text'][contenteditable='true'], div[data-key-interaction='comment_input']";
        // Live DOM (Oct 2026): DivCommentObjectWrapper is the item wrapper
        // (inner DivCommentItemWrapper is NESTED inside it). Match ONLY
        // ObjectWrapper — matching both double-counted items (20 real → 40).
        const LIST = "div[class*='DivCommentObjectWrapper']";
        const EMPTY_TEXT = 'Start the conversation';
        let expectReal = Number(expectedCount) > 0;

        const probe = () => page.evaluate((args) => {
            const items = document.querySelectorAll(args.list).length;
            const composer = !!document.querySelector(args.composer);
            const empty = (document.body?.innerText || '').includes(args.emptyText);
            let state = null;
            if (items > 0) state = 'list';
            else if (args.expectReal) state = null; // count>0 → composer/empty prove nothing
            else if (composer) state = 'composer';
            else if (empty) state = 'empty';
            return { items, composer, empty, state };
        }, { composer: COMPOSER, list: LIST, emptyText: EMPTY_TEXT, expectReal });

        const poll = async (ms) => {
            const deadline = Date.now() + ms;
            let snap = await probe();
            while (Date.now() < deadline && !snap.state) {
                await new Promise(r => setTimeout(r, 400));
                snap = await probe();
            }
            return snap;
        };

        // Photo posts: the list renders but the DraftEditor isn't mounted/
        // focused until the input container is clicked. The OLD check only
        // looked for the container (div[data-key-interaction='comment_input'])
        // — that's a false-positive: the contenteditable DESCENDANT inside it
        // isn't rendered until you click. Require the actual editable element.
        const ensureComposer = async () => {
            // True only when a contenteditable DraftEditor is live (visible,
            // non-zero box) — this is what typeText actually targets.
            const has = async () => page.evaluate(() => {
                const eds = document.querySelectorAll("div[data-e2e='comment-text'] div[contenteditable='true'], div[data-key-interaction='comment_input'] div[contenteditable='true'], div[data-e2e='comment-text'][contenteditable='true'], .public-DraftEditor-content[contenteditable='true']");
                for (const ed of eds) {
                    const r = ed.getBoundingClientRect();
                    if (r.width >= 1 && r.height >= 1) return true;
                }
                return false;
            }).catch(() => false);
            if (await has()) return true;
            // Click the input container / placeholder to mount the DraftEditor.
            await DOMHelpers.humanClick(page, "div[data-e2e='comment-input'], div[data-key-interaction='comment_input'], div[data-e2e='comment-text']", { timeout: 3000 }).catch(() => false);
            // DraftEditor mounts async — poll up to 4s.
            for (let i = 0; i < 8; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (await has()) return true;
            }
            // Last resort: scroll the panel bottom (composer is sticky-bottom).
            await DOMHelpers.humanScroll(page, "div[class*='DivCommentMain'], div[class*='DivTabContainer'], div[class*='RightPanel']", { totalPx: 300 }).catch(() => false);
            for (let i = 0; i < 6; i++) {
                await new Promise(r => setTimeout(r, 500));
                if (await has()) return true;
            }
            return false;
        };

        // Already showing real comments? Nothing to do.
        let snap = await probe();
        if (snap.state === 'list') {
            const composerOk = await ensureComposer();
            logger.info(`${logPrefix} Comments panel ready (list, ${snap.items} items, composer=${composerOk}).`);
            return { ok: true, state: 'list', items: snap.items, composer: composerOk };
        }
        if (!expectReal && snap.state) {
            const composerOk = snap.state === 'composer' ? true : await ensureComposer();
            logger.info(`${logPrefix} Comments panel ready (${snap.state}, composer=${composerOk}).`);
            return { ok: true, state: snap.state, items: snap.items, composer: composerOk };
        }

        // Real-mouse tab click: the old el.click() in evaluate fired
        // isTrusted=false events — the underline moved but the comment-list
        // fetch often returned an empty body. Drive the actual cursor.
        const clickTab = async (name) => {
            const rect = await page.evaluate((tabName) => {
                const items = document.querySelectorAll("div[class*='tux-tabbar-item']");
                for (const item of items) {
                    const label = item.querySelector("span[data-testid='tux-web-text']");
                    if (label && label.textContent.trim() === tabName) {
                        const r = item.getBoundingClientRect();
                        if (r.width < 1 || r.height < 1) return null;
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    }
                }
                return null;
            }, name);
            if (!rect) return false;
            return DOMHelpers.humanClickAt(page, rect.x, rect.y, { hoverMs: [150, 350] }).catch(() => false);
        };

        // Click the action-rail comment icon (speech bubble under the heart).
        // Video posts have NO Comments tab until this opens the panel. Selector
        // chain: 1) legacy data-e2e attrs, 2) tux icon-button whose SVG path
        // matches the comment-bubble signature (d starts "M2 21.5c0-10.22 9.88-18"
        // — unique to the comment icon; heart/bookmark/share differ).
        const clickCommentIcon = async () => {
            const rect = await page.evaluate(() => {
                const pick = (el) => {
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    if (r.width < 1 || r.height < 1) return null;
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                };
                const legacy = document.querySelector("div[data-e2e='browse-comment-icon'], [data-e2e='comment-icon']");
                const lp = pick(legacy);
                if (lp) return lp;
                const path = document.querySelector("svg path[d^='M2 21.5c0-10.22'], svg path[d*='9.88-18']");
                if (path) {
                    const btn = path.closest("button") || path.closest("[role='button']") || path.parentElement;
                    const bp = pick(btn);
                    if (bp) return bp;
                }
                return null;
            }).catch(() => null);
            if (!rect) return false;
            return DOMHelpers.humanClickAt(page, rect.x, rect.y, { hoverMs: [150, 350] }).catch(() => false);
        };

        // Panel not shown yet → open it. Photo posts have a visible "Comments"
        // tab; video posts don't (open via the rail icon). USER RULE: the
        // FIRST click may land on the "You may like" tab — always click
        // "Comments" a second time to guarantee the right tab is active.
        if (snap.items === 0 && !snap.composer) {
            let clicked = await clickTab('Comments');
            if (!clicked) {
                clicked = await clickCommentIcon();
                if (clicked) logger.info(`${logPrefix} Opened comments via action-rail icon (no Comments tab).`);
            }
            if (!clicked) {
                logger.warn(`${logPrefix} Comments tab and comment icon both not found.`);
                return { ok: false, state: null, items: 0, reason: 'comments_tab_not_found' };
            }
            logger.info(`${logPrefix} Opened comments. Expected ${expectReal ? expectedCount : '?'} comments.`);
            // First click may have activated "You may like" — click Comments again.
            await new Promise(r => setTimeout(r, 1400));
            const reClicked = await clickTab('Comments');
            if (reClicked) logger.info(`${logPrefix} Second Comments-tab click (first may have opened "You may like").`);
            // Action-bar count was 0 (common on photo posts) → read the panel
            // header ("23.1K comments") once the tab is active. Real count
            // flips expectReal so the poll requires actual list items.
            if (!expectReal) {
                const panelCount = await readCommentsPanelCount(page);
                if (panelCount > 0) {
                    expectedCount = panelCount;
                    expectReal = true;
                    logger.info(`${logPrefix} Panel header count = ${panelCount} (action-bar was 0) — requiring real list items.`);
                }
            }
        }

        // Patient wait for real comment items (or a valid non-real state).
        snap = await poll(15000);
        if (snap.state) {
            const composerOk = snap.state === 'composer' ? true : await ensureComposer();
            logger.info(`${logPrefix} Comments panel ready (${snap.state}${snap.items ? `, ${snap.items} items` : ''}, composer=${composerOk}).`);
            return { ok: true, state: snap.state, items: snap.items, composer: composerOk };
        }

        if (expectReal) {
            // Fallback A: click the action-bar comment icon to (re)focus the panel.
            logger.warn(`${logPrefix} 0 items after 15s (expected ${expectedCount}) — trying comment-icon click.`);
            await clickCommentIcon();
            snap = await poll(6000);
            if (snap.state) {
                logger.info(`${logPrefix} Comments loaded after comment-icon click (${snap.items} items).`);
                return { ok: true, state: snap.state, items: snap.items };
            }

            // Fallback B: real wheel-scroll over the right panel — virtualized
            // lists often fetch items only after the container scrolls, and
            // wheel events under the cursor look human (scrollTop= jumps don't).
            logger.warn(`${logPrefix} Still 0 items — trying panel scroll.`);
            for (let i = 0; i < 3 && !snap.state; i++) {
                await DOMHelpers.humanScroll(page, "div[class*='DivCommentMain'], div[class*='DivTabContainer'], div[class*='RightPanel']", { totalPx: 500 }).catch(() => false);
                snap = await poll(3000);
            }
            if (snap.state) {
                logger.info(`${logPrefix} Comments loaded after panel scroll (${snap.items} items).`);
                return { ok: true, state: snap.state, items: snap.items };
            }

            // Fallback C: toggle tabs to re-fire /api/comment/list/. Under
            // automation the first fetch sometimes returns an empty body
            // (observed: HTTP 200, 0 bytes) — switching away and back with the
            // real mouse re-issues it (D1 observer logs the 2nd response).
            logger.warn(`${logPrefix} Still 0 items — trying tab toggle to re-fire comment list.`);
            await clickTab('You may like');
            await new Promise(r => setTimeout(r, 1300));
            const reClicked = await clickTab('Comments');
            if (reClicked) {
                snap = await poll(6000);
                if (snap.state) {
                    logger.info(`${logPrefix} Comments loaded after tab toggle (${snap.items} items).`);
                    return { ok: true, state: snap.state, items: snap.items };
                }
            }

            // D2: one-line panel diagnostic for why nothing rendered.
            const diag = await page.evaluate(() => {
                const tabs = Array.from(document.querySelectorAll("div[class*='tux-tabbar-item']"))
                    .map(t => (t.textContent || '').trim()).filter(Boolean).slice(0, 4);
                const panel = document.querySelector("div[class*='DivCommentMain'], div[class*='DivTabContainer']");
                const text = (panel ? panel.innerText : document.body?.innerText || '').replace(/\s+/g, ' ').trim();
                return { tabs: tabs.join('|'), snippet: text.substring(0, 160) };
            }).catch(() => ({ tabs: '?', snippet: '?' }));
            logger.warn(`${logPrefix} comments_not_loaded: expected=${expectedCount}, items=0, composer=${snap.composer}, empty=${snap.empty}, tabs=[${diag.tabs}], panel: "${diag.snippet}"`);
            return { ok: false, state: null, items: 0, reason: 'comments_not_loaded' };
        }

        // !expectReal and still nothing: the first open click may have landed
        // on "You may like" — toggle to Comments once before giving up (same
        // re-fire trick as Fallback C above).
        logger.warn(`${logPrefix} Panel not hydrated — toggling "You may like" → "Comments".`);
        await clickTab('You may like');
        await new Promise(r => setTimeout(r, 1300));
        await clickTab('Comments');
        snap = await poll(6000);
        if (snap.state) {
            const composerOk = snap.state === 'composer' ? true : await ensureComposer();
            logger.info(`${logPrefix} Comments panel ready after tab toggle (${snap.state}${snap.items ? `, ${snap.items} items` : ''}, composer=${composerOk}).`);
            return { ok: true, state: snap.state, items: snap.items, composer: composerOk };
        }

        if (!expectReal) {
            const composerOk = await ensureComposer();
            if (composerOk) {
                logger.info(`${logPrefix} Zero-comment post: composer ready without comment list.`);
                return { ok: true, state: 'composer-zero-comments', items: 0, composer: true };
            }
        }

        logger.warn(`${logPrefix} Comments panel did not hydrate within 15s.`);
        return { ok: false, state: null, items: 0, reason: 'panel_not_hydrated' };
    } catch (e) {
        logger.warn(`${logPrefix} ensureCommentsVisible failed: ${e.message}`);
        return { ok: false, state: null, items: 0, reason: 'exception' };
    }
}

// ==================== Like-state Verification ====================
// Reads the like button's real state: returns { state, why, ariaPressed,
// colorAttr, computedFill, computedColor } or null (button missing / eval
// error). `state` true = liked, false = not liked OR no strong signal — check
// `why` (or use isConfidentlyUnliked) before acting on a false. Used
// defensively: switching to the Comments tab can re-render the action bar and
// reset an optimistic like before the server confirms it.
export async function isPostLiked(page, s, logPrefix = '') {
    try {
        const signals = await page.evaluate((sel) => {
            const icon = document.querySelector(sel);
            if (!icon) return { state: null, why: 'like-button-missing' };
            // Signal 1: aria-pressed on the icon itself or a clickable ancestor.
            // TikTok sets aria-pressed="true" only when liked; "false" is a
            // confident NOT-liked signal (the outer div[data-e2e='like-icon']
            // carries it), so trust it both ways.
            const apEl = icon.closest('[aria-pressed]') || icon.querySelector('[aria-pressed]');
            const ariaPressed = apEl ? apEl.getAttribute('aria-pressed') : null;
            if (ariaPressed === 'true') return { state: true, why: 'aria-pressed=true', ariaPressed };
            // Signal 2: TikTok-red filled heart. #FE2C55 → rgb(254, 44, 85) —
            // note 254, NOT 255. An rgb() string never contains the hex, so
            // match both forms.
            const red = (v) => {
                if (!v) return false;
                v = String(v).toLowerCase();
                return v.includes('fe2c55') || v.includes('2c55')
                    || v.includes('254, 44, 85') || v.includes('254,44,85')
                    || v.includes('255, 44, 85') || v.includes('255,44,85');
            };
            const white = (v) => {
                if (!v) return false;
                v = String(v).toLowerCase();
                return v.includes('255, 255, 255') || v.includes('255,255,255');
            };
            const svg = icon.matches('svg') ? icon : icon.querySelector('svg');
            let colorAttr = null, computedFill = null, computedColor = null;
            if (svg) {
                colorAttr = svg.getAttribute('color') || svg.getAttribute('fill');
                try { computedFill = getComputedStyle(svg).fill; } catch (e) { /* ignore */ }
                try { computedColor = getComputedStyle(svg).color; } catch (e) { /* ignore */ }
                const path = svg.querySelector('path');
                if (path) {
                    if (!colorAttr) colorAttr = path.getAttribute('color') || path.getAttribute('fill');
                    if (!computedFill) { try { computedFill = getComputedStyle(path).fill; } catch (e) { /* ignore */ } }
                }
                if (red(colorAttr) || red(computedFill) || red(computedColor)) {
                    return { state: true, why: 'red-fill', ariaPressed, colorAttr, computedFill, computedColor };
                }
                if (white(colorAttr) || white(computedFill) || white(computedColor)) {
                    return { state: false, why: 'white-fill', ariaPressed, colorAttr, computedFill, computedColor };
                }
            }
            if (ariaPressed === 'false') return { state: false, why: 'aria-pressed=false', ariaPressed, colorAttr, computedFill, computedColor };
            return { state: false, why: 'no-strong-signal', ariaPressed, colorAttr, computedFill, computedColor };
        }, s.likeButton);
        if (logPrefix) {
            logger.info(`${logPrefix} likeState=${signals.state} (${signals.why}, aria-pressed=${signals.ariaPressed ?? 'none'}, color=${signals.colorAttr ?? 'none'}, fill=${signals.computedFill ?? 'none'})`);
        }
        return signals;
    } catch (e) {
        return null;
    }
}

// Confident "not liked" = the page explicitly says so (aria-pressed=false) or
// the heart renders white (TikTok's unliked state). Anything weaker (null
// button, unrecognized colors) must NOT trigger a re-like — clicking a
// heart that is actually liked would UNLIKE it (observed like/unlike flap).
export function isConfidentlyUnliked(sig) {
    return !!sig && sig.state === false && (sig.why === 'aria-pressed=false' || sig.why === 'white-fill');
}
