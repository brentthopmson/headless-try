import logger from "../../../utils/logger.js";
import { getSheetDataApi } from '../../api/googlesheets.js';

const ACTION_TYPES = [
    "likeOnStory", "likesOnPost", "likesOnComment",
    "commentOnComment", "commentOnStory", "commentOnPost",
    "follow", "unfollow", "coldMessage"
];

let limitsCache = null;
let lastFetch = 0;
const CACHE_TTL = 30000;

async function fetchPlatformLimits(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && limitsCache && (now - lastFetch < CACHE_TTL)) return limitsCache;

    try {
        const result = await getSheetDataApi("Limits");
        if (!result.success) {
            logger.warn(`[limits] Failed to fetch Limits sheet: ${result.error}`);
            return limitsCache || {};
        }

        const headers = result.headers;
        const rows = result.data;
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

        limitsCache = limits;
        lastFetch = now;
        logger.info(`[limits] Fetched limits for ${Object.keys(limits).length} platforms`);
        return limits;
    } catch (e) {
        logger.error(`[limits] Error fetching limits: ${e.message}`);
        return limitsCache || {};
    }
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
    try {
        const result = await getSheetDataApi("Limits");
        if (!result.success) return { shootContactsLimit: Infinity, interactionLimit: Infinity };

        const headers = result.headers;
        const categoryIdx = headers.indexOf("category");
        const shootIdx = headers.indexOf("shootContactsLimit");
        const interactIdx = headers.indexOf("interactionLimit");

        if (categoryIdx === -1) return { shootContactsLimit: Infinity, interactionLimit: Infinity };

        const campaignRow = result.data.find(r => String(r[categoryIdx]).trim().toLowerCase() === "campaign");
        if (!campaignRow) return { shootContactsLimit: Infinity, interactionLimit: Infinity };

        const parseLimit = (val) => {
            if (!val) return Infinity;
            const n = parseInt(val, 10);
            return (!isNaN(n) && n >= 0) ? n : Infinity;
        };

        return {
            shootContactsLimit: parseLimit(shootIdx !== -1 ? campaignRow[shootIdx] : null),
            interactionLimit: parseLimit(interactIdx !== -1 ? campaignRow[interactIdx] : null),
        };
    } catch (e) {
        logger.warn(`[getCampaignLimits] Error: ${e.message}`);
        return { shootContactsLimit: Infinity, interactionLimit: Infinity };
    }
}

export { ACTION_TYPES };
