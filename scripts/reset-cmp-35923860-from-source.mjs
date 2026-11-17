// Rebuild CMP-35923860 CSV from the ORIGINAL user-provided source file, keeping
// only genuine input data, then append the 5 negative test rows.
//
// Source of truth: 1m_9x7Vm8pdW684nDhxOwCOOMhu2g_Eov (49 rows, 93 columns).
// Target campaign CSV keeps its 94-column header (extra HELPERKEYWORD column).
//
// Cleared: all engine/stat columns, placeholder BUSINESSNAME ("Personal"),
// generated CONTEXT ("Personal contact: ...") and any prior test artifacts
// (enhancedSubject/enhancedBody). FIRSTNAME stays exactly as supplied in the
// source (full name in one column), LASTNAME stays empty, EMAIL stays.
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const CAMPAIGN_ID = 'CMP-35923860';
const SOURCE_FILE_ID = '1m_9x7Vm8pdW684nDhxOwCOOMhu2g_Eov';
const TARGET_FILE_ID = '1SytDn9kigdPCJhD2zLj0HdXp0FPGsRqs';
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;

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

// Columns that must always be empty in a fresh input file.
const CLEAR_NAMES = new Set([
  'validation', 'providermxresult', 'enhancedsubject', 'enhancedbody', 'enhancedsocialmessage',
  'enrichmentstatus', 'personalizationstatus', 'executionstatus',
  'senddate', 'sendtime', 'sendstamp', 'retrycount', 'lastsendmethod', 'lastsendstatus',
  'lastsenderror', 'lastattemptat', 'sentstatus', 'sendresult', 'senderror', 'deliverystatus',
  'searchkeys', 'searchcount', 'searchstatus', 'searchstamp',
  'profiletointeract', 'interactcount', 'interactstatus', 'interactstamp', 'link',
  'retrycount', 'lastsendmethod', 'lastsendstatus', 'lastsenderror', 'lastattemptat',
  'sentstatus', 'sendresult', 'senderror', 'deliverystatus',
  // Genuine input columns that were polluted in the source/prior runs:
  'businessname', 'context', 'lastname',
]);
const PLACEHOLDERS = new Set(['personal', 'self', 'private', 'individual', 'unknown', 'n/a', 'na', 'none', '-']);

const NEGATIVE_ROWS = [
  { sn: 50, first: 'Bad MX', email: 'mx.bad@invalid-domain-xyz.com' },
  { sn: 51, first: 'Missing GmailOne', email: 'no.such.user.839201@gmail.com' },
  { sn: 52, first: 'Missing GmailTwo', email: 'definitely.missing.472019@gmail.com' },
  { sn: 53, first: 'Missing OutlookOne', email: 'not.real.person.571920@outlook.com' },
  { sn: 54, first: 'Missing OutlookTwo', email: 'absent.account.648213@outlook.com' },
];

async function main() {
  if (!SCRIPT_URL || !SCRIPT_KEY) throw new Error('Missing SCRIPT_URL/SCRIPT_KEY');

  const srcDl = await gas('getDriveFileText', { fileId: SOURCE_FILE_ID });
  if (!srcDl?.success || typeof srcDl.content !== 'string') throw new Error('source download failed');
  const srcRows = parseCSV(srcDl.content);
  if (srcRows.length < 2) throw new Error('source empty');
  const srcHeader = srcRows[0].map(x => String(x || '').trim());
  const srcIx = new Map(srcHeader.map((n, i) => [nk(n), i]));

  const tgtDl = await gas('getDriveFileText', { fileId: TARGET_FILE_ID });
  if (!tgtDl?.success || typeof tgtDl.content !== 'string') throw new Error('target download failed');
  const tgtRows = parseCSV(tgtDl.content);
  const targetHeader = tgtRows[0].map(x => String(x || '').trim());

  // Helper keyword comes from campaign settings (the CSV may already be dirty).
  const campEarly = await gas('getData', { sheetname: 'campaigns' });
  const chEarly = campEarly.headers || [];
  const cRowEarly = (campEarly.data || []).find(x => String(x[chEarly.indexOf('campaignId')] || '').trim() === CAMPAIGN_ID);
  let earlySettings = {};
  try { earlySettings = cRowEarly ? JSON.parse(cRowEarly[chEarly.indexOf('settings')] || '{}') || {} : {}; } catch {}
  const helper = String(earlySettings.helperKeyword || earlySettings.campaignKeyword || '').trim();

  const out = [targetHeader.slice()];
  const getSrc = (row, name) => {
    const i = srcIx.get(nk(name));
    return i === undefined ? '' : String(row[i] ?? '').trim();
  };
  for (const s of srcRows.slice(1)) {
    const r = new Array(targetHeader.length).fill('');
    targetHeader.forEach((h, i) => {
      const key = nk(h);
      if (CLEAR_NAMES.has(key)) { r[i] = ''; return; }
      const v = getSrc(s, h);
      // Never carry placeholders even if a column survived the clear list.
      r[i] = PLACEHOLDERS.has(v.toLowerCase()) ? '' : v;
    });
    const hIdx = targetHeader.findIndex(h => nk(h) === 'helperkeyword');
    if (hIdx >= 0) r[hIdx] = helper;
    out.push(r);
  }

  for (const item of NEGATIVE_ROWS) {
    const r = new Array(targetHeader.length).fill('');
    targetHeader.forEach((h, i) => {
      const key = nk(h);
      if (key === 'sn') r[i] = String(item.sn);
      else if (key === 'firstname') r[i] = item.first;
      else if (key === 'email') r[i] = item.email;
      else if (key === 'helperkeyword') r[i] = helper;
      // everything else stays blank (incl. CONTEXT, BUSINESSNAME, LASTNAME)
    });
    out.push(r);
  }

  // Campaign row: reset runtime stats only; preserve all settings.
  const camp = await gas('getData', { sheetname: 'campaigns' });
  const h = camp.headers || [];
  const row = (camp.data || []).find(x => String(x[h.indexOf('campaignId')] || '').trim() === CAMPAIGN_ID);
  if (!row) throw new Error('campaign not found');
  let settings = {};
  try { settings = JSON.parse(row[h.indexOf('settings')] || '{}') || {}; } catch {}
  for (const k of [
    'validationStatus', 'enrichmentStatus', 'personalizationStatus', 'executionStatus', 'interactionStatus',
    'mailMerged', 'lastProcessedRow', 'retryAttempts', 'serverAssignments',
    'lastError', 'lastEngineError', 'runLease', 'restUntil', 'restReason', 'restSetAt', 'pauseReason',
    'status', 'statusAudit', 'analytics', '_scopedCompleted', '_fullAccounts',
    '_lockVersion', '_lockedAt', '_lockedBy', 'replyFilterInstalled', 'replyFilterKeyword',
    'tagStatus', 'postStatus', 'firstStartedAt', 'startedAt', 'finishedAt',
    'completedAt', 'pausedAt', 'runCount', 'lastStage', 'currentStage', 'lastProcessedAt',
  ]) delete settings[k];
  // Stage-status keys are part of the original 60-key settings shape; keep them
  // present (null) so downstream readers see a clean, not a missing, state.
  for (const k of ['validationStatus', 'enrichmentStatus', 'personalizationStatus',
    'executionStatus', 'interactionStatus']) settings[k] = null;
  settings.mailMerged = false;
  settings.lastProcessedRow = 0;
  settings.retryAttempts = 0;
  settings.serverAssignments = {};
  settings._settingsVersion = (Number(settings._settingsVersion) || 0) + 1;

  const upd = await gas('setMultipleCellDataByColumnSearch', {
    sheetName: 'campaigns', searchColumn: 'campaignId', searchValue: CAMPAIGN_ID,
    data: JSON.stringify({
      settings: JSON.stringify(settings),
      status: 'draft',
      updatedOn: new Date().toISOString(),
    }),
  });
  if (!upd?.success) throw new Error('campaign update failed');

  const ul = await gas('updateDriveFileText', {
    fileId: TARGET_FILE_ID, content: stringifyCSV(out), mimeType: 'text/csv',
  });
  if (!ul?.success) throw new Error('csv upload failed');

  // Verify
  const v = await gas('getDriveFileText', { fileId: TARGET_FILE_ID });
  const vrows = parseCSV(v.content);
  const vh = vrows[0].map(x => nk(x));
  const col = name => vh.indexOf(nk(name));
  const filled = name => {
    const i = col(name); if (i < 0) return 'n/a';
    let n = 0; for (let r = 1; r < vrows.length; r++) if (String(vrows[r][i] || '').trim()) n++;
    return n + '/' + (vrows.length - 1);
  };
  console.log('CAMPAIGN row reset to draft; settings keys:', Object.keys(settings).length);
  console.log('CSV rows:', vrows.length - 1, 'cols:', vrows[0].length);
  for (const c of ['FIRSTNAME', 'LASTNAME', 'EMAIL', 'BUSINESSNAME', 'CONTEXT', 'URL', 'VALIDATION',
    'PROVIDERMXRESULT', 'ENHANCEDSUBJECT', 'ENHANCEDBODY', 'ENRICHMENTSTATUS', 'PERSONALIZATIONSTATUS',
    'EXECUTIONSTATUS', 'HELPERKEYWORD']) {
    console.log(' ', c, filled(c));
  }
  const ei = col('EMAIL');
  console.log('negative rows:', vrows.slice(-5).map(r => r[ei]).join(', '));
}

main().catch(e => {
  console.error('RESET_FAILED', e?.message || e);
  if (e?.response?.data) console.error('RESP', JSON.stringify(e.response.data));
  process.exit(1);
});
