// Shared, CSV-facing field helpers used by mail-merge and the stage routes.
//
//  1) One canonical date/time format for sendDate / sendTime (sendStamp stays a
//     full ISO timestamp). This removes the old `11/17/2026` vs `2026-11-17`
//     split caused by toLocaleDateString() being mixed with Intl en-CA.
//  2) A single per-row STATUS column that summarizes overall row state from
//     the stage columns, so the UI can read one field instead of inferring.

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cell(row, headers, name) {
  const key = norm(name);
  const i = headers.findIndex((h) => norm(h) === key);
  return i >= 0 ? String(row[i] || '').trim() : '';
}

/** YYYY-MM-DD in the given IANA timezone (never locale-dependent). */
export function formatCampaignDate(dateLike, timezone = 'UTC') {
  try {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return '';
  }
}

/** HH:MM:SS (24h) in the given IANA timezone. */
export function formatCampaignTime(dateLike, timezone = 'UTC') {
  try {
    const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone || 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23', hour12: false,
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
    return `${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    return '';
  }
}

/**
 * Summarize a row's overall state into one value.
 * Precedence (highest first): failed/terminal-send errors > sent > scheduled >
 * validation failures > personalized > enriched > validated > raw validation
 * state > awaiting.
 */
export function deriveRowStatus(row, headers) {
  const exec = cell(row, headers, 'executionStatus').toLowerCase();
  const lastSend = cell(row, headers, 'lastSendStatus').toLowerCase();
  const val = cell(row, headers, 'validation').toLowerCase();
  const pers = cell(row, headers, 'personalizationStatus').toLowerCase();
  const enrich = cell(row, headers, 'enrichmentStatus').toLowerCase();

  if (/(fail|error|retryable)/.test(exec) || /(fail|error)/.test(lastSend)) return 'failed';
  if (exec === 'sent' || lastSend === 'sent') return 'sent';
  if (exec === 'scheduled' || lastSend === 'scheduled') return 'scheduled';
  if (val === 'not_exists') return 'not_exists';
  if (val.includes('invalid') && val.includes('domain')) return 'invalid_domain';
  if (/^(verified_exists|valid|exists|verified)/.test(val)) {
    if (pers === 'completed') return 'personalized';
    if (enrich === 'completed') return 'enriched';
    return 'validated';
  }
  if (pers === 'completed') return 'personalized';
  if (enrich === 'completed') return 'enriched';
  if (val && val !== 'idle' && val !== 'pending') return val;
  return 'awaiting';
}

/** Ensure a STATUS column exists and fill it for every data row. */
export function applyRowStatuses(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const headers = rows[0];
  let idx = headers.findIndex((h) => norm(h) === 'status');
  if (idx === -1) {
    headers.push('STATUS');
    idx = headers.length - 1;
  }
  for (let i = 1; i < rows.length; i++) {
    rows[i][idx] = deriveRowStatus(rows[i], headers);
  }
}
