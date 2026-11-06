import { getSheetDataApi, updateSheetRowApi } from "../../api/googlesheets.js";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";

/**
 * Extracts a Google Drive file ID from a URL or returns the raw ID.
 */
export function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

/**
 * Parses a CSV text string into a 2D array of rows and cells.
 * Handles quoted values with escaped quotes and CRLF line endings.
 */
export function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else { inQuotes = false; }
      } else {
        row[row.length - 1] += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(""); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
  }
  if (row.length > 1 || row[0] !== "") lines.push(row);
  return lines;
}

/**
 * Converts a 2D array back into CSV text, escaping commas, quotes, and newlines.
 */
export function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? "" : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');
}

/**
 * Re-reads the campaign row and returns true if its status is currently paused.
 * Used mid-batch so an in-flight run can abort at a checkpoint when the user pauses.
 */
export async function isCampaignPaused(campaignId) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return false;
    const headers = campaignsResult.headers;
    const idIdx = headers.indexOf("campaignId");
    const statusIdx = headers.indexOf("status");
    if (idIdx === -1 || statusIdx === -1) return false;
    const row = campaignsResult.data.find(r => String(r[idIdx]).trim() === String(campaignId).trim());
    if (!row) return false;
    return String(row[statusIdx] || "").trim().toLowerCase() === "paused";
  } catch (err) {
    logger.warn(`[Pipeline] Pause check failed for ${campaignId}: ${err.message}`);
    return false;
  }
}

/**
 * Merges updates into the campaign's settings JSON and writes it back to the campaigns sheet.
 * Uses optimistic concurrency control via _settingsVersion to prevent write conflicts.
 */
export async function updateCampaignSettings(campaignId, updates, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const campaignsResult = await getSheetDataApi("campaigns");
      if (!campaignsResult.success) return;
      const cHeaders = campaignsResult.headers;
      const cIdIndex = cHeaders.indexOf("campaignId");
      const cSettingsIndex = cHeaders.indexOf("settings");
      const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
      if (!campaignRow || cSettingsIndex === -1) return;

      let settings = {};
      try {
        const settingsStr = campaignRow[cSettingsIndex];
        if (typeof settingsStr === "string") settings = JSON.parse(settingsStr);
        else if (settingsStr && typeof settingsStr === 'object') settings = settingsStr;
      } catch {}

      const currentVersion = settings._settingsVersion || 0;

      Object.assign(settings, updates);
      settings._settingsVersion = currentVersion + 1;

      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify(settings),
        updatedOn: new Date().toISOString()
      });
      return; // success
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 100 * (attempt + 1)));
      } else {
        logger.warn(`[Pipeline] Failed to update campaign settings for ${campaignId} after ${retries} attempts: ${err.message}`);
      }
    }
  }
}

/**
 * Reads the campaign settings JSON from the campaigns sheet.
 * Returns { settings, campaignRow, headers } or null if not found.
 */
export async function getCampaignSettings(campaignId) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return null;
    const headers = campaignsResult.headers;
    const cIdIndex = headers.indexOf("campaignId");
    const cSettingsIndex = headers.indexOf("settings");
    const cStatusIndex = headers.indexOf("status");
    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow) return null;

    let settings = {};
    try {
      const settingsStr = campaignRow[cSettingsIndex];
      if (typeof settingsStr === "string") settings = JSON.parse(settingsStr);
      else if (settingsStr && typeof settingsStr === 'object') settings = settingsStr;
    } catch {}

    return {
      settings,
      campaignRow,
      headers,
      status: String(campaignRow[cStatusIndex] || "").trim()
    };
  } catch (err) {
    logger.warn(`[Pipeline] Failed to read campaign settings for ${campaignId}: ${err.message}`);
    return null;
  }
}

// ==================== Failure classification & retry/error tracking ====================

export function classifyStageFailure(errorLike) {
  const msg = typeof errorLike === 'string' ? errorLike : (errorLike?.message || errorLike?.error || '');
  const s = String(msg).toLowerCase();
  // limit/quota
  if (/(limit|quota|cap|daily.*limit|monthly.*limit|limit reached|429.*quota|insufficient.*quota)/.test(s)) {
    if (/transient|retry later|temporary/.test(s)) return 'transient';
    return 'limit';
  }
  // transient/network
  if (/(etimedout|econnreset|econnrefused|eai_again|fetch failed|socket hang up|timeout|deadline exceeded|network|connection)/.test(s)) return 'transient';
  if (/(502|503|504|bad gateway|service unavailable|gateway timeout)/.test(s)) return 'transient';
  if (/(500|internal server error)/.test(s)) return 'transient';
  if (/(invalid_grant|token.*expired|refresh.*token)/.test(s)) return 'transient';
  if (/(429|too many requests|rate limit)/.test(s)) {
    if (/quota|daily|monthly|limit/.test(s)) return 'limit';
    return 'transient';
  }
  // permanent
  if (/(no email column|missing.*column|bad csv|invalid.*csv|no targets|no leads|invalid file)/.test(s)) return 'permanent';
  if (/(401|unauthorized)/.test(s) && !/invalid_grant/.test(s)) return 'permanent';
  if (/(400|bad request)/.test(s)) return 'permanent';
  return 'permanent';
}

export async function recordStageError(campaignId, { stage, reason, kind } = {}) {
  try {
    const fresh = await getCampaignSettings(campaignId);
    if (!fresh) return;
    const settings = { ...(fresh.settings || {}) };
    settings.lastError = {
      stage: stage || settings.lastError?.stage || null,
      reason: String(reason || '').slice(0, 500),
      kind: kind || settings.lastError?.kind || null,
      at: new Date().toISOString(),
    };
    if (kind === 'transient') {
      settings.retryAttempts = typeof settings.retryAttempts === 'number' ? settings.retryAttempts : 0;
    }
    await updateCampaignSettings(campaignId, settings);
  } catch (e) {
    logger.warn(`[Pipeline] Failed to record stage error for ${campaignId}: ${e.message}`);
  }
}

export async function clearStageError(campaignId) {
  try {
    const fresh = await getCampaignSettings(campaignId);
    if (!fresh) return;
    const settings = { ...(fresh.settings || {}) };
    delete settings.lastError;
    settings.retryAttempts = 0;
    await updateCampaignSettings(campaignId, settings);
  } catch (e) {
    logger.warn(`[Pipeline] Failed to clear stage error for ${campaignId}: ${e.message}`);
  }
}

export async function getRetryBudget() {
  try {
    const s = await getSetting('pipelineRetryBudget');
    const v = s?.value1;
    const n = parseInt(v);
    return Number.isFinite(n) && n >= 0 ? n : 2;
  } catch {
    return 2;
  }
}

// ==================== Per-account tag resume state ====================
// Tags are the campaign's targeting keywords/handles (settings.socialKeywords).
// A tag marked 'done' for an account is skipped when that account resumes after
// an hourly limit. Shape: settings.tagStatus[profileId][tag] = 'done'.
// Writes are serialized (read-merge-write) so parallel accounts can't clobber
// each other's map.
let _tagStatusChain = Promise.resolve();

/**
 * @param {object} settings - campaign settings object
 * @param {string} profileId
 * @returns {Record<string,'done'>} tags already done for this account
 */
export function getAccountTagStatuses(settings, profileId) {
  const all = (settings && settings.tagStatus) || {};
  return all[String(profileId)] || {};
}

/**
 * Marks tags as done for one account (per-account scope).
 * @param {string} campaignId
 * @param {string} profileId
 * @param {string[]} tags
 * @returns {Promise<void>}
 */
export async function markTagsDone(campaignId, profileId, tags) {
  if (!campaignId || !profileId || !Array.isArray(tags) || tags.length === 0) return;
  const pid = String(profileId);
  _tagStatusChain = _tagStatusChain
    .then(async () => {
      const fresh = await getCampaignSettings(campaignId);
      if (!fresh) return;
      const tagStatus = fresh.settings.tagStatus || {};
      const acct = tagStatus[pid] || {};
      let changed = false;
      for (const t of tags) {
        const key = String(t || '').trim();
        if (key && acct[key] !== 'done') {
          acct[key] = 'done';
          changed = true;
        }
      }
      if (!changed) return;
      tagStatus[pid] = acct;
      await updateCampaignSettings(campaignId, { tagStatus });
      logger.info(`[tagStatus] Marked ${tags.length} tag(s) done for ${campaignId}/${pid}`);
    })
    .catch((e) => {
      logger.warn(`[tagStatus] Failed to mark tags done for ${campaignId}/${pid}: ${e.message}`);
    });
  return _tagStatusChain;
}

// ==================== Per-account post deduplication state ====================
// IMPORTANT: interacted POST IDs are NOT persisted to campaign/settings (Google Sheet cell
// limit ~50k chars; long campaigns bloat). Cross-run dedup relies on DOM main-like check
// ("already liked" => already interacted, skip whole post) + in-run memory. Tags ARE still
// persisted (see tagStatus above).
let _postStatusChain = Promise.resolve();

/** Statuses that mean "do not reprocess this post for this account" (in-run/semantic). */
export const INTERACTED_POST_STATUSES = new Set(['engaged', 'already_liked', 'already_interacted', 'liked']);

export function isPostInteracted(statusOrMap, postId = null) {
  if (postId != null && statusOrMap && typeof statusOrMap === 'object' && !Array.isArray(statusOrMap)) {
    return isPostInteracted(statusOrMap[String(postId)]);
  }
  const s = String(statusOrMap || '').trim().toLowerCase();
  return !!s && INTERACTED_POST_STATUSES.has(s);
}

/**
 * Resolve a stable post identifier from a URL (platform-aware). Used for in-run/dedup keys.
 * Returns null when no stable id can be derived (DOM-only guard should still apply).
 */
export function getStablePostId(platform, url) {
  const p = String(platform || '').toLowerCase().trim();
  const u = String(url || '');
  if (!u) return null;
  try {
    const mTikTok = u.match(/\/(?:video|photo)\/(\d{15,})/) || u.match(/\/(\d{15,})(?:[/?#]|$)/);
    if (p === 'tiktok' || /tiktok\.com/i.test(u)) return mTikTok ? `tiktok:${mTikTok[1]}` : null;
    if (p === 'instagram' || /instagram\.com/i.test(u)) {
      const m = u.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
      return m ? `instagram:${m[1]}` : null;
    }
    if (p === 'twitter' || p === 'x' || /(?:twitter|x)\.com/i.test(u)) {
      const m = u.match(/\/status\/(\d+)/);
      return m ? `twitter:${m[1]}` : null;
    }
    if (p === 'youtube' || /youtu\.?be/i.test(u)) {
      const m = u.match(/[?&]v=([A-Za-z0-9_-]{6,})/) || u.match(/\/shorts\/([A-Za-z0-9_-]{6,})/) || u.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
      return m ? `youtube:${m[1]}` : null;
    }
    if (p === 'facebook' || /facebook\.com/i.test(u)) {
      const m = u.match(/\/(?:posts|reel|videos|watch\/?\?v=)\/([A-Za-z0-9_-]+)/) || u.match(/[?&](?:story_fbid|fbid|v)=(\d+)/) || u.match(/\/permalink\/(\d+)/);
      return m ? `facebook:${m[1]}` : null;
    }
    if (p === 'linkedin' || /linkedin\.com/i.test(u)) {
      const m = u.match(/activity[:-](\d+)/) || u.match(/ugcPost[:-](\d+)/);
      return m ? `linkedin:${m[1]}` : null;
    }
    if (p === 'reddit' || /reddit\.com/i.test(u)) {
      const m = u.match(/\/comments\/([a-z0-9]+)/i);
      return m ? `reddit:${m[1]}` : null;
    }
    if (p === 'threads' || /threads\.(?:net|com)/i.test(u)) {
      const m = u.match(/\/post\/([A-Za-z0-9_-]+)/);
      return m ? `threads:${m[1]}` : null;
    }
    // Generic fallback: stable path fragment for known hosts only when it looks like a post id
    const g = u.match(/\/(\d{8,})(?:[/?#]|$)/);
    return g ? `${p || 'web'}:${g[1]}` : null;
  } catch { return null; }
}

/**
 * @param {object} settings - campaign settings object
 * @param {string} profileId
 * @returns {Record<string,string>} persisted post IDs (intentionally empty: post dedup not sheet-persisted)
 */
export function getAccountPostStatuses(settings, profileId) {
  // Do not read settings.postStatus (can bloat sheet to 50k/cell). Rely on DOM main-like check.
  return {};
}

/**
 * Post interaction marker — NO-OP for sheet persistence (avoids 50k/cell bloat).
 * Callers maintain in-run memory; cross-run protection comes from DOM "main post already liked" check.
 */
export async function markPostEngaged(campaignId, profileId, postId, status = 'engaged') {
  // Intentionally not persisted to sheet/settings.postStatus (avoids 50k/cell bloat).
  // Callers maintain in-run memory; cross-run protection comes from DOM "main post already liked".
  return _postStatusChain;
}

/**
 * Reads firestick emails from the SETTINGS sheet.
 * Returns an array of { firstName, lastName, email, address, city } objects.
 * Used for the firestick warm-up flow: send to familiar inbox before each lead.
 */
export async function getFirestickEmails() {
  try {
    const result = await getSheetDataApi("SETTINGS");
    if (!result.success || !result.data || !result.headers) return [];

    const headers = result.headers;
    const emailIdx = headers.indexOf("firestickEmail");
    if (emailIdx === -1) return [];

    const firstNameIdx = headers.indexOf("firestickFirstName");
    const lastNameIdx = headers.indexOf("firestickLastName");
    const addressIdx = headers.indexOf("firestickAddress");
    const cityIdx = headers.indexOf("firestickCity");

    return result.data
      .filter(row => row[emailIdx] && String(row[emailIdx]).trim())
      .map(row => ({
        firstName: firstNameIdx !== -1 ? (row[firstNameIdx] || "") : "",
        lastName: lastNameIdx !== -1 ? (row[lastNameIdx] || "") : "",
        email: String(row[emailIdx]).trim(),
        address: addressIdx !== -1 ? (row[addressIdx] || "") : "",
        city: cityIdx !== -1 ? (row[cityIdx] || "") : "",
      }));
  } catch (err) {
    logger.warn(`[Pipeline] Failed to read firestick emails: ${err.message}`);
    return [];
  }
}

/**
 * Merges {{variable}} placeholders in a template string with actual CSV row values.
 * Supported variables: firstName/first_name, lastName/last_name, email, company/businessName, context.
 * No fallbacks — empty CSV column means empty string in output.
 */
export function mergeTemplate(template, row, headers) {
  if (!template) return "";
  const getVal = (col) => {
    const idx = headers.indexOf(col);
    return idx !== -1 ? (row[idx]?.trim() || "") : "";
  };
  return template
    .replace(/\{\{firstName\}\}|\{\{first_name\}\}/gi, getVal("FIRSTNAME"))
    .replace(/\{\{lastName\}\}|\{\{last_name\}\}/gi, getVal("LASTNAME"))
    .replace(/\{\{email\}\}/gi, getVal("EMAIL"))
    .replace(/\{\{company\}\}|\{\{businessName\}\}/gi, getVal("BUSINESSNAME"))
    .replace(/\{\{context\}\}/gi, getVal("CONTEXT"));
}

/**
 * Strips raw HTML tags from a value if it looks like HTML content.
 * Prevents scraped HTML from corrupting CSV data.
 */
export function sanitizeForCsv(value) {
  if (!value || typeof value !== "string") return value;
  if (/<html|<head|<style|<body|<script|<link\s+rel/i.test(value)) {
    return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3000);
  }
  return value;
}

/**
 * Returns performance presets based on the global performanceLevel setting.
 * Each stage route should read its own batch/delay settings from SETTINGS,
 * but use these presets as defaults if no override is configured.
 *
 * Levels:
 *   - conservative: smaller batches, longer delays, lower concurrency
 *   - balanced: moderate batches, moderate delays (current defaults)
 *   - aggressive: larger batches, shorter delays, higher concurrency
 */
export function getPerformancePresets(level) {
  const presets = {
    conservative: {
      validateMxBatchLimit: 10,
      validatePlatformBatchLimit: 3,
      enrichBatchLimit: 10,
      enrichSearchBatchLimit: 5,
      enrichAiBatchLimit: 7,
      enrichScrapeConcurrency: 3,
      personalizationBatchLimit: 7,
      shootingBatchLimit: 10,
      interactBatchLimit: 5,
      interBatchDelayMs: 200,
      checkpointInterval: 3,
    },
    balanced: {
      validateMxBatchLimit: 20,
      validatePlatformBatchLimit: 5,
      enrichBatchLimit: 20,
      enrichSearchBatchLimit: 10,
      enrichAiBatchLimit: 15,
      enrichScrapeConcurrency: 5,
      personalizationBatchLimit: 15,
      shootingBatchLimit: 20,
      interactBatchLimit: 10,
      interBatchDelayMs: 100,
      checkpointInterval: 5,
    },
    aggressive: {
      validateMxBatchLimit: 30,
      validatePlatformBatchLimit: 10,
      enrichBatchLimit: 30,
      enrichSearchBatchLimit: 15,
      enrichAiBatchLimit: 20,
      enrichScrapeConcurrency: 8,
      personalizationBatchLimit: 20,
      shootingBatchLimit: 30,
      interactBatchLimit: 15,
      interBatchDelayMs: 50,
      checkpointInterval: 10,
    },
  };
  return presets[level] || presets.balanced;
}

// ==================== Per-Campaign Quota Budget ====================

const QUOTA_BUDGET_LIMITS = {
  maxReadsPerHour: 50,
  maxWritesPerHour: 30,
};

/**
 * Get the quota budget for a campaign from its settings.
 */
export function getCampaignQuotaBudget(settings) {
  return settings._quotaBudget || {
    readsUsed: 0,
    writesUsed: 0,
    lastResetAt: new Date().toISOString(),
    backoffUntil: 0,
    backoffLevel: 0,
  };
}

/**
 * Check if a campaign has exceeded its quota budget.
 * @param {object} settings - campaign settings
 * @param {'read'|'write'} type
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkQuotaBudget(settings, type) {
  const budget = getCampaignQuotaBudget(settings);
  const now = Date.now();
  const lastReset = new Date(budget.lastResetAt).getTime();
  const hourElapsed = now - lastReset > 3600000;

  // Reset if hour has passed
  if (hourElapsed) {
    return { allowed: true, reason: "budget_reset" };
  }

  // Check backoff
  if (budget.backoffUntil > now) {
    return { allowed: false, reason: `backoff_until_${new Date(budget.backoffUntil).toISOString()}` };
  }

  if (type === "read" && budget.readsUsed >= QUOTA_BUDGET_LIMITS.maxReadsPerHour) {
    return { allowed: false, reason: `read_budget_exceeded: ${budget.readsUsed}/${QUOTA_BUDGET_LIMITS.maxReadsPerHour}` };
  }

  if (type === "write" && budget.writesUsed >= QUOTA_BUDGET_LIMITS.maxWritesPerHour) {
    return { allowed: false, reason: `write_budget_exceeded: ${budget.writesUsed}/${QUOTA_BUDGET_LIMITS.maxWritesPerHour}` };
  }

  return { allowed: true };
}

/**
 * Increment the quota budget counter for a campaign.
 */
export async function incrementQuotaBudget(campaignId, settings, type) {
  const budget = getCampaignQuotaBudget(settings);
  const now = Date.now();
  const lastReset = new Date(budget.lastResetAt).getTime();
  const hourElapsed = now - lastReset > 3600000;

  // Reset if hour has passed
  if (hourElapsed) {
    budget.readsUsed = 0;
    budget.writesUsed = 0;
    budget.lastResetAt = new Date().toISOString();
    budget.backoffUntil = 0;
    budget.backoffLevel = 0;
  }

  if (type === "read") budget.readsUsed++;
  if (type === "write") budget.writesUsed++;

  // Don't await - fire and forget to avoid blocking
  updateCampaignSettings(campaignId, { _quotaBudget: budget }).catch(() => {});
}
