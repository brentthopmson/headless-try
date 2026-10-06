import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi } from '../../api/googlesheets.js';

const HUB_SHEET = "hub";
const USERS_SHEET = "user";

// ==================== Hub Account Interaction Tracking ====================

function parseInteractionUsage(raw) {
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); } catch { return {}; }
}

function defaultUsage(action) {
    const now = new Date();
    return {
        [action]: {
            hourly: 1,
            daily: 1,
            monthly: 1,
            total: 1,
            lastAction: now.toISOString(),
            hour: now.getHours(),
            day: now.getDate(),
            month: now.getMonth(),
            year: now.getFullYear(),
        }
    };
}

function incrementUsage(existing, action, count = 1) {
    const now = new Date();
    const n = Number.isFinite(parseInt(count, 10)) && parseInt(count, 10) > 0 ? parseInt(count, 10) : 1;
    const current = existing[action] || { hourly: 0, daily: 0, monthly: 0, total: 0 };

    const hourChanged = current.hour !== undefined && current.hour !== now.getHours();
    const dayChanged = current.day !== undefined && current.day !== now.getDate();
    // Monthly counters must roll over on month change AND on year change
    // (same calendar month next year must not inherit last year's total).
    const monthChanged = current.month !== undefined && (
        current.month !== now.getMonth() ||
        (current.year !== undefined && current.year !== now.getFullYear())
    );

    return {
        ...existing,
        [action]: {
            hourly: hourChanged ? n : (current.hourly || 0) + n,
            daily: dayChanged ? n : (current.daily || 0) + n,
            monthly: monthChanged ? n : (current.monthly || 0) + n,
            total: (current.total || 0) + n,
            lastAction: now.toISOString(),
            hour: now.getHours(),
            day: now.getDate(),
            month: now.getMonth(),
            year: now.getFullYear(),
        }
    };
}

export async function getAccountUsage(accountId) {
    try {
        const result = await getSheetDataApi(HUB_SHEET);
        if (!result.success) return {};

        const headers = result.headers;
        const submissionIdIdx = headers.indexOf("submissionId");
        const interactionUsageIdx = headers.indexOf("interactionUsage");
        const interactionStatusIdx = headers.indexOf("interactionStatus");

        if (submissionIdIdx === -1) return {};

        const row = result.data.find(r => String(r[submissionIdIdx]).trim() === String(accountId).trim());
        if (!row) return {};

        return {
            interactionUsage: parseInteractionUsage(interactionUsageIdx !== -1 ? row[interactionUsageIdx] : null),
            interactionStatus: interactionStatusIdx !== -1 ? String(row[interactionStatusIdx]).trim().toUpperCase() : "ACTIVE",
            rowIndex: result.data.indexOf(row),
        };
    } catch (e) {
        logger.error(`[getAccountUsage] Error for ${accountId}: ${e.message}`);
        return {};
    }
}

export async function updateAccountUsage(accountId, action, count = 1) {
    try {
        const accountData = await getAccountUsage(accountId);
        const currentUsage = accountData.interactionUsage || {};
        const updatedUsage = incrementUsage(currentUsage, action, count);

        const result = await updateSheetRowApi(HUB_SHEET, "submissionId", accountId, {
            interactionUsage: JSON.stringify(updatedUsage),
        });

        if (result.success) {
            logger.info(`[updateAccountUsage] ${accountId} action=${action} usage updated`);
        }
        return result.success;
    } catch (e) {
        logger.error(`[updateAccountUsage] Error for ${accountId}: ${e.message}`);
        return false;
    }
}

export async function updateAccountStatus(accountId, status) {
    const validStatuses = ["ACTIVE", "RATE_LIMITED", "WAITING", "CANCELLED"];
    const upper = status.toUpperCase().trim();
    if (!validStatuses.includes(upper)) {
        logger.warn(`[updateAccountStatus] Invalid status: ${status}`);
        return false;
    }

    try {
        const result = await updateSheetRowApi(HUB_SHEET, "submissionId", accountId, {
            interactionStatus: upper,
        });
        if (result.success) {
            logger.info(`[updateAccountStatus] ${accountId} → ${upper}`);
        }
        return result.success;
    } catch (e) {
        logger.error(`[updateAccountStatus] Error for ${accountId}: ${e.message}`);
        return false;
    }
}

export async function updateAccountInteractionData(accountId, interactionData) {
    try {
        const dataStr = typeof interactionData === "string" ? interactionData : JSON.stringify(interactionData);
        const result = await updateSheetRowApi(HUB_SHEET, "submissionId", accountId, {
            interactionData: dataStr,
        });
        if (result.success) {
            logger.info(`[updateAccountInteractionData] ${accountId} data updated`);
        }
        return result.success;
    } catch (e) {
        logger.error(`[updateAccountInteractionData] Error for ${accountId}: ${e.message}`);
        return false;
    }
}

// ==================== User-Level Usage Tracking ====================

// Single users-sheet read returning BOTH the plan (plan-row lookup key for
// monthly USER quotas) and the usage blob (the *Usage counters themselves).
// Missing user/columns → { plan: '', usage: {} } (callers fail open).
export async function getUserRecord(userId) {
    try {
        const result = await getSheetDataApi(USERS_SHEET);
        if (!result.success) return { plan: "", usage: {} };

        const headers = result.headers;
        const userIdIdx = headers.indexOf("userId");
        const usageIdx = headers.indexOf("usage");
        const planIdx = headers.indexOf("plan");

        if (userIdIdx === -1) return { plan: "", usage: {} };

        const row = result.data.find(r => String(r[userIdIdx]).trim() === String(userId).trim());
        if (!row) return { plan: "", usage: {} };

        const plan = planIdx !== -1 ? String(row[planIdx] || "").trim() : "";
        const raw = usageIdx !== -1 ? row[usageIdx] : null;
        return { plan, usage: parseInteractionUsage(raw) };
    } catch (e) {
        logger.error(`[getUserRecord] Error for ${userId}: ${e.message}`);
        return { plan: "", usage: {} };
    }
}

export async function getUserUsage(userId) {
    const record = await getUserRecord(userId);
    return record.usage;
}

export async function updateUserUsage(userId, action, count = 1) {
    try {
        const currentUsage = await getUserUsage(userId);
        const updatedUsage = incrementUsage(currentUsage, action, count);

        const result = await updateSheetRowApi(USERS_SHEET, "userId", userId, {
            usage: JSON.stringify(updatedUsage),
        });

        if (result.success) {
            logger.info(`[updateUserUsage] ${userId} action=${action} usage updated`);
        }
        return result.success;
    } catch (e) {
        logger.error(`[updateUserUsage] Error for ${userId}: ${e.message}`);
        return false;
    }
}

export { incrementUsage, parseInteractionUsage };
