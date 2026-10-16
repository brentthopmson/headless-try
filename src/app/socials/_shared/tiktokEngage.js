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

    const pause = (min, max) => DOMHelpers.randomDelay(min, max);

    for (const keyword of keywords) {
        if (stopType) break;
        if (checkTimeStop()) break;
        try {
            // ---- Search ----
            logger.info(`[engage:${taskId}] Searching: "${keyword}"`);
            const searchUrl = `${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`;
            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: platformConfig.timing?.navigationTimeout || 15000 }).catch(() => {});
            await pause(2000, 3500);
            if (!(await ensureCaptchaSolved('search page'))) break;

            // Wait for results container then extract.
            await page.waitForSelector(s.searchResultsContainer || s.searchResultItem, { timeout: 8000 }).catch(() => {});
            await pause(1500, 2500);
            if (!(await ensureCaptchaSolved('search results'))) break;

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
            // Prefer results with a URL; fall back to clicking grid items by index.
            const resultsWithUrl = scraped.filter(v => v.url);
            logger.info(`[engage:${taskId}] Keyword "${keyword}": ${scraped.length} scraped, ${resultsWithUrl.length} with URLs. Cap=${maxResultsPerKeyword}`);

            const toProcess = resultsWithUrl.slice(0, maxResultsPerKeyword);
            for (let rIdx = 0; rIdx < toProcess.length; rIdx++) {
                if (stopType) break;
                if (checkTimeStop()) break;
                const video = toProcess[rIdx];
                try {
                    // ---- Open post ----
                    logger.info(`[engage:${taskId}] Opening post ${rIdx + 1}/${toProcess.length}: ${video.url}`);
                    await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: platformConfig.timing?.navigationTimeout || 15000 }).catch(() => {});
                    await pause(2500, 4000);
                    if (!(await ensureCaptchaSolved('post page'))) break;

                    // ---- AI analysis of post content ----
                    let analyzedVideo = '';
                    try {
                        const descText = await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.textContent.trim() : '';
                        }, s.browseDesc || '[data-e2e="browse-desc"]').catch(() => '');
                        const postContext = `Caption: ${video.caption || descText}\nAuthor: ${video.author || 'unknown'}`;
                        const analyzePrompt = `${platformConfig.aiPrompts?.analyzeVideo || 'Summarize this post.'}\n\nPost: ${postContext}`;
                        analyzedVideo = ai ? await ai.generate(analyzePrompt) : postContext;
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI analysis failed: ${e.message}`);
                        analyzedVideo = video.caption || '';
                    }

                    // ---- Like the post ----
                    const likeGate = await gateAndConsume(platform, profileId, 'like');
                    if (!likeGate.allowed) {
                        stopType = likeGate.stopType;
                        stopReason = likeGate.reason;
                        logger.info(`[engage:${taskId}] Like blocked (${stopReason}) — stopping run.`);
                        break;
                    }
                    const likeClicked = await DOMHelpers.clickElement(page, s.likeButton, { timeout: 5000, delay: 1000 }).catch(() => false);
                    logger.info(`[engage:${taskId}] Like ${likeClicked ? 'clicked' : 'NOT found'} (quota consumed anyway per policy).`);
                    await pause(1200, 2200);

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
                        const genPrompt = `${platformConfig.aiPrompts?.generateComment || 'Write a natural comment.'}\n\n${socialStrategyPrompt ? 'Strategy: ' + socialStrategyPrompt + '\n' : ''}Video analysis: ${analyzedVideo}`;
                        generatedComment = ai ? await ai.generate(genPrompt) : 'Great post!';
                        generatedComment = String(generatedComment).replace(/^["']|["']$/g, '').trim().slice(0, 150);
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI comment generation failed: ${e.message}`);
                        generatedComment = 'Nice share!';
                    }
                    if (generatedComment) {
                        const typed = await DOMHelpers.typeText(page, s.commentBox, generatedComment, { delay: 40 }).catch(() => false);
                        if (typed) {
                            await pause(600, 1200);
                            await DOMHelpers.clickElement(page, s.commentSubmit, { timeout: 5000, delay: 1500 }).catch(() => false);
                            logger.info(`[engage:${taskId}] Comment posted: "${generatedComment.substring(0, 60)}..."`);
                        } else {
                            logger.warn(`[engage:${taskId}] Comment box not found — skipping comment.`);
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
                                    const replyPrompt = `${platformConfig.aiPrompts?.replyToComment || 'Reply briefly.'}\n\nVideo analysis: ${analyzedVideo}\nYour comment: ${generatedComment}\nComment to reply to: ${comment.text}`;
                                    replyText = ai ? await ai.generate(replyPrompt) : '🙏';
                                    replyText = String(replyText).replace(/^["']|["']$/g, '').trim().slice(0, 120);
                                } catch (e) {
                                    replyText = '🙌';
                                }
                                if (replyText) {
                                    await DOMHelpers.typeText(page, s.commentBox, replyText, { delay: 40 }).catch(() => false);
                                    await pause(500, 1000);
                                    await DOMHelpers.clickElement(page, s.commentSubmit, { timeout: 5000, delay: 1200 }).catch(() => false);
                                    logger.info(`[engage:${taskId}] Replied to comment ${comment.index}: "${replyText.substring(0, 50)}..."`);
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

                    // Close overlay / return to results.
                    await DOMHelpers.clickElement(page, s.browseClose, { timeout: 3000, delay: 800 }).catch(() => {});
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

    if (stopType === 'hourly' && profileId) {
        await updateAccountStatus(profileId, 'RATE_LIMITED');
        logger.info(`[engage:${taskId}] Hourly limit hit — account ${profileId} marked RATE_LIMITED. Resume next hour-cycle.`);
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
