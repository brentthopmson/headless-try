import logger from "../../../utils/logger.js";
import { checkGate, consumeAction, classifyStop } from "./routeHelper.js";
import { createTally } from "./quotaActions.js";
import { updateAccountStatus } from "./hubUpdater.js";

export function createRunContext(options = {}) {
    const platform = options.platform || "";
    const profileId = options.profileId || null;
    const taskId = options.taskId || "run";
    const stopAfterHours = Math.max(0, Number(options.stopAfterHours) || 0);
    const log = options.log || logger;
    const tally = createTally();
    const startedAt = Date.now();

    const ctx = {
        platform,
        profileId,
        taskId,
        log,
        tally,
        stopType: null,
        stopReason: null,
        engaged: 0,
        failed: 0,
        startedAt,
        actionExhausted: {},

        stop(type, reason) {
            if (ctx.stopType) return ctx.stopType;
            ctx.stopType = type || "limit";
            ctx.stopReason = reason || type || "limit";
            return ctx.stopType;
        },

        markActionExhausted(baseAction, type, reason) {
            if (!ctx.actionExhausted[baseAction]) {
                ctx.actionExhausted[baseAction] = { type: type || "limit", reason: reason || "" };
                log.info(`[${taskId}] Action '${baseAction}' exhausted (${ctx.actionExhausted[baseAction].type}) — skipping '${baseAction}' only.`);
            }
            return ctx.actionExhausted[baseAction];
        },

        isActionExhausted(baseAction) {
            return !!ctx.actionExhausted[baseAction];
        },

        stopIfNoPermittedActions(actions) {
            if (ctx.stopped()) return true;
            const list = Array.isArray(actions) ? actions.filter(Boolean) : [];
            if (!list.length) return false;
            if (!list.every(a => ctx.actionExhausted[a])) return false;
            const tiers = list.map(a => ctx.actionExhausted[a] && ctx.actionExhausted[a].type).filter(Boolean);
            const hasHourly = tiers.includes("hourly");
            if (hasHourly) ctx.stop("hourly", "all_actions_hourly_exhausted");
            else if (tiers.includes("daily")) ctx.stop("daily", "all_actions_exhausted");
            else if (tiers.includes("monthly")) ctx.stop("monthly", "all_actions_exhausted");
            else if (tiers.includes("yearly")) ctx.stop("yearly", "all_actions_exhausted");
            else ctx.stop("cap", "all_actions_exhausted");
            log.info(`[${taskId}] No permitted actions remain (${list.join(",")}) — stopping run (${ctx.stopType}).`);
            return true;
        },

        stopped() {
            return !!ctx.stopType;
        },

        timeExceeded() {
            if (!stopAfterHours) return false;
            const elapsedHours = (Date.now() - startedAt) / 3600000;
            if (elapsedHours < stopAfterHours) return false;
            ctx.stop("time", `time_limit_${stopAfterHours}h`);
            return true;
        },

        shouldContinue() {
            if (ctx.stopped()) return false;
            if (ctx.timeExceeded()) return false;
            return true;
        },

        // Legacy: blocks the WHOLE run on quota. Prefer checkSoft + stopIfNoPermittedActions for isolation.
        async check(baseAction) {
            if (ctx.stopped()) return false;
            const gate = await checkGate(platform, profileId, baseAction);
            if (gate.allowed) return true;
            const type = gate.stopType || classifyStop(gate.reason) || "limit";
            ctx.stop(type, gate.reason);
            log.info(`[${taskId}] ${baseAction} blocked (${gate.reason}) - stopping run.`);
            return false;
        },

        // Per-action isolation: marks only this action exhausted (does not stop run).
        async checkSoft(baseAction) {
            if (ctx.stopped()) return false;
            if (ctx.actionExhausted[baseAction]) return false;
            const gate = await checkGate(platform, profileId, baseAction);
            if (gate.allowed) return true;
            const type = gate.stopType || classifyStop(gate.reason) || "limit";
            ctx.markActionExhausted(baseAction, type, gate.reason);
            return false;
        },

        async record(baseAction, count = 1) {
            const n = Number(count) || 0;
            if (n <= 0) return 0;
            const ok = await consumeAction(profileId, baseAction, n).catch(() => false);
            if (ok) tally.add(baseAction, n);
            return ok ? n : 0;
        },

        async verifyAndRecord(page, baseAction, verifyFn, count = 1) {
            let result;
            try {
                result = await verifyFn(page);
            } catch (e) {
                log.warn(`[${taskId}] verify ${baseAction} failed: ${e.message}`);
                result = { verified: false, reason: "verify-error" };
            }
            if (result && result.verified) {
                await ctx.record(baseAction, count);
                ctx.engaged += Number(count) || 1;
                return true;
            }
            if (result && result.unverified) {
                log.warn(`[${taskId}] ${baseAction} counted as unverified${result.reason ? ` (${result.reason})` : ""}`);
                await ctx.record(baseAction, count);
                ctx.engaged += Number(count) || 1;
                return true;
            }
            log.info(`[${taskId}] ${baseAction} NOT counted${result?.reason ? ` (${result.reason})` : ""}`);
            ctx.failed += 1;
            return false;
        },

        async finish() {
            if (ctx.stopType === "hourly") {
                await updateAccountStatus(profileId, "RATE_LIMITED").catch(() => {});
                log.info(`[${taskId}] Hourly limit hit - account ${profileId || "unknown"} marked RATE_LIMITED.`);
            } else if (ctx.stopType === "captcha") {
                await updateAccountStatus(profileId, "WAITING").catch(() => {});
            } else if (ctx.stopType === "daily" || ctx.stopType === "monthly" || ctx.stopType === "yearly" || ctx.stopType === "cap") {
                log.info(`[${taskId}] ${ctx.stopType} limit reached - stopping this run.`);
            }
        },

        summary(extra = {}) {
            return {
                ...extra,
                quota: { ...tally.tally, total: tally.total() },
                engaged: ctx.engaged,
                failed: ctx.failed,
                stopType: ctx.stopType,
                stopReason: ctx.stopReason,
            };
        },
    };

    return ctx;
}

export async function runAction(ctx, baseAction, fn) {
    if (!ctx.shouldContinue()) return null;
    if (!(await ctx.check(baseAction))) return null;
    try {
        return await fn();
    } catch (e) {
        ctx.failed += 1;
        ctx.log.warn(`[${ctx.taskId}] ${baseAction} failed: ${e.message}`);
        return null;
    }
}
