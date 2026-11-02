import logger from './logger.js';
import { getSetting } from './settingsCache.js';
import { getCampaignLimits } from '../app/socials/_shared/limits.js';
import { getSheetDataApi } from '../app/api/googlesheets.js';

// ==================== Global campaign concurrency cap ====================
// Single source of truth for how many browser-opening campaign tasks may run
// at once — social interact tasks, cookie/email account-opening logins, etc.
// Reads the operational SETTINGS key MAX_CONCURRENT_TASKS. Fallback chain when
// that row is blank/unparseable: env MAX_CONCURRENT_TASKS -> env
// MAX_GLOBAL_BROWSERS -> 4. Cached for a short TTL on top of settingsCache's
// own 5-min TTL so the hot path (browser slot acquire) is cheap.
const SETTING_KEY = 'MAX_CONCURRENT_TASKS';
const CACHE_TTL_MS = 60 * 1000;

function envFallback() {
  const fromTasks = parseInt(process.env.MAX_CONCURRENT_TASKS, 10);
  if (Number.isFinite(fromTasks) && fromTasks > 0) return fromTasks;
  const fromGlobal = parseInt(process.env.MAX_GLOBAL_BROWSERS, 10);
  if (Number.isFinite(fromGlobal) && fromGlobal > 0) return fromGlobal;
  return 4;
}

if (!globalThis.__campaignConcurrencyState) {
  // globalThis so every route module (Next.js dev creates per-route module
  // scopes) shares the same cached value.
  globalThis.__campaignConcurrencyState = {
    value: null,
    fetchedAt: 0,
    inFlight: null,
  };
}
const state = globalThis.__campaignConcurrencyState;

/**
 * Returns the effective max concurrent campaign tasks. Reads SETTINGS
 * MAX_CONCURRENT_TASKS (cached ~60s), falling back to env then a default of 4.
 * @returns {Promise<number>}
 */
export async function getMaxConcurrentTasks() {
  const now = Date.now();
  if (state.value !== null && now - state.fetchedAt < CACHE_TTL_MS) {
    return state.value;
  }

  if (state.inFlight) return await state.inFlight;

  state.inFlight = (async () => {
    let resolved = null;
    try {
      const setting = await getSetting(SETTING_KEY);
      const raw = setting ? setting.value1 : null;
      if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
        const n = parseInt(String(raw).trim(), 10);
        if (Number.isFinite(n) && n > 0) resolved = n;
      }
    } catch (e) {
      logger.warn(`[campaignConcurrency] Failed to read "${SETTING_KEY}": ${e.message}`);
    } finally {
      state.inFlight = null;
    }

    if (resolved === null) resolved = envFallback();
    if (state.value !== resolved) {
      logger.info(`[campaignConcurrency] Max concurrent tasks = ${resolved}`);
    }
    state.value = resolved;
    state.fetchedAt = now;
    return resolved;
  })();

  return await state.inFlight;
}

/**
 * Last-known limit without awaiting the sheet (env/default before first read).
 * @returns {number}
 */
export function getMaxConcurrentTasksSync() {
  return state.value !== null ? state.value : envFallback();
}

/**
 * Clears the cached limit so the next read hits the sheet.
 */
export function invalidateCampaignConcurrency() {
  state.value = null;
  state.fetchedAt = 0;
  logger.debug('[campaignConcurrency] Cache invalidated.');
}

// ==================== Per-user concurrent campaign cap ====================
// SETTINGS key campaignConcurrentLimit (read via getCampaignLimits, fallback
// 1 — safety valve). Counts this user's campaigns-sheet rows in an active
// status; 'resting' counts too because a cooldown campaign wakes up
// automatically via TRIGGERS and therefore still holds its slot.
const ACTIVE_CAMPAIGN_STATUSES = ['running', 'processing', 'staged', 'resting'];

/**
 * Guard: is this user allowed to start (or continue) a campaign?
 * The campaign being started/polled is excluded from the count — callers
 * mark it 'running' before dispatch, so counting it would shrink capacity
 * by 1 and permanently block a campaign when limit=1.
 * Fail-open on sheet errors (matches historical behavior) but logs.
 * @param {string} userId
 * @param {string} [excludeCampaignId]
 * @returns {Promise<{allowed: boolean, current: number, limit: number}>}
 */
export async function checkUserConcurrentCampaigns(userId, excludeCampaignId) {
  if (!userId) return { allowed: true, current: 0, limit: 3 };

  let resolvedLimit = 3; // best-known until SETTINGS resolves (fail-open payload)
  try {
    const limits = await getCampaignLimits();
    const concurrentLimit = limits.campaignConcurrentLimit || 1;
    resolvedLimit = concurrentLimit;

    const campaignsResult = await getSheetDataApi('campaigns');
    if (!campaignsResult.success) return { allowed: true, current: 0, limit: concurrentLimit };

    const headers = campaignsResult.headers || [];
    const userIdIdx = headers.indexOf('userId');
    const statusIdx = headers.indexOf('status');
    const campaignIdIdx = headers.indexOf('campaignId');
    if (userIdIdx === -1) return { allowed: true, current: 0, limit: concurrentLimit };

    const excludeId = excludeCampaignId ? String(excludeCampaignId).trim() : null;
    const uid = String(userId).trim();
    const current = (campaignsResult.data || []).filter(r => {
      const rCampaignId = campaignIdIdx !== -1 ? String(r[campaignIdIdx] || '').trim() : '';
      if (excludeId && rCampaignId === excludeId) return false;
      const rUserId = String(r[userIdIdx] || '').trim();
      const rStatus = String(r[statusIdx] || '').trim().toLowerCase();
      return rUserId === uid && ACTIVE_CAMPAIGN_STATUSES.includes(rStatus);
    }).length;

    return { allowed: current < concurrentLimit, current, limit: concurrentLimit };
  } catch (err) {
    logger.warn(`[campaignConcurrency] Concurrent campaign check failed: ${err.message}`);
    return { allowed: true, current: 0, limit: resolvedLimit };
  }
}

// ==================== In-process active campaign liveness registry ====================
// Tracks which campaignIds are actively executing in this Node process across
// pipeline-orchestrator and stage routes. Exposed via GET /api/serverless-self?ping=1
// so GAS getCampaign can verify whether a 'running' campaign in the sheet is
// actually still running on the engine (zero extra sheet writes).
if (!globalThis.__activeCampaignRuns) {
  globalThis.__activeCampaignRuns = new Map(); // campaignId -> { stages: Set<string>, updatedAt: number }
}
const activeCampaignRuns = globalThis.__activeCampaignRuns;

export function registerActiveCampaignRun(campaignId, stage = 'execute') {
  if (!campaignId) return;
  const cid = String(campaignId).trim();
  if (!cid) return;
  let entry = activeCampaignRuns.get(cid);
  if (!entry) {
    entry = { stages: new Set(), updatedAt: Date.now() };
    activeCampaignRuns.set(cid, entry);
  }
  entry.stages.add(String(stage || 'execute'));
  entry.updatedAt = Date.now();
}

export function unregisterActiveCampaignRun(campaignId, stage = 'execute') {
  if (!campaignId) return;
  const cid = String(campaignId).trim();
  const entry = activeCampaignRuns.get(cid);
  if (!entry) return;
  entry.stages.delete(String(stage || 'execute'));
  entry.updatedAt = Date.now();
  if (entry.stages.size === 0) {
    activeCampaignRuns.delete(cid);
  }
}

export function getActiveCampaignIdsInProcess() {
  return Array.from(activeCampaignRuns.keys());
}

