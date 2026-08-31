import logger from "./logger.js";
import { getSheetDataApi, updateSheetRowApi } from "../app/api/googlesheets.js";

const LOCK_TIMEOUT_MS = 300 * 1000; // 5 minutes (matches Vercel maxDuration)
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_MAX_RETRIES = 3;

if (!globalThis.__campaignLocks) {
  globalThis.__campaignLocks = new Map();
}
const lockMap = globalThis.__campaignLocks;

/**
 * Acquire a per-campaign lock before triggering a stage.
 * Uses hybrid in-memory + Sheet version check.
 *
 * @param {string} campaignId
 * @param {string} serverlessId - current server identity (e.g. "serverless4")
 * @returns {Promise<{ acquired: boolean, reason?: string }>}
 */
export async function acquireCampaignLock(campaignId, serverlessId) {
  // 1. Check in-memory lock first (fast path)
  const memLock = lockMap.get(campaignId);
  if (memLock) {
    const age = Date.now() - memLock.lockedAt;
    if (age < LOCK_TIMEOUT_MS) {
      if (memLock.lockedBy === serverlessId) {
        logger.debug(`[campaignLock] Already locked by self: ${campaignId}`);
        return { acquired: false, reason: "already_locked_by_self" };
      }
      logger.info(`[campaignLock] Locked by another server (${memLock.lockedBy}): ${campaignId}`);
      return { acquired: false, reason: `locked_by_${memLock.lockedBy}` };
    }
    // Stale lock - will try to acquire via Sheet
    logger.warn(`[campaignLock] Stale in-memory lock (${age}ms) for ${campaignId}, attempting takeover`);
  }

  // 2. Read campaign settings from Sheet
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      const campaignsResult = await getSheetDataApi("campaigns");
      if (!campaignsResult.success) {
        return { acquired: false, reason: "failed_to_read_campaigns" };
      }

      const headers = campaignsResult.headers;
      const idIdx = headers.indexOf("campaignId");
      const settingsIdx = headers.indexOf("settings");

      if (idIdx === -1 || settingsIdx === -1) {
        return { acquired: false, reason: "missing_columns" };
      }

      const row = campaignsResult.data.find(r => String(r[idIdx]).trim() === String(campaignId).trim());
      if (!row) {
        return { acquired: false, reason: "campaign_not_found" };
      }

      let settings = {};
      try {
        settings = JSON.parse(row[settingsIdx] || "{}");
      } catch {
        settings = {};
      }

      const currentVersion = settings._lockVersion || 0;
      const lockedBy = settings._lockedBy;
      const lockedAt = settings._lockedAt ? new Date(settings._lockedAt).getTime() : 0;
      const isStale = lockedAt ? (Date.now() - lockedAt > LOCK_TIMEOUT_MS) : true;

      // 3. Check if lock is held by another server and not stale
      if (lockedBy && lockedBy !== serverlessId && !isStale) {
        logger.info(`[campaignLock] Sheet lock held by ${lockedBy}, not stale: ${campaignId}`);
        return { acquired: false, reason: `locked_by_${lockedBy}` };
      }

      // 4. Acquire lock by writing version + identity
      const lockSettings = {
        _lockVersion: currentVersion + 1,
        _lockedBy: serverlessId,
        _lockedAt: new Date().toISOString(),
      };

      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify({ ...settings, ...lockSettings }),
      });

      // 5. Store in memory
      lockMap.set(campaignId, {
        version: currentVersion + 1,
        lockedBy: serverlessId,
        lockedAt: Date.now(),
      });

      logger.info(`[campaignLock] Lock acquired for ${campaignId} (v${currentVersion + 1})`);
      return { acquired: true };

    } catch (err) {
      logger.warn(`[campaignLock] Attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < LOCK_MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, LOCK_RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  return { acquired: false, reason: "max_retries_exceeded" };
}

/**
 * Release a per-campaign lock.
 *
 * @param {string} campaignId
 * @param {string} serverlessId
 */
export async function releaseCampaignLock(campaignId, serverlessId) {
  // Remove from memory
  const memLock = lockMap.get(campaignId);
  if (memLock && memLock.lockedBy === serverlessId) {
    lockMap.delete(campaignId);
  }

  // Clear lock fields in Sheet (best-effort)
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return;

    const headers = campaignsResult.headers;
    const idIdx = headers.indexOf("campaignId");
    const settingsIdx = headers.indexOf("settings");

    const row = campaignsResult.data.find(r => String(r[idIdx]).trim() === String(campaignId).trim());
    if (!row) return;

    let settings = {};
    try {
      settings = JSON.parse(row[settingsIdx] || "{}");
    } catch {
      return;
    }

    // Only clear if we still own the lock
    if (settings._lockedBy === serverlessId) {
      delete settings._lockVersion;
      delete settings._lockedBy;
      delete settings._lockedAt;

      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify(settings),
      });
      logger.info(`[campaignLock] Lock released for ${campaignId}`);
    }
  } catch (err) {
    logger.warn(`[campaignLock] Failed to release lock for ${campaignId}: ${err.message}`);
  }
}

/**
 * Check if a campaign is currently locked.
 *
 * @param {string} campaignId
 * @returns {{ locked: boolean, by?: string, ageMs?: number }}
 */
export function isCampaignLocked(campaignId) {
  const memLock = lockMap.get(campaignId);
  if (!memLock) return { locked: false };

  const age = Date.now() - memLock.lockedAt;
  if (age >= LOCK_TIMEOUT_MS) {
    return { locked: false };
  }

  return { locked: true, by: memLock.lockedBy, ageMs: age };
}
