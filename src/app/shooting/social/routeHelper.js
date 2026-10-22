import logger from "../../../utils/logger.js";
import { createRunContext } from "../../socials/_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../../socials/_shared/tiktokEngagement.js";

export function supportsSendMessageRunner(platform) {
    const helper = getPlatformHelper(platform);
    return !!(helper && helper.capabilities.newDm);
}

export async function runSendMessage(options = {}) {
    const {
        page,
        platform,
        profileId = null,
        taskId = "send-message",
        recipient = "",
        messageText = "",
        stopAfterHours = 0,
        log = logger,
    } = options;

    const helper = getPlatformHelper(platform);
    if (!helper || !helper.capabilities.newDm) return { supported: false };

    const ctx = createRunContext({ platform, profileId, taskId, stopAfterHours, log });
    let detach = () => {};

    try {
        detach = attachSingleTabGuard(page, `[${taskId}]`);
        const opened = await helper.openMessages(page);
        if (!opened) return { supported: true, sent: false, reason: "messages-open-failed", ...ctx.summary() };
        await enforceSingleTab(page, `[${taskId}]`);

        if (await helper.isLoggedOut(page)) {
            ctx.stop("logged_out", "logged_out");
            return { supported: true, sent: false, reason: "logged_out", ...ctx.summary() };
        }
        if (String(platform).toLowerCase() === "tiktok") {
            const guard = await handleTikTokGuards(page, { profileId, logPrefix: `[${taskId}]` });
            if (!guard.ok) {
                ctx.stop(guard.stopType, guard.reason);
                return { supported: true, sent: false, reason: guard.reason, ...ctx.summary() };
            }
        }

        if (!(await ctx.check("coldMessage"))) {
            return { supported: true, sent: false, reason: ctx.stopReason || "limit", ...ctx.summary() };
        }

        const outcome = await helper.sendNewMessage(page, recipient, messageText);
        const ok = !!(outcome && (outcome.verified || outcome.unverified));
        if (ok) {
            await ctx.record("coldMessage", 1);
            ctx.engaged += 1;
        } else {
            ctx.failed += 1;
        }
        return {
            supported: true,
            sent: ok,
            verified: !!outcome?.verified,
            unverified: !!outcome?.unverified,
            reason: outcome?.reason,
            ...ctx.summary(),
        };
    } finally {
        detach();
        await ctx.finish();
    }
}
