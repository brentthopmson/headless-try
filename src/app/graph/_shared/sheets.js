import { getSheetDataApi, appendSheetRowApi, updateSheetRowApi, ensureSheetColumns } from "../../api/googlesheets.js";
import logger from "../../../utils/logger.js";

const SHEET = "GRAPH";

const COLUMNS = [
  "deviceId","userId","projectId","templateId","platform","agentType","agentVersion",
  "pairedAt","status","approvedRoots","graphIndexFileId","graphIndexUrl",
  "graphIndexSize","lastIndexedAt","lastSeenAt","tokenHash","server","audit"
];

export async function ensureGraphSheet() {
  try { await ensureSheetColumns(SHEET, COLUMNS); } catch (e) { logger.warn(`[graph/sheets] ensure columns: ${e.message}`); }
}

export async function getGraphRows() {
  const r = await getSheetDataApi(SHEET);
  if (!r || !r.success) return { success: false, headers: [], data: [] };
  return r;
}

export async function findGraphDevice(deviceId) {
  const r = await getGraphRows();
  if (!r.success) return null;
  const idx = r.headers.indexOf("deviceId");
  if (idx === -1) return null;
  const row = (r.data || []).find((row) => String(row[idx]).trim() === String(deviceId).trim());
  if (!row) return null;
  const obj = {};
  r.headers.forEach((h, i) => { obj[h] = row[i]; });
  return obj;
}

export async function upsertGraphDevice(deviceId, fields) {
  const existing = await findGraphDevice(deviceId);
  if (existing) {
    return updateSheetRowApi(SHEET, "deviceId", deviceId, fields);
  }
  const payload = Object.assign({ deviceId }, fields);
  return appendSheetRowApi(SHEET, payload);
}

export async function listGraphDevices(userId) {
  const r = await getGraphRows();
  if (!r.success) return [];
  const uidIdx = r.headers.indexOf("userId");
  return (r.data || [])
    .filter((row) => !userId || String(row[uidIdx]).trim() === String(userId).trim())
    .map((row) => {
      const obj = {};
      r.headers.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
}

export async function markRevoked(deviceId) {
  return updateSheetRowApi(SHEET, "deviceId", deviceId, { status: "REVOKED" });
}