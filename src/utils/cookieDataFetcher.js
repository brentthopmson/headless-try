import axios from 'axios';
import { URLSearchParams } from 'url';
import logger from './logger.js';
import { getSheetDataApi } from '../app/api/googlesheets.js';

// Use globalThis so ALL route modules (emails, banks, socials) share the
// same cache instance even in Next.js dev mode where webpack may create
// separate module scopes per route.
if (!globalThis.__cookieDataFetcherState) {
  globalThis.__cookieDataFetcherState = {
    appScriptDataCache: null,
    lastCacheUpdateTime: 0,
    isUpdatingCache: false,
    currentUpdatePromise: null,
    backgroundUpdaterIntervalId: null,
  };
}
const state = globalThis.__cookieDataFetcherState;

const SHEETS_API_MIN_INTERVAL = 15000; // 15 seconds minimum between actual Sheets API reads
const CACHE_UPDATE_INTERVAL = 15000;   // 15 seconds for background updater

async function _fetchAndCacheAppScriptData(retries = 3, timeout = 120000, forceRefresh = false) {
  const now = Date.now();

  // If an update is already in progress, wait for it
  if (state.isUpdatingCache && state.currentUpdatePromise) {
    return await state.currentUpdatePromise;
  }

  // If cache is fresh enough AND forceRefresh is not true, return it immediately
  if (!forceRefresh && state.appScriptDataCache && (now - state.lastCacheUpdateTime < SHEETS_API_MIN_INTERVAL)) {
    logger.debug("[cookieDataFetcher] Returning cached data (Sheets API rate limit active).");
    return state.appScriptDataCache;
  }

  state.isUpdatingCache = true;
  const fetchPromise = (async () => {
    try {
      // --- Attempt Sheets API first ---
      try {
        const sheetsApiResult = await getSheetDataApi("cookie");
        if (sheetsApiResult.success) {
          logger.info("[cookieDataFetcher] Sheets API data fetched successfully.");
          state.appScriptDataCache = [sheetsApiResult.headers, ...sheetsApiResult.data];
          state.lastCacheUpdateTime = Date.now();
          return state.appScriptDataCache;
        } else {
          logger.warn(`[cookieDataFetcher] Sheets API fetch failed: ${sheetsApiResult.error}. Falling back to App Script.`);
        }
      } catch (sheetsApiError) {
        logger.error(`[cookieDataFetcher] Error with Sheets API fetch: ${sheetsApiError.message}. Falling back to App Script.`);
      }

      // --- Fallback to App Script ---
      const appScriptUrl = process.env.SCRIPT_URL;
      const params = new URLSearchParams({
        action: 'getCookieData',
        key: process.env.SCRIPT_KEY,
      });

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await axios.post(appScriptUrl, params, {
            timeout: timeout,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });

          if (!response.data || !response.data.success) {
            throw new Error(`Invalid response: ${JSON.stringify(response.data)}`);
          }

          const responseData = response.data;
          if (!responseData.headers || !responseData.data) {
            throw new Error(`Missing headers or data in response: ${JSON.stringify(responseData)}`);
          }

          state.appScriptDataCache = [responseData.headers, ...responseData.data];
          state.lastCacheUpdateTime = Date.now();
          logger.info("[cookieDataFetcher] App Script data cache updated successfully.");
          return state.appScriptDataCache;
        } catch (error) {
          logger.error(`[cookieDataFetcher] Attempt ${attempt} failed: ${error.message}`);
          if (attempt === retries) {
            // If both Sheets API and AppScript fail, return stale cache if available
            if (state.appScriptDataCache) {
              logger.warn("[cookieDataFetcher] All fetch attempts failed. Returning stale cache.");
              return state.appScriptDataCache;
            }
            throw new Error(`Failed to fetch data after ${retries} attempts.`);
          }
        }
      }
    } finally {
      state.isUpdatingCache = false;
      state.currentUpdatePromise = null;
    }
  })();

  state.currentUpdatePromise = fetchPromise;
  return await fetchPromise;
}

export async function fetchDataFromAppScript(retries = 3, timeout = 120000, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && state.appScriptDataCache && (now - state.lastCacheUpdateTime < CACHE_UPDATE_INTERVAL)) {
    logger.debug("[cookieDataFetcher][fetchDataFromAppScript] Returning cached data.");
    return state.appScriptDataCache;
  }
  logger.debug("[cookieDataFetcher][fetchDataFromAppScript] Fetching fresh data (cache expired or forced refresh).");
  return await _fetchAndCacheAppScriptData(retries, timeout, forceRefresh);
}

export function startAppScriptDataBackgroundUpdater() {
  if (state.backgroundUpdaterIntervalId === null) {
    logger.info("[cookieDataFetcher] Starting background App Script data updater.");
    state.backgroundUpdaterIntervalId = setInterval(async () => {
      try {
        await _fetchAndCacheAppScriptData();
      } catch (error) {
        logger.error(`[cookieDataFetcher] Error updating cache in background: ${error.message}`);
      }
    }, CACHE_UPDATE_INTERVAL);
  } else {
    logger.debug("[cookieDataFetcher] Background updater is already running.");
  }
}

export function stopAppScriptDataBackgroundUpdater() {
  if (state.backgroundUpdaterIntervalId !== null) {
    logger.info("[cookieDataFetcher] Stopping background App Script data updater.");
    clearInterval(state.backgroundUpdaterIntervalId);
    state.backgroundUpdaterIntervalId = null;
  }
}

export function invalidateCache() {
  state.appScriptDataCache = null;
  state.lastCacheUpdateTime = 0;
}

/**
 * Directly patch a row in the in-memory cache with updated field values.
 * This ensures the pooler sees the latest data immediately, without waiting
 * for the next Sheets API fetch.
 */
export async function patchCachedRow(browserId, fieldUpdates) {
  if (!state.appScriptDataCache) {
    // Cache not populated yet — fetch fresh data first, then patch
    try {
      await _fetchAndCacheAppScriptData();
    } catch (e) {
      logger.warn(`[cookieDataFetcher] patchCachedRow: fetch failed for ${browserId}: ${e.message}`);
      return;
    }
  }
  const cacheHeaders = state.appScriptDataCache[0];
  if (!Array.isArray(cacheHeaders)) return;
  const browserIdIdx = cacheHeaders.indexOf('browserId');
  if (browserIdIdx === -1) return;
  const rows = state.appScriptDataCache.slice(1);
  for (const row of rows) {
    if (String(row[browserIdIdx]).trim() === String(browserId).trim()) {
      for (const [field, value] of Object.entries(fieldUpdates)) {
        const idx = cacheHeaders.indexOf(field);
        if (idx !== -1) row[idx] = value;
      }
      break;
    }
  }
}
