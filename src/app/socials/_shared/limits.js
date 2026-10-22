import logger from "../../../utils/logger.js";
import { getSheetDataApi } from '../../api/googlesheets.js';
import { getSetting } from "../../../utils/settingsCache.js";
import limitsCore from './limitsCore.js';
import { getUserRecord } from './hubUpdater.js';

const { evaluateActionPolicy, pickLimitNumber, evaluateUserQuota, parsePlanRow, resolveUsageEntry } = limitsCore;

// Shared Limits sheet cache. Uses globalThis so ALL route modules (socials,
// campaign engine) share the same instance even in Next.js dev mode where
// webpack may create separate module scopes per route. One read every TTL with
// stale fallback, so platform action limits and campaign caps stay available
// even when the Sheets quota is exhausted.
if (!globalThis.__limitsCacheState) {
  globalThis.__limitsCacheState = {
    headers: null,
    data: null,
    fetchedAt: 0,
    inFlight: null,
  };
}
const state = globalThis.__limitsCacheState;

const LIMITS_SHEET_NAME = "Limits";
const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const ACTION_TYPES = [
    "likeOnStory", "repostOnStory", "commentOnStory",
    "likesOnPost", "repostOnPost", "commentOnPost",
    "likesOnComment", "repostOnComment", "commentOnComment",
    "follow", "unfollow", "coldMessage",
    "inboxReply",
    "extract"
];

/**
 * Returns the Limits sheet rows ({ headers, data }), reading the sheet at most
 * once per TTL. On a failed read it falls back to stale cache so callers never
 * get nothing. Single in-flight promise prevents read stampedes.
 * @param {boolean} forceRefresh - bypass the TTL and re-read the sheet.
 * @returns {Promise<{ headers: string[], data: string[][] } | null>}
 */
export async function getLimitsSheet(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && state.data && state.headers && (now - state.fetchedAt < LIMITS_CACHE_TTL_MS)) {
        logger.debug('[limits] Returning cached Limits data.');
        return { headers: state.headers, data: state.data };
    }

    if (state.inFlight) {
        return await state.inFlight;
    }

    state.inFlight = (async () => {
        try {
            const result = await getSheetDataApi(LIMITS_SHEET_NAME);
            if (result.success && result.headers && result.data) {
                state.headers = result.headers;
                state.data = result.data;
                state.fetchedAt = Date.now();
                logger.info(`[limits] Limits data loaded (${result.data.length} rows).`);
                return { headers: state.headers, data: state.data };
            }
            logger.warn(`[limits] Failed to fetch Limits sheet: ${result.error || 'unknown error'}. Falling back to stale cache.`);
        } catch (e) {
            logger.error(`[limits] Error fetching Limits: ${e.message}. Falling back to stale cache.`);
        } finally {
            state.inFlight = null;
        }
        return (state.data && state.headers) ? { headers: state.headers, data: state.data } : null;
    })();

    return await state.inFlight;
}

async function fetchPlatformLimits() {
    const sheet = await getLimitsSheet();
    if (!sheet) return {};

    const headers = sheet.headers;
    const rows = sheet.data;
    const limits = {};

    for (const row of rows) {
        const platform = String(row[headers.indexOf("platform")] || "").toUpperCase().trim();
        if (!platform) continue;

        limits[platform] = {};
        for (const action of ACTION_TYPES) {
            const colIdx = headers.indexOf(action);
            if (colIdx !== -1 && row[colIdx]) {
                try {
                    limits[platform][action] = JSON.parse(row[colIdx]);
                } catch (e) {
                    limits[platform][action] = { hourly: "0", daily: "0", monthly: "0", cap: "" };
                }
            } else {
                limits[platform][action] = { hourly: "0", daily: "0", monthly: "0", cap: "" };
            }
        }
    }

    return limits;
}

export async function getPlatformLimits(platform) {
    const allLimits = await fetchPlatformLimits();
    const key = platform.toUpperCase().trim();
    return allLimits[key] || null;
}

export async function checkActionAllowed(platform, action, accountUsage = {}) {
    // Canonical key (Limits column) plus legacy base-name aliases (older rows
    // stored likeComment/commentComment/...). Both forms are summed per window.
    const usage = resolveUsageEntry(accountUsage, action);

    // ACCOUNT-tier per-account override: a reserved `_limits` key inside the
    // hub interactionUsage blob REPLACES the platform policy for this account
    // (admin-set {hourly,daily,monthly}; absent = platform policy unchanged).
    const override = accountUsage && accountUsage._limits;
    if (override && typeof override === "object") {
        return evaluateActionPolicy(override, usage);
    }

    const limits = await getPlatformLimits(platform);
    if (!limits) return { allowed: true, reason: "no_limits_configured", tier: "platform" };

    const actionLimits = limits[action];
    if (!actionLimits) return { allowed: true, reason: "no_action_limits", tier: "platform" };

    return evaluateActionPolicy(actionLimits, usage);
}

// USER tier: MONTHLY per-key quotas per human user across all their accounts.
// Thresholds live in the Limits sheet plan row (matched by the user's plan;
// 0/missing = unlimited); state lives in the user sheet usage blob's *Usage
// keys. Fail-open on errors so a sheet outage never stalls campaigns.
// checks: { keys: [...] } — which usage keys the caller gates.
export async function checkUserQuota(userId, checks) {
    if (!userId) {
        return { allowed: true, reason: "no_user", tier: "user" };
    }
    try {
        const record = await getUserRecord(userId);
        const planLimits = await getPlanLimits(record.plan);
        return evaluateUserQuota(record.usage, planLimits, checks);
    } catch (e) {
        logger.warn(`[limits] checkUserQuota failed for ${userId}: ${e.message} — allowing (fail-open)`);
        return { allowed: true, reason: "quota_check_failed", tier: "user" };
    }
}

// Limits-sheet plan row → monthly USER limits keyed by *Usage.
// Missing plan/plan column/row = {} = every key unlimited (fail-open).
export async function getPlanLimits(plan) {
    const sheet = await getLimitsSheet();
    if (!sheet) return {};

    const planIdx = sheet.headers.indexOf("plan");
    if (planIdx === -1) {
        logger.warn('[limits] Limits sheet has no "plan" column — USER monthly quotas unavailable (unlimited)');
        return {};
    }

    const wanted = String(plan || "").trim().toUpperCase();
    if (!wanted) return {};

    const planRow = sheet.data.find(r => String(r[planIdx] || "").trim().toUpperCase() === wanted);
    if (!planRow) {
        logger.warn(`[limits] No Limits plan row for "${plan}" — USER monthly quotas unlimited`);
        return {};
    }

    return parsePlanRow(sheet.headers, planRow) || {};
}

// Per-run caps live in the SETTINGS sheet (operational batch keys), NOT the
// Limits sheet — the Limits sheet only carries monthly plan quotas and
// platform action policies. Strict: a missing/unparseable key yields 0 and the
// calling stage blocks with an actionable message (no silent defaults), except
// campaignConcurrentLimit which falls back to 1 (safety valve, not a spend
// cap) and accountSendPerRunLimit which keeps a 5 sends/account floor as an
// account-protection default.
const CAMPAIGN_CAP_SETTINGS_KEYS = {
    validateLimit: "validateBatchLimit",
    enrichLimit: "enrichBatchLimit",
    personalizeLimit: "personalizeBatchLimit",
    shootCampaignLimit: "shootingBatchLimit",
    interactionLimit: "interactionBatchLimit",
    campaignConcurrentLimit: "campaignConcurrentLimit",
};

export async function getCampaignLimits() {
    const out = {
        accountSendPerRunLimit: 5,
        campaignConcurrentLimit: 1,
    };

    for (const [cap, key] of Object.entries(CAMPAIGN_CAP_SETTINGS_KEYS)) {
        let value = 0;
        try {
            const setting = await getSetting(key);
            const raw = setting ? setting.value1 : null;
            if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
                value = pickLimitNumber(raw);
            }
        } catch (e) {
            logger.warn(`[limits] Failed to read setting "${key}" — treating as 0 (block): ${e.message}`);
        }
        if (cap === "campaignConcurrentLimit") {
            out[cap] = value > 0 ? value : 1;
        } else {
            out[cap] = value;
        }
    }

    return out;
}

export function getLimitsCacheStats() {
    return {
        hasData: !!(state.data && state.headers),
        rows: state.data ? state.data.length : 0,
        ageMs: state.fetchedAt ? Date.now() - state.fetchedAt : null,
        ttlMs: LIMITS_CACHE_TTL_MS
    };
}

export { ACTION_TYPES };
