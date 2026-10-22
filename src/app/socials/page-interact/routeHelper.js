import logger from "../../../utils/logger.js";
import { createRunContext } from "../_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../_shared/tiktokEngagement.js";

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
        taskId = "page",
        handles = [],
        operation = "",
        engagementMode = false,
        messageText = "",
        stopAfterHours = 0,
        log = logger,
    } = options;

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
            } else if (baseAction === "like") {
                const links = await helper.listPostLinks(page, 1);
                const target = links[0] || page.url();
                if (target !== page.url()) await helper.openPost(page, target);
                outcome = await helper.like(page);
            } else if (baseAction === "comment") {
                const links = await helper.listPostLinks(page, 1);
                const target = links[0] || page.url();
                if (target !== page.url()) await helper.openPost(page, target);
                outcome = await helper.comment(page, messageText);
            }

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
    } finally {
        detach();
        await ctx.finish();
    }

    return { supported: true, results, ...ctx.summary() };
}
