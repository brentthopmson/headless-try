const axios = require("axios");

/**
 * Server-scoped opencode SETTINGS resolution (CJS for Node launcher + Next bundler interop).
 *
 * SETTINGS AI rows can include multiple opencode entries, one per server,
 * distinguished by `aiSeverlessId` (sample spelling) / `aiServerlessId`.
 * Each server (identified by process.env.SERVERLESS_ID, like 3001/links) must
 * read/write ONLY its matching opencode row so servers never contend.
 *
 * GAS `setMultipleCellDataByColumnSearch` is single-column search, so writes
 * resolve the matching row via `getData` -> find (provider=opencode AND
 * serverlessId matches) -> update by unique `aiSn`.
 */

const SERVERLESS_ID_KEYS = [
  "aiseverlessid",
  "aiserverlessid",
  "ai_severless_id",
  "ai_serverless_id",
  "serverlessid",
  "severlessid",
];

function getServerlessId(env = process.env) {
  return String(env?.SERVERLESS_ID || "").trim();
}

function norm(v) {
  return String(v == null ? "" : v).toLowerCase().trim();
}

function stripKey(k) {
  return norm(k).replace(/[^a-z0-9]/g, "");
}

function cell(v) {
  return String(v == null ? "" : v).trim();
}

function isOpencodeProviderValue(v) {
  return norm(v) === "opencode";
}

/** Read serverless-id from a normalized row object (supports stripped/lower keys). */
function pickServerlessIdFromNormalizedRow(row) {
  if (!row || typeof row !== "object") return "";
  for (const k of SERVERLESS_ID_KEYS) {
    const v = row[k];
    if (cell(v)) return cell(v);
  }
  // fallback: scan any key that normalizes to a known serverless-id form
  for (const [k, v] of Object.entries(row)) {
    if (SERVERLESS_ID_KEYS.includes(stripKey(k)) && cell(v)) return cell(v);
  }
  return "";
}

/** Read serverless-id from a raw GAS row array given headers. */
function pickServerlessIdFromRawRow(headers, rowArr) {
  if (!Array.isArray(headers) || !Array.isArray(rowArr)) return "";
  for (let i = 0; i < headers.length; i++) {
    if (SERVERLESS_ID_KEYS.includes(stripKey(headers[i])) && cell(rowArr[i])) return cell(rowArr[i]);
  }
  return "";
}

function pickAiSnFromRawRow(headers, rowArr) {
  if (!Array.isArray(headers) || !Array.isArray(rowArr)) return "";
  const idx = headers.findIndex((h) => stripKey(h) === "aisn");
  return idx >= 0 ? cell(rowArr[idx]) : "";
}

function pickAiProviderFromRawRow(headers, rowArr) {
  if (!Array.isArray(headers) || !Array.isArray(rowArr)) return "";
  const idx = headers.findIndex((h) => stripKey(h) === "aiprovider");
  return idx >= 0 ? cell(rowArr[idx]) : "";
}

function findHeaderActual(headers, strippedName) {
  if (!Array.isArray(headers)) return strippedName;
  return headers.find((h) => stripKey(h) === strippedName) || strippedName;
}

/**
 * Find the opencode SETTINGS row for this server.
 * @param {Array<object>} rows normalized row objects
 * @param {string} serverlessId
 * @returns {{row:object, aiSn:string, matchedBy:string}|null}
 */
function findMatchingOpencodeNormalizedRow(rows, serverlessId) {
  if (!Array.isArray(rows)) return null;
  const sid = cell(serverlessId);
  const opencodeRows = rows.filter((r) => isOpencodeProviderValue(r?.aiprovider ?? r?.ai_provider ?? r?.provider));
  if (!opencodeRows.length) return null;

  if (sid) {
    const scoped = opencodeRows.filter((r) => norm(pickServerlessIdFromNormalizedRow(r)) === norm(sid));
    if (scoped.length === 1) return { row: scoped[0], aiSn: cell(scoped[0].aisn ?? scoped[0].aiSn ?? scoped[0].sn), matchedBy: "serverlessId" };
    if (scoped.length > 1) return { row: scoped[0], aiSn: cell(scoped[0].aisn ?? scoped[0].aiSn ?? scoped[0].sn), matchedBy: "serverlessId_first", ambiguous: true };
    // No scoped match: allow an unscoped opencode row ONLY when unambiguous (single opencode row, no serverless id set)
    const unscoped = opencodeRows.filter((r) => !cell(pickServerlessIdFromNormalizedRow(r)));
    if (unscoped.length === 1 && opencodeRows.length === 1) return { row: unscoped[0], aiSn: cell(unscoped[0].aisn ?? unscoped[0].aiSn ?? unscoped[0].sn), matchedBy: "unscoped_compat" };
    return null;
  }

  // No SERVERLESS_ID env: legacy behavior - only safe if exactly one opencode row
  if (opencodeRows.length === 1) return { row: opencodeRows[0], aiSn: cell(opencodeRows[0].aisn ?? opencodeRows[0].aiSn ?? opencodeRows[0].sn), matchedBy: "single_legacy" };
  const unscoped = opencodeRows.filter((r) => !cell(pickServerlessIdFromNormalizedRow(r)));
  if (unscoped.length === 1) return { row: unscoped[0], aiSn: cell(unscoped[0].aisn ?? unscoped[0].aiSn ?? unscoped[0].sn), matchedBy: "unscoped_legacy" };
  return null;
}

/** Normalize GAS getData rows (headers + array rows) -> array of objects with lower+stripped keys. */
function normalizeSettingsRows(headers, dataRows) {
  const hs = Array.isArray(headers) ? headers.map((h) => String(h || "")) : [];
  const rows = Array.isArray(dataRows) ? dataRows : [];
  return rows.map((r) => {
    const obj = { __raw: Array.isArray(r) ? r : [] };
    hs.forEach((h, idx) => {
      const raw = Array.isArray(r) ? r[idx] : undefined;
      const lower = norm(h);
      obj[lower] = raw;
      obj[stripKey(h)] = raw;
      obj[h] = raw; // preserve original
    });
    return obj;
  });
}

async function gasGetData(scriptUrl, scriptKey, sheetname = "SETTINGS", timeout = 30000) {
  const url = String(scriptUrl || "").trim().replace(/\/+$/, "");
  const key = String(scriptKey || "").trim();
  if (!url || !key) return { ok: false, error: "missing_script_config" };
  const params = new URLSearchParams({ action: "getData", key, sheetname });
  const res = await axios.post(url, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout,
  });
  if (!res.data?.success || !Array.isArray(res.data?.headers)) return { ok: false, error: res.data?.error || "bad_response" };
  return { ok: true, headers: res.data.headers.map((h) => String(h)), data: res.data.data || [] };
}

/**
 * Resolve the target opencode row's aiSn for this server (for GAS single-column updates).
 * Safe for both Node/CJS callers and bundled ESM callers.
 */
async function resolveOpencodeTargetForServer(opts = {}) {
  const scriptUrl = opts.scriptUrl || process.env.SCRIPT_URL || "";
  const scriptKey = opts.scriptKey || process.env.SCRIPT_KEY || "";
  const serverlessId = cell(opts.serverlessId || getServerlessId());
  const label = opts.label || "opencode-settings";

  const got = await gasGetData(scriptUrl, scriptKey, "SETTINGS", opts.timeout || 30000);
  if (!got.ok) return { ok: false, error: got.error, serverlessId };

  const { headers, data } = got;
  const aiSnHeader = findHeaderActual(headers, "aisn");
  const aiProviderIdx = headers.findIndex((h) => stripKey(h) === "aiprovider");

  // scan raw rows for precise compound match
  let match = null;
  let opCount = 0;
  for (const r of (data || [])) {
    const prov = aiProviderIdx >= 0 ? r[aiProviderIdx] : pickAiProviderFromRawRow(headers, r);
    if (!isOpencodeProviderValue(prov)) continue;
    opCount++;
    const rowSid = pickServerlessIdFromRawRow(headers, r);
    if (serverlessId && norm(rowSid) === norm(serverlessId)) { match = { r, rowSid }; break; }
  }

  // compat: no serverlessId env or no scoped match
  if (!match) {
    if (serverlessId) {
      // allow unscoped only if single opencode row total and it's unscoped
      const unscopedSingles = (data || []).filter((r) => {
        const prov = aiProviderIdx >= 0 ? r[aiProviderIdx] : pickAiProviderFromRawRow(headers, r);
        if (!isOpencodeProviderValue(prov)) return false;
        return !cell(pickServerlessIdFromRawRow(headers, r));
      });
      const allOp = (data || []).filter((r) => isOpencodeProviderValue(aiProviderIdx >= 0 ? r[aiProviderIdx] : pickAiProviderFromRawRow(headers, r)));
      if (unscopedSingles.length === 1 && allOp.length === 1) {
        match = { r: unscopedSingles[0], rowSid: "", compat: true };
      }
    } else if (opCount === 1) {
      const only = (data || []).find((r) => isOpencodeProviderValue(aiProviderIdx >= 0 ? r[aiProviderIdx] : pickAiProviderFromRawRow(headers, r)));
      if (only) match = { r: only, rowSid: pickServerlessIdFromRawRow(headers, only), compat: true };
    }
  }

  if (!match) {
    console.warn(`[${label}] No opencode SETTINGS row for SERVERLESS_ID='${serverlessId || "(unset)"}' (opencode rows=${opCount}). Add aiSeverlessId/aiServerlessId='${serverlessId || "<SERVERLESS_ID>"}' to the correct aiProvider=opencode row. Skipping to avoid cross-server contention.`);
    return { ok: false, error: "no_matching_opencode_row", serverlessId, opCount, aiSnHeader };
  }

  const aiSn = pickAiSnFromRawRow(headers, match.r);
  if (!aiSn) return { ok: false, error: "missing_aiSn", serverlessId, aiSnHeader };

  if (match.compat) console.log(`[${label}] Using unscoped/legacy opencode row aiSn=${aiSn} (SERVERLESS_ID='${serverlessId || "(unset)"}')`);
  else console.log(`[${label}] Resolved opencode row aiSn=${aiSn} for SERVERLESS_ID='${serverlessId}'`);
  return { ok: true, aiSn, aiSnHeader, serverlessId, headers, compat: !!match.compat };
}

/** Update SETTINGS cells for the resolved opencode row by aiSn. */
async function setSettingsCellsByAiSn(opts = {}) {
  const scriptUrl = String(opts.scriptUrl || process.env.SCRIPT_URL || "").trim().replace(/\/+$/, "");
  const scriptKey = String(opts.scriptKey || process.env.SCRIPT_KEY || "").trim();
  const { aiSn, aiSnHeader = "aiSn", data } = opts;
  const label = opts.label || "opencode-settings";
  if (!scriptUrl || !scriptKey) return { ok: false, error: "missing_script_config" };
  if (!aiSn) return { ok: false, error: "missing_aiSn" };
  const params = new URLSearchParams({
    action: "setMultipleCellDataByColumnSearch",
    sheetName: "SETTINGS",
    searchColumn: aiSnHeader,
    searchValue: String(aiSn),
    key: scriptKey,
    data: JSON.stringify(data || {}),
  });
  const res = await axios.post(scriptUrl, params, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: opts.timeout || 30000,
  });
  if (res.data && res.data.success) {
    console.log(`[${label}] SETTINGS.${aiSnHeader}=${aiSn} updated -> OK (row ${res.data.rowNumber}) keys=${Object.keys(data||{}).join(',')}`);
    return { ok: true, rowNumber: res.data.rowNumber, raw: res.data };
  }
  console.warn(`[${label}] SETTINGS.${aiSnHeader}=${aiSn} update failed: ${JSON.stringify(res.data)}`);
  return { ok: false, error: res.data?.error || "update_failed", raw: res.data };
}

/** Resolve + update in one go (convenience for managers). */
async function syncOpencodeRowForServer(data, opts = {}) {
  const target = await resolveOpencodeTargetForServer(opts);
  if (!target.ok) return target;
  return await setSettingsCellsByAiSn({ ...opts, aiSn: target.aiSn, aiSnHeader: target.aiSnHeader, data });
}

module.exports = {
  getServerlessId,
  isOpencodeProviderValue,
  pickServerlessIdFromNormalizedRow,
  pickServerlessIdFromRawRow,
  findMatchingOpencodeNormalizedRow,
  normalizeSettingsRows,
  resolveOpencodeTargetForServer,
  setSettingsCellsByAiSn,
  syncOpencodeRowForServer,
};
