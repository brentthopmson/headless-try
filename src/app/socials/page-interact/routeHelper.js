import logger from "../../../utils/logger.js";
import { createRunContext } from "../_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../_shared/tiktokEngagement.js";
import { getAccountPostStatuses, markPostEngaged, getCampaignSettings, isPostInteracted, getStablePostId } from '../../campaign/_shared/pipelineUtils.js';
import { runCommentWaves } from '../_shared/commentWaveEngine.js';
import { isSocialCampaignPaused } from '../_shared/pauseCheck.js';
import { getPlatformConfig as getSearchPlatformConfig, MultiProviderAI } from '../search-interact/platforms.js';

const FOLLOW_OPS = new Set(["followuser", "follow", "followfromsuggested", "followfromfollowers"]);
const UNFOLLOW_OPS = new Set(["unfollowuser", "unfollow"]);

export function pageActionForOperation(operationRaw, engagementMode = false) {
    const op = String(operationRaw || "").split(",")[0].trim().toLowerCase();
    if (engagementMode) return "follow";
    if (FOLLOW_OPS.has(op)) return "follow";
    if (UNFOLLOW_OPS.has(op)) return "unfollow";
    if (op === "interactwithprofile" || op === "like") return "like";
    if (op === "comment") return "comment";
    return null;
}

export function supportsPageRunner(platform) {
    return !!getPlatformHelper(platform);
}

export async function runPageInteract(options = {}) {
    const {
        page,
        platform,
        profileId = null,
        campaignId = null,
        taskId = "page",
        handles = [],
        operation = "",
        engagementMode = false,
        messageText = "",
        stopAfterHours = 0,
        maxRepliesPerPost = 30,
        maxResultsPerKeyword = 5,
        requireAiForComments = false,
        socialStrategyPrompt = '',
        log = logger,
    } = options;

    let accountPostStatuses = {};
    if (campaignId && profileId) {
        try {
            const campSettings = await getCampaignSettings(campaignId);
            accountPostStatuses = Object.assign({}, getAccountPostStatuses(campSettings?.settings, profileId));
        } catch (e) { log.warn(`[${taskId}] Could not load post dedup state: ${e.message}`); }
    }
    const markInteracted = async (postId, status = 'already_liked') => {
        if (!postId) return;
        accountPostStatuses[postId] = status;
        if (campaignId && profileId) await markPostEngaged(campaignId, profileId, postId, status).catch(() => {});
    };

    const helper = getPlatformHelper(platform);
    const baseAction = pageActionForOperation(operation, engagementMode);
    if (!helper || !baseAction) return { supported: false };

    const ctx = createRunContext({ platform, profileId, taskId, stopAfterHours, log });
    const results = [];
    let detach = () => {};

    try {
        detach = attachSingleTabGuard(page, `[${taskId}]`);
        for (const handle of handles) {
            if (!ctx.shouldContinue()) break;
            if (await isSocialCampaignPaused(campaignId)) {
                logger.info(`[${taskId}] PAUSE_DETECTED at handle ${handle} — stopping page-interact cleanly.`);
                break;
            }
            if (!(await ctx.check(baseAction))) break;

            const opened = await helper.openProfile(page, handle);
            if (!opened) {
                ctx.failed += 1;
                results.push({ handle, status: "FAILED", reason: "profile-open-failed" });
                continue;
            }
            await enforceSingleTab(page, `[${taskId}]`);

            if (String(platform).toLowerCase() === "tiktok") {
                const guard = await handleTikTokGuards(page, { profileId, logPrefix: `[${taskId}]` });
                if (!guard.ok) {
                    ctx.stop(guard.stopType, guard.reason);
                    break;
                }
            }

            let outcome;
            if (baseAction === "follow") {
                outcome = await helper.follow(page);
            } else if (baseAction === "unfollow") {
                outcome = await helper.unfollow(page);
            } else if (baseAction === "like" || baseAction === "comment") {
                // Interact with MULTIPLE posts per profile (TikTok parity), not just one.
                const links = await helper.listPostLinks(page, Math.max(1, Number(maxResultsPerKeyword) || 5));
                const targets = links.length ? links : [page.url()];
                for (let pIdx = 0; pIdx < targets.length; pIdx++) {
                    if (!ctx.shouldContinue()) break;
                    const target = targets[pIdx];
                    const postId = getStablePostId(platform, target);
                    if (postId && isPostInteracted(accountPostStatuses, postId)) {
                        log.info(`[${taskId}] Post already interacted (${postId}) — skipping for ${handle}`);
                        results.push({ handle, status: "ALREADY_INTERACTED", reason: "already_interacted", postId, target });
                        continue;
                    }
                    if (target !== page.url()) await helper.openPost(page, target);
                    const livePostId = postId || getStablePostId(platform, page.url());
                    const likedNow = typeof helper.isPostLiked === 'function' ? await helper.isPostLiked(page).catch(() => false) : false;
                    if (likedNow) {
                        await markInteracted(livePostId, 'already_liked');
                        log.info(`[${taskId}] Main post already liked — skipping as already interacted (${livePostId || target})`);
                        results.push({ handle, status: "ALREADY_INTERACTED", reason: "main_post_already_liked", postId: livePostId, target: page.url() });
                        continue;
                    }
                    if (baseAction !== 'like' && requireAiForComments && !messageText) {
                        log.info(`[${taskId}] Comment skipped: AI required but no message available (handle=${handle}).`);
                        results.push({ handle, status: "COMMENT_SKIPPED_AI_REQUIRED", reason: "no_ai_message" });
                        continue;
                    }
                    outcome = baseAction === 'like' ? await helper.like(page) : await helper.comment(page, messageText);
                    if (outcome && outcome.already) {
                        await markInteracted(livePostId, 'already_liked');
                        log.info(`[${taskId}] ${baseAction} detected already liked — skipping as already interacted (${livePostId || target})`);
                        results.push({ handle, status: "ALREADY_INTERACTED", reason: "main_post_already_liked", postId: livePostId, target: page.url() });
                        continue;
                    } else if (outcome && (outcome.verified || outcome.unverified)) {
                        await markInteracted(livePostId, 'engaged');
                    }

                    // Reply waves on this post (TikTok-solid, all platforms, capped).
                    try {
                        const scfg = getSearchPlatformConfig(String(platform).toLowerCase());
                        if (scfg?.selectors?.commentItem && scfg?.selectors?.commentReplyButton) {
                            const wave = await runCommentWaves(page, {
                                platform, platformConfig: scfg, profileId, taskId,
                                maxRepliesPerPost, requireAiForComments,
                                author: String(handle || '').replace(/^@+/, ''),
                                socialStrategyPrompt, analysisText: '',
                                aiOverride: MultiProviderAI, log,
                            });
                            for (const [k, n] of Object.entries(wave.quota || {})) await ctx.record(k, n);
                        }
                    } catch (e) { log.warn(`[${taskId}] reply waves failed for ${handle}: ${e.message}`); }

                    // Account this post's main action.
                    const counted = !!(outcome && (outcome.verified || outcome.unverified));
                    if (counted) {
                        await ctx.record(baseAction, 1);
                        ctx.engaged += 1;
                        results.push({ handle, status: outcome.already ? "ALREADY" : "DONE", postId: livePostId, verified: !!outcome.verified, unverified: !!outcome.unverified });
                    } else {
                        ctx.failed += 1;
                        results.push({ handle, status: "FAILED", reason: outcome?.reason || "not-confirmed" });
                    }
                } // end posts loop
            }

            if (baseAction !== 'like' && baseAction !== 'comment' && outcome != null) {
                const counted = !!(outcome && (outcome.verified || outcome.unverified));
                if (counted) {
                    await ctx.record(baseAction, 1);
                    ctx.engaged += 1;
                    results.push({ handle, status: outcome.already ? "ALREADY" : "DONE", verified: !!outcome.verified, unverified: !!outcome.unverified });
                } else {
                    ctx.failed += 1;
                    results.push({ handle, status: "FAILED", reason: outcome?.reason || "not-confirmed" });
                }
            }
        }
    } finally {
        detach();
        await ctx.finish();
    }

    return { supported: true, results, ...ctx.summary() };
}
