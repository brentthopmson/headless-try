import logger from "../../../utils/logger.js";
import { getSheetDataApi } from '../../api/googlesheets.js';
import limitsCore from './limitsCore.js';
import { getUserRecord } from './hubUpdater.js';

const { evaluateActionPolicy, pickLimitNumber, evaluateUserQuota, parsePlanRow } = limitsCore;

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
    "likeOnStory", "likesOnPost", "likesOnComment",
    "commentOnComment", "commentOnStory", "commentOnPost",
    "follow", "unfollow", "coldMessage",
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
    const usage = accountUsage[action] || {};

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

// Campaign row per-run caps fail closed (0 = block) — except interactionLimit
// and accountSendPerRunLimit which protect accounts/SMTPs with per-run
// defaults (10 interactions, 5 sends/account) when the cell is unset.
const CAMPAIGN_LIMIT_DEFAULTS = {
    validateLimit: 0,
    enrichLimit: 0,
    personalizeLimit: 0,
    shootCampaignLimit: 0,
    interactionLimit: 10,
    campaignConcurrentLimit: 3,
    accountSendPerRunLimit: 5,
};

// Cell → number, falling back to `whenEmpty` when the column or cell is unset.
// An explicit 0 in the cell always wins (= off / block per caller semantics).
function cellOr(headers, row, col, whenEmpty) {
    const i = headers.indexOf(col);
    if (i === -1) return whenEmpty;
    const raw = row[i];
    if (raw === null || raw === undefined || String(raw).trim() === "") return whenEmpty;
    return pickLimitNumber(raw);
}

export async function getCampaignLimits() {
    const sheet = await getLimitsSheet();
    // Default to 0 (block) when sheet is unavailable
    if (!sheet) return { ...CAMPAIGN_LIMIT_DEFAULTS };

    const headers = sheet.headers;
    const categoryIdx = headers.indexOf("category");
    if (categoryIdx === -1) return { ...CAMPAIGN_LIMIT_DEFAULTS };

    const campaignRow = sheet.data.find(r => String(r[categoryIdx]).trim().toLowerCase() === "campaign");
    if (!campaignRow) return { ...CAMPAIGN_LIMIT_DEFAULTS };

    const idx = (col) => {
        const i = headers.indexOf(col);
        return i !== -1 ? campaignRow[i] : null;
    };

    return {
        validateLimit: pickLimitNumber(idx("validateLimit")),
        enrichLimit: pickLimitNumber(idx("enrichLimit")),
        personalizeLimit: pickLimitNumber(idx("personalizeLimit")),
        shootCampaignLimit: pickLimitNumber(idx("shootCampaignLimit")),
        interactionLimit: cellOr(headers, campaignRow, "interactionLimit", CAMPAIGN_LIMIT_DEFAULTS.interactionLimit),
        campaignConcurrentLimit: pickLimitNumber(idx("campaignConcurrentLimit")) || 3,
        accountSendPerRunLimit: cellOr(headers, campaignRow, "accountSendPerRunLimit", CAMPAIGN_LIMIT_DEFAULTS.accountSendPerRunLimit),
    };
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
