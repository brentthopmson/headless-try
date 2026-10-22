import logger from "../../../utils/logger.js";
import { createRunContext } from "../_shared/engagementRunner.js";
import { getPlatformHelper } from "./platformHelper/index.js";
import { enforceSingleTab, attachSingleTabGuard, handleTikTokGuards } from "../_shared/tiktokEngagement.js";

export function inboxActionForOperation(operationRaw) {
    const op = String(operationRaw || "").split(",")[0].trim().toLowerCase();
    if (op === "sendmessage" || op === "reply" || op === "replymessages") return "inboxReply";
    return null;
}

export function supportsInboxRunner(platform) {
    const helper = getPlatformHelper(platform);
    return !!(helper && helper.capabilities.inbox);
}

export async function runInboxInteract(options = {}) {
    const {
        page,
        platform,
        profileId = null,
        taskId = "inbox",
        operation = "",
        recipient = "",
        messageText = "",
        stopAfterHours = 0,
        maxReplies = 10,
        log = logger,
    } = options;

    const helper = getPlatformHelper(platform);
    const baseAction = inboxActionForOperation(operation);
    if (!helper || !baseAction || !helper.capabilities.inbox) return { supported: false };

    const ctx = createRunContext({ platform, profileId, taskId, stopAfterHours, log });
    const results = [];
    let detach = () => {};

    try {
        detach = attachSingleTabGuard(page, `[${taskId}]`);
        const opened = await helper.openMessages(page);
        if (!opened) return { supported: true, results: [{ status: "FAILED", reason: "messages-open-failed" }], ...ctx.summary() };
        await enforceSingleTab(page, `[${taskId}]`);

        if (await helper.isLoggedOut(page)) {
            ctx.stop("logged_out", "logged_out");
            return { supported: true, results, ...ctx.summary() };
        }
        if (String(platform).toLowerCase() === "tiktok") {
            const guard = await handleTikTokGuards(page, { profileId, logPrefix: `[${taskId}]` });
            if (!guard.ok) {
                ctx.stop(guard.stopType, guard.reason);
                return { supported: true, results, ...ctx.summary() };
            }
        }

        const text = String(messageText || "").trim();
        if (!text) return { supported: true, results: [{ status: "FAILED", reason: "empty-message" }], ...ctx.summary() };

        if (recipient) {
            if (!helper.capabilities.newDm) return { supported: false };
            if (!(await ctx.check(baseAction))) return { supported: true, results, ...ctx.summary() };
            const outcome = await helper.sendNewMessage(page, recipient, text);
            const ok = !!(outcome && (outcome.verified || outcome.unverified));
            if (ok) { await ctx.record(baseAction, 1); ctx.engaged += 1; }
            else ctx.failed += 1;
            results.push({ recipient, status: ok ? "SENT" : "FAILED", reason: outcome?.reason, unverified: !!outcome?.unverified });
            return { supported: true, results, ...ctx.summary() };
        }

        const conversations = await helper.listConversations(page, maxReplies);
        for (const conv of conversations) {
            if (!ctx.shouldContinue() || ctx.engaged >= maxReplies) break;
            if (!(await ctx.check(baseAction))) break;
            const convOpened = await helper.openConversation(page, conv.index);
            if (!convOpened) { ctx.failed += 1; continue; }
            const incoming = await helper.lastMessageText(page);
            const outcome = await helper.sendMessageText(page, text);
            const ok = !!(outcome && (outcome.verified || outcome.unverified));
            if (ok) { await ctx.record(baseAction, 1); ctx.engaged += 1; }
            else ctx.failed += 1;
            results.push({
                conversation: conv.name || conv.text || `#${conv.index}`,
                incoming: String(incoming || "").slice(0, 160),
                status: ok ? "SENT" : "FAILED",
                reason: outcome?.reason,
                unverified: !!outcome?.unverified,
            });
            await helper.openMessages(page);
            await enforceSingleTab(page, `[${taskId}]`);
        }
    } finally {
        detach();
        await ctx.finish();
    }

    return { supported: true, results, ...ctx.summary() };
}
