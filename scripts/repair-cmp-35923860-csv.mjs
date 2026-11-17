// One-time repair for CMP-35923860's CSV after the parser/mail-merge fixes.
//
// Preserves ALL existing evidence (validation, MX, enrichment, personalization)
// and the 5 negative test rows. It only:
//   - backs up the current CSV locally,
//   - appends (if missing) and populates the standard fallback columns
//     emailSubject / emailBody / socialMessage / LINK / HELPERKEYWORD / STATUS,
//   - normalizes sendDate (YYYY-MM-DD) and sendTime (HH:MM:SS),
//   - clears the false sendStamp on rows that were never actually sent,
//   - clears the stale lastEngineError from campaign settings.
//
// It does NOT rebuild from source, remove rows, or drop any columns.
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const CAMPAIGN_ID = 'CMP-35923860';
const TARGET_FILE_ID = '1SytDn9kigdPCJhD2zLj0HdXp0FPGsRqs';
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;
const BACKUP_DIR = path.resolve(process.cwd(), 'scripts', 'backups');

function parseCSV(text) {
  const rows = []; let row = ['']; let inQuotes = false;
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

const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const normHeader = h => String(h || '').trim().toUpperCase();

function ensure(headers, rows, name) {
  const key = nk(name);
  let i = headers.findIndex(h => nk(h) === key);
  if (i === -1) {
    headers.push(name);
    i = headers.length - 1;
    for (let r = 1; r < rows.length; r++) rows[r][i] = '';
  }
  return i;
}
function cell(row, headers, name) {
  const key = nk(name);
  const i = headers.findIndex(h => nk(h) === key);
  return i >= 0 ? String(row[i] || '').trim() : '';
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}
function normalizeTime(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2], sec = m[3] || '00';
    const ap = (m[4] || '').toUpperCase();
    if (ap === 'PM' && h < 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${min}:${sec}`;
  }
  return s;
}

function mergeTemplate(template, row, headers) {
  if (!template) return '';
  const getVal = (col) => {
    const i = headers.findIndex(h => normHeader(h) === normHeader(col));
    return i !== -1 ? (String(row[i] ?? '').trim() || '') : '';
  };
  return template
    .replace(/\{\{firstName\}\}|\{\{first_name\}\}/gi, getVal('FIRSTNAME'))
    .replace(/\{\{lastName\}\}|\{\{last_name\}\}/gi, getVal('LASTNAME'))
    .replace(/\{\{email\}\}/gi, getVal('EMAIL'))
    .replace(/\{\{jobTitle\}\}|\{\{job_title\}\}|\{\{title\}\}/gi, getVal('JOBTITLE'))
    .replace(/\{\{company\}\}|\{\{businessName\}\}/gi, getVal('BUSINESSNAME'))
    .replace(/\{\{link\}\}|\{\{url\}\}/gi, getVal('LINK') || getVal('URL'))
    .replace(/\{\{helperKeyword\}\}|\{\{helper_keyword\}\}/gi, getVal('HELPERKEYWORD'))
    .replace(/\{\{context\}\}/gi, getVal('CONTEXT'));
}

function buildLink(base, param, val) {
  const b = String(base || '').trim();
  if (!b || !val) return b;
  const key = String(param || 'email').trim().toLowerCase().replace(/[^a-z0-9_]/gi, '') || 'email';
  return `${b}${b.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(String(val).trim())}`;
}

function deriveStatus(row, headers) {
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

async function main() {
  const dl = await gas('getDriveFileText', { fileId: TARGET_FILE_ID });
  if (!dl.content) throw new Error('CSV download failed');
  const rows = parseCSV(dl.content);
  if (rows.length < 2) throw new Error('CSV empty');

  // Backup locally before any write.
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(BACKUP_DIR, `${CAMPAIGN_ID}-${stamp}.csv`);
  fs.writeFileSync(backup, dl.content, 'utf8');
  console.log('Backup written:', backup);

  // Campaign settings (templates + routing) — used only to fill fallbacks.
  const camp = await gas('getData', { sheetname: 'campaigns' });
  const ch = camp.headers || [];
  const crow = (camp.data || []).find(x => String(x[ch.indexOf('campaignId')] || '').trim() === CAMPAIGN_ID);
  if (!crow) throw new Error('campaign row not found');
  let settings = {};
  try { settings = JSON.parse(crow[ch.indexOf('settings')] || '{}') || {}; } catch {}
  const subjectTemplate = String(settings.subject || '');
  const bodyTemplate = String(settings.body || '');
  const socialTemplate = String(settings.socialMessage || bodyTemplate || '');
  const channel = settings.channel || 'email';
  const helper = String(settings.helperKeyword || '').trim();
  const tz = String(settings.timezone || 'UTC');
  const linkParam = String(settings.linkParam || 'email').trim() || 'email';
  const targetLink = String(settings.targetLink || '').trim();

  const headers = rows[0];
  const subjIdx = channel === 'email' ? ensure(headers, rows, 'emailSubject') : -1;
  const bodyIdx = channel === 'email' ? ensure(headers, rows, 'emailBody') : -1;
  const socialIdx = channel === 'social' ? ensure(headers, rows, 'socialMessage') : -1;
  const linkIdx = targetLink ? ensure(headers, rows, 'LINK') : -1;
  const helperIdx = ensure(headers, rows, 'HELPERKEYWORD');
  const statusIdx = ensure(headers, rows, 'STATUS');
  const dateIdx = headers.findIndex(h => nk(h) === 'senddate');
  const timeIdx = headers.findIndex(h => nk(h) === 'sendtime');
  const stampIdx = headers.findIndex(h => nk(h) === 'sendstamp');
  const execIdx = headers.findIndex(h => nk(h) === 'executionstatus');
  const lastSendIdx = headers.findIndex(h => nk(h) === 'lastsendstatus');

  let filledSubject = 0, filledBody = 0, filledSocial = 0, filledLink = 0, filledHelper = 0;
  let normalizedDates = 0, normalizedTimes = 0, clearedStamps = 0;
  const statusCounts = {};

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    // Standard fallbacks — fill only when empty, never overwrite evidence.
    if (subjIdx !== -1 && !String(row[subjIdx] || '').trim() && subjectTemplate) {
      row[subjIdx] = mergeTemplate(subjectTemplate, row, headers); filledSubject++;
    }
    if (bodyIdx !== -1 && !String(row[bodyIdx] || '').trim() && bodyTemplate) {
      row[bodyIdx] = mergeTemplate(bodyTemplate, row, headers); filledBody++;
    }
    if (socialIdx !== -1 && !String(row[socialIdx] || '').trim() && socialTemplate) {
      row[socialIdx] = mergeTemplate(socialTemplate, row, headers); filledSocial++;
    }
    if (linkIdx !== -1 && !String(row[linkIdx] || '').trim()) {
      const email = cell(row, headers, 'EMAIL');
      row[linkIdx] = buildLink(targetLink, linkParam, email); filledLink++;
    }
    if (!String(row[helperIdx] || '').trim() && helper) {
      row[helperIdx] = helper; filledHelper++;
    }

    // Date/time normalization.
    if (dateIdx !== -1 && String(row[dateIdx] || '').trim()) {
      const before = String(row[dateIdx]); const after = normalizeDate(before);
      if (before !== after) normalizedDates++;
      row[dateIdx] = after;
    }
    if (timeIdx !== -1 && String(row[timeIdx] || '').trim()) {
      const before = String(row[timeIdx]); const after = normalizeTime(before);
      if (before !== after) normalizedTimes++;
      row[timeIdx] = after;
    }

    // False send artifacts: sendStamp belongs only to actually-sent rows.
    const exec = (execIdx !== -1 ? String(row[execIdx] || '').trim().toLowerCase() : '');
    const lastSend = (lastSendIdx !== -1 ? String(row[lastSendIdx] || '').trim().toLowerCase() : '');
    const wasSent = exec === 'sent' || lastSend === 'sent';
    if (!wasSent && stampIdx !== -1 && String(row[stampIdx] || '').trim()) {
      row[stampIdx] = ''; clearedStamps++;
    }

    const st = deriveStatus(row, headers);
    row[statusIdx] = st;
    statusCounts[st] = (statusCounts[st] || 0) + 1;
  }

  const ul = await gas('updateDriveFileText', {
    fileId: TARGET_FILE_ID, content: stringifyCSV(rows), mimeType: 'text/csv',
  });
  if (!ul?.success) throw new Error('CSV upload failed');

  // Clear the stale relay error without changing the campaign status.
  let clearMsg = 'settings unchanged';
  try {
    if (settings.lastEngineError) {
      delete settings.lastEngineError;
      settings._settingsVersion = (Number(settings._settingsVersion) || 0) + 1;
      const upd = await gas('setMultipleCellDataByColumnSearch', {
        sheetName: 'campaigns', searchColumn: 'campaignId', searchValue: CAMPAIGN_ID,
        data: JSON.stringify({ settings: JSON.stringify(settings) }),
      });
      clearMsg = upd?.success ? 'lastEngineError cleared' : 'lastEngineError clear failed';
    }
  } catch (e) { clearMsg = 'lastEngineError clear failed: ' + e.message; }

  console.log('Rows:', rows.length - 1, 'cols:', headers.length);
  console.log('Filled subject/body/social/link/helper:', filledSubject, filledBody, filledSocial, filledLink, filledHelper);
  console.log('Normalized dates/times:', normalizedDates, normalizedTimes, '| cleared false sendStamps:', clearedStamps);
  console.log('STATUS distribution:', JSON.stringify(statusCounts));
  const ei = headers.findIndex(h => nk(h) === 'email');
  console.log('Negative rows preserved:', rows.slice(-5).map(r => r[ei]).join(', '));
  console.log('Campaign:', clearMsg);
}

main().catch(e => { console.error('FAIL', e.message); process.exit(1); });
