import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;
const TARGET = 'CMP-74B3A51D';
const SOURCE_FILE_ID = '1m_9x7Vm8pdW684nDhxOwCOOMhu2g_Eov';

const gas = async (a, e = {}) => {
  const p = new URLSearchParams({ action: a, key: SCRIPT_KEY, ...e });
  const r = await axios.post(SCRIPT_URL, p, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 180000, maxBodyLength: Infinity });
  return r.data;
};
const Q = String.fromCharCode(34);
function parseCSV(t) {
  const rows = []; let row = ['']; let inQ = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i], n = t[i + 1];
    if (inQ) { if (c === Q && n === Q) { row[row.length - 1] += Q; i++; } else if (c === Q) inQ = false; else row[row.length - 1] += c; }
    else { if (c === Q) inQ = true; else if (c === ',') row.push(''); else if (c === '\n') { rows.push(row); row = ['']; } else if (c === '\r') { if (n === '\n') i++; rows.push(row); row = ['']; } else row[row.length - 1] += c; }
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
const nk = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const NEGATIVE = [
  { sn: 50, first: 'Bad MX', email: 'mx.bad@invalid-domain-xyz.com' },
  { sn: 51, first: 'Missing GmailOne', email: 'no.such.user.839201@gmail.com' },
  { sn: 52, first: 'Missing GmailTwo', email: 'definitely.missing.472019@gmail.com' },
  { sn: 53, first: 'Missing OutlookOne', email: 'not.real.person.571920@outlook.com' },
  { sn: 54, first: 'Missing OutlookTwo', email: 'absent.account.648213@outlook.com' },
];
const CLEAR = new Set(['validation','providermxresult','enhancedsubject','enhancedbody','enhancedsocialmessage','enrichmentstatus','personalizationstatus','executionstatus','senddate','sendtime','sendstamp','retrycount','lastsendmethod','lastsendstatus','lastsenderror','lastattemptat','sentstatus','sendresult','senderror','deliverystatus','searchkeys','searchcount','searchstatus','searchstamp','profiletointeract','interactcount','interactstatus','interactstamp','link','businessname','context','lastname']);
const PLACE = new Set(['personal','self','private','individual','unknown','n/a','na','none','-']);

// 1) Load source
const src = await gas('getDriveFileText', { fileId: SOURCE_FILE_ID });
if (!src.content) throw new Error('source download failed');
const srows = parseCSV(src.content);
const sh = srows[0].map(x => String(x || '').trim());
const six = new Map(sh.map((n, i) => [nk(n), i]));

// 2) Canonical header = SOURCE columns + engine columns (append). Use email campaign's target header as the canonical shape.
const emailCamp = await gas('getData', { sheetname: 'campaigns' });
const eh = emailCamp.headers || [];
const egi = n => eh.indexOf(n);
const emailRow = (emailCamp.data || []).find(x => String(x[egi('campaignId')] || '').trim() === 'CMP-35923860');
const emailSettings = JSON.parse(emailRow[egi('settings')] || '{}');
const emailFileId = String(emailSettings.fileUrl || '').match(/[-\w]{25,}/)?.[0];
const emailCsv = await gas('getDriveFileText', { fileId: emailFileId });
const canonicalHeader = parseCSV(emailCsv.content)[0];

// 3) Build clean rows from source mapped onto canonical header
const out = [canonicalHeader.slice()];
for (const s of srows.slice(1)) {
  const r = new Array(canonicalHeader.length).fill('');
  canonicalHeader.forEach((h, i) => {
    const key = nk(h);
    if (CLEAR.has(key)) { r[i] = ''; return; }
    const si = six.get(key);
    const v = si === undefined ? '' : String(s[si] ?? '').trim();
    r[i] = PLACE.has(v.toLowerCase()) ? '' : v;
  });
  out.push(r);
}
for (const item of NEGATIVE) {
  const r = new Array(canonicalHeader.length).fill('');
  const setV = (name, val) => { const i = canonicalHeader.findIndex(h => nk(h) === nk(name)); if (i !== -1) r[i] = val; };
  setV('SN', String(item.sn)); setV('FIRSTNAME', item.first); setV('EMAIL', item.email);
  out.push(r);
}

// 4) Create the dedicated Drive file
const created = await gas('createDriveCsv', { fileName: `${TARGET}_campaign.csv`, content: stringifyCSV(out) });
if (!created.success || !created.fileId) throw new Error('create failed: ' + JSON.stringify(created));
console.log('Created CSV fileId=', created.fileId, 'url=', created.url);

// 5) Update campaign: point fileUrl at new file, clear run state, draft
const c = await gas('getData', { sheetname: 'campaigns' });
const h = c.headers || [];
const gi = n => h.indexOf(n);
const row = (c.data || []).find(x => String(x[gi('campaignId')] || '').trim() === TARGET);
let s = {};
try { s = JSON.parse(row[gi('settings')] || '{}') || {}; } catch {}
s.fileUrl = created.url;
for (const k of ['validationStatus','enrichmentStatus','personalizationStatus','executionStatus','interactionStatus','lastEngineError','statusAudit','executionStatus','lastProcessedRow','retryAttempts','serverAssignments','restUntil','restReason','restSetAt','pauseReason']) delete s[k];
for (const k of ['validationStatus','enrichmentStatus','personalizationStatus','executionStatus','interactionStatus']) s[k] = null;
s.mailMerged = false; s.lastProcessedRow = 0; s.retryAttempts = 0; s.serverAssignments = {};
s._settingsVersion = (Number(s._settingsVersion) || 0) + 1;
const upd = await gas('setMultipleCellDataByColumnSearch', {
  sheetName: 'campaigns', searchColumn: 'campaignId', searchValue: TARGET,
  data: JSON.stringify({ settings: JSON.stringify(s), status: 'draft', updatedOn: new Date().toISOString() }),
});
if (!upd?.success) throw new Error('campaign update failed: ' + JSON.stringify(upd));
console.log('Updated', TARGET, '-> draft, fileUrl=', created.url, 'rows=', out.length - 1, 'cols=', out[0].length);
