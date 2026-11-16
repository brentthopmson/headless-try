import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const CAMPAIGN_ID='CMP-35923860';
const SCRIPT_URL=process.env.SCRIPT_URL, SCRIPT_KEY=process.env.SCRIPT_KEY;
async function gas(action, extra={}, timeout=120000){const params=new URLSearchParams({action,key:SCRIPT_KEY,...extra});const res=await axios.post(SCRIPT_URL,params,{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout,maxBodyLength:Infinity,maxContentLength:Infinity});return res.data;}
(async()=>{
  const camp=await gas('getData',{sheetname:'campaigns'});
  if(!camp?.success) throw new Error('getData failed: '+JSON.stringify(camp));
  const h=camp.headers||[], d=camp.data||[]; const idIdx=h.indexOf('campaignId'); const settingsIdx=h.indexOf('settings');
  const row=d.find(r=>String(r[idIdx]||'').trim()===CAMPAIGN_ID);
  if(!row) throw new Error('Campaign not found');
  let settings={}; try{settings=JSON.parse(row[settingsIdx]||'{}')||{};}catch{settings={};}
  const canonical = String(settings.campaignKeyword || settings.helperKeyword || settings.replyFolder || '').trim() || '5R1234899';
  settings.campaignKeyword = canonical;
  settings.helperKeyword = canonical;
  delete settings.replyFolder;
  settings._settingsVersion = (Number(settings._settingsVersion)||0) + 1;
  const updateData = { settings: JSON.stringify(settings), updatedOn: new Date().toISOString() };
  const upd = await gas('setMultipleCellDataByColumnSearch', { sheetName:'campaigns', searchColumn:'campaignId', searchValue: CAMPAIGN_ID, data: JSON.stringify(updateData) });
  if(!upd?.success) throw new Error('Update failed: '+JSON.stringify(upd));
  console.log('KEYWORD_CLEANED',{campaignKeyword:settings.campaignKeyword, helperKeyword:settings.helperKeyword, hasReplyFolder: Object.prototype.hasOwnProperty.call(settings,'replyFolder'), v: settings._settingsVersion});
})().catch(e=>{console.error('ERR',e.message, e.response?.data||''); process.exit(1);});
