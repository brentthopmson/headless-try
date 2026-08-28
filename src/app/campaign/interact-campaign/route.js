import { NextResponse } from "next/server";
import { getSheetsAuthClient } from "../../api/googlesheets.js";
import { google } from "googleapis";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete, getDriveClient } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings } from "../_shared/pipelineUtils.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

async function classifyReply(replyBody) {
  const prompt = `Classify this email reply into one of these categories:
- positive: interested, wants to connect, scheduling meeting
- negative: not interested, rejection, do not contact
- neutral: questions, information request, acknowledgment
- out_of_office: auto-reply, vacation, away message
- unsubscribe: wants to be removed from mailing list

Reply body:
${replyBody.slice(0, 1000)}

Return ONLY a JSON object: {"type": "category", "confidence": 0.0-1.0}`;

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn(`[Interact Campaign] Classification failed: ${err.message}`);
  }
  return { type: "neutral", confidence: 0.5 };
}

async function generateAutoReply(replyType, campaignContext, senderEmail) {
  const prompt = `Generate a brief, professional auto-reply for an email campaign response.

Response type: ${replyType}
Campaign context: ${campaignContext || "General outreach"}
Sender: ${senderEmail}

Rules:
- Keep it under 50 words
- Be professional and courteous
- For positive: express enthusiasm and suggest next steps
- For neutral: provide helpful information
- For negative: acknowledge and respect their decision
- For out_of_office: no reply needed

Return ONLY the reply text, no JSON or formatting.`;

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt);
    return text.trim();
  } catch (err) {
    logger.warn(`[Interact Campaign] Auto-reply generation failed: ${err.message}`);
  }
  return null;
}

export async function POST(request) {
  let browser = null;
  try {
    const body = await request.json();
    const { campaignId, fileUrl, serverBatch } = body;

    logger.info(`[Interact Campaign] Received interaction request for campaign: ${campaignId}${serverBatch ? ` [worker rowStart=${serverBatch.rowStart} rowEnd=${serverBatch.rowEnd}]` : ''}`);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
    }

    if (serverBatch) {
      return await handleWorkerMode(campaignId, fileId, serverBatch);
    }

    return await handleCoordinatorMode(campaignId, fileId, fileUrl);

  } catch (error) {
    logger.error(`[Interact Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function handleCoordinatorMode(campaignId, fileId, fileUrl) {
  const authClient = await getSheetsAuthClient();
  if (!authClient) {
    return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
  }
  const drive = google.drive({ version: "v3", auth: authClient });

  const batchSetting = await getSetting('interactionBatchLimit');
  const BATCH_SIZE = parseInt(batchSetting?.value1) || 10;

  // Read per-campaign settings for stop guard
  const campaignData = await getCampaignSettings(campaignId);
  const settings = campaignData?.settings || {};

  // Read selected interaction accounts
  const interactionAccountIds = settings.interactionAccounts || [];
  const channel = settings.channel || "email";

  logger.info(`[Interact Campaign] Channel: ${channel}, Selected interaction accounts: ${interactionAccountIds.length}`);

  logger.info(`[Interact Campaign] Downloading CSV file: ${fileId}`);
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

  const interactStatusIdx = headers.findIndex(h => h.toUpperCase() === "INTERACTSTATUS");
  const interactCountIdx = headers.findIndex(h => h.toUpperCase() === "INTERACTCOUNT");
  const interactStampIdx = headers.findIndex(h => h.toUpperCase() === "INTERACTSTAMP");
  const validationIdx = headers.indexOf("validation");

  const sentRows = rows.slice(1).filter((row) => {
    if (validationIdx === -1) return false;
    const status = row[validationIdx]?.trim().toLowerCase();
    return status === "sent";
  });

  logger.info(`[Interact Campaign] Found ${sentRows.length} sent rows to monitor for replies`);

  if (sentRows.length === 0) {
    return NextResponse.json({
      success: true,
      message: "No sent emails found to monitor for interactions",
      stats: { monitored: 0, replies: 0, autoReplied: 0 }
    });
  }

  if (await isMultiServerEnabled()) {
    const dispatchResult = await dispatchToServers(campaignId, 'interact', fileUrl, sentRows.length);
    if (dispatchResult) {
      return NextResponse.json({ success: true, dispatched: true, servers: dispatchResult.servers });
    }
  }

  let replyCount = 0;
  let autoReplyCount = 0;

  // Compute existing reply count from CSV data
  if (interactCountIdx !== -1) {
    for (const row of rows.slice(1)) {
      const count = parseInt(row[interactCountIdx], 10);
      if (!isNaN(count)) replyCount += count;
    }
  }

  const stopAfterHours = settings.interactionStopAfterHours || 72;
  const maxReplies = settings.interactionMaxReplies || 100;
  const interactionStartedAt = settings.interactionStartedAt || new Date().toISOString();

  // Fetch interactionLimit from Limits sheet
  let interactionLimit = 0;
  try {
    const campaignLimits = await getCampaignLimits();
    interactionLimit = campaignLimits.interactionLimit;
  } catch (limitErr) {
    logger.warn(`[Interact Campaign] Failed to fetch interactionLimit: ${limitErr.message}`);
  }

  const batchCount = Math.ceil(sentRows.length / BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Interact Campaign] Campaign paused at batch ${batchIdx + 1}/${batchCount}`);
      break;
    }

    // Stop guard: check time limit
    const hoursElapsed = (Date.now() - new Date(interactionStartedAt).getTime()) / (1000 * 60 * 60);
    if (hoursElapsed >= stopAfterHours) {
      logger.info(`[Interact Campaign] Stop guard: time limit reached (${hoursElapsed.toFixed(1)}h >= ${stopAfterHours}h)`);
      await updateCampaignSettings(campaignId, {
        interactionStatus: "completed",
        interactionStoppedReason: "time_limit_reached"
      });
      return NextResponse.json({
        success: true,
        message: `Interaction stopped: time limit reached (${stopAfterHours}h)`,
        stats: { monitored: sentRows.length, replies: replyCount, autoReplied: autoReplyCount, stoppedReason: "time_limit_reached" }
      });
    }

    // Stop guard: check reply limit
    if (replyCount >= maxReplies) {
      logger.info(`[Interact Campaign] Stop guard: reply limit reached (${replyCount} >= ${maxReplies})`);
      await updateCampaignSettings(campaignId, {
        interactionStatus: "completed",
        interactionStoppedReason: "reply_limit_reached"
      });
      return NextResponse.json({
        success: true,
        message: `Interaction stopped: reply limit reached (${maxReplies})`,
        stats: { monitored: sentRows.length, replies: replyCount, autoReplied: autoReplyCount, stoppedReason: "reply_limit_reached" }
      });
    }

    // Stop guard: check plan interactionLimit
    if (interactionLimit > 0 && replyCount >= interactionLimit) {
      logger.info(`[Interact Campaign] Stop guard: plan interactionLimit reached (${replyCount} >= ${interactionLimit})`);
      await updateCampaignSettings(campaignId, {
        interactionStatus: "completed",
        interactionStoppedReason: "reply_limit_reached"
      });
      return NextResponse.json({
        success: true,
        message: `Interaction stopped: plan limit reached (${interactionLimit})`,
        stats: { monitored: sentRows.length, replies: replyCount, autoReplied: autoReplyCount, stoppedReason: "reply_limit_reached" }
      });
    }

    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, sentRows.length);
    const batch = sentRows.slice(start, end);

    for (const row of batch) {
      const email = row[emailIdx]?.trim();
      if (!email) continue;

      if (interactStatusIdx !== -1 && !row[interactStatusIdx]?.trim()) {
        row[interactStatusIdx] = "monitoring";
      }
      if (interactCountIdx !== -1 && !row[interactCountIdx]?.trim()) {
        row[interactCountIdx] = "0";
      }
      if (interactStampIdx !== -1 && !row[interactStampIdx]?.trim()) {
        row[interactStampIdx] = new Date().toISOString();
      }
    }

    try {
      await drive.files.update({
        fileId,
        media: { mimeType: "text/csv", body: stringifyCSV(rows) }
      });
    } catch (flushErr) {
      logger.warn(`[Interact Campaign] Live flush failed at batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    logger.info(`[Interact Campaign] Batch ${batchIdx + 1}/${batchCount} initialized`);
  }

  await drive.files.update({
    fileId,
    media: { mimeType: "text/csv", body: stringifyCSV(rows) }
  });

  await updateCampaignSettings(campaignId, {
    interactionStatus: "monitoring",
    interactionStartedAt: new Date().toISOString()
  });

  return NextResponse.json({
    success: true,
    message: "Campaign interaction monitoring started",
    stats: { monitored: sentRows.length, replies: replyCount, autoReplied: autoReplyCount }
  });
}

async function handleWorkerMode(campaignId, fileId, serverBatch) {
  const myAssignment = await findMyAssignment(campaignId, 'interact');
  if (!myAssignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  }

  await updateMyAssignment(campaignId, 'interact', { status: 'running' });

  const drive = await getDriveClient();
  if (!drive) {
    return NextResponse.json({ success: false, error: "Failed to get Drive client" }, { status: 500 });
  }

  const batchSetting = await getSetting('interactionBatchLimit');
  const BATCH_SIZE = parseInt(batchSetting?.value1) || 10;

  // Read per-campaign settings for stop guard
  const campaignData = await getCampaignSettings(campaignId);
  const settings = campaignData?.settings || {};

  // Read selected interaction accounts
  const interactionAccountIds = settings.interactionAccounts || [];
  const channel = settings.channel || "email";

  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV");

  const rows = parseCSV(csvContent);
  if (rows.length === 0) throw new Error("CSV file is empty");

  const headers = rows[0];

  const emailIdx = headers.findIndex(h => {
    const n = h.toLowerCase().trim();
    return n === "email" || n === "mail" || n === "email address";
  });
  if (emailIdx === -1) throw new Error("No email column found");

  const interactStatusIdx = headers.findIndex(h => h.toUpperCase() === "INTERACTSTATUS");
  const interactCountIdx = headers.findIndex(h => h.toUpperCase() === "INTERACTCOUNT");
  const interactStampIdx = headers.findIndex(h => h.toUpperCase() === "INTERACTSTAMP");
  const validationIdx = headers.indexOf("validation");

  // Find sent rows and extract only those in our assigned range
  const allDataRows = rows.slice(1);
  const sentRowsWithIndex = [];
  for (let i = 0; i < allDataRows.length; i++) {
    if (validationIdx === -1) continue;
    const status = allDataRows[i][validationIdx]?.trim().toLowerCase();
    if (status === "sent") sentRowsWithIndex.push({ row: allDataRows[i], index: i });
  }

  const { rowStart, rowEnd } = serverBatch;
  const mySentRows = sentRowsWithIndex.filter(r => r.index >= rowStart && r.index < rowEnd);

  logger.info(`[Interact Campaign][Worker] Processing ${mySentRows.length} sent rows in range ${rowStart}-${rowEnd - 1}`);

  let replyCount = 0;
  let autoReplyCount = 0;

  // Compute existing reply count from CSV data
  if (interactCountIdx !== -1) {
    for (const { row } of mySentRows) {
      const count = parseInt(row[interactCountIdx], 10);
      if (!isNaN(count)) replyCount += count;
    }
  }

  const stopAfterHours = settings.interactionStopAfterHours || 72;
  const maxReplies = settings.interactionMaxReplies || 100;
  const interactionStartedAt = settings.interactionStartedAt || new Date().toISOString();

  // Fetch interactionLimit from Limits sheet
  let interactionLimit = 0;
  try {
    const campaignLimits = await getCampaignLimits();
    interactionLimit = campaignLimits.interactionLimit;
  } catch (limitErr) {
    logger.warn(`[Interact Campaign][Worker] Failed to fetch interactionLimit: ${limitErr.message}`);
  }

  const batchCount = Math.ceil(mySentRows.length / BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) break;

    // Stop guard: check time limit
    const hoursElapsed = (Date.now() - new Date(interactionStartedAt).getTime()) / (1000 * 60 * 60);
    if (hoursElapsed >= stopAfterHours) {
      logger.info(`[Interact Campaign][Worker] Stop guard: time limit reached`);
      await updateCampaignSettings(campaignId, {
        interactionStatus: "completed",
        interactionStoppedReason: "time_limit_reached"
      });
      break;
    }

    // Stop guard: check reply limit
    if (replyCount >= maxReplies) {
      logger.info(`[Interact Campaign][Worker] Stop guard: reply limit reached`);
      await updateCampaignSettings(campaignId, {
        interactionStatus: "completed",
        interactionStoppedReason: "reply_limit_reached"
      });
      break;
    }

    // Stop guard: check plan interactionLimit
    if (interactionLimit > 0 && replyCount >= interactionLimit) {
      logger.info(`[Interact Campaign][Worker] Stop guard: plan interactionLimit reached`);
      await updateCampaignSettings(campaignId, {
        interactionStatus: "completed",
        interactionStoppedReason: "reply_limit_reached"
      });
      break;
    }

    const start = batchIdx * BATCH_SIZE;
    const end = Math.min(start + BATCH_SIZE, mySentRows.length);
    const batch = mySentRows.slice(start, end);

    for (const { row } of batch) {
      const email = row[emailIdx]?.trim();
      if (!email) continue;

      if (interactStatusIdx !== -1 && !row[interactStatusIdx]?.trim()) {
        row[interactStatusIdx] = "monitoring";
      }
      if (interactCountIdx !== -1 && !row[interactCountIdx]?.trim()) {
        row[interactCountIdx] = "0";
      }
      if (interactStampIdx !== -1 && !row[interactStampIdx]?.trim()) {
        row[interactStampIdx] = new Date().toISOString();
      }
    }

    await mergeAndFlush(campaignId, 'interact', rows, fileId);
    await updateMyAssignment(campaignId, 'interact', { processedUpTo: rowStart + end });

    logger.info(`[Interact Campaign][Worker] Batch ${batchIdx + 1}/${batchCount} initialized`);
  }

  await mergeAndFlush(campaignId, 'interact', rows, fileId);
  await updateMyAssignment(campaignId, 'interact', { status: 'completed', processedUpTo: rowEnd });

  const allDone = await checkAllComplete(campaignId, 'interact');
  if (allDone) {
    await updateCampaignSettings(campaignId, {
      interactionStatus: "completed",
      interactionStartedAt: settings.interactionStartedAt || new Date().toISOString()
    });
  }

  return NextResponse.json({
    success: true,
    message: `Worker completed interaction tracking for rows ${rowStart}-${rowEnd - 1}`,
    stats: { monitored: mySentRows.length, replies: replyCount, autoReplied: autoReplyCount, allComplete: !!allDone }
  });
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
