import axios from 'axios';
import logger from '../../../utils/logger.js';
import { getSettingsSheet } from '../../../utils/settingsCache.js';
import { DOMHelpers } from './routeHelper.js';
import limitsCore from './limitsCore.js';
import { checkActionAllowed } from './limits.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus } from './hubUpdater.js';

const { toLimitActions } = limitsCore;

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
        logger.warn(`[tiktokEngage] Failed to load Gemini key from settings: ${e.message}`);
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

// Navigate to url and wait for a settled page: goto (with one retry on
// failure) → short hydration pause → poll for a definitive signal
// (results / post / login modal / captcha) up to ~20s.
// Returns { ok, state, url }. ok=false means navigation itself failed.
async function navigateAndWait(page, url, s, opts = {}) {
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
export async function ensureCommentsVisible(page, logPrefix = '[tiktokComments]', expectedCount = null) {
    try {
        const COMPOSER = "div[data-e2e='comment-text'][contenteditable='true'], div[data-key-interaction='comment_input']";
        const LIST = "div[class*='DivCommentItemContainer']";
        const EMPTY_TEXT = 'Start the conversation';
        const expectReal = Number(expectedCount) > 0;

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

        // Already showing real comments? Nothing to do.
        let snap = await probe();
        if (snap.state === 'list') {
            logger.info(`${logPrefix} Comments panel ready (list, ${snap.items} items).`);
            return { ok: true, state: 'list', items: snap.items };
        }
        if (!expectReal && snap.state) {
            logger.info(`${logPrefix} Comments panel ready (${snap.state}).`);
            return { ok: true, state: snap.state, items: snap.items };
        }

        // Panel not shown yet → click the "Comments" tab.
        if (snap.items === 0 && !snap.composer) {
            const clicked = await page.evaluate(() => {
                const items = document.querySelectorAll("div[class*='tux-tabbar-item']");
                for (const item of items) {
                    const label = item.querySelector("span[data-testid='tux-web-text']");
                    if (label && label.textContent.trim() === 'Comments') {
                        label.click();
                        return true;
                    }
                }
                return false;
            });
            if (!clicked) {
                logger.warn(`${logPrefix} Comments tab not found.`);
                return { ok: false, state: null, items: 0, reason: 'comments_tab_not_found' };
            }
            logger.info(`${logPrefix} Clicked Comments tab. Expected ${expectReal ? expectedCount : '?'} comments.`);
        }

        // Patient wait for real comment items (or a valid non-real state).
        snap = await poll(15000);
        if (snap.state) {
            logger.info(`${logPrefix} Comments panel ready (${snap.state}${snap.items ? `, ${snap.items} items` : ''}).`);
            return { ok: true, state: snap.state, items: snap.items };
        }

        if (expectReal) {
            // Fallback A: click the action-bar comment icon to (re)focus the panel.
            logger.warn(`${logPrefix} 0 items after 15s (expected ${expectedCount}) — trying comment-icon click.`);
            await DOMHelpers.clickElement(page, "div[data-e2e='browse-comment-icon'], [data-e2e='comment-icon']", { timeout: 3000, delay: 800 }).catch(() => false);
            snap = await poll(6000);
            if (snap.state) {
                logger.info(`${logPrefix} Comments loaded after comment-icon click (${snap.items} items).`);
                return { ok: true, state: snap.state, items: snap.items };
            }

            // Fallback B: scroll the right panel — virtualized lists often fetch
            // items only after the container scrolls.
            logger.warn(`${logPrefix} Still 0 items — trying panel scroll.`);
            for (let i = 0; i < 3 && !snap.state; i++) {
                await page.evaluate(() => {
                    const cands = Array.from(document.querySelectorAll("div[class*='DivCommentMain'], div[class*='DivTabContainer'], div[class*='RightPanel']"));
                    for (const el of cands) {
                        if (el.scrollHeight > el.clientHeight + 10) {
                            el.scrollTop = el.scrollTop + 600;
                            return true;
                        }
                    }
                    window.scrollBy(0, 600);
                    return false;
                }).catch(() => {});
                snap = await poll(3000);
            }
            if (snap.state) {
                logger.info(`${logPrefix} Comments loaded after panel scroll (${snap.items} items).`);
                return { ok: true, state: snap.state, items: snap.items };
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
async function isPostLiked(page, s, logPrefix = '') {
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
function isConfidentlyUnliked(sig) {
    return !!sig && sig.state === false && (sig.why === 'aria-pressed=false' || sig.why === 'white-fill');
}

// ==================== Post Frame Capture (vision fallback) ====================
// Captures a PNG (base64) of the post's video frame or photo for the vision
// fallback analysis. Prefers the largest playing <video>; falls back to the
// largest visible photo <img>. Returns null when nothing capturable exists —
// the caller then keeps its text result (never throws, never blocks a run).
async function capturePostFrame(page) {
    try {
        // Make sure the main video is playing so a frame is actually rendered.
        await page.evaluate(() => {
            const vids = Array.from(document.querySelectorAll('video'));
            vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
            const v = vids[0];
            if (v) { v.muted = true; if (v.paused) v.play().catch(() => {}); }
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));

        const handle = await page.evaluateHandle(() => {
            // Largest video that has real dimensions.
            const vids = Array.from(document.querySelectorAll('video'))
                .filter(v => v.videoWidth > 0 && v.getBoundingClientRect().width > 100);
            vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
            if (vids[0]) return vids[0];
            // Else largest visible photo image (photo posts / image-text).
            const imgs = Array.from(document.querySelectorAll('img')).filter(i => {
                const r = i.getBoundingClientRect();
                return r.width > 200 && r.height > 200 && r.top < window.innerHeight && r.bottom > 0;
            });
            imgs.sort((a, b) => {
                const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                return (rb.width * rb.height) - (ra.width * ra.height);
            });
            return imgs[0] || null;
        });
        const el = handle?.asElement?.();
        if (!el) return null;
        const buf = await el.screenshot({ type: 'png' });
        return Buffer.from(buf).toString('base64');
    } catch (e) {
        return null;
    }
}

// ==================== Verified Comment Submission ====================
// Types into the comment composer and only reports success when the text
// actually landed AND the submit button was enabled AND the composer clears
// after clicking (TikTok clears it on a successful post). Prevents the
// untruthful "Comment posted" logs seen when typing silently no-ops or the
// Post button stays disabled.
async function postCommentVerified(page, s, text, logPrefix = '') {
    const typed = await DOMHelpers.typeText(page, s.commentBox, text, { delay: 40 }).catch(() => false);
    if (!typed) return { posted: false, reason: 'composer-not-found' };
    await DOMHelpers.randomDelay(600, 1200);

    const composerText = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent || '').trim() : null;
    }, s.commentBox).catch(() => null);
    if (composerText === null) return { posted: false, reason: 'composer-missing-after-type' };
    if (!composerText) return { posted: false, reason: 'text-not-entered' };

    const btnState = await page.evaluate((sel) => {
        const b = document.querySelector(sel);
        if (!b) return 'missing';
        return (b.disabled || b.getAttribute('aria-disabled') === 'true') ? 'disabled' : 'enabled';
    }, s.commentSubmit).catch(() => 'missing');
    if (btnState !== 'enabled') return { posted: false, reason: `submit-${btnState}` };

    const clicked = await DOMHelpers.clickElement(page, s.commentSubmit, { timeout: 5000, delay: 1500 }).catch(() => false);
    if (!clicked) return { posted: false, reason: 'submit-click-failed' };

    // TikTok clears the composer once the post is accepted — poll briefly.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        const remaining = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? (el.textContent || '').trim() : '';
        }, s.commentBox).catch(() => '');
        if (!remaining) return { posted: true };
        await DOMHelpers.randomDelay(400, 700);
    }
    if (logPrefix) logger.warn(`${logPrefix} composer still has text 4s after submit.`);
    return { posted: false, reason: 'composer-not-cleared' };
}

// ==================== Quota Gate Helper ====================
// Per-action gate + usage increment. Returns { allowed, reason, stopType }.
// stopType: 'hourly' | 'daily' | 'monthly' | 'cap' | null.

function classifyStop(reason) {
    if (!reason) return null;
    if (reason.startsWith('hourly_limit')) return 'hourly';
    if (reason.startsWith('daily_limit')) return 'daily';
    if (reason.startsWith('monthly_limit')) return 'monthly';
    if (reason.startsWith('cap_reached')) return 'cap';
    return null;
}

export async function gateAndConsume(platform, profileId, baseAction) {
    const limitAction = toLimitActions([baseAction])[0] || baseAction;
    const usageData = profileId ? await getAccountUsage(profileId) : null;
    const usage = usageData?.interactionUsage || {};
    const limit = await checkActionAllowed(platform, limitAction, usage);
    if (!limit.allowed) {
        return { allowed: false, reason: limit.reason, stopType: classifyStop(limit.reason) };
    }
    if (profileId) {
        await updateAccountUsage(profileId, baseAction);
    }
    return { allowed: true, reason: limit.reason, stopType: null };
}

// ==================== Main Engagement Runner ====================
// Runs inside ONE browser session. For each search keyword → scrape results
// (capped by maxResultsPerKeyword) → for each result: like → comment →
// per-comment like+reply. Per-action quota checks; hourly limit stops the
// whole run (account marked RATE_LIMITED, resume next hour); daily/monthly/
// cap stops permanently for this run.

export async function runSearchInteractEngagement(page, opts) {
    const {
        platform,
        platformConfig,
        ai,
        profileId,
        keywords,
        maxResultsPerKeyword = 5,
        maxRepliesPerPost = 3,
        stopAfterHours = 0,
        socialStrategyPrompt,
        taskId = 'session',
    } = opts;

    const s = platformConfig.selectors || {};
    const results = [];
    let stopType = null;          // 'hourly' | 'daily' | 'monthly' | 'cap'
    let stopReason = null;
    let captchaFailed = false;
    const startedAt = Date.now();

    const checkTimeStop = () => {
        if (stopAfterHours > 0) {
            const elapsedHours = (Date.now() - startedAt) / (1000 * 60 * 60);
            if (elapsedHours >= stopAfterHours) {
                stopType = 'time';
                stopReason = `interaction_stop_after_hours: ${elapsedHours.toFixed(2)}/${stopAfterHours}`;
                logger.info(`[engage:${taskId}] Time stop hit: ${stopReason}`);
                return true;
            }
        }
        return false;
    };

    const ensureCaptchaSolved = async (where) => {
        const visible = await isTikTokCaptchaVisible(page);
        if (!visible) return true;
        logger.info(`[engage:${taskId}] Captcha detected at ${where} — solving...`);
        const ok = await solveTikTokAudioCaptcha(page, `[engage:${taskId}]`);
        if (!ok) {
            captchaFailed = true;
            if (profileId) await updateAccountStatus(profileId, 'WAITING');
            stopType = 'captcha';
            stopReason = 'captcha_failed';
            return false;
        }
        return true;
    };

    // Logged-out detection: when the login modal appears the session is dead.
    // Skip the account immediately (no quota burn, no retries). Surfaced as
    // stopType='logged_out' so the task result shows LOGGED_OUT, not 0-scraped.
    const ensureLoggedIn = async (where) => {
        if (!(await isTikTokLoggedOut(page))) return true;
        logger.warn(`[engage:${taskId}] ACCOUNT_LOGGED_OUT: ${profileId || 'unknown'} at ${where} (${page.url()}) — skipping account.`);
        if (profileId) await updateAccountStatus(profileId, 'LOGGED_OUT');
        stopType = 'logged_out';
        stopReason = `logged_out_at_${where}`;
        return false;
    };

    // ---- D1: comment-list API observer (diagnostics) ----
    // Under automation the comment list sometimes never renders even though the
    // action bar shows a comment count. Log the raw comment API responses
    // (HTTP status + TikTok status_code + item count) so we can see whether the
    // request fired and what TikTok answered. Removed at run end.
    const onCommentApiResponse = (res) => {
        try {
            const u = res.url();
            if (!/comment/i.test(u)) return;
            if (!/list|feed|reply|detail/i.test(u)) return;
            logger.info(`[engage:${taskId}] comment-api: HTTP ${res.status()} ${u.substring(0, 140)}`);
            res.text().then((t) => {
                try {
                    const j = JSON.parse(t);
                    const list = j.comments || j?.data?.comments || j?.data?.comment_list || j?.data?.list || [];
                    const status = j.status_code ?? j?.status?.status_code ?? j?.statusMsg ?? 'n/a';
                    logger.info(`[engage:${taskId}] comment-api body: status_code=${status}, items=${Array.isArray(list) ? list.length : 'n/a'}, bytes=${t.length}`);
                } catch (e) {
                    logger.info(`[engage:${taskId}] comment-api body: non-JSON (${t.length} bytes)`);
                }
            }).catch(() => {});
        } catch (e) { /* ignore */ }
    };
    page.on('response', onCommentApiResponse);

    const pause = (min, max) => DOMHelpers.randomDelay(min, max);

    for (const keyword of keywords) {
        if (stopType) break;
        if (checkTimeStop()) break;
        try {
            // ---- Search ----
            logger.info(`[engage:${taskId}] Searching: "${keyword}"`);
            const searchUrl = `${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`;
            // Wait for a settled page (readyState complete + results/login/captcha
            // signal) instead of racing past domcontentloaded. ~20s budget.
            const nav = await navigateAndWait(page, searchUrl, s, {
                label: `search "${keyword}"`,
                logPrefix: `[engage:${taskId}]`,
            });
            if (!nav.ok) {
                logger.warn(`[engage:${taskId}] Keyword "${keyword}": navigation failed (${nav.error}) — skipping keyword.`);
                continue;
            }
            if (nav.state === 'captcha' && !(await ensureCaptchaSolved('search page'))) break;
            if (nav.state === 'logged_out' && !(await ensureLoggedIn('search page'))) break;
            // Re-verify (modal/captcha can render between poll and now).
            if (!(await ensureCaptchaSolved('search results'))) break;
            if (!(await ensureLoggedIn('search results'))) break;
            if (nav.state === 'unknown') {
                logger.warn(`[engage:${taskId}] Keyword "${keyword}": page never reached a settled state — skipping keyword (no silent 0-scrape).`);
                continue;
            }

            const extractor = platformConfig.extractors?.videos;
            let scraped = [];
            if (extractor) {
                try {
                    const parseFunc = new Function('items', 'return (' + extractor.parseFunction + '\n)(items);');
                    scraped = await page.$$eval(extractor.selector, parseFunc) || [];
                } catch (e) {
                    logger.warn(`[engage:${taskId}] Result extraction failed: ${e.message}`);
                }
            }
            // Prefer results with a URL; dedupe by URL so the same post is
            // never engaged twice (TikTok search often repeats items).
            const seenUrls = new Set();
            const resultsWithUrl = scraped.filter(v => v.url && !seenUrls.has(v.url) && seenUrls.add(v.url));
            logger.info(`[engage:${taskId}] Keyword "${keyword}": ${scraped.length} scraped, ${resultsWithUrl.length} unique with URLs. Cap=${maxResultsPerKeyword}`);

            const toProcess = resultsWithUrl.slice(0, maxResultsPerKeyword);
            for (let rIdx = 0; rIdx < toProcess.length; rIdx++) {
                if (stopType) break;
                if (checkTimeStop()) break;
                const video = toProcess[rIdx];
                try {
                    // ---- Open post ----
                    logger.info(`[engage:${taskId}] Opening post ${rIdx + 1}/${toProcess.length}: ${video.url}`);
                    // Wait for the post page to fully load + settle before engaging.
                    const postNav = await navigateAndWait(page, video.url, s, {
                        label: `post ${video.url}`,
                        logPrefix: `[engage:${taskId}]`,
                    });
                    if (!postNav.ok) {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: navigation failed (${postNav.error}) — skipping post.`);
                        results.push({ keyword, url: video.url, status: 'failed', error: `nav_failed: ${postNav.error}` });
                        continue;
                    }
                    if (postNav.state === 'captcha' && !(await ensureCaptchaSolved('post page'))) break;
                    if (postNav.state === 'logged_out' && !(await ensureLoggedIn('post page'))) break;
                    if (!(await ensureCaptchaSolved('post page'))) break;
                    if (!(await ensureLoggedIn('post page'))) break;
                    if (postNav.state === 'unknown') {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: page never reached a settled state — skipping post.`);
                        results.push({ keyword, url: video.url, status: 'failed', error: 'page_unsettled' });
                        continue;
                    }

                    // ---- Wait for the post action bar to hydrate before engaging ----
                    // navigateAndWait can return 'post' from the URL alone, before the
                    // action bar (Like/Comments) actually renders. Wait for it so the
                    // like/comments clicks target a fully-rendered page (switching tabs
                    // into a half-hydrated DOM was reverting the optimistic like).
                    try {
                        await page.waitForSelector(s.likeButton, { visible: true, timeout: 10000 });
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: action bar rendered.`);
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: action bar not detected within 10s — continuing (like may fail).`);
                    }

                    // Action-bar comment count — drives ensureCommentsVisible:
                    // count > 0 means an empty comment panel is a FAILURE state.
                    let expectedComments = 0;
                    try {
                        const cntText = await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el ? (el.textContent || '') : '';
                        }, s.commentCount).catch(() => '');
                        const m = String(cntText || '').replace(/,/g, '').match(/(\d+)/);
                        expectedComments = m ? parseInt(m[1], 10) : 0;
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: action bar comment count = ${expectedComments}.`);
                    } catch (e) { /* unknown → lenient mode */ }

                    // ---- Like the post ----
                    const likeGate = await gateAndConsume(platform, profileId, 'like');
                    if (!likeGate.allowed) {
                        stopType = likeGate.stopType;
                        stopReason = likeGate.reason;
                        logger.info(`[engage:${taskId}] Like blocked (${stopReason}) — stopping run.`);
                        break;
                    }
                    // Pre-check: clicking a heart that is ALREADY liked would
                    // unlike it (cross-run re-engagement of the same post).
                    const preSig = await isPostLiked(page, s);
                    if (preSig && preSig.state === true) {
                        logger.info(`[engage:${taskId}] Post already liked (${preSig.why}) — skipping like click.`);
                    } else {
                        const likeClicked = await DOMHelpers.clickElement(page, s.likeButton, { timeout: 5000, delay: 1000 }).catch(() => false);
                        logger.info(`[engage:${taskId}] Like ${likeClicked ? 'clicked' : 'NOT found'} (quota consumed anyway per policy).`);
                    }
                    // Patient settle: give TikTok time to commit the like server-side
                    // BEFORE we switch tabs. Switching too early was reverting the
                    // optimistic like (user-observed: "liked, then immediately
                    // unliked when the comments tab was clicked").
                    await pause(2500, 3500);

                    // ---- Switch to Comments tab (composer + list live here) ----
                    // Post pages open on "You may like"; the comment box and
                    // comment list only render after the Comments tab is active.
                    // When count > 0 but the list never renders, the comment
                    // phase is skipped entirely (user decision: no comment
                    // without seeing the thread first).
                    const ccRes = await ensureCommentsVisible(page, `[engage:${taskId}]`, expectedComments);
                    if (!ccRes.ok) {
                        const skipStatus = ccRes.reason === 'comments_not_loaded' ? 'comments_not_loaded' : 'engaged_no_comments_tab';
                        logger.warn(`[engage:${taskId}] Comments unavailable (${ccRes.reason}) — skipping comment + per-comment phase.`);
                        results.push({
                            keyword,
                            url: video.url,
                            author: video.author,
                            caption: (video.caption || '').substring(0, 120),
                            comment: '',
                            commentsProcessed: 0,
                            status: skipStatus,
                            expectedComments,
                        });
                        // Return to search results (no overlay close on direct URLs).
                        await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                        await pause(1200, 2000);
                        continue;
                    }

                    // Defensive: the Comments-tab switch can re-render the action bar
                    // and reset an optimistic like. Re-like ONLY on a confident
                    // "not liked" signal (aria-pressed=false or white heart) —
                    // a false negative here would click a liked post and UNLIKE
                    // it (the observed like/unlike flap). Verify after; never
                    // toggle more than once.
                    try {
                        const sig = await isPostLiked(page, s, `[engage:${taskId}] Post ${rIdx + 1}:`);
                        if (isConfidentlyUnliked(sig)) {
                            logger.warn(`[engage:${taskId}] Like reverted after Comments tab (why=${sig.why}) — re-liking once.`);
                            await DOMHelpers.clickElement(page, s.likeButton, { timeout: 4000, delay: 800 }).catch(() => {});
                            await pause(1200, 2000);
                            const after = await isPostLiked(page, s);
                            if (after && after.state === true) {
                                logger.info(`[engage:${taskId}] Re-like confirmed (aria-pressed=${after.ariaPressed ?? 'none'}).`);
                            } else {
                                logger.warn(`[engage:${taskId}] Re-like NOT confirmed (why=${after?.why ?? 'missing'}) — moving on (no retry).`);
                            }
                        }
                    } catch (e) { /* non-fatal */ }

                    // ---- AI understanding of the post (AFTER comments loaded) ----
                    // Comments + caption are what actually explain a post (photo
                    // posts have no readable caption element), so we analyze them
                    // together AFTER the comments panel has hydrated. This analysis
                    // feeds both the comment we post and the replies.
                    // Pass 1 (primary): text — caption + author + top-10 comments.
                    // Fallback: only if Pass 1 gives a bad result → vision on a
                    // post frame (video/photo) + caption. Replies reuse whichever
                    // result landed — no second vision pass.
                    let analyzedVideo = '';
                    let aiComments = [];   // pre-existing comments (AI context + tone fit)
                    let analysisMode = 'text';
                    let caption = '';
                    try {
                        const descText = await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.textContent.trim() : '';
                        }, s.browseDesc || '[data-e2e="browse-desc"]').catch(() => '');
                        caption = video.caption || descText || '';

                        // Let the comment list finish populating, then extract for AI.
                        await pause(1500, 2500);
                        const cExtractor = platformConfig.extractors?.comments;
                        if (cExtractor) {
                            const parseFunc = new Function('items', 'return (' + cExtractor.parseFunction + '\n)(items);');
                            aiComments = await page.$$eval(cExtractor.selector, parseFunc).catch(() => []) || [];
                        }
                        const commentLines = aiComments
                            .filter(c => c.text)
                            .slice(0, 10)
                            .map(c => `- ${c.username ? c.username + ': ' : ''}${c.text}`)
                            .join('\n');

                        const postContext = [
                            `Caption: ${caption || 'n/a'}`,
                            `Author: ${video.author || 'unknown'}`,
                            commentLines
                                ? `Existing comments (what people are saying):\n${commentLines}`
                                : 'Existing comments: none yet',
                        ].join('\n');
                        const analyzePrompt = `${platformConfig.aiPrompts?.analyzeVideo || 'Summarize this post.'}\n\nUnderstand this post from its caption and the existing comments — the comments reveal what the post is about.\n\nPost:\n${postContext}`;
                        analyzedVideo = ai ? await ai.generate(analyzePrompt) : postContext;
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI text analysis failed: ${e.message}`);
                        analyzedVideo = video.caption || '';
                        analysisMode = 'text_failed';
                    }

                    // Quality gate: Pass 1 must return a usable description. Weak
                    // or failed text → single vision fallback (frame + caption).
                    const textResult = String(analyzedVideo || '').trim();
                    const weakResult = (v) => v.length < 40
                        || /^(could not analyze|ai not available|no ai providers)/i.test(v);
                    const textGood = analysisMode !== 'text_failed' && !weakResult(textResult);
                    if (!textGood) {
                        logger.info(`[engage:${taskId}] Text analysis weak (${textResult.length} chars, ${analysisMode}) — trying vision fallback (frame + caption).`);
                        try {
                            const frame = await capturePostFrame(page);
                            if (frame && ai) {
                                const visionPrompt = `${platformConfig.aiPrompts?.analyzeVideo || 'Summarize this post.'}\n\nThis is a screenshot of the post itself (a video frame or a photo). Describe what is actually shown in it. Use the caption for context.\n\nCaption: ${caption || 'n/a'}\nAuthor: ${video.author || 'unknown'}`;
                                const visionResult = String(await ai.generate(visionPrompt, { imageBase64: frame }) || '').trim();
                                if (!weakResult(visionResult)) {
                                    analyzedVideo = visionResult;
                                    analysisMode = 'vision';
                                } else {
                                    logger.warn(`[engage:${taskId}] Vision result weak — keeping text/caption fallback.`);
                                }
                            } else if (!frame) {
                                logger.warn(`[engage:${taskId}] No post frame captured — keeping text/caption fallback.`);
                            }
                        } catch (ve) {
                            logger.warn(`[engage:${taskId}] Vision fallback failed: ${ve.message}`);
                        }
                    }
                    if (!String(analyzedVideo || '').trim()) {
                        analyzedVideo = video.caption || '';
                    }
                    logger.info(`[engage:${taskId}] AI analysis ready (mode=${analysisMode}, caption ${caption ? 'yes' : 'no'}, ${aiComments.length} comments in context).`);

                    // ---- Generate + post contextual comment ----
                    let generatedComment = '';
                    const commentGate = await gateAndConsume(platform, profileId, 'comment');
                    if (!commentGate.allowed) {
                        stopType = commentGate.stopType;
                        stopReason = commentGate.reason;
                        logger.info(`[engage:${taskId}] Comment blocked (${stopReason}) — stopping run.`);
                        break;
                    }
                    try {
                        const recentLines = aiComments.filter(c => c.text).slice(0, 5).map(c => `- ${c.text}`).join('\n');
                        const genPrompt = `${platformConfig.aiPrompts?.generateComment || 'Write a natural comment.'}\n\n${socialStrategyPrompt ? 'Strategy: ' + socialStrategyPrompt + '\n' : ''}Post analysis: ${analyzedVideo}${recentLines ? `\nExisting comments (so yours fits the conversation):\n${recentLines}` : ''}`;
                        generatedComment = ai ? await ai.generate(genPrompt) : 'Great post!';
                        generatedComment = String(generatedComment).replace(/^["']|["']$/g, '').trim().slice(0, 150);
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI comment generation failed: ${e.message}`);
                        generatedComment = 'Nice share!';
                    }
                    if (generatedComment) {
                        const postRes = await postCommentVerified(page, s, generatedComment, `[engage:${taskId}]`).catch(err => ({ posted: false, reason: err.message }));
                        if (postRes.posted) {
                            logger.info(`[engage:${taskId}] Comment posted: "${generatedComment.substring(0, 60)}..."`);
                        } else {
                            logger.warn(`[engage:${taskId}] Comment NOT posted (${postRes.reason}) — skipping comment.`);
                            generatedComment = '';
                        }
                    }
                    await pause(1500, 2500);

                    // ---- Per-comment like + reply ----
                    let comments = [];
                    try {
                        const cExtractor = platformConfig.extractors?.comments;
                        if (cExtractor) {
                            const parseFunc = new Function('items', 'return (' + cExtractor.parseFunction + '\n)(items);');
                            comments = await page.$$eval(cExtractor.selector, parseFunc) || [];
                        }
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] Comment extraction failed: ${e.message}`);
                    }
                    // Exclude our own just-posted comment if identifiable; bound by maxRepliesPerPost.
                    const targetComments = comments.filter(c => c.text && c.text !== generatedComment).slice(0, maxRepliesPerPost);
                    logger.info(`[engage:${taskId}] ${comments.length} comments extracted, processing ${targetComments.length}.`);

                    for (const comment of targetComments) {
                        if (stopType) break;
                        // Like the comment
                        const likeCGate = await gateAndConsume(platform, profileId, 'likeComment');
                        if (!likeCGate.allowed) {
                            stopType = likeCGate.stopType;
                            stopReason = likeCGate.reason;
                            logger.info(`[engage:${taskId}] Comment-like blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        // Click the like icon within this comment's container by index.
                        try {
                            const likedC = await page.evaluate((cIdx) => {
                                const containers = document.querySelectorAll("div[class*='DivCommentItemContainer']");
                                const el = containers[cIdx];
                                if (!el) return false;
                                const likeIcon = el.querySelector("div[data-e2e='comment-like-icon'], [data-e2e='comment-like-icon']");
                                if (!likeIcon) return false;
                                // Don't double-like: parent aria-pressed or the icon's active state.
                                const pressed = likeIcon.closest('[aria-pressed="true"]') || likeIcon.querySelector('[aria-pressed="true"]');
                                if (pressed) return false;
                                likeIcon.click();
                                return true;
                            }, comment.index);
                            logger.info(`[engage:${taskId}] Comment like ${likedC ? 'clicked' : 'skipped (already liked or not found)'}.`);
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment like click failed: ${e.message}`);
                        }
                        await pause(800, 1500);

                        // Reply to the comment via commentComment
                        const replyGate = await gateAndConsume(platform, profileId, 'commentComment');
                        if (!replyGate.allowed) {
                            stopType = replyGate.stopType;
                            stopReason = replyGate.reason;
                            logger.info(`[engage:${taskId}] Comment reply blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        try {
                            // Click the Reply button in this comment's container.
                            const replyClicked = await page.evaluate((cIdx) => {
                                const containers = document.querySelectorAll("div[class*='DivCommentItemContainer']");
                                const el = containers[cIdx];
                                if (!el) return false;
                                const reply = el.querySelector("span[data-e2e='comment-reply-1'], span[data-e2e^='comment-reply-'], [aria-label='Reply']");
                                if (!reply) return false;
                                reply.click();
                                return true;
                            }, comment.index);
                            if (replyClicked) {
                                await pause(800, 1500);
                                let replyText = '';
                                try {
                                    // Reply reuses the already-loaded analysis — no new
                                    // video/vision capture here (post knowledge is in analyzedVideo).
                                    const replyPrompt = `${platformConfig.aiPrompts?.replyToComment || 'Reply briefly.'}\n\nVideo analysis: ${analyzedVideo}\nYour comment: ${generatedComment}\nComment to reply to: ${comment.text}`;
                                    replyText = ai ? await ai.generate(replyPrompt) : '🙏';
                                    replyText = String(replyText).replace(/^["']|["']$/g, '').trim().slice(0, 120);
                                } catch (e) {
                                    replyText = '🙌';
                                }
                                if (replyText) {
                                    const replyRes = await postCommentVerified(page, s, replyText, `[engage:${taskId}]`).catch(err => ({ posted: false, reason: err.message }));
                                    if (replyRes.posted) {
                                        logger.info(`[engage:${taskId}] Replied to comment ${comment.index}: "${replyText.substring(0, 50)}..."`);
                                    } else {
                                        logger.warn(`[engage:${taskId}] Reply NOT posted for comment ${comment.index} (${replyRes.reason}).`);
                                    }
                                }
                            } else {
                                logger.warn(`[engage:${taskId}] Reply button not found for comment ${comment.index}.`);
                            }
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment reply failed: ${e.message}`);
                        }
                        await pause(1000, 2000);
                    }

                    results.push({
                        keyword,
                        url: video.url,
                        author: video.author,
                        caption: (video.caption || '').substring(0, 120),
                        comment: generatedComment,
                        commentsProcessed: targetComments.length,
                        status: 'engaged',
                    });
                    logger.info(`[engage:${taskId}] Post ${rIdx + 1} engaged successfully.`);

                    // Close overlay / return to results. Direct /photo/ URLs
                    // have no overlay close button — fall back to navigating
                    // back to the search page instead of timing out.
                    const closed = await DOMHelpers.clickElement(page, s.browseClose, { timeout: 3000, delay: 800 }).catch(() => false);
                    if (!closed) {
                        await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                    }
                    await pause(1200, 2000);

                } catch (postErr) {
                    logger.warn(`[engage:${taskId}] Post ${rIdx + 1} failed: ${postErr.message}`);
                    results.push({ keyword, url: video.url, status: 'failed', error: postErr.message });
                    // Try to recover: navigate back to search.
                    await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                    await pause(1500, 2500);
                }
            }
        } catch (kwErr) {
            logger.warn(`[engage:${taskId}] Keyword "${keyword}" failed: ${kwErr.message}`);
        }
    }

    page.off('response', onCommentApiResponse);

    if (stopType === 'hourly' && profileId) {
        await updateAccountStatus(profileId, 'RATE_LIMITED');
        logger.info(`[engage:${taskId}] Hourly limit hit — account ${profileId} marked RATE_LIMITED. Resume next hour-cycle.`);
    } else if (stopType === 'logged_out') {
        logger.warn(`[engage:${taskId}] Account ${profileId} was logged out — skipped immediately (${stopReason}).`);
    } else if ((stopType === 'daily' || stopType === 'monthly' || stopType === 'cap') && profileId) {
        logger.info(`[engage:${taskId}] Permanent limit hit (${stopType}: ${stopReason}) — stopping run for account ${profileId}.`);
    } else if (captchaFailed) {
        logger.warn(`[engage:${taskId}] Captcha solve failed — account ${profileId} set WAITING.`);
    }

    return {
        results,
        stopType,
        stopReason,
        captchaFailed,
        engaged: results.filter(r => r.status === 'engaged').length,
        failed: results.filter(r => r.status === 'failed').length,
    };
}
