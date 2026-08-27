import logger from "../../../utils/logger.js";
import { getSheetDataApi } from '../../api/googlesheets.js';

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
    "follow", "unfollow", "coldMessage"
];

/**
 * Returns the Limits sheet rows ({ headers, data }), reading the sheet at most
 * once per TTL. On a failed read it falls back to stale cache so callers never
 * get nothing. Single in-flight promise prevents read stampedes.
 * @param {boolean} forceRefresh - bypass the TTL and re-read the sheet.
 * @returns {Promise<{ headers: string[], data: string[][] } | null>}
 */
async function getLimitsSheet(forceRefresh = false) {
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
    const limits = await getPlatformLimits(platform);
    if (!limits) return { allowed: true, reason: "no_limits_configured" };

    const actionLimits = limits[action];
    if (!actionLimits) return { allowed: true, reason: "no_action_limits" };

    const hourly = parseInt(actionLimits.hourly, 10);
    const daily = parseInt(actionLimits.daily, 10);
    const monthly = parseInt(actionLimits.monthly, 10);
    const cap = actionLimits.cap ? parseInt(actionLimits.cap, 10) : null;

    if (!hourly && !daily && !monthly && !cap) return { allowed: true, reason: "no_limits_defined" };

    const usage = accountUsage[action] || { hourly: 0, daily: 0, monthly: 0, total: 0 };

    if (cap !== null && usage.total >= cap) {
        return { allowed: false, reason: `cap_reached: ${usage.total}/${cap}` };
    }
    if (hourly && usage.hourly >= hourly) {
        return { allowed: false, reason: `hourly_limit: ${usage.hourly}/${hourly}` };
    }
    if (daily && usage.daily >= daily) {
        return { allowed: false, reason: `daily_limit: ${usage.daily}/${daily}` };
    }
    if (monthly && usage.monthly >= monthly) {
        return { allowed: false, reason: `monthly_limit: ${usage.monthly}/${monthly}` };
    }

    return { allowed: true, reason: "ok" };
}

export async function getCampaignLimits() {
    const sheet = await getLimitsSheet();
    // Default to 0 (block) when sheet is unavailable
    if (!sheet) return { validateLimit: 0, enrichLimit: 0, personalizeLimit: 0, shootCampaignLimit: 0, interactionLimit: 0 };

    const headers = sheet.headers;
    const categoryIdx = headers.indexOf("category");
    if (categoryIdx === -1) return { validateLimit: 0, enrichLimit: 0, personalizeLimit: 0, shootCampaignLimit: 0, interactionLimit: 0 };

    const campaignRow = sheet.data.find(r => String(r[categoryIdx]).trim().toLowerCase() === "campaign");
    if (!campaignRow) return { validateLimit: 0, enrichLimit: 0, personalizeLimit: 0, shootCampaignLimit: 0, interactionLimit: 0 };

    const parseLimit = (val) => {
        if (!val) return 0;
        const n = parseInt(val, 10);
        return (!isNaN(n) && n >= 0) ? n : 0;
    };

    const idx = (col) => {
        const i = headers.indexOf(col);
        return i !== -1 ? campaignRow[i] : null;
    };

    return {
        validateLimit: parseLimit(idx("validateLimit")),
        enrichLimit: parseLimit(idx("enrichLimit")),
        personalizeLimit: parseLimit(idx("personalizeLimit")),
        shootCampaignLimit: parseLimit(idx("shootCampaignLimit")),
        interactionLimit: parseLimit(idx("interactionLimit")),
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
