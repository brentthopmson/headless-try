// Generic engagement runner for non-TikTok search-interact platforms
// (YouTube, X/Twitter, Instagram, Facebook, Quora).
// Mirrors the TikTok runner's *shape* — search → open post → verified like →
// open comments → extract → analyze (vision fallback when media exists) →
// voice-framed main comment → verified post → quota — but every DOM step is
// driven by platformConfigs.selectors / extractors so each platform's UI/UX
// differs only in config, not in duplicated logic.
// Per-comment like/reply waves are intentionally NOT duplicated here yet;
// they stay on the workflow path until per-platform comment DOM is proven.

import logger from '../../../../utils/logger.js';
import { DOMHelpers, checkGate, consumeAction } from '../../_shared/routeHelper.js';
import { getPlatformLimits } from '../../_shared/limits.js';
import { capturePostFrame } from '../../_shared/routeHelper.js';
import limitsCore from '../../_shared/limitsCore.js';
import { navigateAndWaitGeneric, isPostLikedGeneric, isConfidentlyUnlikedGeneric, genericLike, ensureCommentsVisibleGeneric, extractCommentsGeneric, postCommentGeneric } from './GenericHelpers.js';

function stripMentions(text) {
    return String(text || '').replace(/@[A-Za-z0-9._-]+/g, ' ').replace(/@+/g, ' ').replace(/\s+/g, ' ').trim();
}
function sanitizeTypedText(text, maxChars = 150) {
    let s = String(text || '').replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\x00-\x1F\x7F]/g, ' ');
    s = s.replace(/<\/?\s*[A-Za-z][^>]*?>/g, ' ');
    if (/^<!doctype|^<html/i.test(s.trimStart().slice(0, 40))) return '';
    const f = s.trim().match(/^```(?:json|text|markdown)?\s*\n([\s\S]*?)\n\s*```\s*$/i);
    if (f) s = f[1];
    s = s.replace(/^["']|["']$/g, '').trim().replace(/\n{2,}/g, ' ').trim();
    s = stripMentions(s);
    if (maxChars && s.length > maxChars) {
        const cut = s.slice(0, maxChars);
        const sp = cut.lastIndexOf(' ');
        s = (sp > maxChars * 0.7 ? cut.slice(0, sp) : cut).trim();
    }
    return s;
}

function voiceMain(platformLabel, author) {
    return [
        `WHO YOU ARE: an everyday ${platformLabel} viewer who just found this post. You are NOT the post author and the post was NOT made for you.`,
        `WHO YOU TALK TO: the post author @${author || 'author'} ("you" = the author) and the general audience.`,
        'RULES: react to what the AUTHOR made/shows. Never speak as the author, never thank anyone for inviting you, never talk about your own follower count / hitting 1k / a follow-for-follow pact unless the author\'s post is explicitly about that.',
        'PRONOUNS: "you" = the author; "I/we" = you, the viewer.',
    ].join('\n');
}

function voiceReply(commenter, author) {
    return [
        `WHO YOU ARE: the viewer who just commented on @${author || 'author'}'s post. You are NOT the author and NOT the commenter.`,
        `WHO YOU TALK TO: @${commenter || 'a fellow viewer'} — another viewer whose comment sits UNDER the same post (not addressed to you, not a DM).`,
        'RULES: reply peer-to-peer. Never thank them for following YOU, never assume "followed" means they followed you, never propose a follow-for-follow pact or ask about their follower count as if you ran a growth account. React to their words + the post topic.',
        `PRONOUNS: "you" = @${commenter || 'the commenter'}; "I" = you, the replier; "the author" = @${author || 'author'}.`,
    ].join('\n');
}

export async function runGenericEngagement(page, opts) {
    const { platform, platformConfig, ai, profileId, campaignId, keywords, maxResultsPerKeyword = 5, stopAfterHours = 0, socialStrategyPrompt, taskId = 'session' } = opts;
    const { canonicalAction } = limitsCore;
    const s = platformConfig.selectors || {};
    const likeSel = s.likeButton || s.upvoteButton || "button[aria-label*='Like']";
    const results = [];
    const quotaTally = {};
    const runLimits = await getPlatformLimits(platform).catch(() => null);
    const markExhausted = (baseAction, reason) => {
        actionExhausted[baseAction] = { type: 'hourly', reason: String(reason || 'run_cap') };
        logger.info(`[generic:${taskId}] Action '${baseAction}' hit per-run hourly cap (${reason}) — skipping '${baseAction}' only.`);
    };
    const actionExhausted = { like: null, comment: null, likeComment: null, commentComment: null };
    const countAction = async (baseAction, count = 1) => {
        const key = canonicalAction(baseAction);
        const ok = await consumeAction(profileId, baseAction, count).catch(() => false);
        if (ok) {
            quotaTally[key] = (quotaTally[key] || 0) + count;
            logger.info(`[generic:${taskId}] quota: ${key} +${count} (run total ${quotaTally[key]})`);
            const hourly = Number(runLimits?.[key]?.hourly ?? 0) || 0;
            if (hourly > 0 && quotaTally[key] >= hourly) markExhausted(baseAction, `run_cap ${quotaTally[key]}/${hourly}`);
        }
        return ok;
    };
    let stopType = null; let stopReason = null; let engaged = 0; let failed = 0; let completedKeywords = [];
    let unresolvedKeywords = [];
    const startedAt = Date.now();
    const pause = (a, b) => DOMHelpers.randomDelay(a, b);

    // Returns null when the search page never settled (navigation/load
    // failure) so the keyword is left pending instead of marked done.
    const searchResults = async (kw) => {
        const searchUrl = platformConfig.searchUrl || platformConfig.homeUrl;
        const nav = await navigateAndWaitGeneric(page, searchUrl, { timeoutMs: 20000, label: 'search' });
        if (!nav || nav.ok === false || nav.state === 'nav_failed' || nav.state === 'unknown') {
            logger.warn(`[generic:${taskId}] search navigation did not settle for "${kw}" (${(nav && (nav.error || nav.state)) || 'unknown'})`);
            return null;
        }
        if (s.searchBox) {
            await page.click(s.searchBox, { timeout: 4000 }).catch(() => {});
            await page.keyboard.down('Control').catch(() => {});
            const keys = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(keys).catch(() => {});
            await page.keyboard.press('a').catch(() => {});
            await page.keyboard.up(keys).catch(() => {});
            await page.keyboard.up('Control').catch(() => {});
            await page.keyboard.type(kw, { delay: 10 }).catch(() => {});
        }
        if (s.searchSubmit) await page.click(s.searchSubmit, { timeout: 2000 }).catch(() => {});
        // Instagram search needs a suggestion pick; others submit on Enter.
        if (platform === 'instagram' && s.searchBox) {
            await pause(800, 1500);
            const sugg = await page.$("a[href*='/p/'], a[href*='/reel/'], div[role='option']").catch(() => null);
            if (sugg) await sugg.click({ timeout: 2000 }).catch(() => {});
        } else {
            await page.keyboard.press('Enter').catch(() => {});
        }
        await pause(2000, 3500);
        const ext = platformConfig.extractors?.videos || platformConfig.extractors?.posts;
        if (!ext) return [];
        try {
            const parseFunc = new Function('items', 'return (' + ext.parseFunction + '\n)(items);');
            const out = await page.$$eval(ext.selector, parseFunc);
            return Array.isArray(out) ? out.filter(v => v.url) : [];
        } catch (e) { logger.warn(`[generic:${taskId}] extractor failed (${platform} ${kw}): ${e.message}`); return []; }
    };

    for (const kw of keywords) {
        if (stopType) break;
        if (stopAfterHours > 0 && (Date.now() - startedAt) / 3600000 >= stopAfterHours) { stopType = 'time'; stopReason = 'interaction_stop_after_hours'; break; }
        try {
            const videos = await searchResults(kw);
            if (videos === null) {
                // Navigation/load failure: keyword stays pending, never done.
                unresolvedKeywords.push(kw);
                results.push({ keyword: kw, status: 'page_unsettled' });
                continue;
            }
            logger.info(`[generic:${taskId}] "${kw}": ${videos.length} result(s), cap=${maxResultsPerKeyword}`);
            const slice = videos.slice(0, maxResultsPerKeyword);
            let kwDone = true;
            for (let i = 0; i < slice.length; i++) {
                const v = slice[i];
                const st = await engageOne(page, v, i, kw);
                if (st === 'stop') { kwDone = false; break; }
                if (st === 'ok') engaged++; else failed++;
            }
            if (kwDone) completedKeywords.push(kw);
        } catch (e) {
            logger.warn(`[generic:${taskId}] keyword "${kw}" failed: ${e.message} — stays pending.`);
            unresolvedKeywords.push(kw);
            results.push({ keyword: kw, status: 'failed', error: e.message });
        }
    }
    const isNetworkError = unresolvedKeywords.length > 0 && unresolvedKeywords.length === keywords.length && engaged === 0;
    return { results, quota: quotaTally, engaged, failed: failed + unresolvedKeywords.length, stopType: isNetworkError ? 'network_error' : stopType, stopReason: isNetworkError ? 'all_keywords_unsettled' : stopReason, completedKeywords, unresolvedKeywords: [...new Set(unresolvedKeywords)], captchaFailed: false, isNetworkError };

    async function engageOne(page, v, idx, kw) {
        const label = `[generic:${taskId}] ${platform} ${idx + 1}: ${String(v.url || '').slice(0, 80)}`;
        if (stopAfterHours > 0 && (Date.now() - startedAt) / 3600000 >= stopAfterHours) { stopType = 'time'; return 'stop'; }

        // Dedup is handled by the caller/ledger; here just open the post.
        const opened = await navigateAndWaitGeneric(page, v.url, { waitSelector: likeSel, timeoutMs: 20000, label: 'post' });
        if (!opened.ok) { logger.warn(`${label} open failed (${opened.state})`); return 'fail'; }
        await pause(800, 1500);

        // --- like/upvote (verified, fire-and-forget) ---
        let likeDone = false;
        if (actionExhausted.like) { logger.info(`${label} like per-run cap hit — commenting only`); }
        else {
        const likeGate = await checkGate(platform, profileId, 'like');
        if (!likeGate.allowed) { logger.info(`${label} like quota exhausted (${likeGate.reason}) — commenting only`); markExhausted('like', likeGate.reason || 'quota'); }
        else {
            const r = await genericLike(page, likeSel, `[generic:${taskId}]`);
            likeDone = !!(r.liked || r.already);
            if (likeDone) await countAction('like');
            else logger.warn(`${label} like click failed (${r.reason || r.why}) — continuing to comment`);
            await pause(600, 1200);
        }
        }

        // --- comments context (best-effort extract) ---
        await ensureCommentsVisibleGeneric(page, platformConfig, `[generic:${taskId}]`);
        const comments = await extractCommentsGeneric(page, platformConfig);
        const commentLines = comments.filter(c => c.text).slice(0, 10).map(c => `- ${c.username ? c.username + ': ' : ''}${String(c.text).slice(0, 200)}`).join('\n');

        // --- analyze (text first, vision fallback when media exists) ---
        let analyzed = '';
        try {
            const caption = String(v.caption || v.title || '').slice(0, 600);
            const context = [
                `Caption/title: ${caption || 'n/a'}`,
                `Author: ${v.author || 'unknown'}`,
                commentLines ? `Existing comments:\n${commentLines}` : 'Existing comments: none visible',
            ].join('\n');
            const basePrompt = platformConfig.aiPrompts?.analyzePost || platformConfig.aiPrompts?.analyzeVideo || 'Summarize this post.';
            const analyzePrompt = `${basePrompt}\n\nDescribe this post neutrally from a viewer's perspective (it was NOT made for you).\n\nPost:\n${context}`;
            analyzed = ai ? String(await ai.generate(analyzePrompt) || '') : context;
            const weak = !analyzed.trim() || analyzed.length < 30 || /^(could not analyze|ai not available|no ai providers)/i.test(analyzed);
            if (weak) {
                const frame = await capturePostFrame(page).catch(() => null);
                if (frame && ai) {
                    const visionPrompt = `${basePrompt}\n\nThis is a screenshot of the post (video frame or photo). Describe what is shown.\n\nCaption: ${caption || 'n/a'}`;
                    const vr = String(await ai.generate(visionPrompt, { imageBase64: frame, timeoutMs: 90000 }) || '').trim();
                    if (vr && vr.length >= 30 && !/^(could not analyze|ai not available)/i.test(vr)) analyzed = vr;
                }
            }
        } catch (e) { logger.warn(`${label} analyze failed: ${e.message}`); analyzed = String(v.caption || v.title || ''); }
        if (analyzed.length > 2000) analyzed = analyzed.slice(0, 2000);

        // --- main comment (voice-framed, verified post) ---
        if (actionExhausted.comment) { logger.info(`${label} comment per-run cap hit — skipping comment`); results.push({ keyword: kw, url: v.url, author: v.author, status: 'comment_cap_skip', comment: '' }); return likeDone ? 'ok' : 'fail'; }
        const commentGate = await checkGate(platform, profileId, 'comment');
        if (!commentGate.allowed) { logger.info(`${label} comment quota exhausted — skipping comment`); markExhausted('comment', commentGate.reason || 'quota'); results.push({ keyword: kw, url: v.url, author: v.author, status: 'comment_quota_skip', comment: '' }); return likeDone ? 'ok' : 'fail'; }
        let posted = false; let commentText = '';
        try {
            const genPrompt = `${voiceMain(platform, v.author || 'author')}\n\n${platformConfig.aiPrompts?.generateReply || platformConfig.aiPrompts?.generateComment || 'Write a natural comment.'}\n\n${socialStrategyPrompt ? 'Strategy (within voice rules): ' + socialStrategyPrompt + '\n' : ''}Keyword that brought us here: "${kw}" — weave it in only if it fits naturally.\n\nPost analysis (about the AUTHOR's post, not about you):\n${analyzed}${commentLines ? `\nOther viewers' comments (tone only):\n${commentLines.slice(0, 800)}` : ''}`;
            const raw = ai ? await ai.generate(genPrompt) : '';
            commentText = sanitizeTypedText(raw, 150);
        } catch (e) { logger.warn(`${label} comment gen failed: ${e.message}`); }
        if (commentText) {
            const boxSel = s.commentBox || s.replyTextBox || "div[contenteditable='true']";
            const submitSel = s.commentSubmit || s.replySubmit || "button:has-text('Post')";
            const res = await postCommentGeneric(page, {
                commentBox: boxSel,
                commentSubmit: submitSel,
                text: commentText,
            }, `[generic:${taskId}]`);
            posted = !!res.posted;
            if (posted) await countAction('comment'); else logger.warn(`${label} comment NOT posted (${res.reason})`);
            await pause(800, 1500);
        }
        // --- per-comment waves (TikTok parity, best-effort) ---
        // Like + peer reply to existing comments where DOM targets exist.
        // Skips silently when selectors are absent (user refines live).
        let wavesDone = 0;
        const itemSel = s.commentItem;
        const likeBtnSel = s.commentLikeButton;
        const replyBtnSel = s.commentReplyButton;
        if (itemSel && comments.length) {
            const maxWaves = Math.min(comments.length, 5);
            for (let w = 0; w < maxWaves; w++) {
                if (stopAfterHours > 0 && (Date.now() - startedAt) / 3600000 >= stopAfterHours) { stopType = 'time'; break; }
                const c = comments[w];
                // like the comment (quota-gated; respects per-run hourly cap)
                if (actionExhausted.likeComment) { logger.info(`${label} likeComment per-run cap hit — skipping comment likes`); }
                else {
                const likeCGate = await checkGate(platform, profileId, 'likeComment');
                if (!likeCGate.allowed) { markExhausted('likeComment', likeCGate.reason || 'quota'); }
                else if (likeBtnSel) {
                    await page.evaluate((args) => {
                        const items = document.querySelectorAll(args.item);
                        const el = items[args.idx] || items[0];
                        if (!el) return;
                        const btn = el.querySelector(args.like);
                        if (btn) btn.click();
                    }, { item: itemSel, idx: w, like: likeBtnSel }).catch(() => {});
                    await countAction('likeComment');
                    await pause(500, 900);
                }
                }
                // reply (quota-gated; respects per-run hourly cap)
                if (actionExhausted.commentComment) { break; }
                const replyGate = await checkGate(platform, profileId, 'commentComment');
                if (!replyGate.allowed) { markExhausted('commentComment', replyGate.reason || 'quota'); break; }
                // Open reply composer inside that comment.
                const opened = await page.evaluate((args) => {
                    const items = document.querySelectorAll(args.item);
                    const el = items[args.idx] || items[0];
                    if (!el) return false;
                    const btn = el.querySelector(args.reply);
                    if (!btn) return false;
                    btn.click();
                    return true;
                }, { item: itemSel, idx: w, reply: replyBtnSel }).catch(() => false);
                await pause(800, 1400);
                // Inline reply box often reuses the main composer selectors.
                const boxSel = s.commentReplyBox || s.commentBox || s.replyTextBox || "div[contenteditable='true']";
                const submitSel = s.commentReplySubmit || s.commentSubmit || s.replySubmit || "button:has-text('Post')";
                try {
                    const commenter = String(c.username || '').replace(/^@+/, '').slice(0, 40);
                    const replyPrompt = `${voiceReply(commenter, v.author || 'author')}\n\nPost analysis: ${analyzed.slice(0, 800)}\nYour main comment: ${commentText}\nTheir comment (posted to the author's post, not to you): "${String(c.text).slice(0, 300)}"\n\nReply peer-to-peer to @${commenter || 'them'} about their comment + the post. One sentence, no follow-pact.`;
                    const rawReply = ai ? await ai.generate(replyPrompt, { maxTokens: 80, timeoutMs: 25000 }) : '';
                    const replyText = sanitizeTypedText(rawReply, 120);
                    if (replyText && opened) {
                        const rr = await postCommentGeneric(page, { commentBox: boxSel, commentSubmit: submitSel, text: replyText });
                        if (rr.posted) { await countAction('commentComment'); wavesDone++; }
                        else logger.warn(`${label} reply w${w + 1} not posted (${rr.reason})`);
                        await pause(800, 1500);
                    }
                } catch (e) { logger.warn(`${label} reply w${w + 1} failed (${e.message})`); }
            }
        }
        results.push({ keyword: kw, url: v.url, author: v.author, caption: String(v.caption || v.title || '').slice(0, 120), comment: commentText, status: posted ? 'commented' : (likeDone ? 'liked_only' : 'skipped'), commentsInContext: comments.length, commentReplies: wavesDone });
        return (likeDone || posted) ? 'ok' : 'fail';
    }
}
