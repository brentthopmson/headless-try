// Throttled campaign-pause check for long-running social engagement runners.
// The orchestrator/task-dispatch layer checks pause only BETWEEN tasks, but a
// single social task can run for many minutes over multiple keywords/posts.
// This helper lets runners honor a frontend pause at safe checkpoints (between
// posts/actions) without hammering the sheet on every iteration.

import logger from '../../../utils/logger.js';
import { isCampaignPaused, getCampaignStopReason } from '../../campaign/_shared/pipelineUtils.js';

const CHECK_TTL_MS = 4000; // at most one sheet read per 4s PER campaign

// Cache is keyed by campaignId — two concurrent campaigns must never share a
// pause result (one paused, one running would otherwise contaminate each other).
const state = (globalThis.__socialPauseCheckState = globalThis.__socialPauseCheckState || {
  byCampaign: {}, // campaignId -> { at, cached, inFlight }
});

function entryFor(campaignId) {
  let e = state.byCampaign[campaignId];
  if (!e) { e = state.byCampaign[campaignId] = { at: 0, cached: false, inFlight: null }; }
  return e;
}

/**
 * Returns true if the campaign is paused. Throttled per-campaign: within
 * CHECK_TTL_MS the last result for THAT campaign is reused. Failed reads are
 * treated as "not paused" (same as isCampaignPaused) so a transient Sheets
 * error can't spuriously stop a run.
 */
export async function isSocialCampaignPaused(campaignId) {
  if (!campaignId) return false;
  const e = entryFor(campaignId);
  const now = Date.now();
  if (now - e.at < CHECK_TTL_MS) return e.cached;
  if (e.inFlight) return await e.inFlight;
  e.inFlight = (async () => {
    try {
      e.cached = !!(await isCampaignPaused(campaignId));
    } catch (_) {
      e.cached = false;
    }
    e.at = Date.now();
    return e.cached;
  })();
  try { return await e.inFlight; }
  finally { e.inFlight = null; }
}

// Separate cache for the broader "should an in-flight run stop?" signal. Kept
// independent from the pause cache so a pause-check result cannot mask a newly
// written rest (or vice versa) during the 4s TTL.
const stopState = (globalThis.__socialStopReasonState = globalThis.__socialStopReasonState || {
  byCampaign: {}, // campaignId -> { at, cached, inFlight }
});

function stopEntryFor(campaignId) {
  let e = stopState.byCampaign[campaignId];
  if (!e) { e = stopState.byCampaign[campaignId] = { at: 0, cached: null, inFlight: null }; }
  return e;
}

/**
 * Returns 'paused' | 'resting' | null (throttled per campaign). Used by runner
 * checkpoints so a RESTING written mid-run finally stops the task. A read
 * failure returns null — a transient Sheets error must not stop a run.
 */
export async function getSocialStopReason(campaignId) {
  if (!campaignId) return null;
  const e = stopEntryFor(campaignId);
  const now = Date.now();
  if (now - e.at < CHECK_TTL_MS) return e.cached;
  if (e.inFlight) return await e.inFlight;
  e.inFlight = (async () => {
    try {
      e.cached = await getCampaignStopReason(campaignId);
    } catch (_) {
      e.cached = null;
    }
    e.at = Date.now();
    return e.cached;
  })();
  try { return await e.inFlight; }
  finally { e.inFlight = null; }
}

/** Reset one campaign's cache (or all when no id given). */
export function resetSocialPauseCheck(campaignId) {
  if (campaignId) {
    delete state.byCampaign[campaignId];
    delete stopState.byCampaign[campaignId];
  } else {
    state.byCampaign = {};
    stopState.byCampaign = {};
  }
}
