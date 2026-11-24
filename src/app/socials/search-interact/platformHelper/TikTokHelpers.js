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
                { text: 'This is an audio CAPTCHA code. Transcribe the spoken code EXACTLY. CRITICAL: return ONLY the code characters, with NO spaces, NO punctuation, NO quotation marks, NO explanation. Distinguish letters from digits: if you hear the letter S write S (not 5); if you hear the digit 5 write 5 (not S). Example: hearing "S R P L B" means the answer is "SRPLB".' },
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

// All known TikTok TUX captcha container variants. TikTok ships several shells:
// #captcha-verify-container-main-page (older), #captcha-verify-container and
// .captcha-verify-container (newer), plus the always-present switch button.
export const TIKTOK_CAPTCHA_SELECTORS = [
    '#captcha-verify-container-main-page',
    '#captcha-verify-container',
    '.captcha-verify-container',
];

export async function isTikTokCaptchaVisible(page) {
    try {
        return await page.evaluate((sels) => {
            const isVisible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return false;
                const cs = getComputedStyle(el);
                return cs.visibility !== 'hidden' && cs.display !== 'none';
            };
            for (const sel of sels) {
                if (isVisible(document.querySelector(sel))) return true;
            }
            // Fallback: the switch button is unique to the captcha widget.
            if (isVisible(document.querySelector('#captcha_switch_button'))) return true;
            // Heading text used by both puzzle and audio variants.
            const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"],div'));
            if (headings.some(el => isVisible(el) && /^(Verify identity|Drag the puzzle piece into place|Play the audio and enter the code you hear|Slide to complete the puzzle)/i.test((el.textContent || '').trim().slice(0, 80)))) return true;
            return false;
        }, TIKTOK_CAPTCHA_SELECTORS);
    } catch (e) {
        return false;
    }
}

// Find the first visible captcha container from the known variants.
async function findCaptchaRoot(page) {
    for (const sel of TIKTOK_CAPTCHA_SELECTORS) {
        const found = await page.evaluate((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }, sel).catch(() => false);
        if (found) return sel;
    }
    return null;
}

// Real mouse click at the element's center (TUX ignores synthetic .click() on some builds).
async function realClick(page, selector, logPrefix, label) {
    try {
        const handle = await page.$(selector);
        if (!handle) return false;
        const box = await handle.boundingBox();
        if (!box) { await handle.dispose().catch(() => {}); return false; }
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await handle.dispose().catch(() => {});
        logger.info(`${logPrefix} Real-clicked ${label} at (${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)})`);
        return true;
    } catch (e) {
        logger.warn(`${logPrefix} Real-click ${label} failed: ${e.message}`);
        return false;
    }
}

export async function solveTikTokAudioCaptcha(page, logPrefix = '[tiktokCaptcha]') {
    const MAX_ATTEMPTS = 3;
    const containerSel = await findCaptchaRoot(page) || TIKTOK_CAPTCHA_SELECTORS[0];
    logger.info(`${logPrefix} Solving captcha (container=${containerSel})`);
    let replayedSameAudio = false; // one replay of the same clip before spending a new signed URL
    try {
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            logger.info(`${logPrefix} Audio captcha attempt ${attempt}/${MAX_ATTEMPTS}...`);
            if (!(await isTikTokCaptchaVisible(page))) { logger.info(`${logPrefix} Captcha gone before attempt — treating as solved.`); return true; }

            // Ensure AUDIO mode. Switch button label "Audio" = currently on IMAGE → click to switch to audio.
            try {
                const switchLabel = await page.evaluate(() => {
                    const btn = document.querySelector('#captcha_switch_button');
                    const label = btn ? btn.querySelector('.TUXButton-label') : null;
                    return label ? label.textContent.trim() : null;
                });
                if (switchLabel === 'Audio') {
                    const ok = await realClick(page, '#captcha_switch_button', logPrefix, 'Audio switch');
                    if (!ok) await page.evaluate(() => document.querySelector('#captcha_switch_button')?.click()).catch(() => {});
                    await new Promise(r => setTimeout(r, 1800));
                    logger.info(`${logPrefix} Switched from image to audio mode.`);
                } else {
                    logger.info(`${logPrefix} Already in audio mode (switch label=${switchLabel}).`);
                }
            } catch (e) { logger.warn(`${logPrefix} switch check failed: ${e.message}`); }

            // Read audio src (preload=none; click Play to force load if absent).
            const readAudioUrl = () => page.evaluate((sel) => {
                const el = document.querySelector(`${sel} audio`);
                return el ? (el.getAttribute('src') || el.src) : null;
            }, containerSel).catch(() => null);
            const clickPlay = () => realClick(page, `${containerSel} button[aria-label="Play"], #captcha-verify-container button[aria-label="Play"]`, logPrefix, 'Play').catch(() => false);
            // After Refresh the old signed URL stays in the DOM briefly. Reading
            // it immediately gives a stale signature → instant download failures.
            // Wait until the <audio src> actually changes.
            const refreshChallenge = async () => {
                const before = await readAudioUrl();
                await realClick(page, '#captcha_refresh_button', logPrefix, 'Refresh').catch(() => false);
                for (let w = 0; w < 12; w++) {
                    await new Promise(r => setTimeout(r, 400));
                    const now = await readAudioUrl();
                    if (now && now !== before) { logger.info(`${logPrefix} New audio URL after refresh.`); return now; }
                }
                return await readAudioUrl();
            };

            let audioUrl = await readAudioUrl();
            if (!audioUrl) {
                await clickPlay();
                await new Promise(r => setTimeout(r, 1500));
                audioUrl = await readAudioUrl();
            }
            if (!audioUrl) {
                logger.warn(`${logPrefix} No audio src found in captcha container — refreshing challenge.`);
                audioUrl = await refreshChallenge();
                if (!audioUrl) continue;
            }
            logger.info(`${logPrefix} Audio URL obtained (${audioUrl.length} chars).`);

            // Download + transcribe via Gemini. A signed URL can go stale after
            // several refreshes — click Play and re-read once before giving up.
            let audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 }).catch(() => null);
            if (!audioResp || !audioResp.data) {
                await clickPlay();
                await new Promise(r => setTimeout(r, 1200));
                const fresh = await readAudioUrl();
                if (fresh && fresh !== audioUrl) {
                    audioUrl = fresh;
                    logger.info(`${logPrefix} Retrying download with refreshed audio URL.`);
                    audioResp = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 }).catch(() => null);
                }
            }
            if (!audioResp || !audioResp.data) { logger.warn(`${logPrefix} Failed to download captcha audio.`); continue; }
            const audioBase64 = Buffer.from(audioResp.data).toString('base64');
            let transcribed = '';
            try { transcribed = await transcribeAudioBase64Gemini(audioBase64); }
            catch (e) { logger.error(`${logPrefix} Gemini transcription failed: ${e.message}`); continue; }
            if (!transcribed) { logger.warn(`${logPrefix} Gemini returned empty transcription.`); continue; }
            // TikTok wants a compact code ("SRPLB"), not spaced letters
            // ("S R P L B"). Strip ALL non-alphanumerics before typing.
            const answer = transcribed.replace(/[^A-Za-z0-9]/g, '').trim();
            logger.info(`${logPrefix} Audio transcribed: "${transcribed.trim()}" → answer "${answer}"`);
            if (!answer) { logger.warn(`${logPrefix} Empty answer after normalization — refreshing.`); audioUrl = await refreshChallenge(); continue; }

            // Type into the input via React-compatible native setter.
            // NOTE: page.evaluate forwards only ONE argument to the page
            // function — pass { text, sel } as a single object (the old two-arg
            // form left `sel` undefined and worked only via the global fallback).
            const typed = await page.evaluate(({ text, sel }) => {
                const input = document.querySelector(`${sel} input.TUXTextInputCore-input, ${sel} input[placeholder="Enter what you hear"], input[placeholder="Enter what you hear"]`);
                if (!input) return null;
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                setter ? setter.call(input, text) : (input.value = text);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                return input.value;
            }, { text: answer, sel: containerSel });
            logger.info(`${logPrefix} Typed transcription into captcha input (value="${typed}").`);
            await new Promise(r => setTimeout(r, 600));

            // Wait for Verify to become ENABLED (was the failure: clicking a disabled button).
            let verifyEnabled = false;
            for (let w = 0; w < 10; w++) {
                verifyEnabled = await page.evaluate((sel) => {
                    const buttons = Array.from(document.querySelectorAll(`${sel} button, button`));
                    const verify = buttons.find(b => {
                        const label = b.querySelector('.TUXButton-label');
                        return label && label.textContent.trim() === 'Verify';
                    });
                    return !!verify && verify.getAttribute('aria-disabled') !== 'true' && !verify.classList.contains('TUXButton--disabled');
                }, containerSel).catch(() => false);
                if (verifyEnabled) break;
                await new Promise(r => setTimeout(r, 400));
            }
            logger.info(`${logPrefix} Verify button ${verifyEnabled ? 'ENABLED' : 'STILL DISABLED'}.`);
            if (!verifyEnabled) {
                logger.warn(`${logPrefix} Verify stayed disabled (transcription likely not accepted) — refreshing challenge.`);
                audioUrl = await refreshChallenge();
                continue;
            }

            // Click Verify with a REAL mouse click, locating it by its label text.
            const verifyClicked = await page.evaluate((sel) => {
                const verify = Array.from(document.querySelectorAll(`${sel} button`)).find(b => {
                    const l = b.querySelector('.TUXButton-label');
                    return l && l.textContent.trim() === 'Verify';
                });
                if (!verify) return false;
                verify.setAttribute('data-captcha-verify', '1');
                return true;
            }, containerSel).catch(() => false);
            if (verifyClicked) {
                await realClick(page, 'button[data-captcha-verify="1"]', logPrefix, 'Verify');
            }
            logger.info(`${logPrefix} Clicked Verify. Waiting for result...`);
            await new Promise(r => setTimeout(r, 4500));

            if (!(await isTikTokCaptchaVisible(page))) {
                logger.info(`${logPrefix} Captcha SOLVED on attempt ${attempt}.`);
                return true;
            }
            // A wrong answer is often just a bad transcription — replay the
            // SAME clip once (no new signed URL) before refreshing.
            if (!replayedSameAudio) {
                replayedSameAudio = true;
                logger.warn(`${logPrefix} Attempt ${attempt} rejected the answer — replaying same audio once before refresh.`);
                await clickPlay();
                await new Promise(r => setTimeout(r, 1200));
                continue;
            }
            logger.warn(`${logPrefix} Attempt ${attempt} failed (captcha still visible). Refreshing...`);
            audioUrl = await refreshChallenge();
        }
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
            const visible = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                return r.width >= 1 && r.height >= 1;
            };
            const loginTitle = document.querySelector('h2[data-e2e="login-title"]');
            if (loginTitle && loginTitle.textContent.includes('Log in')) return true;
            if (document.querySelector('#login-modal-title')) return true;
            if (document.querySelector("div[class*='DivLoginContainer']")) return true;
            if (location.href.includes('/login')) return true;
            // Logged-out SEARCH page shows a nav "Log in" button (no modal).
            // Observed: page body "... Log in Company Programme ..." with no
            // results and no avatar. Guard against false positives: only treat
            // the nav button as logged-out when there is NO visible signed-in
            // avatar in the nav/header.
            const navLogin = document.querySelector("button[data-e2e='login-button'], [data-e2e='login-button']");
            if (visible(navLogin)) {
                const selfAvatar = document.querySelector(
                    "[data-e2e='nav-avatar'], a[href='/profile'], a[href*='/profile/'], [aria-label='Profile'] img"
                );
                if (!visible(selfAvatar)) return true;
            }
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
            // Captcha first — it overlays everything. Match all TUX variants.
            for (const cs of ['#captcha-verify-container-main-page', '#captcha-verify-container', '.captcha-verify-container']) {
                if (visible(document.querySelector(cs))) return 'captcha';
            }
            if (visible(document.querySelector('#captcha_switch_button'))) return 'captcha';
            // Logged-out login modal.
            const loginTitle = document.querySelector('h2[data-e2e="login-title"]');
            if (loginTitle && loginTitle.textContent.includes('Log in')) return 'logged_out';
            if (visible(document.querySelector('#login-modal-title'))) return 'logged_out';
            if (visible(document.querySelector("div[class*='DivLoginContainer']"))) return 'logged_out';
            if (location.href.includes('/login')) return 'logged_out';
            // Nav "Log in" button with no signed-in avatar = logged-out search page.
            const navLogin = document.querySelector("button[data-e2e='login-button'], [data-e2e='login-button']");
            if (visible(navLogin)) {
                const selfAvatar = document.querySelector("[data-e2e='nav-avatar'], a[href='/profile'], a[href*='/profile/'], [aria-label='Profile'] img");
                if (!visible(selfAvatar)) return 'logged_out';
            }
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

    const targetAweme = (String(url || '').match(/\/(\d{15,})/) || [])[1] || null;
    let navError = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
        navError = null;
        let navDone = false;

        // Start goto in background
        const gotoPromise = page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: NAV_RETRY_TIMEOUT_MS,
        }).then(() => {
            navDone = true;
        }).catch((e) => {
            navDone = true;
            navError = e;
        });

        // Concurrently poll for early readiness: check if the browser has already
        // arrived on the target post/page and the DOM is rendering.
        // TikTok video streams / service workers frequently delay the DOMContentLoaded event
        // past 25s even after the page, video, and action-bar are fully interactive.
        const pollStart = Date.now();
        let earlyReady = false;
        while (Date.now() - pollStart < NAV_RETRY_TIMEOUT_MS) {
            if (navDone) break;
            try {
                const currentUrl = page.url() || '';
                const onTarget = targetAweme
                    ? currentUrl.includes(targetAweme)
                    : (String(url).includes('/search')
                        ? currentUrl.includes('/search')
                        : (/tiktok\.com\/@[^/]+\/(photo|video)\//.test(currentUrl)));
                if (onTarget) {
                    const hasKeyElements = await page.evaluate((likeSel) => {
                        return !!(
                            (likeSel && document.querySelector(likeSel)) ||
                            document.querySelector("[data-e2e='browse-like-icon'], [data-e2e='browse-comment-icon'], [data-e2e='browse-desc'], [data-e2e='like-icon']") ||
                            document.querySelector("div[class*='DivVideoDetailContainer'], main[class*='DivVideoContainer'], [id*='search_top-item-list']")
                        );
                    }, s.likeButton).catch(() => false);

                    if (hasKeyElements) {
                        logger.info(`${logPrefix} Post/page DOM rendered early on ${label} (${currentUrl}). Proceeding without waiting for background streams.`);
                        earlyReady = true;
                        navError = null;
                        break;
                    }
                }
            } catch (_) {}
            await new Promise(r => setTimeout(r, 600));
        }

        if (earlyReady) {
            break;
        }

        await gotoPromise;

        if (navError) {
            logger.warn(`${logPrefix} Navigation to ${label} failed (attempt ${attempt}/2): ${navError.message}`);
            const isDetached = /detached Frame|context was destroyed/i.test(navError.message || '');
            // Check if despite the error (e.g. Navigation timeout), the page is on target.
            // CRITICAL: never accept a stale URL as success when the goto failed with a
            // detached frame — that masks the dead frame and burns every remaining
            // keyword against it (the page.url() still shows the PREVIOUS /search URL).
            if (!isDetached) {
                try {
                    const currentUrl = page.url() || '';
                    const onTarget = targetAweme
                        ? currentUrl.includes(targetAweme)
                        : (String(url).includes('/search')
                            ? currentUrl.includes('/search')
                            : (/tiktok\.com\/@[^/]+\/(photo|video)\//.test(currentUrl)));
                    if (onTarget) {
                        logger.info(`${logPrefix} Navigation timeout on ${label}, but browser reached target URL (${currentUrl}). Continuing.`);
                        navError = null;
                        break;
                    }
                } catch (_) {}
            }

            if (isDetached) {
                // In-flight navigation or frame swap destroyed execution context.
                // Same-page retries keep hitting the dead frame, so navigate to
                // about:blank to force a fresh frame before the retry goto.
                logger.warn(`${logPrefix} Detached frame on ${label} — resetting page to about:blank before retry.`);
                await new Promise(r => setTimeout(r, 1200));
                try { await page.mainFrame(); } catch (_) {}
                try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }); } catch (_) {}
            }
            if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
        } else {
            break;
        }
    }

    if (navError) {
        return { ok: false, state: 'nav_failed', url: (() => { try { return page.url(); } catch (_) { return ''; } })(), error: navError.message, detached: /detached Frame|context was destroyed/i.test(navError.message) };
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
        const onTarget = targetAweme
            ? finalUrl.includes(targetAweme)
            : (/tiktok\.com\/@[^/]+\/(photo|video)\//.test(finalUrl));
        if (onTarget) {
            state = 'post';
        } else {
            // Log what the page actually shows so ambiguity is never silent.
            let snippet = '';
            try {
                snippet = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200));
            } catch (e) { /* ignore */ }
            logger.warn(`${logPrefix} ${label} UNRESOLVED after ${settleTimeoutMs}ms: url=${finalUrl} readyState=${await page.evaluate(() => document.readyState).catch(() => '?')} body="${snippet}"`);
        }
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

export async function ensureCommentsVisible(page, logPrefix = '[tiktokComments]', expectedCount = null, captchaCheck = null) {
    try {
        // USER-OBSERVED (Nov 2026): the TUX captcha (slide puzzle / audio) pops
        // at the exact moment the Comments tab is clicked. The caller's guard
        // runs BEFORE that click and cannot see it, so the caller passes a
        // callback that solves it in place and blocks here (no navigation).
        let captchaBlocked = false;
        const captchaAbort = () => ({ ok: false, state: null, items: 0, reason: 'captcha_failed' });
        const guardCaptcha = async (where) => {
            if (captchaBlocked || typeof captchaCheck !== 'function') return !captchaBlocked;
            let res;
            try { res = await captchaCheck(where); }
            catch (e) { logger.warn(`${logPrefix} captcha check failed at ${where}: ${e.message}`); return true; }
            const ok = res && typeof res === 'object' ? res.ok !== false : res !== false;
            if (!ok) {
                captchaBlocked = true;
                logger.warn(`${logPrefix} CAPTCHA_UNSOLVED at ${where} — aborting comments phase (no navigation).`);
            }
            return ok;
        };

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
                // Captcha can appear slightly AFTER the tab click, while the
                // comment list is still loading. Detect + solve here too.
                if (!(await guardCaptcha('while comments load'))) return snap;
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
            // USER-OBSERVED: captcha is triggered by this first click in some
            // sessions. Check IMMEDIATELY — the pre-click guard cannot see it.
            if (!(await guardCaptcha('right after Comments-tab click'))) return captchaAbort();
            // First click may have activated "You may like" — click Comments again.
            await new Promise(r => setTimeout(r, 1400));
            const reClicked = await clickTab('Comments');
            if (reClicked) logger.info(`${logPrefix} Second Comments-tab click (first may have opened "You may like").`);
            // The second tab click is another known trigger point.
            if (!(await guardCaptcha('after second Comments-tab click'))) return captchaAbort();
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
        if (captchaBlocked) return captchaAbort();
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
            if (captchaBlocked) return captchaAbort();
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
                if (captchaBlocked) return captchaAbort();
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
                if (captchaBlocked) return captchaAbort();
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
        if (captchaBlocked) return captchaAbort();
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
