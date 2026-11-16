import axios from 'axios';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
const CAMPAIGN_ID='CMP-35923860';
const SCRIPT_URL=process.env.SCRIPT_URL, SCRIPT_KEY=process.env.SCRIPT_KEY;
async function gas(action, extra={}, timeout=120000){const params=new URLSearchParams({action,key:SCRIPT_KEY,...extra});const res=await axios.post(SCRIPT_URL,params,{headers:{'Content-Type':'application/x-www-form-urlencoded'},timeout,maxBodyLength:Infinity,maxContentLength:Infinity});return res.data;}
(async()=>{
  if(!SCRIPT_URL||!SCRIPT_KEY) throw new Error('Missing SCRIPT_URL/SCRIPT_KEY');
  const camp=await gas('getData',{sheetname:'campaigns'});
  if(!camp?.success) throw new Error('getData failed: '+JSON.stringify(camp));
  const h=camp.headers||[], d=camp.data||[]; const idIdx=h.indexOf('campaignId'); const settingsIdx=h.indexOf('settings');
  const row=d.find(r=>String(r[idIdx]||'').trim()===CAMPAIGN_ID);
  if(!row) throw new Error('Campaign not found');
  let settings={}; try{settings=JSON.parse(row[settingsIdx]||'{}')||{};}catch{settings={};}

  const merge = {
    validationStaged: true,
    enrichmentStaged: true,
    aiPersonalizationStaged: true,
    executeStaged: true,
    interactionStaged: true,

    enrichmentContext: "B2B outreach lead list. For each recipient, use only verifiable public signals (company website/about/contact/team pages, public profiles, directory/business listings, and domain/company intel). Confirm identity (person ↔ company/domain) before writing fields. Fill/correct: FIRSTNAME/LASTNAME (normalize misfilled full names), BUSINESSNAME, JOBTITLE, BUSINESSPHONE/PHONE, URL, and a short factual CONTEXT (who they are, what the business does, relevant location/role). If a value cannot be verified, leave it blank/mark no_data rather than guessing. Do not invent emails or private details.",

    aiPersonalizationPrompt: "You are writing cold outreach on behalf of the sender (our campaign), not as the recipient. Write a unique, natural, professional email per recipient using their available row fields and verified enriched data (name, company, role/title, website, location, and CONTEXT). Be specific and relevant to them; avoid generic templates, flattery, placeholders, or unsupported claims. If data is sparse, keep it clear, respectful, and concise without inventing details. Return subject and body that are ready to send.",

    socialMessage: settings.socialMessage ?? "",

    sendMode: settings.sendMode || "immediate",
    scheduleStartTime: settings.scheduleStartTime ?? null,
    sendDate: settings.sendDate ?? "",
    sendTime: settings.sendTime ?? "",
    timezone: settings.timezone || settings.timeZone || "America/New_York",

    wireAccount: settings.wireAccount || (Array.isArray(settings.accounts) ? settings.accounts[0] : undefined) || "browser-1794011658491-lh5a0cnqsh",

    channel: settings.channel || "email",
    interactionAccounts: Array.isArray(settings.interactionAccounts) && settings.interactionAccounts.length ? settings.interactionAccounts : (Array.isArray(settings.accounts) ? settings.accounts.slice() : ["browser-1794011658491-lh5a0cnqsh"]),
  };

  // merge without removing existing keys; do not add batch limits
  for (const [k,v] of Object.entries(merge)) { if (v !== undefined) settings[k]=v; }
  settings._settingsVersion = (Number(settings._settingsVersion)||0) + 1;

  const updateData = { settings: JSON.stringify(settings), updatedOn: new Date().toISOString() };
  const upd = await gas('setMultipleCellDataByColumnSearch', { sheetName:'campaigns', searchColumn:'campaignId', searchValue: CAMPAIGN_ID, data: JSON.stringify(updateData) });
  if(!upd?.success) throw new Error('Update failed: '+JSON.stringify(upd));
  console.log('MERGED_OK', {keys:Object.keys(settings).sort().length, _settingsVersion: settings._settingsVersion, validationStaged: settings.validationStaged, enrichmentStaged: settings.enrichmentStaged, aiPersonalizationStaged: settings.aiPersonalizationStaged, executeStaged: settings.executeStaged, interactionStaged: settings.interactionStaged, sendMode: settings.sendMode, wireAccount: settings.wireAccount, channel: settings.channel});
})().catch(e=>{console.error('ERR',e.message, e.response?.data||''); process.exit(1);});
