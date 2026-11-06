import logger from "../../../utils/logger.js";
import { createRunContext } from "../_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../_shared/tiktokEngagement.js";
import { getAccountPostStatuses, markPostEngaged, getCampaignSettings, isPostInteracted, getStablePostId } from '../../campaign/_shared/pipelineUtils.js';

export function activitiesActionForOperation(operationRaw, engagementMode = false) {
    const op = String(operationRaw || "").split(",")[0].trim().toLowerCase();
    if (engagementMode || op === "engagewithnotifications") return "engage";
    if (op === "followback") return "followBack";
    return null;
}

export function supportsActivitiesRunner(platform) {
    return !!getPlatformHelper(platform);
}

export async function runActivitiesInteract(options = {}) {
    const {
        page,
        platform,
        profileId = null,
        campaignId = null,
        taskId = "activities",
        operation = "",
        engagementMode = false,
        messageText = "",
        stopAfterHours = 0,
        maxEngagements = 20,
        log = logger,
    } = options;

    const helper = getPlatformHelper(platform);
    const mode = activitiesActionForOperation(operation, engagementMode);
    if (!helper || !mode) return { supported: false };

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
    const skipIfAlreadyInteracted = async (actionLabel) => {
        const postId = getStablePostId(platform, page.url());
        if (postId && isPostInteracted(accountPostStatuses, postId)) return { skip: true, reason: 'already_interacted', postId };
        const likedNow = typeof helper.isPostLiked === 'function' ? await helper.isPostLiked(page).catch(() => false) : false;
        if (likedNow) { await markInteracted(postId, 'already_liked'); return { skip: true, reason: 'main_post_already_liked', postId }; }
        return { skip: false, postId };
    };

    const ctx = createRunContext({ platform, profileId, taskId, stopAfterHours, log });
    const results = [];
    let detach = () => {};

    try {
        detach = attachSingleTabGuard(page, `[${taskId}]`);
        const opened = await helper.openNotifications(page);
        if (!opened) return { supported: true, results: [{ status: "FAILED", reason: "notifications-open-failed" }], ...ctx.summary() };
        await enforceSingleTab(page, `[${taskId}]`);

        if (String(platform).toLowerCase() === "tiktok") {
            const guard = await handleTikTokGuards(page, { profileId, logPrefix: `[${taskId}]` });
            if (!guard.ok) {
                ctx.stop(guard.stopType, guard.reason);
                return { supported: true, results, ...ctx.summary() };
            }
        }

        const notifications = await helper.listNotifications(page, maxEngagements);
        let index = 0;
        for (const item of notifications) {
            if (!ctx.shouldContinue() || ctx.engaged >= maxEngagements) break;

            if (mode === "followBack") {
                if (item.type !== "follow") { index += 1; continue; }
                if (!(await ctx.check("follow"))) break;
                const outcome = await helper.followBack(page, index);
                const ok = !!(outcome && (outcome.verified || outcome.unverified));
                if (ok) { await ctx.record("follow", 1); ctx.engaged += 1; }
                else ctx.failed += 1;
                results.push({ type: item.type, status: ok ? "DONE" : "FAILED", reason: outcome?.reason });
                index += 1;
                continue;
            }

            if (item.type === "follow") {
                if (!(await ctx.check("follow"))) break;
                const outcome = await helper.followBack(page, index);
                if (outcome && (outcome.verified || outcome.unverified)) { await ctx.record("follow", 1); ctx.engaged += 1; }
                else ctx.failed += 1;
                results.push({ type: "follow", status: "DONE" });
                index += 1;
                continue;
            }

            if (item.type === "like" || item.type === "comment") {
                const targetOpened = await helper.openNotificationTarget(page, index);
                if (!targetOpened) {
                    ctx.failed += 1;
                    index += 1;
                    continue;
                }
                const action = item.type === "like" ? "like" : "comment";
                if (!(await ctx.check(action))) break;
                const gate = await skipIfAlreadyInteracted(action);
                if (gate.skip) {
                    log.info(`[${taskId}] ${action} skipped (already interacted): ${gate.reason} ${gate.postId || page.url()}`);
                    results.push({ type: item.type, status: "ALREADY_INTERACTED", reason: gate.reason, postId: gate.postId });
                    await helper.openNotifications(page);
                    await enforceSingleTab(page, `[${taskId}]`);
                    index += 1;
                    continue;
                }
                const outcome = action === "like"
                    ? await helper.like(page)
                    : await helper.comment(page, messageText);
                const ok = !!(outcome && (outcome.verified || outcome.unverified));
                const postId = gate.postId || getStablePostId(platform, page.url());
                if (outcome && outcome.already) { await markInteracted(postId, 'already_liked'); }
                else if (ok) { await markInteracted(postId, 'engaged'); await ctx.record(action, 1); ctx.engaged += 1; }
                else ctx.failed += 1;
                results.push({ type: item.type, status: (outcome && outcome.already) ? "ALREADY_INTERACTED" : (ok ? "DONE" : "FAILED"), reason: outcome?.reason || (outcome?.already ? 'main_post_already_liked' : undefined) });
                await helper.openNotifications(page);
                await enforceSingleTab(page, `[${taskId}]`);
            }
            index += 1;
        }

        if (notifications.length === 0 && ctx.shouldContinue() && ctx.engaged < maxEngagements) {
            log.info(`[${taskId}] No notifications found — navigating to FYP feed to interact`);
            const feedUrl = String(platform).toLowerCase() === 'tiktok' ? 'https://www.tiktok.com/foryou' : 'https://www.tiktok.com/';
            const ok = await page.goto(feedUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).then(() => true).catch(() => false);
            if (ok) {
                await new Promise(r => setTimeout(r, 2500));
                if (await ctx.check("like")) {
                    const gate = await skipIfAlreadyInteracted("like");
                    if (gate.skip) {
                        results.push({ type: "fyp_like", status: "ALREADY_INTERACTED", reason: gate.reason, postId: gate.postId });
                        log.info(`[${taskId}] FYP post already interacted — skipped`);
                    } else {
                        const outcome = await helper.like(page);
                        const isOk = !!(outcome && (outcome.verified || outcome.unverified));
                        const postId = gate.postId || getStablePostId(platform, page.url());
                        if (outcome && outcome.already) { await markInteracted(postId, 'already_liked'); results.push({ type: "fyp_like", status: "ALREADY_INTERACTED", reason: 'main_post_already_liked' }); }
                        else if (isOk) { await markInteracted(postId, 'engaged'); await ctx.record("like", 1); ctx.engaged += 1; results.push({ type: "fyp_like", status: "DONE" }); log.info(`[${taskId}] Interacted on FYP (liked video)`); }
                    }
                }
            }
        }
    } finally {
        detach();
        await ctx.finish();
    }

    return { supported: true, results, ...ctx.summary() };
}
