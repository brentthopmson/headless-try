import { getSheetDataApi, updateSheetRowApi } from "../../api/googlesheets.js";
import logger from "../../../utils/logger.js";

/**
 * Extracts a Google Drive file ID from a URL or returns the raw ID.
 */
export function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

/**
 * Parses a CSV text string into a 2D array of rows and cells.
 * Handles quoted values with escaped quotes and CRLF line endings.
 */
export function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else { inQuotes = false; }
      } else {
        row[row.length - 1] += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(""); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
  }
  if (row.length > 1 || row[0] !== "") lines.push(row);
  return lines;
}

/**
 * Converts a 2D array back into CSV text, escaping commas, quotes, and newlines.
 */
export function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? "" : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');
}

/**
 * Re-reads the campaign row and returns true if its status is currently paused.
 * Used mid-batch so an in-flight run can abort at a checkpoint when the user pauses.
 */
export async function isCampaignPaused(campaignId) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return false;
    const headers = campaignsResult.headers;
    const idIdx = headers.indexOf("campaignId");
    const statusIdx = headers.indexOf("status");
    if (idIdx === -1 || statusIdx === -1) return false;
    const row = campaignsResult.data.find(r => String(r[idIdx]).trim() === String(campaignId).trim());
    if (!row) return false;
    return String(row[statusIdx] || "").trim().toLowerCase() === "paused";
  } catch (err) {
    logger.warn(`[Pipeline] Pause check failed for ${campaignId}: ${err.message}`);
    return false;
  }
}

/**
 * Merges updates into the campaign's settings JSON and writes it back to the campaigns sheet.
 */
export async function updateCampaignSettings(campaignId, updates) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return;
    const cHeaders = campaignsResult.headers;
    const cIdIndex = cHeaders.indexOf("campaignId");
    const cSettingsIndex = cHeaders.indexOf("settings");
    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow || cSettingsIndex === -1) return;

    let settings = {};
    try {
      const settingsStr = campaignRow[cSettingsIndex];
      if (typeof settingsStr === "string") settings = JSON.parse(settingsStr);
      else if (settingsStr && typeof settingsStr === 'object') settings = settingsStr;
    } catch {}

    Object.assign(settings, updates);

    await updateSheetRowApi("campaigns", "campaignId", campaignId, {
      settings: JSON.stringify(settings),
      updatedOn: new Date().toISOString()
    });
  } catch (err) {
    logger.warn(`[Pipeline] Failed to update campaign settings for ${campaignId}: ${err.message}`);
  }
}

/**
 * Reads the campaign settings JSON from the campaigns sheet.
 * Returns { settings, campaignRow, headers } or null if not found.
 */
export async function getCampaignSettings(campaignId) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return null;
    const headers = campaignsResult.headers;
    const cIdIndex = headers.indexOf("campaignId");
    const cSettingsIndex = headers.indexOf("settings");
    const cStatusIndex = headers.indexOf("status");
    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow) return null;

    let settings = {};
    try {
      const settingsStr = campaignRow[cSettingsIndex];
      if (typeof settingsStr === "string") settings = JSON.parse(settingsStr);
      else if (settingsStr && typeof settingsStr === 'object') settings = settingsStr;
    } catch {}

    return {
      settings,
      campaignRow,
      headers,
      status: String(campaignRow[cStatusIndex] || "").trim()
    };
  } catch (err) {
    logger.warn(`[Pipeline] Failed to read campaign settings for ${campaignId}: ${err.message}`);
    return null;
  }
}
