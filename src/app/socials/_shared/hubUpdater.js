import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi } from '../../api/googlesheets.js';
import limitsCore from './limitsCore.js';

const { canonicalAction } = limitsCore;

const HUB_SHEET = "hub";
const USERS_SHEET = "user";
const CAMPAIGNS_SHEET = "campaigns";

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
// Smart batching: reduce quota usage by buffering writes (5s delay or 10 actions)
const USAGE_FLUSH_DELAY_MS = 5000;
const USAGE_FLUSH_THRESHOLD = 10;
if (!globalThis.__hubUsageState) {
    globalThis.__hubUsageState = {
        cache: new Map(),         // accountId -> { data, ts }
        inflight: new Map(),      // accountId -> Promise<data>
        writeChains: new Map(),   // accountId -> Promise (serialize writes)
        userCache: new Map(),     // userId -> { record, ts }
        userInflight: new Map(),  // userId -> Promise<record>
        userWriteChains: new Map(), // userId -> Promise
        activeCampaigns: new Map(), // accountId -> { campaignId, identifier, platform }
        campaignStatsCache: new Map(), // campaignId -> { stats, ts }
        campaignWriteChains: new Map(), // campaignId -> Promise
        pendingAccountUpdates: new Map(), // accountId -> { usage, timer, count }
        pendingUserUpdates: new Map(), // userId -> { usage, timer, count }
        pendingCampaignUpdates: new Map(), // campaignId -> { updates: Map, timer }
    };
}
const hubState = globalThis.__hubUsageState;
if (!hubState.activeCampaigns) hubState.activeCampaigns = new Map();
if (!hubState.campaignStatsCache) hubState.campaignStatsCache = new Map();
if (!hubState.campaignWriteChains) hubState.campaignWriteChains = new Map();
if (!hubState.pendingAccountUpdates) hubState.pendingAccountUpdates = new Map();
if (!hubState.pendingUserUpdates) hubState.pendingUserUpdates = new Map();
if (!hubState.pendingCampaignUpdates) hubState.pendingCampaignUpdates = new Map();
const usageCache = hubState.cache;
const usageInflight = hubState.inflight;
const usageWriteChains = hubState.writeChains;
const activeCampaigns = hubState.activeCampaigns;
const campaignStatsCache = hubState.campaignStatsCache;
const campaignWriteChains = hubState.campaignWriteChains;
const pendingAccountUpdates = hubState.pendingAccountUpdates;
const pendingUserUpdates = hubState.pendingUserUpdates;
const pendingCampaignUpdates = hubState.pendingCampaignUpdates;

export function setActiveCampaignForAccount(accountId, meta) {
    if (!accountId || !meta || !meta.campaignId) return;
    activeCampaigns.set(String(accountId).trim(), {
        campaignId: String(meta.campaignId).trim(),
        identifier: meta.identifier || String(accountId).trim(),
        platform: meta.platform || "",
    });
}

export function clearActiveCampaignForAccount(accountId, campaignId) {
    if (!accountId) return;
    const key = String(accountId).trim();
    const cur = activeCampaigns.get(key);
    if (!campaignId || (cur && cur.campaignId === String(campaignId).trim())) {
        activeCampaigns.delete(key);
    }
}

async function fetchCampaignStats(campaignId) {
    try {
        const result = await getSheetDataApi(CAMPAIGNS_SHEET);
        if (!result.success) return { totalActions: 0, interactions: 0, conversions: 0, inbox: 0, accounts: {} };
        const headers = result.headers || [];
        const idIdx = headers.indexOf("campaignId");
        const statsIdx = headers.indexOf("stats");
        if (idIdx === -1) return { totalActions: 0, interactions: 0, conversions: 0, inbox: 0, accounts: {} };
        const row = (result.data || []).find(r => String(r[idIdx] || "").trim() === String(campaignId).trim());
        if (!row) return { totalActions: 0, interactions: 0, conversions: 0, inbox: 0, accounts: {} };
        const parsed = parseInteractionUsage(statsIdx !== -1 ? row[statsIdx] : null);
        if (!parsed.accounts || typeof parsed.accounts !== "object") parsed.accounts = {};
        if (typeof parsed.totalActions !== "number") parsed.totalActions = Number(parsed.interactions) || 0;
        if (typeof parsed.interactions !== "number") parsed.interactions = parsed.totalActions || 0;
        if (typeof parsed.conversions !== "number") parsed.conversions = 0;
        if (typeof parsed.inbox !== "number") parsed.inbox = 0;
        return parsed;
    } catch (e) {
        logger.warn(`[fetchCampaignStats] Error for ${campaignId}: ${e.message}`);
        return { totalActions: 0, interactions: 0, conversions: 0, inbox: 0, accounts: {} };
    }
}

export async function seedCampaignAccountsInStats(campaignId, accountsList = []) {
    if (!campaignId || !Array.isArray(accountsList) || accountsList.length === 0) return;
    const cid = String(campaignId).trim();
    const prev = campaignWriteChains.get(cid) || Promise.resolve();
    const job = prev.then(async () => {
        try {
            let stats = campaignStatsCache.get(cid)?.stats;
            if (!stats) {
                stats = await fetchCampaignStats(cid);
            }
            if (!stats.accounts || typeof stats.accounts !== "object") stats.accounts = {};
            let changed = false;
            for (const acc of accountsList) {
                const aid = String(acc.accountId || acc.profileId || "").trim();
                if (!aid) continue;
                if (!stats.accounts[aid]) {
                    stats.accounts[aid] = {
                        identifier: acc.identifier || aid,
                        platform: acc.platform || "",
                        total: 0,
                        usage: {},
                    };
                    changed = true;
                } else {
                    if (acc.identifier && stats.accounts[aid].identifier !== acc.identifier) {
                        stats.accounts[aid].identifier = acc.identifier;
                        changed = true;
                    }
                    if (acc.platform && !stats.accounts[aid].platform) {
                        stats.accounts[aid].platform = acc.platform;
                        changed = true;
                    }
                }
            }
            campaignStatsCache.set(cid, { stats, ts: Date.now() });
            if (changed) {
                await updateSheetRowApi(CAMPAIGNS_SHEET, "campaignId", cid, {
                    stats: JSON.stringify(stats),
                    updatedOn: new Date().toISOString(),
                });
            }
        } catch (e) {
            logger.warn(`[seedCampaignAccountsInStats] Error for ${cid}: ${e.message}`);
        }
    });
    campaignWriteChains.set(cid, job.catch(() => {}));
    return job;
}

async function flushCampaignStatsUsage(campaignId, retryCount = 0) {
    const pending = pendingCampaignUpdates.get(campaignId);
    if (!pending || pending.updates.size === 0) return true;
    if (pending.timer) clearTimeout(pending.timer);
    
    try {
        let stats = campaignStatsCache.get(campaignId)?.stats;
        if (!stats) {
            stats = await fetchCampaignStats(campaignId);
        }
        if (!stats.accounts || typeof stats.accounts !== "object") stats.accounts = {};
        
        let totalPending = 0;
        for (const [key, upd] of pending.updates.entries()) {
            const { accountId: aid, action, count: n, meta } = upd;
            const usageKey = action;
            const accEntry = stats.accounts[aid] || {
                identifier: meta.identifier || aid,
                platform: meta.platform || "",
                total: 0,
                usage: {},
            };
            if (meta.identifier && (!accEntry.identifier || accEntry.identifier === aid)) {
                accEntry.identifier = meta.identifier;
            }
            if (meta.platform && !accEntry.platform) {
                accEntry.platform = meta.platform;
            }
            accEntry.usage = incrementUsage(accEntry.usage || {}, usageKey, n);
            accEntry.total = Object.values(accEntry.usage).reduce((sum, u) => sum + (Number(u?.total) || 0), 0);
            stats.accounts[aid] = accEntry;
            totalPending += n;
            if (usageKey === "inboxReply" || usageKey === "coldMessage" || usageKey === "emailSent") {
                stats.inbox = (Number(stats.inbox) || 0) + n;
            }
        }
        
        const totalAcrossAccounts = Object.values(stats.accounts).reduce((sum, a) => sum + (Number(a?.total) || 0), 0);
        stats.totalActions = Math.max(totalAcrossAccounts, (Number(stats.totalActions) || 0) + totalPending);
        stats.interactions = stats.totalActions;
        
        campaignStatsCache.set(campaignId, { stats, ts: Date.now() });
        
        const prev = campaignWriteChains.get(campaignId) || Promise.resolve();
        const write = prev.then(async () => {
            try {
                const res = await updateSheetRowApi(CAMPAIGNS_SHEET, "campaignId", campaignId, {
                    stats: JSON.stringify(stats),
                    updatedOn: new Date().toISOString(),
                });
                if (res.success) {
                    pendingCampaignUpdates.delete(campaignId);
                    logger.info(`[updateCampaignStatsUsage] campaign=${campaignId} batched ${pending.updates.size} account-updates flushed (+${totalPending} actions)`);
                    return true;
                } else {
                    logger.warn(`[updateCampaignStatsUsage] Flush failed for ${campaignId}, will retry`);
                    if (retryCount < 5) {
                        setTimeout(() => flushCampaignStatsUsage(campaignId, retryCount + 1), 2000 * (retryCount + 1));
                    } else {
                        const timer = setTimeout(() => flushCampaignStatsUsage(campaignId, 0), USAGE_FLUSH_DELAY_MS * 2);
                        pending.timer = timer;
                        pendingCampaignUpdates.set(campaignId, pending);
                    }
                    return false;
                }
            } catch (e) {
                logger.warn(`[updateCampaignStatsUsage] Error for ${campaignId}: ${e.message}`);
                if (retryCount < 5) {
                    setTimeout(() => flushCampaignStatsUsage(campaignId, retryCount + 1), 2000 * (retryCount + 1));
                } else {
                    const timer = setTimeout(() => flushCampaignStatsUsage(campaignId, 0), USAGE_FLUSH_DELAY_MS * 2);
                    pending.timer = timer;
                    pendingCampaignUpdates.set(campaignId, pending);
                }
                return false;
            }
        });
        campaignWriteChains.set(campaignId, write.catch(() => {}));
        return await write;
    } catch (e) {
        logger.warn(`[updateCampaignStatsUsage] Error for ${campaignId}: ${e.message}`);
        if (retryCount < 5) {
            setTimeout(() => flushCampaignStatsUsage(campaignId, retryCount + 1), 2000 * (retryCount + 1));
        } else {
            const timer = setTimeout(() => flushCampaignStatsUsage(campaignId, 0), USAGE_FLUSH_DELAY_MS * 2);
            if (pending) {
                pending.timer = timer;
                pendingCampaignUpdates.set(campaignId, pending);
            }
        }
        return false;
    }
}

export async function flushAllCampaignStats() {
    const promises = [];
    for (const campaignId of Array.from(pendingCampaignUpdates.keys())) {
        promises.push(flushCampaignStatsUsage(campaignId));
    }
    await Promise.allSettled(promises);
}

export async function updateCampaignStatsUsage(campaignId, accountId, action, count = 1, meta = {}) {
    if (!campaignId || !accountId || !action) return false;
    const cid = String(campaignId).trim();
    const aid = String(accountId).trim();
    const usageKey = canonicalAction(action);
    const n = Number.isFinite(parseInt(count, 10)) && parseInt(count, 10) > 0 ? parseInt(count, 10) : 1;

    try {
        // Update cache immediately for accuracy
        let stats = campaignStatsCache.get(cid)?.stats;
        if (!stats) {
            stats = await fetchCampaignStats(cid);
        }
        if (!stats.accounts || typeof stats.accounts !== "object") stats.accounts = {};
        const accEntry = stats.accounts[aid] || {
            identifier: meta.identifier || aid,
            platform: meta.platform || "",
            total: 0,
            usage: {},
        };
        if (meta.identifier && (!accEntry.identifier || accEntry.identifier === aid)) {
            accEntry.identifier = meta.identifier;
        }
        if (meta.platform && !accEntry.platform) {
            accEntry.platform = meta.platform;
        }
        accEntry.usage = incrementUsage(accEntry.usage || {}, usageKey, n);
        accEntry.total = Object.values(accEntry.usage).reduce((sum, u) => sum + (Number(u?.total) || 0), 0);
        stats.accounts[aid] = accEntry;

        const totalAcrossAccounts = Object.values(stats.accounts).reduce((sum, a) => sum + (Number(a?.total) || 0), 0);
        stats.totalActions = Math.max(totalAcrossAccounts, (Number(stats.totalActions) || 0) + n);
        stats.interactions = stats.totalActions;
        if (usageKey === "inboxReply" || usageKey === "coldMessage" || usageKey === "emailSent") {
            stats.inbox = (Number(stats.inbox) || 0) + n;
        }

        campaignStatsCache.set(cid, { stats, ts: Date.now() });

        // Buffer the update - flush immediately for better UI responsiveness
        const existing = pendingCampaignUpdates.get(cid);
        const key = `${aid}:${usageKey}`;
        if (existing) {
            if (existing.timer) clearTimeout(existing.timer);
            if (existing.updates.has(key)) {
                existing.updates.get(key).count += n;
            } else {
                existing.updates.set(key, { accountId: aid, action: usageKey, count: n, meta });
            }
            return await flushCampaignStatsUsage(cid);
        } else {
            const updates = new Map();
            updates.set(key, { accountId: aid, action: usageKey, count: n, meta });
            pendingCampaignUpdates.set(cid, { updates, timer: null });
            return await flushCampaignStatsUsage(cid);
        }
    } catch (e) {
        logger.warn(`[updateCampaignStatsUsage] Error for ${cid}/${aid}: ${e.message}`);
        return false;
    }
}

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

async function flushAccountUsage(accountId, retryCount = 0) {
    const pending = pendingAccountUpdates.get(accountId);
    if (!pending) return true;
    if (pending.timer) clearTimeout(pending.timer);
    
    try {
        await getAccountUsage(accountId);
        const base = usageCache.get(accountId)?.data || {};
        const currentUsage = base.interactionUsage || {};
        let mergedUsage = currentUsage;
        // Apply all pending increments
        for (const [action, count] of Object.entries(pending.usage)) {
            mergedUsage = incrementUsage(mergedUsage, action, count);
        }
        usageCache.set(accountId, {
            data: { ...base, interactionUsage: mergedUsage },
            ts: Date.now(),
        });

        const payload = JSON.stringify(mergedUsage);
        const prev = usageWriteChains.get(accountId) || Promise.resolve();
        const write = prev.then(async () => {
            try {
                const result = await updateSheetRowApi(HUB_SHEET, "submissionId", accountId, {
                    interactionUsage: payload,
                });
                if (result.success) {
                    // Only remove from pending on success
                    pendingAccountUpdates.delete(accountId);
                    logger.info(`[updateAccountUsage] ${accountId} batched ${pending.count} actions flushed`);
                    return true;
                } else {
                    // Failed - keep pending for retry
                    logger.warn(`[updateAccountUsage] Flush failed for ${accountId}, will retry`);
                    if (retryCount < 5) {
                        setTimeout(() => flushAccountUsage(accountId, retryCount + 1), 2000 * (retryCount + 1));
                    } else {
                        // Max retries reached, reschedule for later
                        const timer = setTimeout(() => flushAccountUsage(accountId, 0), USAGE_FLUSH_DELAY_MS * 2);
                        pending.timer = timer;
                        pendingAccountUpdates.set(accountId, pending);
                    }
                    return false;
                }
            } catch (e) {
                // Error - keep pending for retry
                logger.error(`[updateAccountUsage] Error for ${accountId}: ${e.message}`);
                if (retryCount < 5) {
                    setTimeout(() => flushAccountUsage(accountId, retryCount + 1), 2000 * (retryCount + 1));
                } else {
                    const timer = setTimeout(() => flushAccountUsage(accountId, 0), USAGE_FLUSH_DELAY_MS * 2);
                    pending.timer = timer;
                    pendingAccountUpdates.set(accountId, pending);
                }
                return false;
            }
        });
        usageWriteChains.set(accountId, write.catch(() => {}));
        const resultOk = await write;
        const activeCtx = activeCampaigns.get(String(accountId).trim());
        if (resultOk && activeCtx && activeCtx.campaignId) {
            for (const [action, count] of Object.entries(pending.usage)) {
                await updateCampaignStatsUsage(activeCtx.campaignId, accountId, action, count, activeCtx).catch(() => {});
            }
        }
        return resultOk;
    } catch (e) {
        logger.error(`[updateAccountUsage] Error for ${accountId}: ${e.message}`);
        if (retryCount < 5) {
            setTimeout(() => flushAccountUsage(accountId, retryCount + 1), 2000 * (retryCount + 1));
        } else {
            const timer = setTimeout(() => flushAccountUsage(accountId, 0), USAGE_FLUSH_DELAY_MS * 2);
            if (pending) {
                pending.timer = timer;
                pendingAccountUpdates.set(accountId, pending);
            }
        }
        return false;
    }
}

export async function flushAllAccountUsage() {
    const promises = [];
    for (const accountId of Array.from(pendingAccountUpdates.keys())) {
        promises.push(flushAccountUsage(accountId));
    }
    for (const userId of Array.from(pendingUserUpdates.keys())) {
        promises.push(flushUserUsage(userId));
    }
    await Promise.allSettled(promises);
}

export async function updateAccountUsage(accountId, action, count = 1) {
    // Always store under the canonical Limits-column key (likeComment →
    // likesOnComment) so gate checks and writes read the same JSON entry.
    const usageKey = canonicalAction(action);
    const n = Number.isFinite(parseInt(count, 10)) && parseInt(count, 10) > 0 ? parseInt(count, 10) : 1;
    
    try {
        // Update cache immediately for read-modify-write consistency
        await getAccountUsage(accountId);
        const base = usageCache.get(accountId)?.data || {};
        const currentUsage = base.interactionUsage || {};
        const updatedUsage = incrementUsage(currentUsage, usageKey, n);
        usageCache.set(accountId, {
            data: { ...base, interactionUsage: updatedUsage },
            ts: Date.now(),
        });
        
        // Buffer the update instead of writing immediately
        const existing = pendingAccountUpdates.get(accountId);
        if (existing) {
            if (existing.timer) clearTimeout(existing.timer);
            existing.usage[usageKey] = (existing.usage[usageKey] || 0) + n;
            existing.count += n;
            if (existing.count >= USAGE_FLUSH_THRESHOLD) {
                return await flushAccountUsage(accountId);
            }
            existing.timer = setTimeout(() => flushAccountUsage(accountId), USAGE_FLUSH_DELAY_MS);
            pendingAccountUpdates.set(accountId, existing);
            // For campaign stats, also batch or update immediately? Campaign stats less frequent but let's batch too
            const activeCtx = activeCampaigns.get(String(accountId).trim());
            if (activeCtx && activeCtx.campaignId) {
                // Update campaign stats cache immediately for accuracy
                await updateCampaignStatsUsage(activeCtx.campaignId, accountId, usageKey, n, activeCtx).catch(() => {});
            }
            return true;
        } else {
            const timer = setTimeout(() => flushAccountUsage(accountId), USAGE_FLUSH_DELAY_MS);
            pendingAccountUpdates.set(accountId, {
                usage: { [usageKey]: n },
                timer,
                count: n
            });
            const activeCtx = activeCampaigns.get(String(accountId).trim());
            if (activeCtx && activeCtx.campaignId) {
                await updateCampaignStatsUsage(activeCtx.campaignId, accountId, usageKey, n, activeCtx).catch(() => {});
            }
            return true;
        }
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
async function flushUserUsage(userId, retryCount = 0) {
    const pending = pendingUserUpdates.get(userId);
    if (!pending) return true;
    if (pending.timer) clearTimeout(pending.timer);
    
    try {
        await getUserRecord(userId);
        const base = userCache.get(userId)?.record || { plan: "", usage: {} };
        let mergedUsage = base.usage || {};
        for (const [action, count] of Object.entries(pending.usage)) {
            mergedUsage = incrementUsage(mergedUsage, action, count);
        }
        userCache.set(userId, {
            record: { ...base, usage: mergedUsage },
            ts: Date.now(),
        });

        const payload = JSON.stringify(mergedUsage);
        const prev = userWriteChains.get(userId) || Promise.resolve();
        const write = prev.then(async () => {
            try {
                const result = await updateSheetRowApi(USERS_SHEET, "userId", userId, {
                    usage: payload,
                });
                if (result.success) {
                    pendingUserUpdates.delete(userId);
                    logger.info(`[updateUserUsage] ${userId} batched ${pending.count} actions flushed`);
                    return true;
                } else {
                    logger.warn(`[updateUserUsage] Flush failed for ${userId}, will retry`);
                    if (retryCount < 5) {
                        setTimeout(() => flushUserUsage(userId, retryCount + 1), 2000 * (retryCount + 1));
                    } else {
                        const timer = setTimeout(() => flushUserUsage(userId, 0), USAGE_FLUSH_DELAY_MS * 2);
                        pending.timer = timer;
                        pendingUserUpdates.set(userId, pending);
                    }
                    return false;
                }
            } catch (e) {
                logger.error(`[updateUserUsage] Error for ${userId}: ${e.message}`);
                if (retryCount < 5) {
                    setTimeout(() => flushUserUsage(userId, retryCount + 1), 2000 * (retryCount + 1));
                } else {
                    const timer = setTimeout(() => flushUserUsage(userId, 0), USAGE_FLUSH_DELAY_MS * 2);
                    pending.timer = timer;
                    pendingUserUpdates.set(userId, pending);
                }
                return false;
            }
        });
        userWriteChains.set(userId, write.catch(() => {}));
        return await write;
    } catch (e) {
        logger.error(`[updateUserUsage] Error for ${userId}: ${e.message}`);
        if (retryCount < 5) {
            setTimeout(() => flushUserUsage(userId, retryCount + 1), 2000 * (retryCount + 1));
        } else {
            const timer = setTimeout(() => flushUserUsage(userId, 0), USAGE_FLUSH_DELAY_MS * 2);
            if (pending) {
                pending.timer = timer;
                pendingUserUpdates.set(userId, pending);
            }
        }
        return false;
    }
}

export async function updateUserUsage(userId, action, count = 1) {
    const n = Number.isFinite(parseInt(count, 10)) && parseInt(count, 10) > 0 ? parseInt(count, 10) : 1;
    try {
        // Update cache immediately for read-modify-write consistency
        await getUserRecord(userId);
        const base = userCache.get(userId)?.record || { plan: "", usage: {} };
        const updatedUsage = incrementUsage(base.usage || {}, action, n);
        userCache.set(userId, {
            record: { ...base, usage: updatedUsage },
            ts: Date.now(),
        });
        
        // Buffer the update instead of writing immediately
        const existing = pendingUserUpdates.get(userId);
        if (existing) {
            if (existing.timer) clearTimeout(existing.timer);
            existing.usage[action] = (existing.usage[action] || 0) + n;
            existing.count += n;
            if (existing.count >= USAGE_FLUSH_THRESHOLD) {
                return await flushUserUsage(userId);
            }
            existing.timer = setTimeout(() => flushUserUsage(userId), USAGE_FLUSH_DELAY_MS);
            pendingUserUpdates.set(userId, existing);
            return true;
        } else {
            const timer = setTimeout(() => flushUserUsage(userId), USAGE_FLUSH_DELAY_MS);
            pendingUserUpdates.set(userId, {
                usage: { [action]: n },
                timer,
                count: n
            });
            return true;
        }
    } catch (e) {
        logger.error(`[updateUserUsage] Error for ${userId}: ${e.message}`);
        return false;
    }
}

export { incrementUsage, parseInteractionUsage };
