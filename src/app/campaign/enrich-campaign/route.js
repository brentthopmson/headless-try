import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
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

const GENERIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "mail.com", "zoho.com", "yandex.com", "protonmail.com", "proton.me", "gmx.com",
  "mail.ru", "live.com", "msn.com", "googlemail.com"
]);

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function inferFirstName(email) {
  if (!email) return "";
  const username = email.split("@")[0];
  // split on non-alphabetic parts (dots, dashes, underscores, digits)
  const parts = username.split(/[\._\-0-9]+/);
  // find first non-empty word
  for (const part of parts) {
    if (part.length > 1) {
      return capitalize(part);
    }
  }
  return username ? capitalize(username) : "";
}

function inferCompany(email) {
  if (!email) return "";
  const parts = email.split("@");
  if (parts.length !== 2) return "";
  const domain = parts[1].toLowerCase().trim();
  if (GENERIC_DOMAINS.has(domain)) {
    return "Personal";
  }
  // Remove domain extension (.com, .co.uk, etc.)
  const domainName = domain.split(".")[0];
  return capitalize(domainName);
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { campaignId, fileUrl } = body;

    logger.info(`[Enrich Campaign] Received enrichment request for campaign: ${campaignId}`);

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
    logger.info(`[Enrich Campaign] Downloading CSV file: ${fileId}`);
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

    // Prepare columns
    let nameColIndex = headers.indexOf("inferred_first_name");
    let companyColIndex = headers.indexOf("enriched_company");

    if (nameColIndex === -1) {
      headers.push("inferred_first_name");
      nameColIndex = headers.length - 1;
    }
    if (companyColIndex === -1) {
      headers.push("enriched_company");
      companyColIndex = headers.length - 1;
    }

    let enrichedCount = 0;

    // 2. Enrich profile row-by-row
    logger.info(`[Enrich Campaign] Performing enrichment for email list...`);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Pad row to match new headers
      while (row.length < headers.length) {
        row.push("");
      }

      const email = row[emailColIndex]?.trim();
      if (!email) {
        row[nameColIndex] = "";
        row[companyColIndex] = "";
        continue;
      }

      // Infer details
      if (!row[nameColIndex]) {
        row[nameColIndex] = inferFirstName(email);
      }
      if (!row[companyColIndex]) {
        row[companyColIndex] = inferCompany(email);
      }
      enrichedCount++;
    }

    // 3. Save modified CSV back to Drive
    logger.info(`[Enrich Campaign] Uploading enriched CSV back to Drive file: ${fileId}`);
    const updatedCSVContent = stringifyCSV(rows);
    await drive.files.update({
      fileId: fileId,
      media: {
        mimeType: "text/csv",
        body: updatedCSVContent
      }
    });

    // 4. Update status in Google Sheets Database
    logger.info(`[Enrich Campaign] Updating enrichmentStatus = 'completed' in Spreadsheet campaigns sheet`);
    const campaignsResult = await getSheetDataApi("campaigns");
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
          logger.warn(`[Enrich Campaign] Failed to parse settings column: ${e.message}`);
        }

        settings.enrichmentStatus = "completed";

        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          settings: JSON.stringify(settings),
          updatedOn: new Date().toLocaleString()
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Campaign enrichment completed successfully",
      total: rows.length - 1,
      enrichedCount
    });

  } catch (error) {
    logger.error(`[Enrich Campaign] Error in enrichment API: ${error.message}`, { stack: error.stack });
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
