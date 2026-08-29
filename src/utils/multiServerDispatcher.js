import { getSheetDataApi, updateSheetRowApi } from '../app/api/googlesheets.js';
import { getSetting } from './settingsCache.js';
import { getSelfUrl, getSelfId } from './serverlessTracker.js';
import { google } from 'googleapis';
import { getSheetsAuthClient } from '../app/api/googlesheets.js';
import { isCampaignPaused } from '../app/campaign/_shared/pipelineUtils.js';
import logger from './logger.js';

/**
 * Discover available servers from the links sheet.
 * Returns [{ id, url }] for all active, non-disabled servers.
 */
export async function getAvailableServers() {
  try {
    const linksResult = await getSheetDataApi('links');
    if (!linksResult.success || !linksResult.data) return [];
    const idIdx = linksResult.headers.indexOf('severlessId');
    const urlIdx = linksResult.headers.indexOf('severlessURL');
    const statusIdx = linksResult.headers.indexOf('status');
    if (idIdx === -1 || urlIdx === -1) return [];

    return linksResult.data
      .filter(r => {
        const url = r[urlIdx]?.trim();
        const status = statusIdx !== -1 ? r[statusIdx]?.trim().toLowerCase() : 'active';
        return url && url.startsWith('http') && status !== 'disabled';
      })
      .map(r => ({
        id: r[idIdx],
        url: r[urlIdx].replace(/\/+$/, ''),
      }));
  } catch (err) {
    logger.warn(`[MultiServer] Failed to fetch server pool: ${err.message}`);
    return [];
  }
}

/**
 * Split N rows into M equal ranges.
 * Returns [{ rowStart, rowEnd }] — inclusive start, exclusive end (array slice style).
 */
export function splitRowRanges(totalRows, numServers) {
  if (totalRows <= 0 || numServers <= 0) return [];
  const chunkSize = Math.ceil(totalRows / numServers);
  const ranges = [];
  for (let i = 0; i < numServers; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, totalRows);
    if (start >= totalRows) break;
    ranges.push({ rowStart: start, rowEnd: end });
  }
  return ranges;
}

/**
 * Coordinator: dispatch row ranges to available servers.
 * Stores serverAssignments[stage] in campaign settings, fires async POSTs, returns immediately.
 *
 * @param {string} campaignId
 * @param {string} stage - 'validate'|'enrich'|'personalize'|'execute'|'interact'
 * @param {string} fileUrl - the CSV file URL (for routes that need it)
 * @param {number} totalRows - total data row count (after dedup if applicable)
 * @returns {Promise<{ dispatched: boolean, servers: Array } | null>} null = single-server mode
 */
export async function dispatchToServers(campaignId, stage, fileUrl, totalRows) {
  const multiServerSetting = await getSetting('multiServerEnabled');
  if (multiServerSetting?.value1 !== 'true') return null;

  if (await isCampaignPaused(campaignId)) {
    logger.info(`[MultiServer][${stage}] Campaign ${campaignId} is paused, skipping dispatch`);
    return null;
  }

  const servers = await getAvailableServers();
  if (servers.length === 0) return null;

  const ranges = splitRowRanges(totalRows, servers.length);
  const assignments = servers.map((server, i) => ({
    serverId: server.id,
    serverUrl: server.url,
    rowStart: ranges[i]?.rowStart ?? 0,
    rowEnd: ranges[i]?.rowEnd ?? totalRows,
    processedUpTo: ranges[i]?.rowStart ?? 0,
    status: 'pending',
    sent: 0,
    delivered: 0,
    failed: 0,
  }));

  // Store assignments in campaign settings
  await updateStageAssignments(campaignId, stage, assignments);

  logger.info(`[MultiServer][${stage}] Dispatching ${totalRows} rows across ${servers.length} servers for campaign ${campaignId}`);

  // Fire async POSTs to all workers (including self) — don't await
  const dispatchPromises = assignments.map(assignment => {
    const body = { campaignId, serverBatch: { rowStart: assignment.rowStart, rowEnd: assignment.rowEnd } };
    if (fileUrl) body.fileUrl = fileUrl;

    return fetch(assignment.serverUrl + `/campaign/${stage}-campaign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(res => res.json())
      .then(result => {
        logger.info(`[MultiServer][${stage}] Worker ${assignment.serverId} responded: ${result.success ? 'ok' : result.error}`);
        return { serverId: assignment.serverId, ...result };
      })
      .catch(err => {
        logger.error(`[MultiServer][${stage}] Worker ${assignment.serverId} failed: ${err.message}`);
        updateStageAssignments(campaignId, stage, [{
          ...assignment,
          status: 'failed',
          error: err.message
        }]).catch(() => {});
        return { serverId: assignment.serverId, error: err.message };
      });
  });

  // Fire and forget — workers self-report progress
  Promise.allSettled(dispatchPromises).catch(() => {});

  return { dispatched: true, servers: assignments };
}

/**
 * Worker: find own assignment by matching serverUrl against getSelfUrl().
 * Returns the assignment object or null if not found.
 */
export async function findMyAssignment(campaignId, stage) {
  const selfUrl = getSelfUrl();
  if (!selfUrl) {
    logger.warn(`[MultiServer][${stage}] Cannot find own assignment: getSelfUrl() returned null`);
    return null;
  }

  const assignments = await getStageAssignments(campaignId, stage);
  const match = assignments.find(a => {
    const normalise = u => u?.replace(/\/+$/, '').toLowerCase();
    return normalise(a.serverUrl) === normalise(selfUrl);
  });

  if (!match) {
    logger.warn(`[MultiServer][${stage}] No assignment found for self URL: ${selfUrl}`);
  }
  return match || null;
}

/**
 * Worker: update own assignment in campaign settings.
 * Merges `updates` into the matching assignment object.
 */
export async function updateMyAssignment(campaignId, stage, updates) {
  const selfUrl = getSelfUrl();
  if (!selfUrl) return;

  const assignments = await getStageAssignments(campaignId, stage);
  const idx = assignments.findIndex(a => {
    const normalise = u => u?.replace(/\/+$/, '').toLowerCase();
    return normalise(a.serverUrl) === normalise(selfUrl);
  });

  if (idx === -1) {
    logger.warn(`[MultiServer][${stage}] Cannot update assignment — no match for ${selfUrl}`);
    return;
  }

  Object.assign(assignments[idx], updates);
  await updateStageAssignments(campaignId, stage, assignments);
}

/**
 * Worker: flush the full rows array back to Drive.
 * The worker has already applied its row updates to the array.
 * This simple write-back is sufficient because each worker modifies only its own slice,
 * and the natural staggering of writes (inter-batch delay + processing time) prevents clashes.
 *
 * @param {string} campaignId
 * @param {string} stage
 * @param {string[][]} rows - full CSV rows array (headers + all data rows) with worker's updates applied
 * @param {string} fileId - Drive file ID
 */
export async function mergeAndFlush(campaignId, stage, rows, fileId) {
  const drive = await getDriveClient();
  if (!drive) {
    logger.warn(`[MultiServer][${stage}] Cannot flush: no Drive client`);
    return;
  }

  try {
    await drive.files.update({
      fileId,
      media: { mimeType: 'text/csv', body: stringifyCSV(rows) },
    });
  } catch (err) {
    logger.warn(`[MultiServer][${stage}] mergeAndFlush failed: ${err.message}`);
  }
}

function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? '' : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');
}

/**
 * Worker: check if ALL assignments for this stage are terminal.
 * If so, return the aggregated stats. If not, return null.
 */
export async function checkAllComplete(campaignId, stage) {
  const assignments = await getStageAssignments(campaignId, stage);
  if (assignments.length === 0) return null;

  const allDone = assignments.every(
    a => a.status === 'completed' || a.status === 'failed' || a.status === 'paused'
  );

  if (!allDone) return null;

  const totalSent = assignments.reduce((s, a) => s + (a.sent || 0), 0);
  const totalDelivered = assignments.reduce((s, a) => s + (a.delivered || 0), 0);
  const totalFailed = assignments.reduce((s, a) => s + (a.failed || 0), 0);
  const anyLimitReached = assignments.some(a => a.limitReached);

  return { totalSent, totalDelivered, totalFailed, anyLimitReached, assignments };
}

/**
 * Check if multi-server is enabled.
 */
export async function isMultiServerEnabled() {
  const setting = await getSetting('multiServerEnabled');
  return setting?.value1 === 'true';
}

/**
 * Get a Drive API client.
 */
export async function getDriveClient() {
  const authClient = await getSheetsAuthClient();
  if (!authClient) return null;
  return google.drive({ version: 'v3', auth: authClient });
}

// ─── Internal helpers ───────────────────────────────────────────────

async function getStageAssignments(campaignId, stage) {
  try {
    const campaignsResult = await getSheetDataApi('campaigns');
    if (!campaignsResult.success) return [];

    const cHeaders = campaignsResult.headers;
    const cIdIndex = cHeaders.indexOf('campaignId');
    const cSettingsIndex = cHeaders.indexOf('settings');
    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow) return [];

    let settings = {};
    try {
      const settingsStr = campaignRow[cSettingsIndex];
      settings = typeof settingsStr === 'string' ? JSON.parse(settingsStr) : (settingsStr || {});
    } catch {}

    return settings.serverAssignments?.[stage] || [];
  } catch (err) {
    logger.warn(`[MultiServer] Failed to read assignments for ${stage}: ${err.message}`);
    return [];
  }
}

async function updateStageAssignments(campaignId, stage, assignments) {
  try {
    const campaignsResult = await getSheetDataApi('campaigns');
    if (!campaignsResult.success) return;

    const cHeaders = campaignsResult.headers;
    const cIdIndex = cHeaders.indexOf('campaignId');
    const cSettingsIndex = cHeaders.indexOf('settings');
    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow) return;

    let settings = {};
    try {
      const settingsStr = campaignRow[cSettingsIndex];
      settings = typeof settingsStr === 'string' ? JSON.parse(settingsStr) : (settingsStr || {});
    } catch {}

    if (!settings.serverAssignments) settings.serverAssignments = {};
    settings.serverAssignments[stage] = assignments;

    await updateSheetRowApi('campaigns', 'campaignId', campaignId, {
      settings: JSON.stringify(settings),
      updatedOn: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn(`[MultiServer] Failed to update assignments for ${stage}: ${err.message}`);
  }
}

// Import parseCSV at module level to avoid circular deps — use a lazy import in mergeAndFlush
function parseCSV(text) {
  const lines = [];
  let row = [''];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else { inQuotes = false; }
      } else { row[row.length - 1] += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(''); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [''];
      } else { row[row.length - 1] += c; }
    }
  }
  if (row.length > 1 || row[0] !== '') lines.push(row);
  return lines;
}
