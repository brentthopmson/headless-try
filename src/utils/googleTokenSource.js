import axios from 'axios';
import logger from './logger.js';
import googleTokenSourceCore from './googleTokenSourceCore.js';

const { SETTINGS_SHEET_NAME, SETTINGS_KEY, extractRefreshToken, parseExpiryFromValue2, chooseRefreshToken } = googleTokenSourceCore;

// Refresh-token source of truth: the SETTINGS sheet row `googleRefreshToken`
// (settingsKey / settingsValue1 / settingsValue2), read through the App-Script
// getData action — which needs NO OAuth token — so a rotation works even when
// the previous refresh token is already dead. The env var
// GOOGLE_DRIVE_REFRESH_TOKEN remains the bootstrap/fallback when the sheet is
// unreadable (no SCRIPT_URL, quota, network).
//
// Rotation workflow: exchange a new code at oauth2.googleapis.com/token (same
// OAuth Playground client as GOOGLE_OAUTH2_JSON), paste the refresh_token into
// settingsValue1; every Sheets/Drive auth picks it up within CACHE_TTL_MS.
const CACHE_TTL_MS = 60 * 1000; // serve a resolved token for 60s before re-reading
const FAILURE_BACKOFF_MS = 30 * 1000; // after a failed read, retry at most every 30s
const GAS_READ_TIMEOUT_MS = 15000;

if (!globalThis.__googleTokenSourceState) {
  globalThis.__googleTokenSourceState = {
    resolved: null, // last resolved token (sheet > stale > env)
    resolvedAt: 0, // when the last successful sheet read happened
    lastFailedAt: 0, // when the last sheet read attempt failed
    inFlight: null,
  };
}
const state = globalThis.__googleTokenSourceState;

/**
 * Token-independent SETTINGS read via the App-Script endpoint. Deliberately
 * NOT routed through getSheetDataApi()/getSheetsAuthClient() — those need the
 * very token this function exists to resolve (recursion would be circular).
 */
async function readRefreshTokenViaAppScript() {
  const appScriptUrl = process.env.SCRIPT_URL;
  if (!appScriptUrl) {
    return { ok: false, error: 'SCRIPT_URL not configured' };
  }
  try {
    const params = new URLSearchParams({
      action: 'getData',
      key: process.env.SCRIPT_KEY || '',
      sheetname: SETTINGS_SHEET_NAME,
    });
    const response = await axios.post(appScriptUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: GAS_READ_TIMEOUT_MS,
    });
    if (response.data?.success && Array.isArray(response.data.headers)) {
      const headers = response.data.headers;
      const rows = response.data.data || [];
      const sheet = extractRefreshToken(headers, rows);
      const keyIdx = headers.indexOf('settingsKey');
      const val2Idx = headers.indexOf('settingsValue2');
      const row = keyIdx !== -1
        ? rows.find(r => r && String(r[keyIdx] == null ? '' : r[keyIdx]).trim() === SETTINGS_KEY)
        : null;
      const expiry = row && val2Idx !== -1 ? parseExpiryFromValue2(row[val2Idx]) : null;
      return { ok: true, sheet, expiry };
    }
    return { ok: false, error: response.data?.error || 'unsuccessful response' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Resolves the Google OAuth refresh token: SETTINGS sheet first, last-known
 * value second, env GOOGLE_DRIVE_REFRESH_TOKEN last. Never throws; worst case
 * returns null (caller disables Google integrations, same as missing env).
 *
 * @param {{forceRefresh?: boolean}} [options]
 * @returns {Promise<string|null>}
 */
export async function resolveRefreshToken(options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const env = process.env.GOOGLE_DRIVE_REFRESH_TOKEN || null;
  const now = Date.now();

  if (!forceRefresh && state.resolved && now - state.resolvedAt < CACHE_TTL_MS) {
    return state.resolved;
  }
  if (!forceRefresh && state.lastFailedAt && now - state.lastFailedAt < FAILURE_BACKOFF_MS) {
    return chooseRefreshToken({ sheet: null, stale: state.resolved, env });
  }

  if (!state.inFlight) {
    state.inFlight = (async () => {
      try {
        const read = await readRefreshTokenViaAppScript();
        if (read.ok) {
          state.resolved = chooseRefreshToken({ sheet: read.sheet, stale: state.resolved, env });
          state.resolvedAt = Date.now();
          state.lastFailedAt = 0;
          if (read.expiry && Date.now() > read.expiry) {
            logger.warn('[googleTokenSource] SETTINGS refresh token is past its expires= hint - rotate googleRefreshToken now (resolved anyway).');
          }
          const source = read.sheet ? 'sheet' : state.resolved === String(env || '').trim() ? 'env' : 'stale';
          logger.info(`[googleTokenSource] refresh token source=${source} len=${state.resolved ? state.resolved.length : 0}`);
        } else {
          state.lastFailedAt = Date.now();
          logger.warn(`[googleTokenSource] SETTINGS read failed (${read.error}) - using stale/env fallback.`);
        }
      } finally {
        state.inFlight = null;
      }
      return chooseRefreshToken({ sheet: null, stale: state.resolved, env });
    })();
  }

  return await state.inFlight;
}

/** Test/ops helper: forget every cached value (next resolve re-reads the sheet). */
export function invalidateTokenSource() {
  state.resolved = null;
  state.resolvedAt = 0;
  state.lastFailedAt = 0;
  state.inFlight = null;
}

/**
 * Synchronous hint for pre-flight config checks: last resolved token if any
 * (sheet or env), else env. Never triggers a sheet read.
 */
export function getCachedRefreshToken() {
  return state.resolved || process.env.GOOGLE_DRIVE_REFRESH_TOKEN || null;
}

export function getTokenSourceStats() {
  return {
    hasResolved: !!state.resolved,
    resolvedLen: state.resolved ? state.resolved.length : 0,
    ageMs: state.resolvedAt ? Date.now() - state.resolvedAt : null,
    lastFailedAt: state.lastFailedAt || null,
  };
}
