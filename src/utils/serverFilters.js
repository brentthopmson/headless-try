/**
 * Pure server-row filters shared by getAvailableServers (multiServerDispatcher)
 * and GAS getBestServerlessEndpoint. No I/O, no logging — callers warn.
 *
 * Semantics (mirror GAS LINKS.js):
 * - All filters opt-in: falsy value = axis ignored entirely (byte-identical legacy).
 * - When requested, the row's cell must contain a matching comma-separated value.
 * - severlessCategory / severlessType: missing column while requested = filter
 *   skipped (row passes), caller should warn.
 * - severlessPlatform: missing column while requested = no row qualifies
 *   (strict, matches GAS platform branch which skips all rows).
 * - Empty cell while filter requested = row skipped (no match).
 */

function splitRoutingValues(value) {
  return String(value == null ? '' : value)
    .toUpperCase()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function resolveHeader(headers, name) {
  const exact = headers.indexOf(name);
  if (exact !== -1) return exact;
  return headers.indexOf(name.toLowerCase());
}

function cellMatches(row, headers, columnName, requestedValue, strictMissingColumn) {
  if (!requestedValue) return true;
  const idx = resolveHeader(headers, columnName);
  if (idx === -1) return !strictMissingColumn;
  const rowValues = splitRoutingValues(row[idx]);
  const requested = splitRoutingValues(requestedValue);
  if (requested.length === 0) return true;
  return requested.some(v => rowValues.includes(v));
}

/**
 * @param {any[]} row - sheet row array
 * @param {string[]} headers - sheet header array
 * @param {{ category?: string, serverType?: string, platform?: string }} filters
 *   serverType → severlessType column (EMAIL / SOCIAL / BANK)
 *   platform → severlessPlatform column (GMAIL / TIKTOK / CHASE …)
 * @returns {boolean} true = row passes all requested filters
 */
function matchesServerFilters(row, headers, filters = {}) {
  const { category, serverType, platform } = filters || {};
  if (!Array.isArray(row) || !Array.isArray(headers)) return false;
  if (!category && !serverType && !platform) return true;
  if (!cellMatches(row, headers, 'severlessCategory', category, false)) return false;
  if (!cellMatches(row, headers, 'severlessType', serverType, false)) return false;
  if (!cellMatches(row, headers, 'severlessPlatform', platform, true)) return false;
  return true;
}


module.exports = { splitRoutingValues, matchesServerFilters };

