import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const CAMPAIGN_ID='CMP-35923860';
const SCRIPT_URL=process.env.SCRIPT_URL, SCRIPT_KEY=process.env.SCRIPT_KEY;
async function gas(action, extra={}, timeout=120000){const params=new URLSearchParams({action,key:SCRIPT_KEY,...extra});const res=await axios.post(SCRIPT_URL,params,{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout});return res.data;}
(async()=>{
  const camp=await gas('getData',{sheetname:'campaigns'});
  const h=camp.headers||[], d=camp.data||[]; const id=h.indexOf('campaignId');
  const row=d.find(r=>String(r[id]||'').trim()===CAMPAIGN_ID);
  const obj={}; h.forEach((k,i)=>obj[k]=row?row[i]:'');
  let s={}; try{s=JSON.parse(obj.settings||'{}')}catch(e){console.log('parseerr',e.message)}
  console.log(JSON.stringify(s, null, 2));
})().catch(e=>{console.error('ERR',e.message); process.exit(1);});
