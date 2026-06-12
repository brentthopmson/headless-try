import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import geminiHelper from "../../api/gemini.js";
import logger from "../../../utils/logger.js";

export const maxDuration = 60; // Up to 60 seconds
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
    const next = text[i+1];

    if (inQuotes) {
      if (c === '"') {
        if (next === '"') {
          row[row.length - 1] += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        row[row.length - 1] += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push("");
      } else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') {
          i++;
        }
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
  }
  if (row.length > 1 || row[0] !== "") {
    lines.push(row);
  }
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

    // 1. Download CSV content
    logger.info(`[Personalize Campaign] Downloading CSV file: ${fileId}`);
    const driveFile = await drive.files.get({
      fileId: fileId,
      alt: "media"
    });

    const csvContent = driveFile.data;
    if (typeof csvContent !== "string") {
      throw new Error("Failed to download CSV as text content");
    }

    const rows = parseCSV(csvContent);
    if (rows.length === 0) {
      throw new Error("CSV file is empty");
    }

    const headers = rows[0];
    const emailColIndex = headers.findIndex(h => {
      const normalized = h.toLowerCase().trim();
      return normalized === "email" || normalized === "mail" || normalized === "email address";
    });

    if (emailColIndex === -1) {
      throw new Error("No email column found in the CSV file headers.");
    }

    // Identify name and company columns, falling back to inferred ones if present
    let nameColIndex = headers.findIndex(h => {
      const normalized = h.toLowerCase().trim();
      return normalized === "first name" || normalized === "name" || normalized === "inferred_first_name";
    });
    if (nameColIndex === -1) {
      nameColIndex = headers.indexOf("inferred_first_name");
    }

    let companyColIndex = headers.findIndex(h => {
      const normalized = h.toLowerCase().trim();
      return normalized === "company" || normalized === "organization" || normalized === "enriched_company";
    });
    if (companyColIndex === -1) {
      companyColIndex = headers.indexOf("enriched_company");
    }

    // Prepare subject and message columns
    let subjectColIndex = headers.indexOf("subject");
    let messageColIndex = headers.indexOf("message");

    if (subjectColIndex === -1) {
      headers.push("subject");
      subjectColIndex = headers.length - 1;
    }
    if (messageColIndex === -1) {
      headers.push("message");
      messageColIndex = headers.length - 1;
    }

    // 2. Fetch campaign details to grab personalization prompt
    logger.info(`[Personalize Campaign] Fetching personalization prompt from sheets...`);
    let personalizationPrompt = "Write a short, highly professional cold outreach email. Address the recipient by their first name and reference their company. Keep it engaging, under 150 words, and clear in value. Vary subject lines.";
    
    const campaignsResult = await getSheetDataApi("campaigns");
    if (campaignsResult.success) {
      const cHeaders = campaignsResult.headers;
      const cIdIndex = cHeaders.indexOf("campaignId");
      const cSettingsIndex = cHeaders.indexOf("settings");
      const cContextIndex = cHeaders.indexOf("context");

      const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
      if (campaignRow) {
        if (cSettingsIndex !== -1) {
          const settingsStr = campaignRow[cSettingsIndex];
          try {
            const settings = typeof settingsStr === "string" ? JSON.parse(settingsStr) : (settingsStr || {});
            if (settings.aiPersonalizationPrompt) {
              personalizationPrompt = settings.aiPersonalizationPrompt;
            }
          } catch (e) {
            logger.warn(`[Personalize Campaign] Settings parse failed: ${e.message}`);
          }
        }
        // Fallback to context column if set
        if (cContextIndex !== -1 && campaignRow[cContextIndex]) {
          const contextVal = campaignRow[cContextIndex];
          try {
            // Check if context column contains JSON
            const contextJson = typeof contextVal === "string" ? JSON.parse(contextVal) : contextVal;
            if (contextJson && contextJson.personalizationPrompt) {
              personalizationPrompt = contextJson.personalizationPrompt;
            } else if (typeof contextVal === "string" && contextVal.length > 10) {
              personalizationPrompt = contextVal;
            }
          } catch (e) {
            if (typeof contextVal === "string" && contextVal.length > 10) {
              personalizationPrompt = contextVal;
            }
          }
        }
      }
    }

    logger.info(`[Personalize Campaign] Using prompt: "${personalizationPrompt.substring(0, 100)}..."`);

    // 3. Generate personalized emails in batches to optimize speed and rates
    const maxPersonalizedRows = 50; // Cap to prevent Vercel 60s timeout
    const rowsToProcess = Math.min(rows.length, maxPersonalizedRows + 1);

    logger.info(`[Personalize Campaign] Processing ${rowsToProcess - 1} rows with Gemini AI...`);
    const batchSize = 5;
    for (let i = 1; i < rowsToProcess; i += batchSize) {
      const batchPromises = [];
      for (let j = i; j < Math.min(i + batchSize, rowsToProcess); j++) {
        const row = rows[j];
        while (row.length < headers.length) {
          row.push("");
        }

        const email = row[emailColIndex]?.trim();
        if (!email) continue;

        const firstName = nameColIndex !== -1 && row[nameColIndex] ? row[nameColIndex] : "there";
        const company = companyColIndex !== -1 && row[companyColIndex] ? row[companyColIndex] : "your company";

        const prompt = `You are an expert personalized outreach copywriter. Generate a highly tailored cold email subject line and email body for the following recipient:
- First Name: ${firstName}
- Company: ${company}
- Email: ${email}

Context and Instructions for email tone and objective:
"${personalizationPrompt}"

Rules:
1. Vary the subject line to be engaging and personalized.
2. The email body must be professional, natural, concise, and have a clear call-to-action.
3. Return the response strictly as a valid JSON object matching this exact structure:
{
  "subject": "Tailored subject line",
  "body": "Tailored email body"
}
Do NOT return any markdown backticks, explanations, or surrounding text. Return ONLY the JSON object.`;

        const promise = (async () => {
          try {
            if (!geminiHelper.model) {
              throw new Error("Gemini model not initialized");
            }
            const result = await geminiHelper.model.generateContent(prompt);
            const responseText = result.response.text().trim();
            
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              row[subjectColIndex] = parsed.subject || `Quick question for ${firstName}`;
              row[messageColIndex] = parsed.body || `Hi ${firstName},\n\nHope you are well. Let's connect.\n\nBest,\nWebFixx`;
            } else {
              throw new Error("No JSON object found in response");
            }
          } catch (err) {
            logger.warn(`[Personalize Campaign] Failed to personalize for ${email}: ${err.message}`);
            row[subjectColIndex] = `Quick question for ${firstName}`;
            row[messageColIndex] = `Hi ${firstName},\n\nHope this finds you well. I wanted to reach out to you at ${company}.\n\nBest,\nWebFixx Team`;
          }
        })();
        batchPromises.push(promise);
      }
      await Promise.all(batchPromises);
    }

    // Handle remaining rows beyond cap with simple fallback
    for (let i = rowsToProcess; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < headers.length) {
        row.push("");
      }
      const firstName = nameColIndex !== -1 && row[nameColIndex] ? row[nameColIndex] : "there";
      const company = companyColIndex !== -1 && row[companyColIndex] ? row[companyColIndex] : "your company";
      row[subjectColIndex] = `Quick question for ${firstName}`;
      row[messageColIndex] = `Hi ${firstName},\n\nHope this finds you well. I wanted to reach out to you at ${company}.\n\nBest,\nWebFixx Team`;
    }

    // 4. Save modified CSV back to Drive
    logger.info(`[Personalize Campaign] Uploading personalized CSV back to Drive file: ${fileId}`);
    const updatedCSVContent = stringifyCSV(rows);
    await drive.files.update({
      fileId: fileId,
      media: {
        mimeType: "text/csv",
        body: updatedCSVContent
      }
    });

    // 5. Update status in Google Sheets Database
    logger.info(`[Personalize Campaign] Updating personalizationStatus = 'completed' in Spreadsheet campaigns sheet`);
    if (campaignsResult.success) {
      const cHeaders = campaignsResult.headers;
      const cIdIndex = cHeaders.indexOf("campaignId");
      const cSettingsIndex = cHeaders.indexOf("settings");

      const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
      if (campaignRow && cSettingsIndex !== -1) {
        const settingsStr = campaignRow[cSettingsIndex];
        let settings = {};
        try {
          settings = typeof settingsStr === "string" ? JSON.parse(settingsStr) : (settingsStr || {});
        } catch (e) {
          logger.warn(`[Personalize Campaign] Failed to parse settings column: ${e.message}`);
        }

        settings.personalizationStatus = "completed";

        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          settings: JSON.stringify(settings),
          updatedOn: new Date().toLocaleString()
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Campaign personalization completed successfully",
      total: rows.length - 1,
      personalized: rowsToProcess - 1
    });

  } catch (error) {
    logger.error(`[Personalize Campaign] Error in personalization API: ${error.message}`, { stack: error.stack });
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
