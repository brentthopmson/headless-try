import logger from "../../../utils/logger.js";
import { createRunContext } from "../_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../_shared/tiktokEngagement.js";

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
                const outcome = action === "like"
                    ? await helper.like(page)
                    : await helper.comment(page, messageText);
                const ok = !!(outcome && (outcome.verified || outcome.unverified));
                if (ok) { await ctx.record(action, 1); ctx.engaged += 1; }
                else ctx.failed += 1;
                results.push({ type: item.type, status: ok ? "DONE" : "FAILED", reason: outcome?.reason });
                await helper.openNotifications(page);
                await enforceSingleTab(page, `[${taskId}]`);
            }
            index += 1;
        }
    } finally {
        detach();
        await ctx.finish();
    }

    return { supported: true, results, ...ctx.summary() };
}
