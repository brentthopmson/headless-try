import logger from "../../../utils/logger.js";
import { checkActionAllowed, getPlatformLimits } from "./limits.js";
import { getAccountUsage, updateAccountStatus } from "./hubUpdater.js";

// ACCOUNT-tier status gate, evaluated BEFORE any browser launch.
//
// Reads hub interactionStatus for a profile/account and decides whether it may
// run tasks right now:
//   ACTIVE / WAITING / missing / unknown row → allow (WAITING is used by email
//     login flows and is left untouched to avoid breaking them)
//   CANCELLED → block (explicit opt-out, never auto-recovered)
//   RATE_LIMITED → block UNLESS every configured platform action is back under
//     its policy (windows rolled) → then auto-recover to ACTIVE and allow.
//
// Recovery evaluates the platform policy against current usage for every
// action column that has a real limit configured — so it is independent of
// which action originally tripped the flag.
//
// Blocked reasons are phrased distinctly from platform-policy blocks:
//   routes' catch blocks only flip RATE_LIMITED on "blocked by platform limits",
//   so "blocked by account limits" never re-writes the status it just read.
export async function resolveAccountGate(profileId, platform) {
    if (!profileId) return { blocked: false };

    let accountData;
    try {
        accountData = await getAccountUsage(profileId);
    } catch (e) {
        logger.warn(`[account-limit] status read failed for ${profileId}: ${e.message} — allowing (fail-open)`);
        return { blocked: false, error: e.message };
    }

    const status = accountData && accountData.interactionStatus;
    if (!status || status === "ACTIVE" || status === "WAITING") {
        return { blocked: false, status: status || "ACTIVE" };
    }

    if (status === "CANCELLED") {
        return { blocked: true, status, reason: "cancelled" };
    }

    if (status === "RATE_LIMITED") {
        const usage = (accountData && accountData.interactionUsage) || {};
        const limits = await getPlatformLimits(platform);
        const actions = limits ? Object.keys(limits) : [];
        let firstBlocked = null;
        for (const action of actions) {
            const res = await checkActionAllowed(platform, action, usage);
            if (!res.allowed) {
                firstBlocked = `${action} ${res.reason}`;
                break;
            }
        }
        if (!firstBlocked) {
            try {
                await updateAccountStatus(profileId, "ACTIVE");
            } catch (e) {
                logger.warn(`[account-limit] recovery status write failed for ${profileId}: ${e.message}`);
            }
            logger.info(`[account-limit] ${profileId}: RATE_LIMITED auto-recovered (windows rolled) → ACTIVE`);
            return { blocked: false, status: "ACTIVE", recovered: true };
        }
        return { blocked: true, status, reason: firstBlocked };
    }

    return { blocked: false, status };
}

// Throws the standard account-limit error when the gate blocks. Kept separate
// so callers can choose to skip silently (campaign queue) or throw (routes).
export function accountGateError(profileId, gate) {
    return new Error(`Account ${profileId} blocked by account limits: ${gate.reason}`);
}

// Shared classifier for limit-type task errors → campaign treats these as
// SKIPPED (account/platform limits) rather than FAILED (real errors).
function isLimitSkipError(message) {
    const msg = String(message || "");
    return msg.includes("blocked by platform limits") || msg.includes("blocked by account limits");
}

export { isLimitSkipError };
