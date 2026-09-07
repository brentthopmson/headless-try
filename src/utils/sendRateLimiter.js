import logger from "./logger.js";
import { getLimitsSheet } from "../app/socials/_shared/limits.js";

// ==================== Global Send Rate Limiter ====================
// Tracks sends per account across all campaigns to prevent exceeding provider limits.
// Used by both SMTP (smtpSender.js) and wire/browser (wireSender.js) sending.

if (!globalThis.__sendRateLimiter) {
  globalThis.__sendRateLimiter = {
    counters: new Map(), // accountId -> { hourly, daily, monthly, total }
    limits: null,        // cached from Limits sheet coldMessage column
    limitsFetchedAt: 0,
  };
}
const state = globalThis.__sendRateLimiter;

const LIMITS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ==================== Provider Detection ====================

/**
 * Detect email provider from host or email address.
 * Returns a key matching the Limits sheet platform column (GMAIL, MICROSOFT, etc.).
 */
export function detectEmailProvider(hostOrEmail) {
  const lower = (hostOrEmail || "").toLowerCase();
  if (lower.includes("gmail") || lower.includes("googlemail")) return "GMAIL";
  if (lower.includes("outlook") || lower.includes("hotmail") || lower.includes("live") || lower.includes("microsoft")) return "MICROSOFT";
  if (lower.includes("google") || lower.includes("gsuite") || lower.includes("googleworkspace")) return "GSUITE";
  if (lower.includes("office365") || lower.includes("office.com")) return "OFFICE";
  if (lower.includes("yahoo")) return "YAHOO";
  if (lower.includes("aol")) return "AOL";
  return "GMAIL"; // default fallback
}

// ==================== Limits Loading ====================

/**
 * Load send limits from the Limits sheet coldMessage column.
 * Returns { GMAIL: { hourly: 20, daily: 500, monthly: 15000 }, ... }
 */
async function loadSendLimits() {
  const now = Date.now();
  if (state.limits && (now - state.limitsFetchedAt) < LIMITS_CACHE_TTL_MS) {
    return state.limits;
  }

  try {
    const sheet = await getLimitsSheet();
    if (!sheet) return state.limits || getDefaultLimits();

    const headers = sheet.headers;
    const platformIdx = headers.indexOf("platform");
    const coldMessageIdx = headers.indexOf("coldMessage");

    if (platformIdx === -1 || coldMessageIdx === -1) {
      return state.limits || getDefaultLimits();
    }

    const limits = {};
    for (const row of sheet.data) {
      const platform = String(row[platformIdx] || "").toUpperCase().trim();
      if (!platform) continue;

      try {
        const coldMsg = JSON.parse(row[coldMessageIdx] || "{}");
        limits[platform] = {
          hourly: parseInt(coldMsg.hourly, 10) || 0,
          daily: parseInt(coldMsg.daily, 10) || 0,
          monthly: parseInt(coldMsg.monthly, 10) || 0,
        };
      } catch {
        // skip malformed rows
      }
    }

    state.limits = limits;
    state.limitsFetchedAt = now;
    return limits;
  } catch (err) {
    logger.warn(`[sendRateLimiter] Failed to load limits: ${err.message}`);
    return state.limits || getDefaultLimits();
  }
}

function getDefaultLimits() {
  return {
    GMAIL: { hourly: 20, daily: 500, monthly: 15000 },
    MICROSOFT: { hourly: 20, daily: 500, monthly: 15000 },
    GSUITE: { hourly: 20, daily: 500, monthly: 15000 },
    OFFICE: { hourly: 20, daily: 500, monthly: 15000 },
    YAHOO: { hourly: 20, daily: 500, monthly: 15000 },
    AOL: { hourly: 20, daily: 500, monthly: 15000 },
  };
}

// ==================== Counter Management ====================

function getOrCreateCounter(accountId) {
  if (!state.counters.has(accountId)) {
    state.counters.set(accountId, {
      hourly: { count: 0, windowStart: Date.now() },
      daily: { count: 0, windowStart: Date.now() },
      monthly: { count: 0, windowStart: Date.now() },
      total: 0,
    });
  }
  return state.counters.get(accountId);
}

function resetWindowIfNeeded(window) {
  const now = Date.now();
  const elapsed = now - window.windowStart;

  // hourly window: 1 hour
  if (elapsed > 3600000) {
    window.count = 0;
    window.windowStart = now;
    return true;
  }
  return false;
}

function resetDailyIfNeeded(window) {
  const now = Date.now();
  const elapsed = now - window.windowStart;

  // daily window: 24 hours
  if (elapsed > 86400000) {
    window.count = 0;
    window.windowStart = now;
    return true;
  }
  return false;
}

function resetMonthlyIfNeeded(window) {
  const now = Date.now();
  const elapsed = now - window.windowStart;

  // monthly window: 30 days
  if (elapsed > 2592000000) {
    window.count = 0;
    window.windowStart = now;
    return true;
  }
  return false;
}

// ==================== Public API ====================

/**
 * Check if a send is allowed for the given platform and account.
 * @param {string} platform - GMAIL, MICROSOFT, GSUITE, OFFICE, etc.
 * @param {string} accountId - smtp.user (for SMTP) or profileId (for wire)
 * @returns {Promise<{ allowed: boolean, reason?: string, retryAfterMs?: number }>}
 */
export async function checkSendAllowed(platform, accountId) {
  const limits = await loadSendLimits();
  const platformKey = (platform || "GMAIL").toUpperCase();
  const platformLimits = limits[platformKey];

  if (!platformLimits) {
    return { allowed: true, reason: "no_limits_for_platform" };
  }

  const counter = getOrCreateCounter(accountId);

  // Check hourly limit
  resetWindowIfNeeded(counter.hourly);
  if (platformLimits.hourly > 0 && counter.hourly.count >= platformLimits.hourly) {
    const retryAfterMs = 3600000 - (Date.now() - counter.hourly.windowStart);
    return {
      allowed: false,
      reason: `hourly_limit: ${counter.hourly.count}/${platformLimits.hourly}`,
      retryAfterMs,
    };
  }

  // Check daily limit
  resetDailyIfNeeded(counter.daily);
  if (platformLimits.daily > 0 && counter.daily.count >= platformLimits.daily) {
    const retryAfterMs = 86400000 - (Date.now() - counter.daily.windowStart);
    return {
      allowed: false,
      reason: `daily_limit: ${counter.daily.count}/${platformLimits.daily}`,
      retryAfterMs,
    };
  }

  // Check monthly limit
  resetMonthlyIfNeeded(counter.monthly);
  if (platformLimits.monthly > 0 && counter.monthly.count >= platformLimits.monthly) {
    const retryAfterMs = 2592000000 - (Date.now() - counter.monthly.windowStart);
    return {
      allowed: false,
      reason: `monthly_limit: ${counter.monthly.count}/${platformLimits.monthly}`,
      retryAfterMs,
    };
  }

  return { allowed: true };
}

/**
 * Increment the send counter for the given platform and account.
 * Call this AFTER a successful send.
 * @param {string} platform
 * @param {string} accountId
 */
export function incrementSendCount(platform, accountId) {
  const counter = getOrCreateCounter(accountId);

  resetWindowIfNeeded(counter.hourly);
  resetDailyIfNeeded(counter.daily);
  resetMonthlyIfNeeded(counter.monthly);

  counter.hourly.count++;
  counter.daily.count++;
  counter.monthly.count++;
  counter.total++;

  logger.debug(`[sendRateLimiter] ${accountId} (${platform}): hourly=${counter.hourly.count}, daily=${counter.daily.count}, monthly=${counter.monthly.count}, total=${counter.total}`);
}

/**
 * Get current send stats for an account.
 */
export function getSendStats(accountId) {
  const counter = state.counters.get(accountId);
  if (!counter) return null;

  resetWindowIfNeeded(counter.hourly);
  resetDailyIfNeeded(counter.daily);
  resetMonthlyIfNeeded(counter.monthly);

  return {
    hourly: counter.hourly.count,
    daily: counter.daily.count,
    monthly: counter.monthly.count,
    total: counter.total,
  };
}

// ==================== Hub Sheet Persistence ====================

/**
 * Persist usage counters to the hub sheet for cross-session durability.
 * Called after each batch send from the shoot endpoint.
 * @param {string} browserId
 * @param {object} counter - { hourly: {count}, daily: {count}, monthly: {count}, total }
 */
export async function persistUsageToHub(browserId, counter) {
  try {
    const { updateSheetRowApi } = await import("../app/api/googlesheets.js");
    const result = await updateSheetRowApi("hub", "browserId", browserId, {
      shotHourly: String(counter.hourly.count),
      shotDaily: String(counter.daily.count),
      shotMonthly: String(counter.monthly.count),
      shotTotal: String(counter.total),
      lastShotAt: new Date().toISOString(),
    });
    if (result.success) {
      logger.debug(`[sendRateLimiter] Persisted usage for ${browserId}`);
    }
  } catch (err) {
    logger.warn(`[sendRateLimiter] Failed to persist usage: ${err.message}`);
  }
}

/**
 * Restore in-memory counters from hub sheet on startup.
 * Called when the engine starts or when a shoot session begins.
 * @param {string} browserId
 * @returns {Promise<object|null>} counter state or null
 */
export async function restoreUsageFromHub(browserId) {
  try {
    const { getSheetDataApi } = await import("../app/api/googlesheets.js");
    const result = await getSheetDataApi("hub");
    if (!result.success) return null;

    const headers = result.headers;
    const browserIdIdx = headers.indexOf("browserId");
    const submissionIdIdx = headers.indexOf("submissionId");

    for (const row of result.data) {
      const bid = row[browserIdIdx] || "";
      const sid = row[submissionIdIdx] || "";
      if (bid === browserId || sid === browserId) {
        const counter = getOrCreateCounter(browserId);

        const hourly = parseInt(row[headers.indexOf("shotHourly")] || "0", 10);
        const daily = parseInt(row[headers.indexOf("shotDaily")] || "0", 10);
        const monthly = parseInt(row[headers.indexOf("shotMonthly")] || "0", 10);
        const total = parseInt(row[headers.indexOf("shotTotal")] || "0", 10);

        // Only restore if the window hasn't expired
        const now = Date.now();
        if (hourly > 0) { counter.hourly.count = hourly; counter.hourly.windowStart = now; }
        if (daily > 0) { counter.daily.count = daily; counter.daily.windowStart = now; }
        if (monthly > 0) { counter.monthly.count = monthly; counter.monthly.windowStart = now; }
        counter.total = total || 0;

        logger.info(`[sendRateLimiter] Restored usage for ${browserId}: hourly=${hourly}, daily=${daily}, total=${total}`);
        return counter;
      }
    }
  } catch (err) {
    logger.warn(`[sendRateLimiter] Failed to restore usage: ${err.message}`);
  }
  return null;
}
