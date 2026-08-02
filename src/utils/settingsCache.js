import logger from './logger.js';
import { getSheetDataApi } from '../app/api/googlesheets.js';

// Shared SETTINGS sheet cache. Uses globalThis so ALL route modules (emails,
// banks, socials) share the same instance even in Next.js dev mode where webpack
// may create separate module scopes per route. Single read every TTL with stale
// fallback, so admin-notification config and AI-provider rows stay available even
// when the Sheets quota is exhausted.
if (!globalThis.__settingsCacheState) {
  globalThis.__settingsCacheState = {
    headers: null,
    data: null,
    fetchedAt: 0,
    inFlight: null,
  };
}
const state = globalThis.__settingsCacheState;

const SETTINGS_SHEET_NAME = 'SETTINGS';
const SETTINGS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the SETTINGS sheet rows ({ headers, data }), reading the sheet at most
 * once per TTL. On a failed/failed-auth read it falls back to stale cache so
 * callers never get nothing. Single in-flight promise prevents read stampedes.
 * @param {boolean} forceRefresh - bypass the TTL and re-read the sheet.
 * @returns {Promise<{ headers: string[], data: string[][] } | null>}
 */
export async function getSettingsSheet(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && state.data && state.headers && (now - state.fetchedAt < SETTINGS_CACHE_TTL_MS)) {
    logger.debug('[settingsCache] Returning cached SETTINGS data.');
    return { headers: state.headers, data: state.data };
  }

  if (state.inFlight) {
    return await state.inFlight;
  }

  state.inFlight = (async () => {
    try {
      const result = await getSheetDataApi(SETTINGS_SHEET_NAME);
      if (result.success && result.headers && result.data) {
        state.headers = result.headers;
        state.data = result.data;
        state.fetchedAt = Date.now();
        logger.info(`[settingsCache] SETTINGS data loaded (${result.data.length} rows).`);
        return { headers: state.headers, data: state.data };
      }
      logger.warn(`[settingsCache] SETTINGS fetch failed: ${result.error || 'unknown error'}. Falling back to stale cache.`);
    } catch (err) {
      logger.error(`[settingsCache] Error fetching SETTINGS: ${err.message}. Falling back to stale cache.`);
    } finally {
      state.inFlight = null;
    }
    return (state.data && state.headers) ? { headers: state.headers, data: state.data } : null;
  })();

  return await state.inFlight;
}

/**
 * Looks up a single settings row by its settingsKey column value.
 * @param {string} key
 * @returns {Promise<{ value1: string|null, value2: string|null } | null>}
 */
export async function getSetting(key) {
  const sheet = await getSettingsSheet();
  if (!sheet) return null;
  const keyIdx = sheet.headers.indexOf('settingsKey');
  const val1Idx = sheet.headers.indexOf('settingsValue1');
  const val2Idx = sheet.headers.indexOf('settingsValue2');
  if (keyIdx === -1) {
    logger.warn('[settingsCache] SETTINGS sheet missing settingsKey column');
    return null;
  }
  for (const row of sheet.data) {
    if (row[keyIdx] && String(row[keyIdx]).trim() === String(key).trim()) {
      return {
        value1: val1Idx !== -1 ? row[val1Idx] : null,
        value2: val2Idx !== -1 ? row[val2Idx] : null
      };
    }
  }
  return null;
}

/**
 * Clears the cached SETTINGS data so the next read hits the sheet. Called after
 * aiService writes aiStatus back to SETTINGS so cooldowns are honored promptly.
 */
export function invalidateSettings() {
  state.headers = null;
  state.data = null;
  state.fetchedAt = 0;
  logger.debug('[settingsCache] SETTINGS cache invalidated.');
}

export function getSettingsCacheStats() {
  return {
    hasData: !!(state.data && state.headers),
    rows: state.data ? state.data.length : 0,
    ageMs: state.fetchedAt ? Date.now() - state.fetchedAt : null,
    ttlMs: SETTINGS_CACHE_TTL_MS
  };
}
