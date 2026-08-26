import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import geminiHelper from "../../api/gemini.js";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else { inQuotes = false; }
      } else { row[row.length - 1] += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(""); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else { row[row.length - 1] += c; }
    }
  }
  if (row.length > 1 || row[0] !== "") lines.push(row);
  return lines;
}

function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? "" : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');
}

async function isCampaignPaused(campaignId) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return false;
    const headers = campaignsResult.headers;
    const idIdx = headers.indexOf("campaignId");
    const statusIdx = headers.indexOf("status");
    if (idIdx === -1 || statusIdx === -1) return false;
    const row = campaignsResult.data.find(r => String(r[idIdx]).trim() === String(campaignId).trim());
    if (!row) return false;
    return String(row[statusIdx] || "").trim().toLowerCase() === "paused";
  } catch (err) {
    logger.warn(`[Personalize Campaign] Pause check failed: ${err.message}`);
    return false;
  }
}

async function updateCampaignSettings(campaignId, updates) {
  try {
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return;
    const cHeaders = campaignsResult.headers;
    const cIdIndex = cHeaders.indexOf("campaignId");
    const cSettingsIndex = cHeaders.indexOf("settings");
    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow || cSettingsIndex === -1) return;

    let settings = {};
    try {
      const settingsStr = campaignRow[cSettingsIndex];
      if (typeof settingsStr === "string") settings = JSON.parse(settingsStr);
      else if (settingsStr && typeof settingsStr === 'object') settings = settingsStr;
    } catch {}

    Object.assign(settings, updates);

    await updateSheetRowApi("campaigns", "campaignId", campaignId, {
      settings: JSON.stringify(settings),
      updatedOn: new Date().toISOString()
    });
  } catch (err) {
    logger.warn(`[Personalize Campaign] Failed to update settings: ${err.message}`);
  }
}

async function personalizeBatch(batch, personalizationPrompt, headers) {
  if (!geminiHelper.model || batch.length === 0) return batch.map(() => null);

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
    const result = await geminiHelper.model.generateContent(prompt);
    const text = result.response.text().trim();
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
  if (!geminiHelper.model || batch.length === 0) return batch.map(() => null);

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
    const result = await geminiHelper.model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn(`[Personalize Campaign] Social batch AI failed: ${err.message}`);
  }
  return batch.map(() => null);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { campaignId, fileUrl } = body;

    logger.info(`[Personalize Campaign] Received personalization request for campaign: ${campaignId}`);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
    }

    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
    }
    const drive = google.drive({ version: "v3", auth: authClient });

    // Read batch limits from SETTINGS
    const batchSetting = await getSetting('personalizeBatchLimit');
    const BATCH_SIZE = parseInt(batchSetting?.value1) || 30;
    logger.info(`[Personalize Campaign] Batch size: ${BATCH_SIZE}`);

    // 1. Download CSV
    logger.info(`[Personalize Campaign] Downloading CSV file: ${fileId}`);
    const driveFile = await drive.files.get({ fileId, alt: "media" });
    const csvContent = driveFile.data;
    if (typeof csvContent !== "string") throw new Error("Failed to download CSV as text content");

    const rows = parseCSV(csvContent);
    if (rows.length === 0) throw new Error("CSV file is empty");

    const headers = rows[0];

    // 2. Find column indices
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
    const validationIdx = headers.indexOf("validation");

    // 3. Fetch personalization prompt from campaign settings
    let personalizationPrompt = "Write a short, professional cold outreach email. Address by first name, reference company. Keep it engaging, under 150 words. Vary subject lines.";

    const campaignsResult = await getSheetDataApi("campaigns");
    if (campaignsResult.success) {
      const cHeaders = campaignsResult.headers;
      const cIdIndex = cHeaders.indexOf("campaignId");
      const cSettingsIndex = cHeaders.indexOf("settings");
      const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
      if (campaignRow && cSettingsIndex !== -1) {
        try {
          const settingsStr = campaignRow[cSettingsIndex];
          const settings = typeof settingsStr === "string" ? JSON.parse(settingsStr) : (settingsStr || {});
          if (settings.aiPersonalizationPrompt) personalizationPrompt = settings.aiPersonalizationPrompt;
        } catch {}
      }
    }

    // 4. Determine channel
    let channel = "email";
    try {
      const campaignsResult2 = await getSheetDataApi("campaigns");
      if (campaignsResult2.success) {
        const cHeaders = campaignsResult2.headers;
        const cIdIndex = cHeaders.indexOf("campaignId");
        const cSettingsIndex = cHeaders.indexOf("settings");
        const campaignRow = campaignsResult2.data.find(r => r[cIdIndex] === campaignId);
        if (campaignRow && cSettingsIndex !== -1) {
          const settingsStr = campaignRow[cSettingsIndex];
          const settings = typeof settingsStr === "string" ? JSON.parse(settingsStr) : (settingsStr || {});
          channel = settings.channel || "email";
        }
      }
    } catch {}

    // 5. Process in batches
    const dataRows = rows.slice(1);
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

      // Email personalization
      if (channel === "email") {
        const contacts = batch.map(row => ({
          email: row[emailIdx]?.trim() || "",
          firstName: firstNameIdx !== -1 ? row[firstNameIdx]?.trim() || "there" : "there",
          company: companyIdx !== -1 ? row[companyIdx]?.trim() || "your company" : "your company",
          context: contextIdx !== -1 ? row[contextIdx]?.trim() || "" : ""
        }));

        const aiResults = await personalizeBatch(contacts, personalizationPrompt, headers);

        for (let i = 0; i < batch.length; i++) {
          const result = aiResults[i];
          if (result) {
            if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = result.subject || "";
            if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = result.body || "";
            personalizedCount++;
          } else {
            // Fallback
            const firstName = contacts[i].firstName;
            const company = contacts[i].company;
            if (enhancedSubjectIdx !== -1) batch[i][enhancedSubjectIdx] = `Quick question for ${firstName}`;
            if (enhancedBodyIdx !== -1) batch[i][enhancedBodyIdx] = `Hi ${firstName},\n\nHope this finds you well. I wanted to reach out about ${company}.\n\nBest,\nWebFixx Team`;
            personalizedCount++;
          }
        }
      }

      // Social message personalization
      if (channel === "social" && enhancedSocialMsgIdx !== -1) {
        const socialContacts = batch.map(row => ({
          username: socialUsernameIdx !== -1 ? row[socialUsernameIdx]?.trim() || "" : "",
          platform: socialPlatformIdx !== -1 ? row[socialPlatformIdx]?.trim() || "" : "",
          firstName: firstNameIdx !== -1 ? row[firstNameIdx]?.trim() || "there" : "there",
          context: contextIdx !== -1 ? row[contextIdx]?.trim() || "" : ""
        }));

        const aiResults = await personalizeSocialBatch(socialContacts, personalizationPrompt);

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

      // Live flush after each batch
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

    // 6. Final flush
    logger.info(`[Personalize Campaign] Final CSV flush to Drive: ${fileId}`);
    await drive.files.update({
      fileId,
      media: { mimeType: "text/csv", body: stringifyCSV(rows) }
    });

    // 7. Update campaign settings
    await updateCampaignSettings(campaignId, { personalizationStatus: "completed" });

    return NextResponse.json({
      success: true,
      message: "Campaign personalization completed successfully",
      total: dataRows.length,
      personalized: personalizedCount
    });

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
