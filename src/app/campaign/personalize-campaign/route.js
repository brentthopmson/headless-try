import { NextResponse } from "next/server";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings, getPerformancePresets, buildPersonalizedLink, ensureLinkColumn } from "../_shared/pipelineUtils.js";
import { getSelfUrl, getSelfUrlWithFallback, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits, checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";

// Validate/enrich/personalize must be able to run to completion for all rows.
export const maxDuration = 0;
export const dynamic = "force-dynamic";

async function personalizeBatch(batch, personalizationPrompt) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Company: ${contact.company}, Email: ${contact.email}${contact.context ? `, Context: ${contact.context.slice(0, 200)}` : ""}${contact.link ? `, Personal link (use EXACTLY this URL when you include a CTA, never re-type the base URL): ${contact.link}` : ""}`
  ).join("\n");

  const prompt = `You are an expert personalized outreach copywriter writing as the SENDER (our campaign account). Generate highly tailored cold email subject lines and email bodies for these ${batch.length} recipients. Each recipient below is the person RECEIVING this email (they have never seen it) — never write as if they already replied or agreed to anything. "You" (in the email) = that recipient; "I/we" = the sender.

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per recipient (same order):
[{"subject": "Tailored subject line", "body": "Tailored email body"}, ...]

Rules:
1. Each subject must be unique and engaging
2. Each body must be professional, natural, concise, with clear CTA
3. Reference the recipient's name and company
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

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Platform: ${contact.platform}, Username: ${contact.username}${contact.context ? `, About: ${contact.context.slice(0, 200)}` : ""}`
  ).join("\n");

  const prompt = `You are an expert social media outreach copywriter writing as the SENDER opening a COLD first DM. Generate personalized DM messages for these ${batch.length} social media contacts. Each contact below RECEIVES this message for the first time (they have never replied) — never write as if they already responded. "You" = that contact; "I" = the sender.

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per contact (same order):
[{"message": "Personalized DM message"}, ...]

Rules:
1. Each message must be unique and reference something specific about the contact
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

function isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx) {
  if (personalizationStatusIdx !== -1 && String(row[personalizationStatusIdx] || '').toLowerCase().trim() === 'personalized') return true;
  if (channel === 'social') {
    return enhancedSocialMsgIdx !== -1 && String(row[enhancedSocialMsgIdx] || '').trim().length > 0;
  }
  // email: accept if body present (subject helpful but not strictly required)
  const hasBody = enhancedBodyIdx !== -1 && String(row[enhancedBodyIdx] || '').trim().length > 0;
  const hasSubject = enhancedSubjectIdx !== -1 && String(row[enhancedSubjectIdx] || '').trim().length > 0;
  return hasBody || (hasSubject && enhancedBodyIdx === -1);
}

function markRowPersonalized(row, personalizationStatusIdx) {
  if (personalizationStatusIdx !== -1) row[personalizationStatusIdx] = 'personalized';
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
    const finalRes = (result && (result.subject || result.body)) ? result : fallbackEmail(c.firstName, c.company);
    if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = finalRes.subject || '';
    if (enhancedBodyIdx !== -1) {
      let body = finalRes.body || '';
      if (c.link) body = String(body).replace(/\{\{\s*(link|url)\s*\}\}/gi, c.link);
      batch[i][enhancedBodyIdx] = body;
    }
    markRowPersonalized(batch[i], personalizationStatusIdx);
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
    const finalRes = (result && result.message) ? result : fallbackSocial(c.firstName, c.platform);
    if (enhancedSocialMsgIdx !== -1) batch[i][enhancedSocialMsgIdx] = finalRes.message || '';
    markRowPersonalized(batch[i], personalizationStatusIdx);
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

  const scoped = dataRows.slice(scopeStart, scopeEnd);
  let personalizedCount = 0;
  const batchCount = Math.ceil(scoped.length / BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    // Non-interruptible by policy for validate/enrich/personalize
    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, scoped.length);
    const batch = scoped.slice(start, end);

    // Skip rows already personalized (resumable)
    const pendingRows = [];
    const pendingMeta = [];
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i];
      if (isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx)) {
        markRowPersonalized(row, personalizationStatusIdx);
        continue;
      }
      pendingRows.push(row);
      pendingMeta.push(i);
    }

    if (pendingRows.length > 0) {
      if (channel === 'social' && enhancedSocialMsgIdx !== -1) {
        const contacts = pendingRows.map(row => ({
          username: socialUsernameIdx !== -1 ? String(row[socialUsernameIdx] || '').trim() : '',
          platform: socialPlatformIdx !== -1 ? String(row[socialPlatformIdx] || '').trim() : '',
          firstName: firstNameIdx !== -1 ? String(row[firstNameIdx] || '').trim() || 'there' : 'there',
          context: contextIdx !== -1 ? String(row[contextIdx] || '').trim() : ''
        }));
        personalizedCount += await personalizeSocialRows(pendingRows, contacts, personalizationPrompt, enhancedSocialMsgIdx, personalizationStatusIdx);
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
          };
        });
        personalizedCount += await personalizeEmailRows(pendingRows, contacts, personalizationPrompt, enhancedSubjectIdx, enhancedBodyIdx, personalizationStatusIdx, log);
      }
    }

    try {
      await uploadCsvText(fileId, stringifyCSV(rows));
    } catch (flushErr) {
      log.warn(` Live flush failed at batch ${batchIdx + 1}: ${flushErr.message}`);
    }
    log.info(` Batch ${batchIdx + 1}/${batchCount} complete`);
  }

  // Verify full scope completion
  const allDone = scoped.every(row => isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx));
  // ensure status marked for any already-done rows
  if (personalizationStatusIdx !== -1) {
    for (const row of scoped) {
      if (isRowPersonalized(row, channel, enhancedSubjectIdx, enhancedBodyIdx, enhancedSocialMsgIdx, personalizationStatusIdx)) {
        row[personalizationStatusIdx] = 'personalized';
      }
    }
  }
  return { personalizedCount, allDone };
}

async function handleCoordinatorMode(campaignId, fileId, fileUrl, log, stageUserId) {
  const perfLevelSetting = await getSetting('performanceLevel');
  const perfPresets = getPerformancePresets(perfLevelSetting?.value1 || 'balanced');
  const batchSetting = await getSetting('personalizeBatchLimit');
  const BATCH_SIZE = parseInt(batchSetting?.value1) || perfPresets.personalizationBatchLimit;

  await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });

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
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.personalizeLimit > 0)) {
    return NextResponse.json({ success: true, limitReached: true, message: "Personalization blocked: personalizeBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const scopeEnd = Math.min(dataRows.length, campaignLimits.personalizeLimit);

  const multiEnabled = await isMultiServerEnabled();
  if (multiEnabled) {
    const dispatchResult = await dispatchToServers(campaignId, 'personalize', fileUrl, scopeEnd);
    if (dispatchResult && dispatchResult.servers) {
      return NextResponse.json({ success: true, processing: true, dispatched: true, servers: dispatchResult.servers });
    }
  }

  const { personalizedCount, allDone } = await processPersonalizationBatches({
    rows, headers, dataRows, scopeStart: 0, scopeEnd, channel, personalizationPrompt, campaignSettings, BATCH_SIZE, fileId, campaignId, log
  });

  try { await uploadCsvText(fileId, stringifyCSV(rows)); } catch {}

  if (!allDone) {
    await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });
    return NextResponse.json({ success: true, processing: true, completed: false, message: "Personalization incomplete - remaining rows pending", total: scopeEnd, personalized: personalizedCount });
  }

  await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });
  if (stageUserId && personalizedCount > 0) {
    try { await updateUserUsage(stageUserId, "personalizeUsage", personalizedCount); } catch (e) { log.warn(`[user-limit] personalizeUsage increment failed: ${e.message}`); }
  }
  return NextResponse.json({ success: true, completed: true, message: "Campaign personalization completed successfully", total: scopeEnd, personalized: personalizedCount });
}

async function handleWorkerMode(campaignId, fileId, serverBatch, log) {
  const myAssignment = await findMyAssignment(campaignId, 'personalize');
  if (!myAssignment) return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  await updateMyAssignment(campaignId, 'personalize', { status: 'running' });
  await updateCampaignSettings(campaignId, { personalizationStatus: "processing" });

  const perfLevelSetting = await getSetting('performanceLevel');
  const perfPresets = getPerformancePresets(perfLevelSetting?.value1 || 'balanced');
  const batchSetting = await getSetting('personalizeBatchLimit');
  const BATCH_SIZE = parseInt(batchSetting?.value1) || perfPresets.personalizationBatchLimit;

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

  const { personalizedCount, allDone } = await processPersonalizationBatches({
    rows, headers, dataRows, scopeStart: rowStart, scopeEnd: rowEnd, channel, personalizationPrompt, campaignSettings, BATCH_SIZE, fileId, campaignId, log
  });

  await mergeAndFlush(campaignId, 'personalize', rows, fileId);
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
        try { const selfUrl = getSelfUrlWithFallback(); fetch(`${selfUrl}/campaign/pipeline-orchestrator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId }) }).catch(()=>{}); } catch {}
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
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
