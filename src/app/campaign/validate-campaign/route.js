import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import dns from "dns";
import { promisify } from "util";
import logger from "../../../utils/logger.js";

const resolveMx = promisify(dns.resolveMx);

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

    logger.info(`[Validate Campaign] Received validation request for campaign: ${campaignId}`);

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
    logger.info(`[Validate Campaign] Downloading CSV file: ${fileId}`);
    const driveFile = await drive.files.get({
      fileId: fileId,
      alt: "media"
    });

    const csvContent = driveFile.data;
    if (typeof csvContent !== "string") {
      throw new Error("Failed to download CSV as text content");
    }

    // Strip BOM if present
    const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

    const rows = parseCSV(cleanContent);
    if (rows.length === 0) {
      throw new Error("CSV file is empty");
    }
    if (rows.length === 1) {
      throw new Error("CSV file contains only headers with no data rows");
    }

    const headers = rows[0];
    if (headers.length === 0) {
      throw new Error("CSV file has no headers");
    }

    // Validate row consistency: all rows should have the same number of columns
    const headerCount = headers.length;
    let inconsistentRows = 0;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length !== headerCount) {
        inconsistentRows++;
      }
    }
    if (inconsistentRows > 0) {
      const pct = ((inconsistentRows / (rows.length - 1)) * 100).toFixed(1);
      logger.warn(`[Validate Campaign] ${inconsistentRows}/${rows.length - 1} (${pct}%) data rows have inconsistent column counts (expected ${headerCount} columns).`);
    }

    // Check for required columns
    const normalizedHeaders = headers.map(h => h.toLowerCase().trim());
    const emailColIndex = normalizedHeaders.findIndex(h => {
      return h === "email" || h === "mail" || h === "email address" || h === "e-mail";
    });
    if (emailColIndex === -1) {
      throw new Error("No email column found in the CSV file headers. Expected column named 'email', 'mail', or 'email address'.");
    }

    // Check for useful columns and log warnings if missing
    const RECOMMENDED_COLUMNS = ['firstname', 'first name', 'fname', 'lastname', 'last name', 'lname', 'company', 'businessname'];
    const hasNameColumn = normalizedHeaders.some(h => RECOMMENDED_COLUMNS.includes(h));
    if (!hasNameColumn) {
      logger.warn(`[Validate Campaign] CSV is missing a first name/last name column. Recipients will be addressed as 'there'.`);
    }

    // Prepare columns
    let valColIndex = headers.indexOf("validation_status");
    let mxColIndex = headers.indexOf("mx_record");

    if (valColIndex === -1) {
      headers.push("validation_status");
      valColIndex = headers.length - 1;
    }
    if (mxColIndex === -1) {
      headers.push("mx_record");
      mxColIndex = headers.length - 1;
    }

    let validCount = 0;
    let invalidCount = 0;

    // 2. Validate email domains using MX records check
    logger.info(`[Validate Campaign] Checking MX records for email list in CSV...`);
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      // Pad row to match new headers
      while (row.length < headers.length) {
        row.push("");
      }

      const email = row[emailColIndex]?.trim();
      if (!email) {
        row[valColIndex] = "empty";
        row[mxColIndex] = "none";
        invalidCount++;
        continue;
      }

      const parts = email.split("@");
      if (parts.length !== 2) {
        row[valColIndex] = "invalid_format";
        row[mxColIndex] = "none";
        invalidCount++;
        continue;
      }

      const domain = parts[1].toLowerCase().trim();

      try {
        const mxRecords = await resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          row[valColIndex] = "valid";
          row[mxColIndex] = mxRecords[0].exchange;
          validCount++;
        } else {
          row[valColIndex] = "no_mx_records";
          row[mxColIndex] = "none";
          invalidCount++;
        }
      } catch (err) {
        logger.warn(`[Validate Campaign] MX Lookup failed for domain ${domain}: ${err.message}`);
        row[valColIndex] = "invalid_domain";
        row[mxColIndex] = "error";
        invalidCount++;
      }
    }

    // 3. Save modified CSV back to Drive
    logger.info(`[Validate Campaign] Uploading validated CSV back to Drive file: ${fileId}`);
    const updatedCSVContent = stringifyCSV(rows);
    await drive.files.update({
      fileId: fileId,
      media: {
        mimeType: "text/csv",
        body: updatedCSVContent
      }
    });

    // 4. Update status in Google Sheets Database
    logger.info(`[Validate Campaign] Updating validationStatus = 'completed' in Spreadsheet campaigns sheet`);
    const campaignsResult = await getSheetDataApi("campaigns");
    if (campaignsResult.success) {
      const cHeaders = campaignsResult.headers;
      const cIdIndex = cHeaders.indexOf("campaignId");
      const cSettingsIndex = cHeaders.indexOf("settings");

      const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
      if (campaignRow && cSettingsIndex !== -1) {
        const settingsStr = campaignRow[cSettingsIndex];
        let settings = {};
        let settingsParseError = null;
        try {
          if (typeof settingsStr === "string") {
            settings = JSON.parse(settingsStr);
            if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
              settings = {};
              settingsParseError = 'Parsed settings is not a plain object';
            }
          } else if (settingsStr && typeof settingsStr === 'object') {
            settings = settingsStr;
          } else {
            settings = {};
            settingsParseError = 'Settings is not a string or object';
          }
        } catch (e) {
          settingsParseError = e.message;
          logger.error(`[Validate Campaign] Failed to parse settings JSON for campaign ${campaignId}: ${e.message}. Raw value: ${String(settingsStr).substring(0, 200)}`);
        }
        if (settingsParseError) {
          settings._parseError = settingsParseError;
        }

        settings.validationStatus = "completed";

        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          settings: JSON.stringify(settings),
          updatedOn: new Date().toLocaleString()
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Campaign email validation completed successfully",
      total: rows.length - 1,
      valid: validCount,
      invalid: invalidCount
    });

  } catch (error) {
    logger.error(`[Validate Campaign] Error in validation API: ${error.message}`, { stack: error.stack });
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
