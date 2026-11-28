// Shared comment-wave engine — TikTok-solid "reply to other people's comments"
// behavior for EVERY platform. Config-driven: all DOM work uses the platform's
// selectors (from search-interact/platforms.js, which defines them for all 8
// platforms) plus GenericHelpers. Enforces:
//   - per-post reply cap (maxRepliesPerPost, default 30) — likes keep running
//   - platform hourly quota via checkGate('likeComment'/'commentComment')
//   - requireAiForComments (never post a non-AI comment/reply when ON)
// Selector/DOM failures are non-fatal: log and skip, never break the campaign.

import logger from "../../../utils/logger.js";
import { checkGate, consumeAction, campaignVoiceBlock, structuralTaskLine } from "./routeHelper.js";
import { resolveCommentPolicy } from "./commentPolicy.js";
import { screenTargets, isTargetApproved } from "./commentTargeting.js";
import limitsCore from "./limitsCore.js";
import { ensureCommentsVisibleGeneric, extractCommentsGeneric, postCommentGeneric } from "../search-interact/platformHelper/GenericHelpers.js";
import { MultiProviderAI } from "../search-interact/platforms.js";

const { canonicalAction } = limitsCore;

function stripMentions(text) {
    return String(text || '').replace(/@[A-Za-z0-9._-]+/g, ' ').replace(/@+/g, ' ').replace(/\s+/g, ' ').trim();
}
function sanitizeTypedText(text, maxChars = 0, keepMentions = true) {
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
    // Never post a mid-sentence fragment.
    if (s && /[A-Za-zÀ-ÿ0-9,;:\-–—]$/.test(s)) {
        const closed = s.replace(/[,;:\-–—\s]+$/, '');
        s = closed ? closed + '.' : '';
    }
    // Keep @mentions by default so replies address the commenter by name.
    return keepMentions ? s.trim() : stripMentions(s).trim();
}
// STRUCTURAL placement only — identity, tone and wording belong to the campaign.
function placementReply(commenter, author) {
    return [
        'Action: a public reply to another user\'s comment under a post.',
        `Post owner: @${author || 'author'}.`,
        `Author of the comment being replied to: @${commenter || 'unknown'}.`,
        'Setting: that comment thread under the post; not a private message.',
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
        campaignId = null,
        taskId = 'waves',
        maxRepliesPerPost = 30,
        requireAiForComments: _requireAiForCommentsRaw = false,
        targetedComments: _targetedCommentsRaw,
        targetScreen: _targetScreenRaw = null,
        targetContext = {},
        author = '',
        socialStrategyPrompt = '',
        analysisText = '',
        aiOverride = null,
        onCaptchaCheck = null,
        log = logger,
    } = opts;
    const policy = await resolveCommentPolicy(
        { requireAiForComments: _requireAiForCommentsRaw, targetedComments: _targetedCommentsRaw },
        { campaignId, log, label: `waves:${taskId}:policy` }
    );
    const requireAiForComments = policy.requireAiForComments;
    const targetedComments = policy.targetedComments;
    let targetScreen = _targetScreenRaw;
    const cfg = platformConfig || {};
    const s = cfg.selectors || {};
    const prefix = `[waves:${taskId}]`;
    const quota = {};
    let replies = 0;
    let commentLikes = 0;
    let captchaFailed = false;

    // Optional platform-specific captcha solver (TikTok passes one). Solves in
    // place; `solved` tells us to retry the current comment on the same post.
    // Absent callback = no-op, so every other platform is unaffected.
    const captchaRetries = new Map();
    const captchaGuard = async (where) => {
        if (typeof onCaptchaCheck !== 'function') return { ok: true, solved: false };
        try {
            const r = await onCaptchaCheck(where);
            if (r && typeof r === 'object') return { ok: r.ok !== false, solved: !!r.solved };
            return { ok: r !== false, solved: false };
        } catch (e) {
            log.warn(`${prefix} captcha check failed at ${where}: ${e.message}`);
            return { ok: true, solved: false };
        }
    };

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
        return { replies, commentLikes, quota, captchaFailed };
    }

    try { await ensureCommentsVisibleGeneric(page, cfg); } catch (e) { log.warn(`${prefix} open comments failed: ${e.message}`); }
    // Comments-tab opening is a known captcha trigger — check right after.
    const openGuard = await captchaGuard('after opening comments');
    if (!openGuard.ok) {
        captchaFailed = true;
        log.warn(`${prefix} captcha unsolved after opening comments — stopping waves (no navigation).`);
        return { replies, commentLikes, quota, captchaFailed };
    }
    let comments = [];
    try { comments = await extractCommentsGeneric(page, cfg) || []; } catch (e) { log.warn(`${prefix} extract comments failed: ${e.message}`); }
    if (!comments.length) {
        log.info(`${prefix} no comments to reply to on this post.`);
        return { replies, commentLikes, quota, captchaFailed };
    }

    const ai = aiOverride || MultiProviderAI;
    // Central screening: callers may pass a precomputed result (avoiding a
    // duplicate AI call); otherwise screen here before any reply DOM work.
    if (targetedComments && !targetScreen) {
        targetScreen = await screenTargets({
            ai,
            targets: comments,
            context: { postOwner: author || 'author', mediaAnalysis: String(analysisText || '').slice(0, 1200), ...(targetContext || {}) },
            socialStrategyPrompt,
            maxTargets: maxRepliesPerPost,
            log,
            label: `${prefix}:targeting`,
        });
    }
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

        // CAPTCHA CHECKPOINT before acting on this comment. A solve refreshes
        // the comment DOM and retries the SAME comment (bounded to 2) so the
        // reply is not lost; an unsolved captcha stops the whole wave in place.
        const guard = await captchaGuard(`before comment ${i + 1}`);
        if (!guard.ok) { captchaFailed = true; break; }
        if (guard.solved) {
            const tries = (captchaRetries.get(key) || 0) + 1;
            captchaRetries.set(key, tries);
            if (tries <= 2) {
                try { comments = await extractCommentsGeneric(page, cfg) || comments; } catch (_) {}
                const fresh = comments.findIndex(x => String(x.id || `${x.username || ''}|${String(x.text).slice(0, 60)}`).trim().toLowerCase() === key);
                if (fresh >= 0) { seen.delete(key); i = fresh - 1; continue; } // loop's i++ reprocesses it
            }
            log.warn(`${prefix} captcha solved but comment not re-located — continuing.`);
        }

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

        // 2) Reply (capped) — central targeting gate BEFORE any reply DOM click
        if (replies >= cap) continue;
        if (targetedComments && targetScreen && !isTargetApproved(targetScreen, c)) {
            log.info(`${prefix} reply skipped (targetedComments): "${String(c.text || '').slice(0, 50)}..."`);
            continue;
        }
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
            const displayName = String(c.displayName || c.name || '').replace(/^@+/, '').trim().slice(0, 40) || commenter;
            const voiceBlock = campaignVoiceBlock(socialStrategyPrompt, placementReply(commenter, author || 'author'));
            const prompt = `${voiceBlock}\n\n${structuralTaskLine(socialStrategyPrompt, cfg.aiPrompts?.replyToComment || cfg.aiPrompts?.generateReply)}\n\nREPLY CONTEXT (observed data):\nPost owner: @${author || 'author'}\nComment author: @${commenter || 'unknown'} (display name: ${displayName || 'unknown'})\nMedia analysis: ${String(analysisText || '').slice(0, 800) || '(none observed)'}\nTheir comment: "${String(c.text).slice(0, 300)}"\nBefore writing, determine who wrote this comment and who it is addressing.`;
            const raw = ai ? await ai.generate(prompt, { maxTokens: 300, timeoutMs: 25000, maxTransientAttempts: 1 }).catch(() => '') : '';
            replyText = sanitizeTypedText(raw);
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

    return { replies, commentLikes, quota, captchaFailed };
}
