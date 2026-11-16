import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const CAMPAIGN_ID='CMP-35923860'; const FILE_ID='1SytDn9kigdPCJhD2zLj0HdXp0FPGsRqs';
const SCRIPT_URL=process.env.SCRIPT_URL, SCRIPT_KEY=process.env.SCRIPT_KEY;
function parseCSV(text){const rows=[];let row=[''];let inQuotes=false;for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];if(inQuotes){if(c==='"'&&n==='"'){row[row.length-1]+='"';i++;}else if(c==='"'){inQuotes=false;}else row[row.length-1]+=c;}else{if(c==='"')inQuotes=true;else if(c===',')row.push('');else if(c==='\n'){rows.push(row);row=[''];}else if(c==='\r'){if(n==='\n')i++;rows.push(row);row=[''];}else row[row.length-1]+=c;}} if(row.length>1||row[0]!=='')rows.push(row); return rows;}
async function gas(action, extra={}, timeout=120000){const params=new URLSearchParams({action,key:SCRIPT_KEY,...extra});const res=await axios.post(SCRIPT_URL,params,{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout,maxBodyLength:Infinity,maxContentLength:Infinity});return res.data;}
(async()=>{
  const camp=await gas('getData',{sheetname:'campaigns'});
  const h=camp.headers||[], d=camp.data||[]; const id=h.indexOf('campaignId');
  const row=d.find(r=>String(r[id]||'').trim()===CAMPAIGN_ID);
  const obj={}; h.forEach((k,i)=>obj[k]=row?row[i]:'');
  console.log('ROW',{campaignId:obj.campaignId,status:obj.status,updatedOn:obj.updatedOn,settings:(obj.settings||'').slice(0,1200)});
  let s={}; try{s=JSON.parse(obj.settings||'{}')}catch{}
  console.log('SETTINGS_KEYS',Object.keys(s).sort());
  console.log('STAGE_STATUSES',{validationStatus:s.validationStatus,enrichmentStatus:s.enrichmentStatus,personalizationStatus:s.personalizationStatus,executionStatus:s.executionStatus,interactionStatus:s.interactionStatus,mailMerged:s.mailMerged,lastProcessedRow:s.lastProcessedRow,retryAttempts:s.retryAttempts,lastError:s.lastError,serverAssignments:s.serverAssignments});
  const dl=await gas('getDriveFileText',{fileId:FILE_ID});
  const rows=parseCSV(dl.content); const ch=rows[0].map(x=>String(x||'').trim());
  const norm=s=>String(s||'').toLowerCase().replace(/[^a-z0-9]/g,'');
  const interesting=new Set(['validation','providermxresult','enrichmentstatus','enhancedsubject','enhancedbody','enhancedsocialmessage','personalizationstatus','executionstatus','senddate','sendtime','sendstamp','retrycount','lastsendmethod','lastsendstatus','lastsenderror','lastattemptat','interactcount','interactstatus','interactstamp','sentstatus','sendresult','senderror','deliverystatus','provider','smtphost','sender']);
  const idxs=ch.map((n,i)=>[n,i]).filter(([n])=>interesting.has(norm(n)));
  console.log('CSV_HEADERS_COUNT',ch.length,'rows',rows.length-1);
  console.log('CHECK_COLS',idxs);
  for(const [name,i] of idxs){
    const vals=rows.slice(1).map(r=>String((r[i]||'')).trim()).filter(v=>v!=='');
    console.log('COL',name,'nonEmpty',vals.length,'sample',vals.slice(0,5));
  }
  for(const ri of [1,2,10,11,49].filter(x=>x<rows.length)){
    const o={}; ch.forEach((k,i)=>{const v=String((rows[ri][i]||'')).trim(); if(v!=='') o[k]=v;});
    console.log('ROW_SAMPLE',ri,JSON.stringify(o).slice(0,700));
  }
})().catch(e=>{console.error('ERR',e.message, e.response?.data||''); process.exit(1);});
