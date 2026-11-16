import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const CAMPAIGN_ID = 'CMP-35923860';
const FILE_ID = '1SytDn9kigdPCJhD2zLj0HdXp0FPGsRqs';
const SPREADSHEET_ID = process.env.DB_ID || process.env.SPREADSHEET_ID;

function colLetter(i){let s='';let n=i+1;while(n>0){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;}
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

async function main(){
  if(!SPREADSHEET_ID) throw new Error('Missing DB_ID/SPREADSHEET_ID');
  const oauthRaw = process.env.GOOGLE_OAUTH2_JSON;
  const refresh = process.env.GOOGLE_REFRESH_TOKEN || process.env.REFRESH_TOKEN;
  if(!oauthRaw || !refresh) throw new Error('Missing GOOGLE_OAUTH2_JSON or refresh token env');
  const creds = JSON.parse(oauthRaw);
  const {client_id, client_secret, redirect_uris} = creds.web || creds.installed || creds;
  const auth = new google.auth.OAuth2(client_id, client_secret, (redirect_uris||[])[0]);
  auth.setCredentials({ refresh_token: refresh });
  const sheets = google.sheets({version:'v4', auth});
  const drive = google.drive({version:'v3', auth});

  console.log('Reading campaigns sheet...');
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'campaigns' });
  const values = res.data.values || [];
  const headers = values[0] || [];
  const idIdx = headers.indexOf('campaignId');
  const settingsIdx = headers.indexOf('settings');
  const statusIdx = headers.indexOf('status');
  if(idIdx<0 || settingsIdx<0) throw new Error('campaignId/settings columns not found');
  let rowNum = -1; let row = null;
  for(let i=1;i<values.length;i++){
    if(String(values[i][idIdx]||'').trim()===CAMPAIGN_ID){ rowNum=i+1; row = values[i].slice(); while(row.length<headers.length) row.push(''); break; }
  }
  if(!rowNum) throw new Error('Campaign not found: '+CAMPAIGN_ID);

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
  // Build clean settings: keep preserved defined values, drop stage/progress/checkpoint/error state
  const clean = {};
  for(const [k,v] of Object.entries(preserve)){ if(v !== undefined) clean[k]=v; }
  // Explicit resets/neutral state
  clean.validationStatus = null;
  clean.enrichmentStatus = null;
  clean.personalizationStatus = null;
  clean.executionStatus = null;
  clean.interactionStatus = null;
  clean.mailMerged = false;
  clean.lastProcessedRow = 0;
  clean.retryAttempts = 0;
  delete clean.lastError;
  clean.serverAssignments = {};
  clean._settingsVersion = (settings._settingsVersion || 0) + 1;

  row[settingsIdx] = JSON.stringify(clean);
  if(statusIdx>=0) row[statusIdx] = 'draft';

  const range = `campaigns!A${rowNum}:${colLetter(headers.length-1)}${rowNum}`;
  await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range, valueInputOption:'RAW', requestBody:{ values:[row] } });
  console.log('Campaign row/settings reset:', CAMPAIGN_ID, 'row', rowNum);

  console.log('Downloading CSV file', FILE_ID);
  const file = await drive.files.get({ fileId: FILE_ID, alt:'media' }, { responseType:'text' });
  const csvText = typeof file.data === 'string' ? file.data : String(file.data||'');
  const csvRows = parseCSV(csvText);
  if(csvRows.length===0) throw new Error('CSV empty');
  const h = csvRows[0].map(x=>String(x||'').trim());
  const norm = s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const clearNames = new Set(['validation','providermxresult','enrichmentstatus','enhancedsubject','enhancedbody','enhancedsocialmessage','personalizationstatus','executionstatus','senddate','sendtime','sendstamp','retrycount','lastsendmethod','lastsendstatus','lastsenderror','lastattemptat','interactcount','interactstatus','interactstamp','sentstatus','sendresult','senderror','deliverystatus']);
  const clearIdx = [];
  h.forEach((name,i)=>{ if(clearNames.has(norm(name))) clearIdx.push(i); });
  let clearedCells=0;
  for(let i=1;i<csvRows.length;i++){
    const r = csvRows[i]; while(r.length<h.length) r.push('');
    for(const idx of clearIdx){ if(r[idx]!=='' && r[idx]!==undefined && r[idx]!==null){ r[idx]=''; clearedCells++; } else { r[idx]=''; } }
  }
  const out = stringifyCSV(csvRows);
  await drive.files.update({ fileId: FILE_ID, media:{ mimeType:'text/csv', body: out } });
  console.log('CSV reset complete. rows=', csvRows.length-1, 'clearedCols=', clearIdx.length, 'colNames=', clearIdx.map(i=>h[i]));
  console.log('DONE full reset prepared for re-run');
}

main().catch(e=>{ console.error('RESET_FAILED', e && e.message ? e.message : e); process.exit(1); });
