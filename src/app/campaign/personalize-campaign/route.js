import { NextResponse } from "next/server";
import { getSheetsAuthClient } from "../../api/googlesheets.js";
import { google } from "googleapis";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete, getDriveClient } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings } from "../_shared/pipelineUtils.js";
import { getSelfUrl } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

async function personalizeBatch(batch, personalizationPrompt, headers) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Company: ${contact.company}, Email: ${contact.email}${contact.context ? `, Context: ${contact.context.slice(0, 200)}` : ""}`
  ).join("\n");

  const prompt = `You are an expert personalized outreach copywriter. Generate highly tailored cold email subject lines and email bodies for these ${batch.length} recipients:

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
5. Return ONLY the JSON array, no markdown or explanations`;

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 4000 });
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn(`[Personalize Campaign] Batch AI failed: ${err.message}`);
  }
  return batch.map(() => null);
}

async function personalizeSocialBatch(batch, personalizationPrompt) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Platform: ${contact.platform}, Username: ${contact.username}${contact.context ? `, About: ${contact.context.slice(0, 200)}` : ""}`
  ).join("\n");

  const prompt = `You are an expert social media outreach copywriter. Generate personalized DM messages for these ${batch.length} social media contacts:

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
    const text = await ai.generate(prompt, { maxTokens: 4000 });
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn(`[Personalize Campaign] Social batch AI failed: ${err.message}`);
  }
  return batch.map(() => null);
}

async function handleCoordinatorMode(campaignId, fileId, fileUrl) {
  const authClient = await getSheetsAuthClient();
  if (!authClient) {
    return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
  }
  const drive = google.drive({ version: "v3", auth: authClient });

  const batchSetting = await getSetting('personalizeBatchLimit');
  const BATCH_SIZE = parseInt(batchSetting?.value1) || 30;
  logger.info(`[Personalize Campaign] Batch size: ${BATCH_SIZE}`);

  logger.info(`[Personalize Campaign] Downloading CSV file: ${fileId}`);
  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV as text content");

  const rows = parseCSV(csvContent);
  if (rows.length === 0) throw new Error("CSV file is empty");

  const headers = rows[0];

  const emailIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "email" || n === "mail" || n === "email address";
  });
  if (emailIdx === -1) throw new Error("No email column found");

  const firstNameIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "firstname" || n === "first name" || n === "first";
  });
  const companyIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "businessname" || n === "business name" || n === "company";
  });
  const contextIdx = headers.findIndex(h => h.toUpperCase() === "CONTEXT");
  const enhancedSubjectIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsubject");
  const enhancedBodyIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedbody");
  const enhancedSocialMsgIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsocialmessage");
  const socialPlatformIdx = headers.findIndex(h => h.toUpperCase() === "SOCIALPLATFORM");
  const socialUsernameIdx = headers.findIndex(h => h.toUpperCase() === "SOCIALUSERNAME");

  let personalizationPrompt = "Write a short, professional cold outreach email. Address by first name, reference company. Keep it engaging, under 150 words. Vary subject lines.";

  let channel = "email";
  try {
    const campaignData = await getCampaignSettings(campaignId);
    if (campaignData?.settings) {
      if (campaignData.settings.aiPersonalizationPrompt) personalizationPrompt = campaignData.settings.aiPersonalizationPrompt;
      channel = campaignData.settings.channel || "email";
    }
  } catch {}

  // Cap personalization prompt length to prevent token overflow
  const promptMaxCharsSetting = await getSetting('personalizationPromptMaxChars');
  const PROMPT_MAX_CHARS = parseInt(promptMaxCharsSetting?.value1) || 500;
  if (personalizationPrompt.length > PROMPT_MAX_CHARS) {
    personalizationPrompt = personalizationPrompt.slice(0, PROMPT_MAX_CHARS);
  }

  const dataRows = rows.slice(1);

  // Apply personalizeLimit from Limits sheet
  const campaignLimits = await getCampaignLimits();
  if (campaignLimits.personalizeLimit > 0 && dataRows.length > campaignLimits.personalizeLimit) {
    dataRows.length = campaignLimits.personalizeLimit;
    logger.info(`[Personalize Campaign] personalizeLimit (${campaignLimits.personalizeLimit}) applied: capped to ${dataRows.length} rows`);
  }

  const multiEnabled = await isMultiServerEnabled();
  if (multiEnabled) {
    const dispatchResult = await dispatchToServers(campaignId, 'personalize', fileUrl, dataRows.length);
    if (dispatchResult && dispatchResult.servers) {
      return NextResponse.json({ success: true, dispatched: true, servers: dispatchResult.servers });
    }
  }

  let personalizedCount = 0;

  const batchCount = Math.ceil(dataRows.length / BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Personalize Campaign] Campaign paused at batch ${batchIdx + 1}/${batchCount}`);
      break;
    }

    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, dataRows.length);
    const batch = dataRows.slice(start, end);

    if (channel === "email") {
      const contacts = batch.map(row => ({
        email: row[emailIdx]?.trim() || "",
        firstName: firstNameIdx !== -1 ? row[firstNameIdx]?.trim() || "there" : "there",
        company: companyIdx !== -1 ? row[companyIdx]?.trim() || "your company" : "your company",
        context: contextIdx !== -1 ? row[contextIdx]?.trim() || "" : ""
      }));

      let aiResults = await personalizeBatch(contacts, personalizationPrompt, headers);

      // Dynamic batch reduction: if AI fails, retry with half batch
      if (!aiResults || aiResults.every(r => !r.subject && !r.body)) {
        const halfSize = Math.ceil(contacts.length / 2);
        if (halfSize >= 2) {
          logger.warn(`[Personalize Campaign] AI batch failed, retrying with half size (${halfSize})`);
          const halfContacts = contacts.slice(0, halfSize);
          const retryResults = await personalizeBatch(halfContacts, personalizationPrompt, headers);
          if (retryResults && retryResults.some(r => r.subject || r.body)) {
            for (let i = 0; i < Math.min(halfSize, batch.length); i++) {
              const result = retryResults[i];
              if (result && (result.subject || result.body)) {
                if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = result.subject || "";
                if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = result.body || "";
                personalizedCount++;
              } else {
                const firstName = contacts[i].firstName;
                const company = contacts[i].company;
                if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = `Quick question for ${firstName}`;
                if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = `Hi ${firstName},\n\nHope this finds you well.\n\nBest,\nWebFixx Team`;
                personalizedCount++;
              }
            }
            logger.info(`[Personalize Campaign] AI retry succeeded for ${halfSize} contacts`);
            continue;
          }
        }
      }

      for (let i = 0; i < batch.length; i++) {
        const result = aiResults[i];
        if (result) {
          if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = result.subject || "";
          if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = result.body || "";
          personalizedCount++;
        } else {
          const firstName = contacts[i].firstName;
          const company = contacts[i].company;
          if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = `Quick question for ${firstName}`;
          if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = `Hi ${firstName},\n\nHope this finds you well. I wanted to reach out about ${company}.\n\nBest,\nWebFixx Team`;
          personalizedCount++;
        }
      }
    }

    if (channel === "social" && enhancedSocialMsgIdx !== -1) {
      const socialContacts = batch.map(row => ({
        username: socialUsernameIdx !== -1 ? row[socialUsernameIdx]?.trim() || "" : "",
        platform: socialPlatformIdx !== -1 ? row[socialPlatformIdx]?.trim() || "" : "",
        firstName: firstNameIdx !== -1 ? row[firstNameIdx]?.trim() || "there" : "there",
        context: contextIdx !== -1 ? row[contextIdx]?.trim() || "" : ""
      }));

      let aiResults = await personalizeSocialBatch(socialContacts, personalizationPrompt);

      // Dynamic batch reduction: if AI fails, retry with half batch
      if (!aiResults || aiResults.every(r => !r.message)) {
        const halfSize = Math.ceil(socialContacts.length / 2);
        if (halfSize >= 2) {
          logger.warn(`[Personalize Campaign] Social AI batch failed, retrying with half size (${halfSize})`);
          const halfContacts = socialContacts.slice(0, halfSize);
          const retryResults = await personalizeSocialBatch(halfContacts, personalizationPrompt);
          if (retryResults && retryResults.some(r => r.message)) {
            for (let i = 0; i < Math.min(halfSize, batch.length); i++) {
              const result = retryResults[i];
              if (result && result.message) {
                batch[i][enhancedSocialMsgIdx] = result.message;
              } else {
                const contact = socialContacts[i];
                batch[i][enhancedSocialMsgIdx] = `Hi ${contact.firstName}, came across your ${contact.platform || 'social'} profile and wanted to connect!`;
              }
            }
            logger.info(`[Personalize Campaign] Social AI retry succeeded for ${halfSize} contacts`);
            continue;
          }
        }
      }

      for (let i = 0; i < batch.length; i++) {
        const result = aiResults[i];
        if (result && result.message) {
          batch[i][enhancedSocialMsgIdx] = result.message;
        } else {
          const contact = socialContacts[i];
          batch[i][enhancedSocialMsgIdx] = `Hi ${contact.firstName}, came across your ${contact.platform || 'social'} profile and wanted to connect!`;
        }
      }
    }

    try {
      await drive.files.update({
        fileId,
        media: { mimeType: "text/csv", body: stringifyCSV(rows) }
      });
    } catch (flushErr) {
      logger.warn(`[Personalize Campaign] Live flush failed at batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    logger.info(`[Personalize Campaign] Batch ${batchIdx + 1}/${batchCount} complete`);
  }

  logger.info(`[Personalize Campaign] Final CSV flush to Drive: ${fileId}`);
  await drive.files.update({
    fileId,
    media: { mimeType: "text/csv", body: stringifyCSV(rows) }
  });

  await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });

  // Auto-advance pipeline
  try {
    const selfUrl = getSelfUrl();
    fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId })
    }).catch(err => logger.warn(`[Personalize Campaign] Auto-advance failed: ${err.message}`));
  } catch {}

  return NextResponse.json({
    success: true,
    message: "Campaign personalization completed successfully",
    total: dataRows.length,
    personalized: personalizedCount
  });
}

async function handleWorkerMode(campaignId, fileId, serverBatch) {
  const myAssignment = await findMyAssignment(campaignId, 'personalize');
  if (!myAssignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  }

  await updateMyAssignment(campaignId, 'personalize', { status: 'running' });

  const drive = await getDriveClient();

  const batchSetting = await getSetting('personalizeBatchLimit');
  const BATCH_SIZE = parseInt(batchSetting?.value1) || 30;
  logger.info(`[Personalize Campaign] Worker batch size: ${BATCH_SIZE}`);

  logger.info(`[Personalize Campaign] Worker downloading CSV file: ${fileId}`);
  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV as text content");

  const rows = parseCSV(csvContent);
  if (rows.length === 0) throw new Error("CSV file is empty");

  const headers = rows[0];

  const emailIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "email" || n === "mail" || n === "email address";
  });
  if (emailIdx === -1) throw new Error("No email column found");

  const firstNameIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "firstname" || n === "first name" || n === "first";
  });
  const companyIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "businessname" || n === "business name" || n === "company";
  });
  const contextIdx = headers.findIndex(h => h.toUpperCase() === "CONTEXT");
  const enhancedSubjectIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsubject");
  const enhancedBodyIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedbody");
  const enhancedSocialMsgIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsocialmessage");
  const socialPlatformIdx = headers.findIndex(h => h.toUpperCase() === "SOCIALPLATFORM");
  const socialUsernameIdx = headers.findIndex(h => h.toUpperCase() === "SOCIALUSERNAME");

  let personalizationPrompt = "Write a short, professional cold outreach email. Address by first name, reference company. Keep it engaging, under 150 words. Vary subject lines.";

  let channel = "email";
  try {
    const campaignData = await getCampaignSettings(campaignId);
    if (campaignData?.settings) {
      if (campaignData.settings.aiPersonalizationPrompt) personalizationPrompt = campaignData.settings.aiPersonalizationPrompt;
      channel = campaignData.settings.channel || "email";
    }
  } catch {}

  // Cap personalization prompt length to prevent token overflow
  const promptMaxCharsSetting = await getSetting('personalizationPromptMaxChars');
  const PROMPT_MAX_CHARS = parseInt(promptMaxCharsSetting?.value1) || 500;
  if (personalizationPrompt.length > PROMPT_MAX_CHARS) {
    personalizationPrompt = personalizationPrompt.slice(0, PROMPT_MAX_CHARS);
  }

  const dataRows = rows.slice(1);
  const rowStart = serverBatch.rowStart || 0;
  const rowEnd = serverBatch.rowEnd || dataRows.length;
  const myRows = dataRows.slice(rowStart, Math.min(rowEnd, dataRows.length));

  let personalizedCount = 0;

  const batchCount = Math.ceil(myRows.length / BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Personalize Campaign] Worker campaign paused at batch ${batchIdx + 1}/${batchCount}`);
      break;
    }

    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, myRows.length);
    const batch = myRows.slice(start, end);

    if (channel === "email") {
      const contacts = batch.map(row => ({
        email: row[emailIdx]?.trim() || "",
        firstName: firstNameIdx !== -1 ? row[firstNameIdx]?.trim() || "there" : "there",
        company: companyIdx !== -1 ? row[companyIdx]?.trim() || "your company" : "your company",
        context: contextIdx !== -1 ? row[contextIdx]?.trim() || "" : ""
      }));

      let aiResults = await personalizeBatch(contacts, personalizationPrompt, headers);

      // Dynamic batch reduction: if AI fails, retry with half batch
      if (!aiResults || aiResults.every(r => !r.subject && !r.body)) {
        const halfSize = Math.ceil(contacts.length / 2);
        if (halfSize >= 2) {
          logger.warn(`[Personalize Campaign] Worker AI batch failed, retrying with half size (${halfSize})`);
          const halfContacts = contacts.slice(0, halfSize);
          const retryResults = await personalizeBatch(halfContacts, personalizationPrompt, headers);
          if (retryResults && retryResults.some(r => r.subject || r.body)) {
            for (let i = 0; i < Math.min(halfSize, batch.length); i++) {
              const result = retryResults[i];
              if (result && (result.subject || result.body)) {
                if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = result.subject || "";
                if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = result.body || "";
                personalizedCount++;
              } else {
                const firstName = contacts[i].firstName;
                const company = contacts[i].company;
                if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = `Quick question for ${firstName}`;
                if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = `Hi ${firstName},\n\nHope this finds you well.\n\nBest,\nWebFixx Team`;
                personalizedCount++;
              }
            }
            logger.info(`[Personalize Campaign] Worker AI retry succeeded for ${halfSize} contacts`);
            continue;
          }
        }
      }

      for (let i = 0; i < batch.length; i++) {
        const result = aiResults[i];
        if (result) {
          if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = result.subject || "";
          if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = result.body || "";
          personalizedCount++;
        } else {
          const firstName = contacts[i].firstName;
          const company = contacts[i].company;
          if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = `Quick question for ${firstName}`;
          if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = `Hi ${firstName},\n\nHope this finds you well. I wanted to reach out about ${company}.\n\nBest,\nWebFixx Team`;
          personalizedCount++;
        }
      }
    }

    if (channel === "social" && enhancedSocialMsgIdx !== -1) {
      const socialContacts = batch.map(row => ({
        username: socialUsernameIdx !== -1 ? row[socialUsernameIdx]?.trim() || "" : "",
        platform: socialPlatformIdx !== -1 ? row[socialPlatformIdx]?.trim() || "" : "",
        firstName: firstNameIdx !== -1 ? row[firstNameIdx]?.trim() || "there" : "there",
        context: contextIdx !== -1 ? row[contextIdx]?.trim() || "" : ""
      }));

      let aiResults = await personalizeSocialBatch(socialContacts, personalizationPrompt);

      // Dynamic batch reduction: if AI fails, retry with half batch
      if (!aiResults || aiResults.every(r => !r.message)) {
        const halfSize = Math.ceil(socialContacts.length / 2);
        if (halfSize >= 2) {
          logger.warn(`[Personalize Campaign] Worker social AI batch failed, retrying with half size (${halfSize})`);
          const halfContacts = socialContacts.slice(0, halfSize);
          const retryResults = await personalizeSocialBatch(halfContacts, personalizationPrompt);
          if (retryResults && retryResults.some(r => r.message)) {
            for (let i = 0; i < Math.min(halfSize, batch.length); i++) {
              const result = retryResults[i];
              if (result && result.message) {
                batch[i][enhancedSocialMsgIdx] = result.message;
              } else {
                const contact = socialContacts[i];
                batch[i][enhancedSocialMsgIdx] = `Hi ${contact.firstName}, came across your ${contact.platform || 'social'} profile and wanted to connect!`;
              }
            }
            logger.info(`[Personalize Campaign] Worker social AI retry succeeded for ${halfSize} contacts`);
            continue;
          }
        }
      }

      for (let i = 0; i < batch.length; i++) {
        const result = aiResults[i];
        if (result && result.message) {
          batch[i][enhancedSocialMsgIdx] = result.message;
        } else {
          const contact = socialContacts[i];
          batch[i][enhancedSocialMsgIdx] = `Hi ${contact.firstName}, came across your ${contact.platform || 'social'} profile and wanted to connect!`;
        }
      }
    }

    const processedUpTo = rowStart + end;
    await updateMyAssignment(campaignId, 'personalize', { processedUpTo });
    await mergeAndFlush(campaignId, 'personalize', rows, fileId);

    logger.info(`[Personalize Campaign] Worker batch ${batchIdx + 1}/${batchCount} complete (processedUpTo: ${processedUpTo})`);
  }

  await mergeAndFlush(campaignId, 'personalize', rows, fileId);
  await updateMyAssignment(campaignId, 'personalize', { status: 'completed' });

  const allDone = await checkAllComplete(campaignId, 'personalize');
  if (allDone) {
    await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });
  }

  return NextResponse.json({
    success: true,
    message: "Worker personalization completed",
    total: myRows.length,
    personalized: personalizedCount
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { campaignId, fileUrl, serverBatch } = body;

    logger.info(`[Personalize Campaign] Received personalization request for campaign: ${campaignId}`);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
    }

    if (serverBatch) {
      return await handleWorkerMode(campaignId, fileId, serverBatch);
    } else {
      return await handleCoordinatorMode(campaignId, fileId, fileUrl);
    }

  } catch (error) {
    logger.error(`[Personalize Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
