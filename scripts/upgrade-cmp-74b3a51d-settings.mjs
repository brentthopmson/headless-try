import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const gas = async (a, e = {}) => {
  const p = new URLSearchParams({ action: a, key: process.env.SCRIPT_KEY, ...e });
  const r = await axios.post(process.env.SCRIPT_URL, p, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 180000 });
  return r.data;
};
const get = async (id) => {
  const c = await gas('getData', { sheetname: 'campaigns' });
  const h = c.headers || [];
  const gi = n => h.indexOf(n);
  const r = (c.data || []).find(x => String(x[gi('campaignId')] || '').trim() === id);
  let s = {};
  try { s = JSON.parse(r[gi('settings')] || '{}') || {}; } catch {}
  return { row: r, headers: h, settings: s };
};

const TARGET = 'CMP-74B3A51D';
const { settings: s } = await get(TARGET);

// Good defaults taken from the solid email campaign (CMP-35923860).
const DEFAULTS = {
  campaignKeyword: '123CATCH',
  enrichmentContext: 'B2B outreach lead list. For each recipient, use only verifiable public signals (company website/about/contact/team pages, public profiles, directories, and domain/company intel). Confirm identity (person <-> company/domain) before writing fields. Fill/correct FIRSTNAME/LASTNAME, BUSINESSNAME, JOBTITLE, BUSINESSPHONE/PHONE, URL, and a short factual CONTEXT (who they are, what the business does, relevant role/location). If a value cannot be verified, leave it blank or mark no_data rather than guessing. Do not invent emails, phones, URLs, employers, titles, or locations.',
  aiPersonalizationPrompt: 'You are writing cold outreach on behalf of the sender (our campaign), not as the recipient. Write a unique, natural, professional email per recipient using their available row fields and verified enriched data (name, company, role/title, website, location, CONTEXT). Be specific and relevant; avoid generic templates, flattery, placeholders, unsupported claims, and invented facts. Keep it concise with a clear CTA. Never output placeholder signatures such as [Your Name], [your name], or {{tokens}}; if no sender name is provided, end with a natural sign-off and no name line.',
  emailStrategyPrompt: 'You are replying on behalf of our campaign/sender account to a contact who responded to our outreach. Be helpful, professional, concise, and human. Match the intent: positive -> acknowledge and propose a clear next step; questions -> answer briefly; negative -> acknowledge and close politely; unsubscribe -> confirm and do not pitch; out-of-office -> no reply needed. Use campaign details only when accurate; never invent commitments, meetings, pricing, or facts.',
  subject: '{{FIRSTNAME}}, worth a quick chat?',
  body: 'Hi {{FIRSTNAME}},\n\nI noticed and thought there might be a practical way we can support what you’re doing.\n\nWould you be open to a brief conversation this week?\n\nBest regards',
  socialMessage: '',
  sendMode: 'immediate',
  scheduleStartTime: null,
  sendDate: '',
  sendTime: '',
  timezone: 'America/New_York',
  wireAccount: 'browser-1794011658491-lh5a0cnqsh',
  linkAfterTurns: 2,
};

let changed = 0;
for (const [k, v] of Object.entries(DEFAULTS)) {
  if (s[k] === undefined) { s[k] = v; changed++; }
}
// Keep identity: campaignKeyword should mirror its own helperKeyword, not a copy.
const kw = String(s.helperKeyword || '123CATCH').trim();
if (kw) { s.campaignKeyword = kw; }

// SMTP per-account caps + sender name (solid campaign has these; this one lacked them).
if (Array.isArray(s.smtpSettings)) {
  s.smtpSettings = s.smtpSettings.map(cfg => ({
    ...cfg,
    hourlyLimit: cfg.hourlyLimit || 5,
    dailyLimit: cfg.dailyLimit || 90,
    monthlyLimit: cfg.monthlyLimit || 2700,
    senderName: cfg.senderName || 'WebFixx Outreach',
  }));
  changed++;
}

// Clean stale run state so it's ready to test fresh.
for (const k of ['lastEngineError', 'statusAudit', 'executionStatus', 'interactionStatus', 'personalizationStatus', 'validationStatus', 'enrichmentStatus', 'lastProcessedRow', 'retryAttempts', 'serverAssignments', 'restUntil', 'restReason', 'restSetAt', 'pauseReason']) {
  if (k in s) { delete s[k]; changed++; }
}
for (const k of ['validationStatus', 'enrichmentStatus', 'personalizationStatus', 'executionStatus', 'interactionStatus']) s[k] = null;
s.mailMerged = false;
s.lastProcessedRow = 0;
s.retryAttempts = 0;
s.serverAssignments = {};
s._settingsVersion = (Number(s._settingsVersion) || 0) + 1;

const upd = await gas('setMultipleCellDataByColumnSearch', {
  sheetName: 'campaigns', searchColumn: 'campaignId', searchValue: TARGET,
  data: JSON.stringify({ settings: JSON.stringify(s), status: 'draft', updatedOn: new Date().toISOString() }),
});
if (!upd?.success) throw new Error('update failed: ' + JSON.stringify(upd));
console.log('Upgraded', TARGET, '- added/changed', changed, 'fields; keys now', Object.keys(s).length);
