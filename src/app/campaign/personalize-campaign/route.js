import { NextResponse } from "next/server";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings, buildPersonalizedLink, ensureLinkColumn, startStageLease } from "../_shared/pipelineUtils.js";
import { getSelfUrl, getSelfUrlWithFallback, getInternalSelfUrl, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits, checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";

// Validate/enrich/personalize must be able to run to completion for all rows.
export const maxDuration = 0;
export const dynamic = "force-dynamic";

async function personalizeBatch(batch, personalizationPrompt) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) => {
    const base = `${i + 1}. Name: ${contact.firstName}, Company: ${contact.company}, Email: ${contact.email}`;
    const extra = contact.rowData ? `\n   Row data (use any relevant fields to personalize; do not invent facts): ${contact.rowData}` : "";
    const ctx = contact.context ? `\n   Context: ${contact.context.slice(0, 300)}` : "";
    const link = contact.link ? `\n   Personal link (use EXACTLY this URL when you include a CTA, never re-type the base URL): ${contact.link}` : "";
    return `${base}${extra}${ctx}${link}`;
  }).join("\n");

  const prompt = `You are an expert personalized outreach copywriter writing as the SENDER (our campaign account). Generate highly tailored, per-recipient cold email subject lines and bodies for these ${batch.length} recipients so messages do not look alike. Use the provided row data/headers and context for each recipient (including any enriched fields) to make each message specific; if enrichment/context is limited, still vary and personalize using whatever recipient data is available. Each recipient below is the person RECEIVING this email (they have never seen it) — never write as if they already replied or agreed to anything. "You" (in the email) = that recipient; "I/we" = the sender.

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per recipient (same order):
[{"subject": "Tailored subject line", "body": "Tailored email body"}, ...]

Rules:
1. Each subject must be unique and engaging
2. Each body must be professional, natural, concise, with clear CTA
3. Personalize using the recipient's available row data (name, company, role, website, industry, context, enriched fields, etc.) without inventing facts
4. Keep body under 150 words
5. If a "Personal link" is listed for a recipient, include that EXACT URL in the body as the CTA — do not invent, shorten, or re-type a different URL.
6. Return ONLY the JSON array, no markdown or explanations`;
  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 4000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed)) {
      const clean = parsed.map(r => r && typeof r === 'object'
        ? { subject: ai.sanitizeAiPlainText(String(r.subject || ''), 200), body: ai.sanitizeAiPlainText(String(r.body || ''), 4000) }
        : null).filter(r => r && (r.subject || r.body));
      if (clean.length) return clean;
    }
    if (typeof ai._salvageJsonArray === 'function') {
      const salvaged = ai._salvageJsonArray(text);
      if (Array.isArray(salvaged) && salvaged.length) {
        return salvaged.map(r => ({ subject: ai.sanitizeAiPlainText(String(r.subject || ''), 200), body: ai.sanitizeAiPlainText(String(r.body || ''), 4000) })).filter(r => r.subject || r.body);
      }
    }
  } catch {}
  return batch.map(() => null);
}

async function personalizeSocialBatch(batch, personalizationPrompt) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) => {
    const base = `${i + 1}. Name: ${contact.firstName}, Platform: ${contact.platform}, Username: ${contact.username}`;
    const extra = contact.rowData ? `\n   Row data (use any relevant fields to personalize; do not invent facts): ${contact.rowData}` : "";
    const ctx = contact.context ? `\n   About: ${contact.context.slice(0, 300)}` : "";
    return `${base}${extra}${ctx}`;
  }).join("\n");

  const prompt = `You are an expert social media outreach copywriter writing as the SENDER opening a COLD first DM. Generate personalized, per-recipient DM messages for these ${batch.length} contacts so messages do not look alike. Use the provided row data/headers and context (including any enriched fields) to make each message specific; if limited, still vary and personalize using whatever data is available. Each contact below RECEIVES this message for the first time (they have never replied) — never write as if they already responded. "You" = that contact; "I" = the sender.

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per contact (same order):
[{"message": "Personalized DM message"}, ...]

Rules:
1. Each message must be unique and reference something specific about the contact using available row data
2. Keep messages under 100 words
3. Be conversational, not salesy
4. Return ONLY the JSON array`;
  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 4000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed)) {
      const clean = parsed.map(r => r && typeof r === 'object'
        ? { message: ai.sanitizeAiPlainText(String(r.message || ''), 2000) }
        : null).filter(r => r && r.message);
      if (clean.length) return clean;
    }
    if (typeof ai._salvageJsonArray === 'function') {
      const salvaged = ai._salvageJsonArray(text);
      if (Array.isArray(salvaged) && salvaged.length) {
        return salvaged.map(r => ({ message: ai.sanitizeAiPlainText(String(r.message || ''), 2000) })).filter(r => r.message);
      }
    }
  } catch {}
  return batch.map(() => null);
}

const PERSONALIZATION_TERMINAL_DONE = new Set(['personalized', 'completed', 'fallback', 'ai_fallback', 'template_fallback', 'failed_fallback', 'skipped']);

function isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx) {
  if (personalizationStatusIdx !== -1) {
    const st = String(row[personalizationStatusIdx] || '').toLowerCase().trim();
    if (PERSONALIZATION_TERMINAL_DONE.has(st)) return true;
  }
  // Content alone (e.g. template mail-merge) is not sufficient: the personalize stage must run and set status.
  // For legacy rows that already carry AI-personalized content but lack a status, treat as done once status is stamped.
  return false;
}

function markRowPersonalized(row, personalizationStatusIdx, status = 'personalized') {
  if (personalizationStatusIdx !== -1) row[personalizationStatusIdx] = status;
}

function fallbackEmail(firstName, company) {
  return {
    subject: `Quick question for ${firstName}`,
    body: `Hi ${firstName},\n\nHope this finds you well. I wanted to reach out about ${company || 'your work'}.\n\nBest,\nWebFixx Team`
  };
}
function fallbackSocial(firstName, platform) {
  return { message: `Hi ${firstName}, came across your ${platform || 'social'} profile and wanted to connect!` };
}

async function personalizeEmailRows(batch, contacts, personalizationPrompt, enhancedSubjectIdx, enhancedBodyIdx, personalizationStatusIdx, log) {
  let count = 0;
  let aiResults = await personalizeBatch(contacts, personalizationPrompt);
  if (!aiResults || aiResults.every(r => !r || (!r.subject && !r.body))) {
    const halfSize = Math.ceil(contacts.length / 2);
    if (halfSize >= 2) {
      const retryResults = await personalizeBatch(contacts.slice(0, halfSize), personalizationPrompt);
      if (retryResults && retryResults.some(r => r && (r.subject || r.body))) {
        aiResults = [...retryResults, ...Array(contacts.length - retryResults.length).fill(null)];
      }
    }
  }
  for (let i = 0; i < batch.length; i++) {
    const result = aiResults && aiResults[i];
    const c = contacts[i];
    const aiOk = !!(result && (result.subject || result.body));
    const finalRes = aiOk ? result : fallbackEmail(c.firstName, c.company);
    if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = finalRes.subject || '';
    if (enhancedBodyIdx !== -1) {
      let body = finalRes.body || '';
      if (c.link) body = String(body).replace(/\{\{\s*(link|url)\s*\}\}/gi, c.link);
      batch[i][enhancedBodyIdx] = body;
    }
    // AI-generated content when available; explicit fallback only when AI unavailable/fails.
    markRowPersonalized(batch[i], personalizationStatusIdx, aiOk ? 'personalized' : 'fallback');
    count++;
  }
  return count;
}

async function personalizeSocialRows(batch, contacts, personalizationPrompt, enhancedSocialMsgIdx, personalizationStatusIdx) {
  let count = 0;
  let aiResults = await personalizeSocialBatch(contacts, personalizationPrompt);
  if (!aiResults || aiResults.every(r => !r || !r.message)) {
    const halfSize = Math.ceil(contacts.length / 2);
    if (halfSize >= 2) {
      const retryResults = await personalizeSocialBatch(contacts.slice(0, halfSize), personalizationPrompt);
      if (retryResults && retryResults.some(r => r && r.message)) {
        aiResults = [...retryResults, ...Array(contacts.length - retryResults.length).fill(null)];
      }
    }
  }
  for (let i = 0; i < batch.length; i++) {
    const result = aiResults && aiResults[i];
    const c = contacts[i];
    const aiOk = !!(result && result.message);
    const finalRes = aiOk ? result : fallbackSocial(c.firstName, c.platform);
    if (enhancedSocialMsgIdx !== -1) batch[i][enhancedSocialMsgIdx] = finalRes.message || '';
    markRowPersonalized(batch[i], personalizationStatusIdx, aiOk ? 'personalized' : 'fallback');
    count++;
  }
  return count;
}

async function processPersonalizationBatches({ rows, headers, dataRows, scopeStart, scopeEnd, channel, personalizationPrompt, campaignSettings, BATCH_SIZE, fileId, campaignId, log }) {
  const emailIdx = headers.findIndex(h => { const n = h.toLowerCase().trim(); return n === "email" || n === "mail" || n === "email address"; });
  const firstNameIdx = headers.findIndex(h => { const n = h.toLowerCase().trim(); return n === "firstname" || n === "first name" || n === "first"; });
  const companyIdx = headers.findIndex(h => { const n = h.toLowerCase().trim(); return n === "businessname" || n === "business name" || n === "company"; });
  const contextIdx = headers.findIndex(h => h.toUpperCase() === "CONTEXT");
  const enhancedSubjectIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsubject");
  const enhancedBodyIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedbody");
  const enhancedSocialMsgIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsocialmessage");
  const socialPlatformIdx = headers.findIndex(h => h.toUpperCase() === "SOCIALPLATFORM");
  const socialUsernameIdx = headers.findIndex(h => h.toUpperCase() === "SOCIALUSERNAME");
  const personalizationStatusIdx = headers.findIndex(h => h.toLowerCase().trim() === "personalizationstatus");

  const wantsLink = !!(campaignSettings.personalizeLink && campaignSettings.targetLink);
  const linkIdx = wantsLink ? ensureLinkColumn(rows) : -1;

  const EXCLUDED_ROW_DATA = new Set([
    'sn','email','firstname','lastname','first_name','last_name','mail','emailaddress','e-mail',
    'enhancedsubject','enhancedbody','enhancedsocialmessage','personalizationstatus','enrichmentstatus','executionstatus',
    'validation','providermxresult','sendstamp','senddate','sendtime','lastsendstatus','lastsenderror','helperkeyword','link',
    'smtp','port','username','password','apppassword','backupcode','oauth2clientid','oauth2clientsecret','oauth2refreshtoken',
    'engine','provider','campaigntype','replyto'
  ]);
  const buildRowData = (row) => {
    const parts = [];
    for (let i = 0; i < headers.length; i++) {
      const h = String(headers[i] || '').trim();
      if (!h) continue;
      const key = h.toLowerCase().replace(/[\s_-]+/g, '');
      if (EXCLUDED_ROW_DATA.has(key)) continue;
      if (key.startsWith('shooter')) continue;
      const v = String(row[i] ?? '').trim();
      if (!v) continue;
      parts.push(`${h}: ${v.slice(0, 180)}`);
      if (parts.join('; ').length > 900) break;
    }
    return parts.join('; ').slice(0, 900);
  };

  const scoped = dataRows.slice(scopeStart, scopeEnd);
  let personalizedCount = 0;
  const concurrency = Math.max(1, parseInt(BATCH_SIZE, 10) || 1); // AI calls in flight AND contacts per AI call
  const itemsPerCall = concurrency;
  const chunks = [];
  for (let i = 0; i < scoped.length; i += itemsPerCall) chunks.push(scoped.slice(i, i + itemsPerCall));

  const processChunk = async (batch, batchIdx) => {
    // Skip rows already personalized (resumable)
    const pendingRows = [];
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      if (isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx)) {
        markRowPersonalized(row, personalizationStatusIdx);
        continue;
      }
      pendingRows.push(row);
    }
    if (pendingRows.length === 0) return 0;
    if (channel === 'social' && enhancedSocialMsgIdx !== -1) {
      const contacts = pendingRows.map(row => ({
        username: socialUsernameIdx !== -1 ? String(row[socialUsernameIdx] || '').trim() : '',
        platform: socialPlatformIdx !== -1 ? String(row[socialPlatformIdx] || '').trim() : '',
        firstName: firstNameIdx !== -1 ? String(row[firstNameIdx] || '').trim() || 'there' : 'there',
        context: contextIdx !== -1 ? String(row[contextIdx] || '').trim() : '',
        rowData: buildRowData(row),
      }));
      return await personalizeSocialRows(pendingRows, contacts, personalizationPrompt, enhancedSocialMsgIdx, personalizationStatusIdx);
    } else {
      const contacts = pendingRows.map(row => {
        const link = linkIdx !== -1 ? buildPersonalizedLink(campaignSettings, row, headers) : '';
        if (linkIdx !== -1) row[linkIdx] = link;
        return {
          email: emailIdx !== -1 ? String(row[emailIdx] || '').trim() : '',
          firstName: firstNameIdx !== -1 ? String(row[firstNameIdx] || '').trim() || 'there' : 'there',
          company: companyIdx !== -1 ? String(row[companyIdx] || '').trim() || 'your company' : 'your company',
          context: contextIdx !== -1 ? String(row[contextIdx] || '').trim() : '',
          link,
          rowData: buildRowData(row),
        };
      });
      return await personalizeEmailRows(pendingRows, contacts, personalizationPrompt, enhancedSubjectIdx, enhancedBodyIdx, personalizationStatusIdx, log);
    }
  };

  let paused = false;
  for (let c = 0; c < chunks.length; c += concurrency) {
    const wave = chunks.slice(c, c + concurrency);
    const results = await Promise.allSettled(wave.map((chunk, wi) => processChunk(chunk, c + wi)));
    for (const r of results) {
      if (r.status === 'fulfilled') personalizedCount += (r.value || 0);
      else log.warn(` Personalization chunk failed: ${r.reason?.message || r.reason}`);
    }
    // Incremental per-batch commit: persist completed batch rows/status before next batch
    try {
      await mergeAndFlush(campaignId, 'personalize', rows, fileId);
    } catch (flushErr) {
      log.warn(` Live flush (merge) failed after wave ${Math.floor(c / concurrency) + 1}: ${flushErr.message} - trying direct upload`);
      try { await uploadCsvText(fileId, stringifyCSV(rows)); }
      catch (e2) { log.error(` Live flush failed after retry (wave ${Math.floor(c / concurrency) + 1}): ${e2.message}`); throw e2; }
    }
    log.info(` Personalization wave ${Math.floor(c / concurrency) + 1}/${Math.ceil(chunks.length / concurrency)} complete (flushed)`);

    // Pause only at safe checkpoints (after persistence)
    if (await isCampaignPaused(campaignId, 'personalize')) { paused = true; break; }
  }

  // Verify full scope completion
  const allDone = !paused && scoped.every(row => isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx));
  // ensure status marked for any legacy rows that already have personalized content but no terminal status
  if (personalizationStatusIdx !== -1) {
    for (const row of scoped) {
      const st = String(row[personalizationStatusIdx] || '').toLowerCase().trim();
      if (PERSONALIZATION_TERMINAL_DONE.has(st)) continue;
      const hasContent = channel === 'social'
        ? (enhancedSocialMsgIdx !== -1 && String(row[enhancedSocialMsgIdx] || '').trim())
        : ((enhancedBodyIdx !== -1 && String(row[enhancedBodyIdx] || '').trim()) || (enhancedSubjectIdx !== -1 && String(row[enhancedSubjectIdx] || '').trim()));
      if (hasContent) row[personalizationStatusIdx] = 'personalized';
    }
  }
  return { personalizedCount, allDone, paused };
}

async function handleCoordinatorMode(campaignId, fileId, fileUrl, log, stageUserId) {
  log.info(` Downloading CSV file: ${fileId}`);
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  const rows = parseCSV(dl.content);
  if (rows.length === 0) throw new Error("CSV file is empty");
  const headers = rows[0];

  let personalizationPrompt = "Write a short, professional cold outreach email. Address by first name, reference company. Keep it engaging, under 150 words. Vary subject lines.";
  let channel = "email";
  let campaignSettings = {};
  try {
    const campaignData = await getCampaignSettings(campaignId);
    if (campaignData?.settings) {
      campaignSettings = campaignData.settings;
      if (campaignData.settings.aiPersonalizationPrompt) personalizationPrompt = campaignData.settings.aiPersonalizationPrompt;
      channel = campaignData.settings.channel || "email";
    }
  } catch {}

  const promptMaxCharsSetting = await getSetting('personalizationPromptMaxChars');
  const PROMPT_MAX_CHARS = parseInt(promptMaxCharsSetting?.value1) || 500;
  if (personalizationPrompt.length > PROMPT_MAX_CHARS) personalizationPrompt = personalizationPrompt.slice(0, PROMPT_MAX_CHARS);

  const dataRows = rows.slice(1);
  // batch limits = concurrency over FULL dataset (never total scope/truncation)
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.personalizeLimit > 0)) {
    return NextResponse.json({ success: true, limitReached: true, message: "Personalization blocked: personalizeBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const personalizeConcurrency = Math.max(1, parseInt(campaignLimits.personalizeLimit, 10) || 1);
  const scopeEnd = dataRows.length; // full dataset

  const multiEnabled = await isMultiServerEnabled();
  if (multiEnabled) {
    const dispatchResult = await dispatchToServers(campaignId, 'personalize', fileUrl, scopeEnd);
    if (dispatchResult && dispatchResult.servers) {
      return NextResponse.json({ success: true, processing: true, dispatched: true, servers: dispatchResult.servers });
    }
  }

  await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });
  const { personalizedCount, allDone, paused } = await processPersonalizationBatches({
    rows, headers, dataRows, scopeStart: 0, scopeEnd, channel, personalizationPrompt, campaignSettings, BATCH_SIZE: personalizeConcurrency, fileId, campaignId, log
  });

  if (paused) {
    await updateCampaignSettings(campaignId, { personalizationStatus: "paused", status: "paused" });
    return NextResponse.json({ success: true, paused: true, completed: false, message: "Personalization paused at checkpoint", total: scopeEnd, personalized: personalizedCount });
  }

  try { await uploadCsvText(fileId, stringifyCSV(rows)); } catch {}

  if (!allDone) {
    await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });
    return NextResponse.json({ success: true, processing: true, completed: false, message: "Personalization incomplete - remaining rows pending", total: scopeEnd, personalized: personalizedCount });
  }

  await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });
  if (stageUserId && scopeEnd > 0) {
    try { await updateUserUsage(stageUserId, "personalizeUsage", scopeEnd); } catch (e) { log.warn(`[user-limit] personalizeUsage increment failed: ${e.message}`); }
  }
  // Notify orchestrator so it can advance (coordinator/single-server completion handoff)
  try {
    const selfUrl = getInternalSelfUrl();
    fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, fromStage: true })
    }).catch(() => {});
  } catch {}
  return NextResponse.json({ success: true, completed: true, message: "Campaign personalization completed successfully", total: scopeEnd, personalized: personalizedCount });
}

async function handleWorkerMode(campaignId, fileId, serverBatch, log) {
  const myAssignment = await findMyAssignment(campaignId, 'personalize');
  if (!myAssignment) return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  await updateMyAssignment(campaignId, 'personalize', { status: 'running' });

  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  const rows = parseCSV(dl.content);
  if (rows.length === 0) throw new Error("CSV file is empty");
  const headers = rows[0];
  const dataRows = rows.slice(1);

  let personalizationPrompt = "Write a short, professional cold outreach email. Address by first name, reference company. Keep it engaging, under 150 words. Vary subject lines.";
  let channel = "email";
  let campaignSettings = {};
  try {
    const campaignData = await getCampaignSettings(campaignId);
    if (campaignData?.settings) {
      campaignSettings = campaignData.settings;
      if (campaignData.settings.aiPersonalizationPrompt) personalizationPrompt = campaignData.settings.aiPersonalizationPrompt;
      channel = campaignData.settings.channel || "email";
    }
  } catch {}
  const promptMaxCharsSetting = await getSetting('personalizationPromptMaxChars');
  const PROMPT_MAX_CHARS = parseInt(promptMaxCharsSetting?.value1) || 500;
  if (personalizationPrompt.length > PROMPT_MAX_CHARS) personalizationPrompt = personalizationPrompt.slice(0, PROMPT_MAX_CHARS);

  const rowStart = serverBatch.rowStart || 0;
  const rowEnd = Math.min(serverBatch.rowEnd || dataRows.length, dataRows.length);
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.personalizeLimit > 0)) {
    await updateMyAssignment(campaignId, 'personalize', { status: 'failed', error: 'personalizeBatchLimit is 0' });
    return NextResponse.json({ success: false, error: "Personalization blocked: personalizeBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const personalizeConcurrency = Math.max(1, parseInt(campaignLimits.personalizeLimit, 10) || 1);
  await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });

  const { personalizedCount, allDone, paused } = await processPersonalizationBatches({
    rows, headers, dataRows, scopeStart: rowStart, scopeEnd: rowEnd, channel, personalizationPrompt, campaignSettings, BATCH_SIZE: personalizeConcurrency, fileId, campaignId, log
  });

  await mergeAndFlush(campaignId, 'personalize', rows, fileId);
  if (paused) {
    await updateMyAssignment(campaignId, 'personalize', { status: 'paused', processedUpTo: rowStart });
    await updateCampaignSettings(campaignId, { personalizationStatus: "paused", status: "paused" });
    return NextResponse.json({ success: true, paused: true, completed: false, message: `Worker personalization paused for rows ${rowStart}-${rowEnd - 1}`, personalized: personalizedCount });
  }
  await updateMyAssignment(campaignId, 'personalize', { status: allDone ? 'completed' : 'running', processedUpTo: rowEnd });

  if (allDone) {
    const allAssignmentsDone = await checkAllComplete(campaignId, 'personalize');
    if (allAssignmentsDone) {
      // verify whole scope
      const enhancedSubjectIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsubject");
      const enhancedBodyIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedbody");
      const enhancedSocialMsgIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsocialmessage");
      const personalizationStatusIdx = headers.findIndex(h => h.toLowerCase().trim() === "personalizationstatus");
      const wholeDone = dataRows.every(r => isRowPersonalized(r, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx));
      if (wholeDone) {
        await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });
        try { const selfUrl = getInternalSelfUrl(); fetch(`${selfUrl}/campaign/pipeline-orchestrator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, fromStage: true }) }).catch(()=>{}); } catch {}
      } else {
        await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });
      }
    }
  }
  return NextResponse.json({ success: true, completed: allDone, processing: !allDone, message: `Worker personalization ${allDone ? 'completed' : 'in progress'}`, total: rowEnd - rowStart, personalized: personalizedCount });
}

export async function POST(request) {
  let log = logger.child({ campaignId: null, stage: 'personalize' });
  let campaignId;
  let stageLease = null;
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const { fileUrl, serverBatch } = body;
    ({ campaignId } = body);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    log = logger.child({ campaignId, stage: 'personalize' });
    log.info(`Received personalization request`);
    stageLease = startStageLease(campaignId, 'personalize', log);

    const fileId = extractFileId(fileUrl);
    if (!fileId) return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });

    let stageUserId = body.settings?.userId || body.userId || null;
    if (!stageUserId) { try { stageUserId = (await getCampaignSettings(campaignId))?.userId || null; } catch {} }
    if (stageUserId) {
      const quota = await checkUserQuota(stageUserId, { keys: ["personalizeUsage"] });
      if (!quota.allowed) {
        await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });
        return NextResponse.json({ success: true, limitReached: true, userMonthlyLimit: true, message: `Personalization blocked: ${quota.reason}` });
      }
    }

    if (serverBatch) return await handleWorkerMode(campaignId, fileId, serverBatch, log);
    return await handleCoordinatorMode(campaignId, fileId, fileUrl, log, stageUserId);
  } catch (error) {
    (log || logger).error(`Error: ${error.message}`, { stack: error.stack });
    try { if (campaignId) await updateCampaignSettings(campaignId, { personalizationStatus: "processing" }); } catch {}
    return NextResponse.json({ success: false, processing: true, error: error.message }, { status: 500 });
  } finally {
    if (stageLease) stageLease.stop();
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
