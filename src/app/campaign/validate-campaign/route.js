import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import dns from "dns";
import { promisify } from "util";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { launchBrowser } from "../../../utils/utils.js";
import { platformConfigs } from "../../emails/cookie/cookie-api-login/platforms.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete, getDriveClient } from "../../../utils/multiServerDispatcher.js";

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const STANDARD_88_COLUMNS = [
  'SN',
  'FIRSTNAME', 'LASTNAME', 'EMAIL', 'ADDRESS', 'CITY', 'STATE', 'COUNTRY', 'ZIPCODE', 'PHONE', 'SEX',
  'BUSINESSNAME', 'BUSINESSADDRESS', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'BUSINESSZIPCODE', 'BUSINESSPHONE', 'BUSINESSEMAIL',
  'SOCIALPLATFORM', 'SOCIALUSERNAME', 'SOCIALPHONE',
  'CONTEXT',
  'URL', '', '', '', '', '',
  'campaignType', 'engine', 'provider',
  'shooterFirstName', 'shooterLastName', 'shooterEmail', 'shooterAddress', 'shooterCity', 'shooterState', 'shooterCountry', 'shooterZipCode', 'shooterPhone', 'shooterSex',
  'smtp', 'port', 'username', 'password', 'appPassword', 'backupCode', 'oAuth2ClientId', 'oAuth2ClientSecret', 'oAuth2RefreshToken',
  '',
  'shouldValidate', 'shouldEnhance', 'shouldSearchInteract', 'shouldPageInteract', 'shouldInboxInteract', 'shouldActivitiesInteract', 'shouldSendMessage',
  '', '',
  'emailSubject', 'emailBody', 'socialMessage', 'replyTo',
  '', '', '',
  'validation', 'providerMXResult', 'enhancedSubject', 'enhancedBody', 'enhancedSocialMessage',
  '', '',
  'sendDate', 'sendTime', 'sendStamp',
  '', '', '',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  '',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp'
];

const FUZZY_MAP = {
  EMAIL: ['EMAIL', 'MAIL', 'E-MAIL', 'LEAD'],
  FIRSTNAME: ['FIRST', 'FIRST NAME', 'FNAME', 'GIVEN'],
  LASTNAME: ['LAST', 'LAST NAME', 'LNAME', 'SURNAME', 'FAMILY'],
  ADDRESS: ['ADDRESS', 'STREET'],
  CITY: ['CITY', 'TOWN'],
  STATE: ['STATE', 'PROVINCE', 'REGION'],
  COUNTRY: ['COUNTRY', 'NATION'],
  ZIPCODE: ['ZIP', 'ZIPCODE', 'ZIP CODE', 'POSTAL', 'POSTCODE'],
  PHONE: ['PHONE', 'PHONENUMBER', 'PHONE NUMBER', 'TELEPHONE', 'TEL', 'MOBILE', 'CELL'],
  SEX: ['SEX', 'GENDER'],
  BUSINESSNAME: ['BUSINESS', 'BUSINESS NAME', 'COMPANY', 'ORGANIZATION', 'ORG'],
  BUSINESSADDRESS: ['BUSINESS ADDRESS', 'COMPANY ADDRESS'],
  BUSINESSCITY: ['BUSINESS CITY', 'COMPANY CITY'],
  BUSINESSSTATE: ['BUSINESS STATE', 'COMPANY STATE'],
  BUSINESSCOUNTRY: ['BUSINESS COUNTRY', 'COMPANY COUNTRY'],
  BUSINESSZIPCODE: ['BUSINESS ZIP', 'BUSINESS POSTAL', 'COMPANY ZIP'],
  BUSINESSPHONE: ['BUSINESS PHONE', 'COMPANY PHONE'],
  BUSINESSEMAIL: ['BUSINESS EMAIL', 'COMPANY EMAIL'],
  SOCIALPLATFORM: ['SOCIAL', 'SOCIAL PLATFORM', 'PLATFORM'],
  SOCIALUSERNAME: ['SOCIAL USERNAME', 'USERNAME', 'HANDLE', 'SOCIAL HANDLE'],
  SOCIALPHONE: ['SOCIAL PHONE'],
  URL: ['URL', 'LINK', 'WEBSITE', 'WEB', 'REFERENCE']
};

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[0] ? matches[1] : null : null;
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
      } else {
        row[row.length - 1] += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(""); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
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

function normalizeAndMapCSV(rawCsvContent, targetSchema) {
  const parsedRows = parseCSV(rawCsvContent);
  if (parsedRows.length === 0) return [];

  const rawHeaders = parsedRows[0].map(h => h.trim().toUpperCase());
  const dataRows = parsedRows.slice(1);

  const normalizedRows = [];
  const headerMap = new Map();

  targetSchema.forEach((stdHeader, index) => {
    if (!stdHeader) return;
    const upperStd = stdHeader.toUpperCase();
    const exactIdx = rawHeaders.indexOf(upperStd);
    if (exactIdx !== -1) { headerMap.set(index, exactIdx); return; }
    const fuzzyKeys = FUZZY_MAP[upperStd];
    if (fuzzyKeys) {
      for (const alias of fuzzyKeys) {
        const aliasIdx = rawHeaders.findIndex(rh => rh === alias || rh.includes(alias));
        if (aliasIdx !== -1) { headerMap.set(index, aliasIdx); return; }
      }
    }
  });

  normalizedRows.push(targetSchema);

  dataRows.forEach((row, idx) => {
    const newRow = new Array(targetSchema.length).fill('');
    targetSchema.forEach((_, stdIndex) => {
      if (headerMap.has(stdIndex)) {
        const rawIndex = headerMap.get(stdIndex);
        newRow[stdIndex] = row[rawIndex] !== undefined && row[rawIndex] !== null ? String(row[rawIndex]) : '';
      }
    });
    if (!headerMap.has(0) && targetSchema[0] && String(targetSchema[0]).toUpperCase() === 'SN') {
      newRow[0] = String(idx + 1);
    }
    normalizedRows.push(newRow);
  });

  return normalizedRows;
}

function detectPlatform(domain) {
  for (const [name, config] of Object.entries(platformConfigs)) {
    if (config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw))) {
      return name;
    }
  }
  return null;
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
    logger.warn(`[Validate Campaign] Pause check failed for ${campaignId}: ${err.message}`);
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
    logger.warn(`[Validate Campaign] Failed to update campaign settings: ${err.message}`);
  }
}

export async function POST(request) {
  let browser = null;
  try {
    const body = await request.json();
    const { campaignId, fileUrl, serverBatch } = body;

    logger.info(`[Validate Campaign] Received validation request for campaign: ${campaignId}${serverBatch ? ` [worker rowStart=${serverBatch.rowStart} rowEnd=${serverBatch.rowEnd}]` : ''}`);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
    }

    // ─── WORKER MODE ────────────────────────────────────────────────
    if (serverBatch) {
      return await handleWorkerMode(campaignId, fileId, serverBatch);
    }

    // ─── COORDINATOR / SINGLE-SERVER MODE ──────────────────────────
    return await handleCoordinatorMode(campaignId, fileId, fileUrl);

  } catch (error) {
    logger.error(`[Validate Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

/**
 * Coordinator mode: check multi-server, dispatch if enabled, otherwise run single-server.
 */
async function handleCoordinatorMode(campaignId, fileId, fileUrl) {
  const authClient = await getSheetsAuthClient();
  if (!authClient) {
    return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
  }
  const drive = google.drive({ version: "v3", auth: authClient });

  // Read batch limits from SETTINGS
  const mxBatchSetting = await getSetting('validateBatchLimit');
  const MX_BATCH_SIZE = parseInt(mxBatchSetting?.value1) || 20;
  const platformBatchSetting = await getSetting('platformVerificationBatchLimit');
  const PLATFORM_BATCH_SIZE = parseInt(platformBatchSetting?.value1) || 5;
  const platformEnabledSetting = await getSetting('platformVerificationEnabled');
  const PLATFORM_VERIFICATION_ENABLED = platformEnabledSetting?.value1 !== 'false';

  // 1. Download CSV
  logger.info(`[Validate Campaign] Downloading CSV file: ${fileId}`);
  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV as text content");

  const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

  // 2. Normalize to 88-column schema
  const normalizedRows = normalizeAndMapCSV(cleanContent, STANDARD_88_COLUMNS);
  if (normalizedRows.length <= 1) {
    throw new Error("CSV file is empty or contains no data rows after normalization");
  }

  const headers = normalizedRows[0];
  const emailColIdx = headers.indexOf("EMAIL");
  const validationIdx = headers.indexOf("validation");
  const providerMXIdx = headers.indexOf("providerMXResult");

  if (emailColIdx === -1) throw new Error("EMAIL column not found in 88-column schema");

  const dataRows = normalizedRows.slice(1);

  // 3. Dedup by email
  const uniqueEmails = new Map();
  let duplicateCount = 0;
  for (let i = 0; i < dataRows.length; i++) {
    const email = dataRows[i][emailColIdx]?.trim().toLowerCase();
    if (!email) continue;
    if (uniqueEmails.has(email)) {
      dataRows[i][validationIdx] = "duplicate";
      duplicateCount++;
    } else {
      uniqueEmails.set(email, i);
    }
  }
  if (duplicateCount > 0) {
    logger.info(`[Validate Campaign] Marked ${duplicateCount} duplicate emails`);
  }

  // 3b. Social channel validation
  const socialPlatformIdx = headers.indexOf("SOCIALPLATFORM");
  const socialUsernameIdx = headers.indexOf("SOCIALUSERNAME");
  if (socialPlatformIdx !== -1 && socialUsernameIdx !== -1) {
    for (const row of dataRows) {
      if (row[validationIdx] === "duplicate") continue;
      const email = row[emailColIdx]?.trim();
      const socialUsername = row[socialUsernameIdx]?.trim();
      const socialPlatform = row[socialPlatformIdx]?.trim();
      if (!email && socialUsername) {
        row[validationIdx] = socialPlatform ? "social_valid" : "social_no_platform";
      }
    }
  }

  // ─── MULTI-SERVER DISPATCH ─────────────────────────────────────
  if (await isMultiServerEnabled()) {
    const dispatchResult = await dispatchToServers(campaignId, 'validate', fileUrl, dataRows.length);
    if (dispatchResult) {
      return NextResponse.json({
        success: true,
        message: `Campaign validation distributed across ${dispatchResult.servers.length} servers`,
        dispatched: true,
        servers: dispatchResult.servers,
      });
    }
  }

  // ─── SINGLE-SERVER FALLBACK ────────────────────────────────────
  logger.info(`[Validate Campaign] MX batch=${MX_BATCH_SIZE}, platform batch=${PLATFORM_BATCH_SIZE}, platform verification=${PLATFORM_VERIFICATION_ENABLED}`);
  logger.info(`[Validate Campaign] Processing ${dataRows.length} rows (single-server)`);

  // 4. MX Record Check (batched)
  const mxCache = new Map();
  let validCount = 0;
  let invalidCount = 0;

  const nonDuplicateRows = dataRows.filter(r => r[validationIdx] !== "duplicate");
  const mxBatchCount = Math.ceil(nonDuplicateRows.length / MX_BATCH_SIZE);

  for (let batchIdx = 0; batchIdx < mxBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Validate Campaign] Campaign paused at MX batch ${batchIdx + 1}/${mxBatchCount}`);
      break;
    }

    const start = batchIdx * MX_BATCH_SIZE;
    const end = Math.min(start + MX_BATCH_SIZE, nonDuplicateRows.length);
    const batch = nonDuplicateRows.slice(start, end);

    const mxPromises = batch.map(async (row) => {
      const email = row[emailColIdx]?.trim();
      if (!email) { row[validationIdx] = "empty"; return; }

      const parts = email.split("@");
      if (parts.length !== 2) { row[validationIdx] = "invalid_format"; return; }

      const domain = parts[1].toLowerCase().trim();

      if (mxCache.has(domain)) {
        const cached = mxCache.get(domain);
        row[validationIdx] = cached.status;
        row[providerMXIdx] = cached.mx;
        return;
      }

      try {
        const mxRecords = await resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          row[validationIdx] = "valid_mx";
          row[providerMXIdx] = mxRecords[0].exchange;
          mxCache.set(domain, { status: "valid_mx", mx: mxRecords[0].exchange });
          validCount++;
        } else {
          row[validationIdx] = "no_mx";
          row[providerMXIdx] = "none";
          mxCache.set(domain, { status: "no_mx", mx: "none" });
          invalidCount++;
        }
      } catch (err) {
        row[validationIdx] = "invalid_domain";
        row[providerMXIdx] = "error";
        mxCache.set(domain, { status: "invalid_domain", mx: "error" });
        invalidCount++;
      }
    });

    await Promise.allSettled(mxPromises);

    try {
      await drive.files.update({
        fileId,
        media: { mimeType: "text/csv", body: stringifyCSV(normalizedRows) }
      });
    } catch (flushErr) {
      logger.warn(`[Validate Campaign] Live CSV flush failed at MX batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    logger.info(`[Validate Campaign] MX batch ${batchIdx + 1}/${mxBatchCount} complete (${validCount} valid, ${invalidCount} invalid so far)`);
  }

  // 5. Platform Browser Verification (batched)
  if (PLATFORM_VERIFICATION_ENABLED) {
    const platformEmails = dataRows.filter(r => {
      const email = r[emailColIdx]?.trim();
      if (!email || r[validationIdx] !== "valid_mx") return false;
      const domain = email.split("@")[1]?.toLowerCase().trim();
      return domain && detectPlatform(domain);
    });

    if (platformEmails.length > 0) {
      logger.info(`[Validate Campaign] ${platformEmails.length} emails match known platforms, verifying...`);
      const platformBatchCount = Math.ceil(platformEmails.length / PLATFORM_BATCH_SIZE);

      for (let batchIdx = 0; batchIdx < platformBatchCount; batchIdx++) {
        if (await isCampaignPaused(campaignId)) break;

        const start = batchIdx * PLATFORM_BATCH_SIZE;
        const end = Math.min(start + PLATFORM_BATCH_SIZE, platformEmails.length);
        const batch = platformEmails.slice(start, end);

        let platformBrowser = null;
        try {
          platformBrowser = await launchBrowser({ headless: true });
          const page = (await platformBrowser.pages())[0] || await platformBrowser.newPage();

          for (const row of batch) {
            const email = row[emailColIdx]?.trim();
            if (!email) continue;

            const domain = email.split("@")[1]?.toLowerCase().trim();
            const platform = detectPlatform(domain);
            if (!platform || !platformConfigs[platform]) continue;

            const config = platformConfigs[platform];
            try {
              await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
              const inputSelector = config.selectors?.input;
              if (!inputSelector) { row[validationIdx] = "platform_no_selector"; continue; }
              await page.waitForSelector(inputSelector, { visible: true, timeout: 8000 });
              await page.type(inputSelector, email, { delay: 30 });
              const nextSelector = config.selectors?.nextButton;
              if (nextSelector) { try { await page.click(nextSelector); await new Promise(r => setTimeout(r, 2000)); } catch {} }

              const pageContent = await page.content();
              const errorPatterns = ["Couldn't find your Google Account", "Enter a valid email", "We couldn't find an account", "That account doesn't exist", "Incorrect email or password", "isn't a valid email"];
              const hasError = errorPatterns.some(p => pageContent.includes(p));
              row[validationIdx] = hasError ? "not_exists" : "verified_exists";
              row[providerMXIdx] = platform;
            } catch (err) {
              row[validationIdx] = "unverifiable";
            }
          }
        } catch (browserErr) {
          for (const row of batch) { if (row[validationIdx] === "valid_mx") row[validationIdx] = "unverifiable"; }
        } finally {
          if (platformBrowser) { try { await platformBrowser.close(); } catch {} }
        }

        try {
          await drive.files.update({ fileId, media: { mimeType: "text/csv", body: stringifyCSV(normalizedRows) } });
        } catch {}
      }
    }
  }

  // 6. Final flush
  await drive.files.update({ fileId, media: { mimeType: "text/csv", body: stringifyCSV(normalizedRows) } });
  await updateCampaignSettings(campaignId, { validationStatus: "completed" });

  const stats = {
    total: dataRows.length,
    duplicates: duplicateCount,
    validMx: validCount,
    invalidMx: invalidCount,
    verifiedExists: dataRows.filter(r => r[validationIdx] === "verified_exists").length,
    notExists: dataRows.filter(r => r[validationIdx] === "not_exists").length,
    unverifiable: dataRows.filter(r => r[validationIdx] === "unverifiable").length,
  };

  return NextResponse.json({ success: true, message: "Campaign email validation completed successfully", stats });
}

/**
 * Worker mode: process only the assigned row range.
 */
async function handleWorkerMode(campaignId, fileId, serverBatch) {
  const myAssignment = await findMyAssignment(campaignId, 'validate');
  if (!myAssignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  }

  await updateMyAssignment(campaignId, 'validate', { status: 'running' });

  const drive = await getDriveClient();
  if (!drive) {
    return NextResponse.json({ success: false, error: "Failed to get Drive client" }, { status: 500 });
  }

  // Read SETTINGS
  const mxBatchSetting = await getSetting('validateBatchLimit');
  const MX_BATCH_SIZE = parseInt(mxBatchSetting?.value1) || 20;
  const platformBatchSetting = await getSetting('platformVerificationBatchLimit');
  const PLATFORM_BATCH_SIZE = parseInt(platformBatchSetting?.value1) || 5;
  const platformEnabledSetting = await getSetting('platformVerificationEnabled');
  const PLATFORM_VERIFICATION_ENABLED = platformEnabledSetting?.value1 !== 'false';

  // 1. Download full CSV
  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV");
  const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

  // 2. Normalize
  const normalizedRows = normalizeAndMapCSV(cleanContent, STANDARD_88_COLUMNS);
  if (normalizedRows.length <= 1) throw new Error("CSV empty after normalization");

  const headers = normalizedRows[0];
  const emailColIdx = headers.indexOf("EMAIL");
  const validationIdx = headers.indexOf("validation");
  const providerMXIdx = headers.indexOf("providerMXResult");

  if (emailColIdx === -1) throw new Error("EMAIL column not found");

  // 3. Extract assigned rows
  const { rowStart, rowEnd } = serverBatch;
  logger.info(`[Validate Campaign][Worker] Processing rows ${rowStart}-${rowEnd - 1}`);

  // 4. MX Record Check on assigned rows
  const mxCache = new Map();
  let validCount = 0;
  let invalidCount = 0;

  for (let i = rowStart; i < rowEnd; i++) {
    const fullIdx = i + 1; // +1 for header
    if (fullIdx >= normalizedRows.length) break;
    const row = normalizedRows[fullIdx];

    if (await isCampaignPaused(campaignId)) break;

    const email = row[emailColIdx]?.trim();
    if (!email) { row[validationIdx] = "empty"; continue; }

    const parts = email.split("@");
    if (parts.length !== 2) { row[validationIdx] = "invalid_format"; continue; }

    const domain = parts[1].toLowerCase().trim();

    if (mxCache.has(domain)) {
      const cached = mxCache.get(domain);
      row[validationIdx] = cached.status;
      row[providerMXIdx] = cached.mx;
      if (cached.status === "valid_mx") validCount++;
      else invalidCount++;
      continue;
    }

    try {
      const mxRecords = await resolveMx(domain);
      if (mxRecords && mxRecords.length > 0) {
        row[validationIdx] = "valid_mx";
        row[providerMXIdx] = mxRecords[0].exchange;
        mxCache.set(domain, { status: "valid_mx", mx: mxRecords[0].exchange });
        validCount++;
      } else {
        row[validationIdx] = "no_mx";
        row[providerMXIdx] = "none";
        mxCache.set(domain, { status: "no_mx", mx: "none" });
        invalidCount++;
      }
    } catch (err) {
      row[validationIdx] = "invalid_domain";
      row[providerMXIdx] = "error";
      mxCache.set(domain, { status: "invalid_domain", mx: "error" });
      invalidCount++;
    }

    // Checkpoint flush every MX_BATCH_SIZE rows
    if ((i - rowStart + 1) % MX_BATCH_SIZE === 0) {
      await updateMyAssignment(campaignId, 'validate', { processedUpTo: i + 1 });
      await mergeAndFlush(drive, fileId, normalizedRows, normalizedRows, rowStart, rowEnd, stringifyCSV);
    }
  }

  // 5. Platform Browser Verification on assigned rows
  if (PLATFORM_VERIFICATION_ENABLED) {
    const platformEmails = [];
    for (let i = rowStart; i < rowEnd; i++) {
      const fullIdx = i + 1;
      if (fullIdx >= normalizedRows.length) break;
      const row = normalizedRows[fullIdx];
      const email = row[emailColIdx]?.trim();
      if (email && row[validationIdx] === "valid_mx") {
        const domain = email.split("@")[1]?.toLowerCase().trim();
        if (domain && detectPlatform(domain)) platformEmails.push({ row, index: i });
      }
    }

    if (platformEmails.length > 0) {
      const platformBatchCount = Math.ceil(platformEmails.length / PLATFORM_BATCH_SIZE);
      for (let batchIdx = 0; batchIdx < platformBatchCount; batchIdx++) {
        if (await isCampaignPaused(campaignId)) break;
        const batch = platformEmails.slice(batchIdx * PLATFORM_BATCH_SIZE, (batchIdx + 1) * PLATFORM_BATCH_SIZE);

        let platformBrowser = null;
        try {
          platformBrowser = await launchBrowser({ headless: true });
          const page = (await platformBrowser.pages())[0] || await platformBrowser.newPage();

          for (const { row } of batch) {
            const email = row[emailColIdx]?.trim();
            if (!email) continue;
            const domain = email.split("@")[1]?.toLowerCase().trim();
            const platform = detectPlatform(domain);
            if (!platform || !platformConfigs[platform]) continue;

            const config = platformConfigs[platform];
            try {
              await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
              const inputSelector = config.selectors?.input;
              if (!inputSelector) { row[validationIdx] = "platform_no_selector"; continue; }
              await page.waitForSelector(inputSelector, { visible: true, timeout: 8000 });
              await page.type(inputSelector, email, { delay: 30 });
              const nextSelector = config.selectors?.nextButton;
              if (nextSelector) { try { await page.click(nextSelector); await new Promise(r => setTimeout(r, 2000)); } catch {} }

              const pageContent = await page.content();
              const errorPatterns = ["Couldn't find your Google Account", "Enter a valid email", "We couldn't find an account", "That account doesn't exist", "Incorrect email or password", "isn't a valid email"];
              row[validationIdx] = errorPatterns.some(p => pageContent.includes(p)) ? "not_exists" : "verified_exists";
              row[providerMXIdx] = platform;
            } catch {
              row[validationIdx] = "unverifiable";
            }
          }
        } catch {
          for (const { row } of batch) { if (row[validationIdx] === "valid_mx") row[validationIdx] = "unverifiable"; }
        } finally {
          if (platformBrowser) { try { await platformBrowser.close(); } catch {} }
        }
      }
    }
  }

  // 6. Final flush
  await mergeAndFlush(drive, fileId, normalizedRows, normalizedRows, rowStart, rowEnd, stringifyCSV);

  const assignmentUpdates = {
    status: 'completed',
    processedUpTo: rowEnd,
    validMx: validCount,
    invalidMx: invalidCount,
  };

  await updateMyAssignment(campaignId, 'validate', assignmentUpdates);

  // Check if all workers are done
  const allDone = await checkAllComplete(campaignId, 'validate');
  if (allDone) {
    await updateCampaignSettings(campaignId, { validationStatus: "completed" });
    logger.info(`[Validate Campaign] All workers complete — validation finished`);
  }

  return NextResponse.json({
    success: true,
    message: `Worker completed validation for rows ${rowStart}-${rowEnd - 1}`,
    stats: { validMx: validCount, invalidMx: invalidCount, allComplete: !!allDone },
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
