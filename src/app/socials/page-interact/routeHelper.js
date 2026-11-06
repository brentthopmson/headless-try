import logger from "../../../utils/logger.js";
import { createRunContext } from "../_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../_shared/tiktokEngagement.js";
import { getAccountPostStatuses, markPostEngaged, getCampaignSettings, isPostInteracted, getStablePostId } from '../../campaign/_shared/pipelineUtils.js';

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
                const links = await helper.listPostLinks(page, 1);
                const target = links[0] || page.url();
                const postId = getStablePostId(platform, target);
                if (postId && isPostInteracted(accountPostStatuses, postId)) {
                    log.info(`[${taskId}] Post already interacted (${postId}) — skipping ${baseAction} for ${handle}`);
                    results.push({ handle, status: "ALREADY_INTERACTED", reason: "already_interacted", postId, target });
                    continue;
                }
                if (target !== page.url()) await helper.openPost(page, target);
                const livePostId = postId || getStablePostId(platform, page.url());
                const likedNow = typeof helper.isPostLiked === 'function' ? await helper.isPostLiked(page).catch(() => false) : false;
                if (likedNow) {
                    await markInteracted(livePostId, 'already_liked');
                    log.info(`[${taskId}] Main post already liked — skipping ${baseAction} as already interacted (${livePostId || target})`);
                    results.push({ handle, status: "ALREADY_INTERACTED", reason: "main_post_already_liked", postId: livePostId, target: page.url() });
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
            }

            if (outcome == null && (baseAction === 'like' || baseAction === 'comment')) {
                // skipped via continue above
            } else {
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
