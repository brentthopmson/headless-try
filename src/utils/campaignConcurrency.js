import logger from './logger.js';
import { getSetting } from './settingsCache.js';

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
