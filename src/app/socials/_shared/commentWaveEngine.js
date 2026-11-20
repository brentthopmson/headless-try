// Shared comment-wave engine — TikTok-solid "reply to other people's comments"
// behavior for EVERY platform. Config-driven: all DOM work uses the platform's
// selectors (from search-interact/platforms.js, which defines them for all 8
// platforms) plus GenericHelpers. Enforces:
//   - per-post reply cap (maxRepliesPerPost, default 30) — likes keep running
//   - platform hourly quota via checkGate('likeComment'/'commentComment')
//   - requireAiForComments (never post a non-AI comment/reply when ON)
// Selector/DOM failures are non-fatal: log and skip, never break the campaign.

import logger from "../../../utils/logger.js";
import { checkGate, consumeAction } from "./routeHelper.js";
import limitsCore from "./limitsCore.js";
import { ensureCommentsVisibleGeneric, extractCommentsGeneric, postCommentGeneric } from "../search-interact/platformHelper/GenericHelpers.js";
import { MultiProviderAI } from "../search-interact/platforms.js";

const { canonicalAction } = limitsCore;

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
    if (maxChars && s.length > maxChars) {
        const cut = s.slice(0, maxChars);
        const sp = cut.lastIndexOf(' ');
        s = (sp > maxChars * 0.7 ? cut.slice(0, sp) : cut).trim();
    }
    return stripMentions(s).trim();
}
function voiceReply(commenter, author) {
    return [
        `WHO YOU ARE: the viewer who just commented on @${author || 'author'}'s post. You are NOT the author and NOT the commenter.`,
        `WHO YOU TALK TO: @${commenter || 'a fellow viewer'} — another viewer whose comment sits UNDER the same post (not addressed to you, not a DM).`,
        'RULES: reply peer-to-peer. Never thank them for following YOU, never propose a follow-for-follow pact, never talk about follower counts. React to their words + the post topic, briefly.',
        `PRONOUNS: "you" = @${commenter || 'the commenter'}; "I" = you, the replier; "the author" = @${author || 'author'}.`,
    ].join('\n');
}

/**
 * Run comment-like + reply waves on the currently-open post.
 * @returns {{ replies:number, commentLikes:number, quota:object }}
 */
export async function runCommentWaves(page, opts = {}) {
    const {
        platform,
        platformConfig,
        profileId = null,
        taskId = 'waves',
        maxRepliesPerPost = 30,
        requireAiForComments = false,
        author = '',
        socialStrategyPrompt = '',
        analysisText = '',
        aiOverride = null,
        log = logger,
    } = opts;
    const cfg = platformConfig || {};
    const s = cfg.selectors || {};
    const prefix = `[waves:${taskId}]`;
    const quota = {};
    let replies = 0;
    let commentLikes = 0;

    const bump = (action, n = 1) => {
        const key = canonicalAction(action);
        quota[key] = (quota[key] || 0) + n;
    };
    const countAction = async (action) => {
        if (!profileId) { bump(action); return; }
        const ok = await consumeAction(profileId, action, 1).catch(() => false);
        if (ok) bump(action);
    };

    const itemSel = s.commentItem;
    const likeBtnSel = s.commentLikeButton;
    const replyBtnSel = s.commentReplyButton;
    const boxSel = s.commentReplyBox || s.commentBox || s.replyTextBox || "div[contenteditable='true']";
    const submitSel = s.commentReplySubmit || s.commentSubmit || s.replySubmit || "button:has-text('Post')";

    if (!itemSel || !replyBtnSel) {
        log.info(`${prefix} no commentItem/commentReplyButton selectors for ${platform} — skipping reply waves (best-effort).`);
        return { replies, commentLikes, quota };
    }

    try { await ensureCommentsVisibleGeneric(page, cfg); } catch (e) { log.warn(`${prefix} open comments failed: ${e.message}`); }
    let comments = [];
    try { comments = await extractCommentsGeneric(page, cfg) || []; } catch (e) { log.warn(`${prefix} extract comments failed: ${e.message}`); }
    if (!comments.length) {
        log.info(`${prefix} no comments to reply to on this post.`);
        return { replies, commentLikes, quota };
    }

    const ai = aiOverride || MultiProviderAI;
    const cap = Math.max(1, Number(maxRepliesPerPost) || 30);
    const seen = new Set();
    let capLogged = false;
    const maxItems = Math.min(comments.length, cap + 8); // a few extra slots for failures

    for (let i = 0; i < maxItems; i++) {
        if (replies >= cap) {
            if (!capLogged) {
                capLogged = true;
                log.info(`${prefix} reply cap reached (${cap}) on this post — continuing comment-likes only, will reply on next post.`);
            }
        }
        const c = comments[i];
        if (!c || !c.text) continue;
        const key = String(c.id || `${c.username || ''}|${String(c.text).slice(0, 60)}`).trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        // 1) Like the comment (quota-gated; always attempted, independent of reply cap)
        const lcIdx = comments.indexOf(c);
        const canLike = likeBtnSel && (await checkGate(platform, profileId, 'likeComment').catch(() => ({ allowed: false }))).allowed;
        if (canLike) {
            const did = await page.evaluate((args) => {
                const items = document.querySelectorAll(args.item);
                const el = items[args.idx] || items[0];
                if (!el) return false;
                const btn = el.querySelector(args.like);
                if (!btn) return false;
                btn.click();
                return true;
            }, { item: itemSel, idx: lcIdx, like: likeBtnSel }).catch(() => false);
            if (did) { commentLikes++; await countAction('likeComment'); await new Promise(r => setTimeout(r, 400)); }
        }

        // 2) Reply (capped)
        if (replies >= cap) continue;
        const replyGate = await checkGate(platform, profileId, 'commentComment').catch(() => ({ allowed: false }));
        if (!replyGate.allowed) {
            log.info(`${prefix} commentComment quota exhausted (${replyGate.reason || 'gate'}) — stopping replies on this post.`);
            break;
        }
        const opened = await page.evaluate((args) => {
            const items = document.querySelectorAll(args.item);
            const el = items[args.idx] || items[0];
            if (!el) return false;
            const btn = el.querySelector(args.reply);
            if (!btn) return false;
            btn.click();
            return true;
        }, { item: itemSel, idx: lcIdx, reply: replyBtnSel }).catch(() => false);
        if (!opened) continue;
        await new Promise(r => setTimeout(r, 600));

        let replyText = '';
        try {
            const commenter = String(c.username || '').replace(/^@+/, '').slice(0, 40);
            const prompt = `${voiceReply(commenter, author || 'author')}\n\n${cfg.aiPrompts?.replyToComment || cfg.aiPrompts?.generateReply || 'Reply briefly.'}\n\n${socialStrategyPrompt ? 'Strategy (apply only within voice rules): ' + socialStrategyPrompt + '\n' : ''}Post analysis (context only): ${String(analysisText || '').slice(0, 800)}\nTheir comment (posted on the author's post, not to you): "${String(c.text).slice(0, 300)}"\n\nReply peer-to-peer to @${commenter || 'them'} about their comment + the post topic. One sentence, no follow-pact.`;
            const raw = ai ? await ai.generate(prompt, { maxTokens: 80, timeoutMs: 25000, maxTransientAttempts: 1 }).catch(() => '') : '';
            replyText = sanitizeTypedText(raw, 120);
        } catch (e) {
            log.warn(`${prefix} reply AI failed: ${e.message}`);
        }
        if (!replyText && requireAiForComments) {
            log.info(`${prefix} reply skipped: AI required but unavailable.`);
            continue;
        }
        if (!replyText) continue; // no non-AI fallback here (TikTok-solid strictness)

        const res = await postCommentGeneric(page, { commentBox: boxSel, commentSubmit: submitSel, text: replyText })
            .catch(err => ({ posted: false, reason: err.message }));
        if (res.posted) {
            replies++;
            await countAction('commentComment');
            log.info(`${prefix} replied (${replies}/${cap}): "${String(c.text).slice(0, 30)}..." -> "${replyText.slice(0, 40)}"`);
        } else {
            log.warn(`${prefix} reply not posted (${res.reason}).`);
        }
        await new Promise(r => setTimeout(r, 700));
    }

    return { replies, commentLikes, quota };
}
