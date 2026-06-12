import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi } from '../../api/googlesheets.js';

const HUB_SHEET = "hub";
const USERS_SHEET = "users";

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
        }
    };
}

function incrementUsage(existing, action) {
    const now = new Date();
    const current = existing[action] || { hourly: 0, daily: 0, monthly: 0, total: 0 };

    const hourChanged = current.hour !== undefined && current.hour !== now.getHours();
    const dayChanged = current.day !== undefined && current.day !== now.getDate();
    const monthChanged = current.month !== undefined && current.month !== now.getMonth();

    return {
        ...existing,
        [action]: {
            hourly: hourChanged ? 1 : (current.hourly || 0) + 1,
            daily: dayChanged ? 1 : (current.daily || 0) + 1,
            monthly: monthChanged ? 1 : (current.monthly || 0) + 1,
            total: (current.total || 0) + 1,
            lastAction: now.toISOString(),
            hour: now.getHours(),
            day: now.getDate(),
            month: now.getMonth(),
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

export async function updateAccountUsage(accountId, action) {
    try {
        const accountData = await getAccountUsage(accountId);
        const currentUsage = accountData.interactionUsage || {};
        const updatedUsage = incrementUsage(currentUsage, action);

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

export async function getUserUsage(userId) {
    try {
        const result = await getSheetDataApi(USERS_SHEET);
        if (!result.success) return {};

        const headers = result.headers;
        const userIdIdx = headers.indexOf("userId");
        const usageIdx = headers.indexOf("usage");

        if (userIdIdx === -1) return {};

        const row = result.data.find(r => String(r[userIdIdx]).trim() === String(userId).trim());
        if (!row) return {};

        const raw = usageIdx !== -1 ? row[usageIdx] : null;
        return parseInteractionUsage(raw);
    } catch (e) {
        logger.error(`[getUserUsage] Error for ${userId}: ${e.message}`);
        return {};
    }
}

export async function updateUserUsage(userId, action) {
    try {
        const currentUsage = await getUserUsage(userId);
        const updatedUsage = incrementUsage(currentUsage, action);

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
