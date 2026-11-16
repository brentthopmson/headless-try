import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const CAMPAIGN_ID = 'CMP-35923860';
const FILE_ID = '1SytDn9kigdPCJhD2zLj0HdXp0FPGsRqs';
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;

function parseCSV(text){
  const rows=[]; let row=['']; let inQuotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i], n=text[i+1];
    if(inQuotes){
      if(c==='"' && n==='"'){ row[row.length-1]+='"'; i++; }
      else if(c==='"'){ inQuotes=false; }
      else row[row.length-1]+=c;
    } else {
      if(c==='"') inQuotes=true;
      else if(c===',') row.push('');
      else if(c==='\n'){ rows.push(row); row=['']; }
      else if(c==='\r'){ if(n==='\n') i++; rows.push(row); row=['']; }
      else row[row.length-1]+=c;
    }
  }
  if(row.length>1 || row[0] !== '') rows.push(row);
  return rows;
}
function stringifyCSV(rows){
  return rows.map(r=>r.map(v=>{
    const s=String(v??'');
    return /[",\n\r]/.test(s)? '"'+s.replace(/"/g,'""')+'"' : s;
  }).join(',')).join('\n');
}

async function gas(action, extra = {}, timeout=120000){
  const params = new URLSearchParams({ action, key: SCRIPT_KEY, ...extra });
  const res = await axios.post(SCRIPT_URL, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout, maxBodyLength: Infinity, maxContentLength: Infinity });
  return res.data;
}

async function main(){
  if(!SCRIPT_URL || !SCRIPT_KEY) throw new Error('Missing SCRIPT_URL/SCRIPT_KEY');

  console.log('Fetching campaigns via App Script...');
  const camp = await gas('getData', { sheetname: 'campaigns' });
  if(!camp?.success) throw new Error('getData campaigns failed: ' + JSON.stringify(camp));
  const headers = camp.headers || [];
  const data = camp.data || [];
  const idIdx = headers.indexOf('campaignId');
  const settingsIdx = headers.indexOf('settings');
  const statusIdx = headers.indexOf('status');
  if(idIdx<0 || settingsIdx<0) throw new Error('campaignId/settings columns not found');
  const row = data.find(r => String(r[idIdx]||'').trim() === CAMPAIGN_ID);
  if(!row) throw new Error('Campaign not found: '+CAMPAIGN_ID);

  let settings = {};
  try { settings = JSON.parse(row[settingsIdx] || '{}') || {}; } catch { settings = {}; }
  const preserve = {
    campaignKeyword: settings.campaignKeyword,
    helperKeyword: settings.helperKeyword,
    enrichmentContext: settings.enrichmentContext,
    subject: settings.subject,
    body: settings.body,
    socialMessage: settings.socialMessage,
    prompt: settings.prompt,
    personalizationPrompt: settings.personalizationPrompt,
    accounts: settings.accounts,
    smtpSettings: settings.smtpSettings,
    smtpAccount: settings.smtpAccount,
    smtpHost: settings.smtpHost,
    smtpPort: settings.smtpPort,
    smtpUser: settings.smtpUser,
    smtpPass: settings.smtpPass,
    smtpFrom: settings.smtpFrom,
    smtpSender: settings.smtpSender,
    deliveryMethod: settings.deliveryMethod,
    firestickEnabled: settings.firestickEnabled,
    firestickList: settings.firestickList,
    firestickSettings: settings.firestickSettings,
    schedule: settings.schedule,
    scheduleStartTime: settings.scheduleStartTime,
    sendMode: settings.sendMode,
    sendDate: settings.sendDate,
    sendTime: settings.sendTime,
    timezone: settings.timezone,
    timeZone: settings.timeZone,
    staged: settings.staged,
    stageOrder: settings.stageOrder,
    pipelineStages: settings.pipelineStages,
    fileUrl: settings.fileUrl || settings.fileID || settings.fileId,
    fileId: settings.fileId || settings.fileID,
  };
  const clean = {};
  for(const [k,v] of Object.entries(preserve)){ if(v !== undefined) clean[k]=v; }
  clean.validationStatus = null;
  clean.enrichmentStatus = null;
  clean.personalizationStatus = null;
  clean.executionStatus = null;
  clean.interactionStatus = null;
  clean.mailMerged = false;
  clean.lastProcessedRow = 0;
  clean.retryAttempts = 0;
  clean.serverAssignments = {};
  clean._settingsVersion = (settings._settingsVersion || 0) + 1;

  const updateData = { settings: JSON.stringify(clean), updatedOn: new Date().toISOString() };
  if(statusIdx>=0) updateData.status = 'draft';
  console.log('Updating campaign row via App Script...');
  const upd = await gas('setMultipleCellDataByColumnSearch', {
    sheetName: 'campaigns',
    searchColumn: 'campaignId',
    searchValue: CAMPAIGN_ID,
    data: JSON.stringify(updateData)
  });
  if(!upd?.success) throw new Error('Campaign update failed: ' + JSON.stringify(upd));
  console.log('Campaign row/settings reset OK');

  console.log('Downloading CSV via App Script...', FILE_ID);
  const dl = await gas('getDriveFileText', { fileId: FILE_ID });
  if(!dl?.success || typeof dl.content !== 'string') throw new Error('CSV download failed: ' + JSON.stringify(dl));
  const csvRows = parseCSV(dl.content);
  if(csvRows.length===0) throw new Error('CSV empty');
  const h = csvRows[0].map(x=>String(x||'').trim());
  const norm = s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const clearNames = new Set(['validation','providermxresult','enrichmentstatus','enhancedsubject','enhancedbody','enhancedsocialmessage','personalizationstatus','executionstatus','senddate','sendtime','sendstamp','retrycount','lastsendmethod','lastsendstatus','lastsenderror','lastattemptat','interactcount','interactstatus','interactstamp','sentstatus','sendresult','senderror','deliverystatus']);
  const clearIdx = [];
  h.forEach((name,i)=>{ if(clearNames.has(norm(name))) clearIdx.push(i); });
  for(let i=1;i<csvRows.length;i++){
    const r = csvRows[i]; while(r.length<h.length) r.push('');
    for(const idx of clearIdx){ r[idx]=''; }
  }
  const out = stringifyCSV(csvRows);
  console.log('Uploading cleaned CSV via App Script...', 'rows=', csvRows.length-1, 'clearedCols=', clearIdx.map(i=>h[i]));
  const ul = await gas('updateDriveFileText', { fileId: FILE_ID, content: out, mimeType: 'text/csv' });
  if(!ul?.success) throw new Error('CSV upload failed: ' + JSON.stringify(ul));
  console.log('DONE full reset (campaign + CSV) completed via App Script fallback');
}

main().catch(e=>{ console.error('RESET_FAILED', e && e.message ? e.message : e); if(e?.response?.data) console.error('RESP', JSON.stringify(e.response.data)); process.exit(1); });
