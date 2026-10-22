import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi } from '../../api/googlesheets.js';
import limitsCore from './limitsCore.js';

const { canonicalAction } = limitsCore;

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

// Window rollover must compare FULL timestamps. Comparing only the hour/day
// number (the old behavior) let counters survive across days/months that shared
// the same number (e.g. Sep 21 → Oct 21 kept the daily count).
function lastUsageDate(entry) {
    if (!entry || typeof entry !== "object") return null;
    if (entry.lastAction) {
        const t = Date.parse(entry.lastAction);
        if (!Number.isNaN(t)) return new Date(t);
    }
    if (Number.isFinite(entry.hour) && Number.isFinite(entry.day) && Number.isFinite(entry.month)) {
        const year = Number.isFinite(entry.year) ? entry.year : new Date().getFullYear();
        return new Date(year, entry.month, entry.day, entry.hour, 0, 0, 0);
    }
    return null;
}

function incrementUsage(existing, action, count = 1) {
    const now = new Date();
    const n = Number.isFinite(parseInt(count, 10)) && parseInt(count, 10) > 0 ? parseInt(count, 10) : 1;
    const current = existing[action] || { hourly: 0, daily: 0, monthly: 0, total: 0 };

    const last = lastUsageDate(current);
    const sameHour = !!last
        && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()
        && last.getDate() === now.getDate() && last.getHours() === now.getHours();
    const sameDay = !!last
        && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth()
        && last.getDate() === now.getDate();
    const sameMonth = !!last
        && last.getFullYear() === now.getFullYear() && last.getMonth() === now.getMonth();

    return {
        ...existing,
        [action]: {
            hourly: sameHour ? (current.hourly || 0) + n : n,
            daily: sameDay ? (current.daily || 0) + n : n,
            monthly: sameMonth ? (current.monthly || 0) + n : n,
            total: (current.total || 0) + n,
            lastAction: now.toISOString(),
            hour: now.getHours(),
            day: now.getDate(),
            month: now.getMonth(),
            year: now.getFullYear(),
        }
    };
}

// ==================== Account usage cache ====================
// A single interaction currently triggers up to 4 HUB_SHEET reads
// (gate check + the re-read inside updateAccountUsage, for like AND comment).
// Cache the parsed usage briefly + dedupe concurrent reads; updates mutate the
// cached copy and write the row WITHOUT re-reading. The sheet is still written
// on every action, so quota survives crashes — worst case is ~4s of staleness
// for another process reading the same account.
// globalThis so every route bundle shares the same cache/chains — Next.js
// creates a separate module scope per route otherwise (see limits.js).
const USAGE_CACHE_TTL_MS = 4000;
if (!globalThis.__hubUsageState) {
    globalThis.__hubUsageState = {
        cache: new Map(),         // accountId -> { data, ts }
        inflight: new Map(),      // accountId -> Promise<data>
        writeChains: new Map(),   // accountId -> Promise (serialize writes)
        userCache: new Map(),     // userId -> { record, ts }
        userInflight: new Map(),  // userId -> Promise<record>
        userWriteChains: new Map(), // userId -> Promise
    };
}
const hubState = globalThis.__hubUsageState;
const usageCache = hubState.cache;
const usageInflight = hubState.inflight;
const usageWriteChains = hubState.writeChains;

async function fetchAccountUsage(accountId) {
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

export async function getAccountUsage(accountId, options = {}) {
    const force = options.force === true;
    const cached = usageCache.get(accountId);
    if (!force && cached && (Date.now() - cached.ts) < USAGE_CACHE_TTL_MS) {
        return cached.data;
    }
    if (usageInflight.has(accountId)) return usageInflight.get(accountId);
    const pending = fetchAccountUsage(accountId)
        .then((data) => {
            usageCache.set(accountId, { data, ts: Date.now() });
            return data;
        })
        .finally(() => usageInflight.delete(accountId));
    usageInflight.set(accountId, pending);
    return pending;
}

export async function updateAccountUsage(accountId, action, count = 1) {
    // Always store under the canonical Limits-column key (likeComment →
    // likesOnComment) so gate checks and writes read the same JSON entry.
    const usageKey = canonicalAction(action);
    try {
        // Warm the cache, then re-read it synchronously so concurrent updates
        // to the same account compose instead of overwriting each other.
        await getAccountUsage(accountId);
        const base = usageCache.get(accountId)?.data || {};
        const currentUsage = base.interactionUsage || {};
        const updatedUsage = incrementUsage(currentUsage, usageKey, count);
        usageCache.set(accountId, {
            data: { ...base, interactionUsage: updatedUsage },
            ts: Date.now(),
        });

        const payload = JSON.stringify(updatedUsage);
        const prev = usageWriteChains.get(accountId) || Promise.resolve();
        const write = prev.then(async () => {
            try {
                const result = await updateSheetRowApi(HUB_SHEET, "submissionId", accountId, {
                    interactionUsage: payload,
                });
                if (result.success) {
                    logger.info(`[updateAccountUsage] ${accountId} action=${usageKey} usage updated`);
                } else {
                    // Force a fresh read next time so we don't drift from the sheet.
                    usageCache.delete(accountId);
                }
                return result.success;
            } catch (e) {
                usageCache.delete(accountId);
                logger.error(`[updateAccountUsage] Error for ${accountId}: ${e.message}`);
                return false;
            }
        });
        usageWriteChains.set(accountId, write.catch(() => {}));
        return await write;
    } catch (e) {
        logger.error(`[updateAccountUsage] Error for ${accountId}: ${e.message}`);
        return false;
    }
}

// Apply a verified action tally to hub usage: { likeComment: 2, ... } or
// canonical keys. Returns the canonical tally that was actually written.
export async function consumeAccountActions(accountId, tally) {
    const written = {};
    if (!accountId || !tally || typeof tally !== "object") return written;
    for (const [action, raw] of Object.entries(tally)) {
        const count = parseInt(raw, 10);
        if (!Number.isFinite(count) || count <= 0) continue;
        const key = canonicalAction(action);
        const ok = await updateAccountUsage(accountId, key, count);
        if (ok) {
            written[key] = (written[key] || 0) + count;
        } else {
            logger.warn(`[consumeAccountActions] ${accountId} ${key} x${count} NOT counted (write failed)`);
        }
    }
    return written;
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

const userCache = hubState.userCache;
const userInflight = hubState.userInflight;
const userWriteChains = hubState.userWriteChains;

async function fetchUserRecord(userId) {
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

// Single users-sheet read returning BOTH the plan (plan-row lookup key for
// monthly USER quotas) and the usage blob. Cached briefly + in-flight dedupe so
// concurrent task runners don't stampede the sheet; fail-open on errors.
export async function getUserRecord(userId, options = {}) {
    const force = options.force === true;
    const cached = userCache.get(userId);
    if (!force && cached && (Date.now() - cached.ts) < USAGE_CACHE_TTL_MS) {
        return cached.record;
    }
    if (userInflight.has(userId)) return userInflight.get(userId);
    const pending = fetchUserRecord(userId)
        .then((record) => {
            userCache.set(userId, { record, ts: Date.now() });
            return record;
        })
        .finally(() => userInflight.delete(userId));
    userInflight.set(userId, pending);
    return pending;
}

export async function getUserUsage(userId) {
    const record = await getUserRecord(userId);
    return record.usage;
}

// Increment a user's usage counters. Writes are serialized per user and the
// cache is updated first so quota checks in the same process see the spend
// immediately. `count` is the number of ACTUAL actions performed.
export async function updateUserUsage(userId, action, count = 1) {
    try {
        await getUserRecord(userId);
        const base = userCache.get(userId)?.record || { plan: "", usage: {} };
        const updatedUsage = incrementUsage(base.usage || {}, action, count);
        userCache.set(userId, {
            record: { ...base, usage: updatedUsage },
            ts: Date.now(),
        });

        const payload = JSON.stringify(updatedUsage);
        const prev = userWriteChains.get(userId) || Promise.resolve();
        const write = prev.then(async () => {
            try {
                const result = await updateSheetRowApi(USERS_SHEET, "userId", userId, {
                    usage: payload,
                });
                if (result.success) {
                    logger.info(`[updateUserUsage] ${userId} action=${action} +${count} usage updated`);
                } else {
                    userCache.delete(userId);
                }
                return result.success;
            } catch (e) {
                userCache.delete(userId);
                logger.error(`[updateUserUsage] Error for ${userId}: ${e.message}`);
                return false;
            }
        });
        userWriteChains.set(userId, write.catch(() => {}));
        return await write;
    } catch (e) {
        logger.error(`[updateUserUsage] Error for ${userId}: ${e.message}`);
        return false;
    }
}

export { incrementUsage, parseInteractionUsage };
