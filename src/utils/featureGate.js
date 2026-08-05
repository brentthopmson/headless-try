import { NextResponse } from "next/server";
import { getSetting } from './settingsCache.js';
import logger from './logger.js';

const OFF_VALUES = ['0', 'false', 'no', 'off', 'disabled'];

/**
 * Returns true when the admin feature flag is enabled.
 * Missing/blank rows are treated as ENABLED (preserves today's behavior).
 * @param {string} key - settingsKey, e.g. 'allowExtraction'
 * @returns {Promise<boolean>}
 */
export async function isFeatureEnabled(key) {
  try {
    const setting = await getSetting(key);
    if (!setting || setting.value1 === null || setting.value1 === undefined) return true;
    const v = String(setting.value1).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch (err) {
    logger.error(`[featureGate] isFeatureEnabled(${key}) error: ${err.message}. Treating as enabled.`);
    return true;
  }
}

/**
 * Gate helper for Next.js route handlers. Returns a CORS 403 NextResponse
 * (truthy) when the feature is disabled, or null when allowed.
 * @param {string} key - settingsKey flag, e.g. 'allowExtraction'
 * @param {string} label - human-readable feature name
 * @returns {Promise<NextResponse|null>}
 */
export async function requireFeature(key, label) {
  const enabled = await isFeatureEnabled(key);
  if (enabled) return null;
  logger.warn(`[featureGate] BLOCKED '${label}' by '${key}'`);
  return NextResponse.json(
    { success: false, error: `Feature disabled. Enable '${key}' in Admin Settings to use ${label}.`, blocked: true },
    { status: 403 }
  );
}
