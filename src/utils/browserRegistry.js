// Per-campaign browser registry so a user pause can force-close a campaign's
// engines browsers immediately, without waiting for the next runner checkpoint
// (which can be minutes away during long AI calls / navigation waits).
//
// Only browsers explicitly registered by a route are tracked. The desktop
// "webfixx-sessions" Electron launcher is a separate process and is NOT tracked
// here — those are the user's persistent login sessions and stay open by design.

import { getSheetDataApi } from "../app/api/googlesheets.js";
import logger from "./logger.js";

if (!globalThis.__webfixxBrowsers) {
  globalThis.__webfixxBrowsers = new Map(); // campaignId -> Set<browser>
}
const byCampaign = globalThis.__webfixxBrowsers;

function cid(campaignId) {
  return campaignId ? String(campaignId).trim() : '';
}

// One shared pause watcher: every few seconds, check whether any campaign with
// a registered browser has been paused in the sheet; if so, force-close it.
// This catches mid-action pauses (long AI calls / navigation waits) that never
// reach a runner checkpoint in time.
const WATCH_MS = 5000;
let watcherStarted = false;
function ensureWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  const timer = setInterval(async () => {
    if (byCampaign.size === 0) return;
    try {
      const res = await getSheetDataApi("campaigns");
      if (!res.success) return;
      const h = res.headers;
      const idIdx = h.indexOf("campaignId");
      const statusIdx = h.indexOf("status");
      if (idIdx === -1 || statusIdx === -1) return;
      const statusById = new Map();
      for (const row of res.data) statusById.set(String(row[idIdx] || '').trim(), String(row[statusIdx] || '').trim().toLowerCase());
      for (const key of Array.from(byCampaign.keys())) {
        if (statusById.get(key) === 'paused') {
          try {
            const closed = await forceCloseCampaignBrowsers(key, logger);
            if (closed) logger.info(`[browserRegistry] Pause watcher force-closed ${closed} browser(s) for ${key}.`);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }, WATCH_MS);
  if (typeof timer.unref === "function") timer.unref();
}

export function registerBrowserForCampaign(campaignId, browser) {
  const key = cid(campaignId);
  if (!key || !browser) return;
  let set = byCampaign.get(key);
  if (!set) { set = new Set(); byCampaign.set(key, set); }
  set.add(browser);
  ensureWatcher();
  // Auto-remove when the browser closes on its own (normal finally cleanup).
  try {
    browser.once?.('disconnected', () => {
      const s = byCampaign.get(key);
      if (s) { s.delete(browser); if (s.size === 0) byCampaign.delete(key); }
    });
  } catch (_) {}
}

export function unregisterBrowserForCampaign(campaignId, browser) {
  const key = cid(campaignId);
  const set = byCampaign.get(key);
  if (!set || !browser) return;
  set.delete(browser);
  if (set.size === 0) byCampaign.delete(key);
}

export async function forceCloseCampaignBrowsers(campaignId, log = null) {
  const key = cid(campaignId);
  const set = byCampaign.get(key);
  if (!set || set.size === 0) return 0;
  let closed = 0;
  for (const browser of Array.from(set)) {
    try { await browser.close(); closed++; }
    catch (e) { log?.warn?.(`[browserRegistry] close failed for ${key}: ${e.message}`); }
  }
  byCampaign.delete(key);
  return closed;
}

export function registeredBrowserCount(campaignId) {
  const set = byCampaign.get(cid(campaignId));
  return set ? set.size : 0;
}
