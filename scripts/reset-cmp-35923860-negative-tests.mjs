// One-shot reset + negative test fixture for CMP-35923860 (App Script fallback).
//
// Clears ONLY run artifacts from the campaign row and CSV, clears placeholder
// business names, and appends 5 deliberately failing verification rows:
//   1 bad-MX domain, 2 nonexistent Gmail users, 2 nonexistent Outlook/Microsoft
// users. NO campaign setting, prompt, account, SMTP, schedule or user data
// column is modified.
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const CAMPAIGN_ID = 'CMP-35923860';
const FILE_ID = '1SytDn9kigdPCJhD2zLj0HdXp0FPGsRqs';
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;

function parseCSV(text) {
  const rows = [];
  let row = [''];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inQuotes) {
      if (c === '"' && n === '"') { row[row.length - 1] += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else row[row.length - 1] += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') row.push('');
      else if (c === '\n') { rows.push(row); row = ['']; }
      else if (c === '\r') { if (n === '\n') i++; rows.push(row); row = ['']; }
      else row[row.length - 1] += c;
    }
  }
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

function stringifyCSV(rows) {
  return rows.map(r => r.map(v => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
}

async function gas(action, extra = {}, timeout = 180000) {
  const params = new URLSearchParams({ action, key: SCRIPT_KEY, ...extra });
  const res = await axios.post(SCRIPT_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout, maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  return res.data;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const CSV_CLEAR = [
  'validation', 'providerMXResult', 'enrichmentStatus',
  'enhancedSubject', 'enhancedBody', 'enhancedSocialMessage',
  'personalizationStatus', 'executionStatus',
  'sendDate', 'sendTime', 'sendStamp', 'retryCount',
  'lastSendMethod', 'lastSendStatus', 'lastSendError', 'lastAttemptAt',
  'sentStatus', 'sendResult', 'sendError', 'deliveryStatus',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp',
  'link',
];
const PLACEHOLDER_BUSINESS = new Set(['personal', 'self', 'private', 'individual', 'unknown', 'n/a', 'na', 'none', '-']);

const NEGATIVE_ROWS = [
  { first: 'Bad', last: 'MX', email: 'mx.bad@invalid-domain-xyz.com' },
  { first: 'Missing', last: 'GmailOne', email: 'no.such.user.839201@gmail.com' },
  { first: 'Missing', last: 'GmailTwo', email: 'definitely.missing.472019@gmail.com' },
  { first: 'Missing', last: 'OutlookOne', email: 'not.real.person.571920@outlook.com' },
  { first: 'Missing', last: 'OutlookTwo', email: 'absent.account.648213@outlook.com' },
];

async function main() {
  if (!SCRIPT_URL || !SCRIPT_KEY) throw new Error('Missing SCRIPT_URL/SCRIPT_KEY');

  // ---- campaign row: runtime stats only ----
  const camp = await gas('getData', { sheetname: 'campaigns' });
  if (!camp?.success) throw new Error('getData campaigns failed');
  const h = camp.headers || [];
  const idx = name => h.indexOf(name);
  const row = (camp.data || []).find(r => String(r[idx('campaignId')] || '').trim() === CAMPAIGN_ID);
  if (!row) throw new Error('campaign not found');

  let settings = {};
  try { settings = JSON.parse(row[idx('settings')] || '{}') || {}; } catch {}
  const before = {
    status: row[idx('status')],
    validationStatus: settings.validationStatus,
    enrichmentStatus: settings.enrichmentStatus,
    personalizationStatus: settings.personalizationStatus,
    executionStatus: settings.executionStatus,
    interactionStatus: settings.interactionStatus,
    mailMerged: settings.mailMerged,
  };

  settings.validationStatus = null;
  settings.enrichmentStatus = null;
  settings.personalizationStatus = null;
  settings.executionStatus = null;
  settings.interactionStatus = null;
  settings.mailMerged = false;
  settings.lastProcessedRow = 0;
  settings.retryAttempts = 0;
  settings.serverAssignments = {};
  // Runtime-only keys. `settings.status` is an engine shadow copy of the row
  // status; the rest are per-run artifacts/counters. None are campaign settings,
  // prompts, accounts, SMTP, keywords or schedule data.
  for (const k of [
    'lastError', 'lastEngineError', 'runLease', 'restUntil', 'restReason', 'restSetAt', 'pauseReason',
    'status', 'statusAudit', 'analytics', '_scopedCompleted', '_fullAccounts',
    'tagStatus', 'postStatus', 'firstStartedAt', 'startedAt', 'finishedAt',
    'completedAt', 'pausedAt', 'runCount', 'lastStage', 'currentStage', 'lastProcessedAt',
  ]) {
    delete settings[k];
  }
  settings._settingsVersion = (Number(settings._settingsVersion) || 0) + 1;

  const upd = await gas('setMultipleCellDataByColumnSearch', {
    sheetName: 'campaigns',
    searchColumn: 'campaignId',
    searchValue: CAMPAIGN_ID,
    data: JSON.stringify({
      settings: JSON.stringify(settings),
      status: 'draft',
      updatedOn: new Date().toISOString(),
    }),
  });
  if (!upd?.success) throw new Error('campaign update failed: ' + JSON.stringify(upd));
  console.log('CAMPAIGN reset OK');
  console.log('  before:', JSON.stringify(before));
  console.log('  key count:', Object.keys(settings).length, ' version:', settings._settingsVersion);

  // ---- CSV ----
  const dl = await gas('getDriveFileText', { fileId: FILE_ID });
  if (!dl?.success || typeof dl.content !== 'string') throw new Error('csv download failed');
  const rows = parseCSV(dl.content);
  if (rows.length < 2) throw new Error('csv empty');
  const headers = rows[0].map(x => String(x || '').trim());
  const clearIdx = [];
  headers.forEach((name, i) => { if (CSV_CLEAR.some(w => norm(w) === norm(name))) clearIdx.push(i); });
  const idxOf = name => headers.findIndex(x => norm(x) === norm(name));
  const snIdx = idxOf('SN');
  const firstIdx = idxOf('FIRSTNAME');
  const lastIdx = idxOf('LASTNAME');
  const emailIdx = idxOf('EMAIL');
  const bizIdx = idxOf('BUSINESSNAME');
  const ctxIdx = idxOf('CONTEXT');
  const helperIdx = idxOf('HELPERKEYWORD');
  if ([snIdx, firstIdx, lastIdx, emailIdx].some(i => i < 0)) throw new Error('CSV missing required input columns');

  // Idempotent: drop any previously appended negative rows before re-adding
  // them, so this script can be run again without duplicating the fixture.
  const negativeEmails = new Set(NEGATIVE_ROWS.map(x => x.email.toLowerCase()));
  const beforeRows = rows.length;
  for (let r = rows.length - 1; r >= 1; r--) {
    if (negativeEmails.has(String(rows[r][emailIdx] || '').trim().toLowerCase())) rows.splice(r, 1);
  }
  if (rows.length !== beforeRows) console.log('  removed old negative rows:', beforeRows - rows.length);

  let clearedCells = 0;
  let clearedBusiness = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    while (cells.length < headers.length) cells.push('');
    for (const i of clearIdx) {
      if (String(cells[i] ?? '') !== '') { cells[i] = ''; clearedCells++; }
    }
    if (bizIdx >= 0 && PLACEHOLDER_BUSINESS.has(String(cells[bizIdx] || '').trim().toLowerCase())) {
      cells[bizIdx] = '';
      clearedBusiness++;
    }
  }

  const helper = helperIdx >= 0 ? String(rows[1][helperIdx] || '').trim() : '';
  let maxSn = 0;
  for (let r = 1; r < rows.length; r++) {
    const n = Number(String(rows[r][snIdx] || '').trim());
    if (Number.isFinite(n) && n > maxSn) maxSn = n;
  }
  for (const item of NEGATIVE_ROWS) {
    const cells = new Array(headers.length).fill('');
    cells[snIdx] = String(++maxSn);
    cells[firstIdx] = item.first;
    cells[lastIdx] = item.last;
    cells[emailIdx] = item.email;
    if (ctxIdx >= 0) cells[ctxIdx] = '';
    if (helperIdx >= 0) cells[helperIdx] = helper;
    rows.push(cells);
  }

  const ul = await gas('updateDriveFileText', {
    fileId: FILE_ID,
    content: stringifyCSV(rows),
    mimeType: 'text/csv',
  });
  if (!ul?.success) throw new Error('csv upload failed: ' + JSON.stringify(ul));
  console.log('CSV reset OK');
  console.log('  stat columns cleared:', clearIdx.map(i => headers[i]).join(', '));
  console.log('  stat cells cleared:', clearedCells, '| placeholder BUSINESSNAME cleared:', clearedBusiness);
  console.log('  rows:', rows.length - 1, '(+' + NEGATIVE_ROWS.length + ' negative test rows)');

  // ---- verify ----
  const camp2 = await gas('getData', { sheetname: 'campaigns' });
  const h2 = camp2.headers || [];
  const r2 = (camp2.data || []).find(r => String(r[h2.indexOf('campaignId')] || '').trim() === CAMPAIGN_ID);
  const s2 = JSON.parse(r2[h2.indexOf('settings')] || '{}') || {};
  console.log('VERIFY row status =', r2[h2.indexOf('status')]);
  console.log('VERIFY stage stats =', JSON.stringify({
    validationStatus: s2.validationStatus, enrichmentStatus: s2.enrichmentStatus,
    personalizationStatus: s2.personalizationStatus, executionStatus: s2.executionStatus,
    interactionStatus: s2.interactionStatus, mailMerged: s2.mailMerged,
    lastProcessedRow: s2.lastProcessedRow, retryAttempts: s2.retryAttempts,
  }));
  const preserved = ['campaignKeyword', 'helperKeyword', 'validationStaged', 'enrichmentStaged',
    'aiPersonalizationStaged', 'executeStaged', 'interactionStaged', 'accounts', 'smtpSettings',
    'deliveryMethod', 'firestickEnabled', 'enrichmentContext', 'aiPersonalizationPrompt',
    'channel', 'sendMode', 'timezone'];
  console.log('VERIFY settings preserved:', preserved.every(k => k in s2) ? 'ALL' : 'MISSING ' + preserved.filter(k => !(k in s2)).join(','));

  const csv2 = await gas('getDriveFileText', { fileId: FILE_ID });
  const vrows = parseCSV(csv2.content);
  const vh = vrows[0].map(x => String(x || '').trim());
  const vnorm = x => norm(x);
  const vi = new Map(vh.map((n, i) => [vnorm(n), i]));
  const filled = [];
  for (const want of CSV_CLEAR) {
    const i = vi.get(vnorm(want));
    if (i === undefined) continue;
    let n = 0;
    for (let r = 1; r < vrows.length; r++) if (String(vrows[r][i] || '').trim()) n++;
    filled.push(`${vh[i]}=${n}`);
  }
  console.log('VERIFY csv stat cells:', filled.join(' '));
  console.log('VERIFY negative rows:', NEGATIVE_ROWS.map(x => x.email).join(', '));
}

main().catch(e => {
  console.error('RESET_FAILED', e?.message || e);
  if (e?.response?.data) console.error('RESP', JSON.stringify(e.response.data));
  process.exit(1);
});
