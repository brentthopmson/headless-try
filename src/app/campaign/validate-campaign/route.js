import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import dns from "dns";
import { promisify } from "util";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { launchBrowser } from "../../../utils/utils.js";
import { platformConfigs } from "../../emails/cookie/cookie-api-login/platforms.js";

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

    // Read batch limits from SETTINGS
    const mxBatchSetting = await getSetting('validateBatchLimit');
    const MX_BATCH_SIZE = parseInt(mxBatchSetting?.value1) || 20;
    const platformBatchSetting = await getSetting('platformVerificationBatchLimit');
    const PLATFORM_BATCH_SIZE = parseInt(platformBatchSetting?.value1) || 5;
    const platformEnabledSetting = await getSetting('platformVerificationEnabled');
    const PLATFORM_VERIFICATION_ENABLED = platformEnabledSetting?.value1 !== 'false';

    logger.info(`[Validate Campaign] MX batch=${MX_BATCH_SIZE}, platform batch=${PLATFORM_BATCH_SIZE}, platform verification=${PLATFORM_VERIFICATION_ENABLED}`);

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
    logger.info(`[Validate Campaign] Processing ${dataRows.length} rows`);

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
    let socialValidCount = 0;
    let socialInvalidCount = 0;

    if (socialPlatformIdx !== -1 && socialUsernameIdx !== -1) {
      for (const row of dataRows) {
        if (row[validationIdx] === "duplicate") continue;
        const email = row[emailColIdx]?.trim();
        const socialUsername = row[socialUsernameIdx]?.trim();
        const socialPlatform = row[socialPlatformIdx]?.trim();

        // Social-only rows (no email but has social username)
        if (!email && socialUsername) {
          if (!socialPlatform) {
            row[validationIdx] = "social_no_platform";
            socialInvalidCount++;
          } else {
            row[validationIdx] = "social_valid";
            socialValidCount++;
          }
        }
      }
      if (socialValidCount > 0 || socialInvalidCount > 0) {
        logger.info(`[Validate Campaign] Social: ${socialValidCount} valid, ${socialInvalidCount} invalid`);
      }
    }

    // 4. MX Record Check (batched)
    logger.info(`[Validate Campaign] Starting batched MX record checks...`);
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

      // Live CSV flush after each MX batch
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
      logger.info(`[Validate Campaign] Starting platform browser verification...`);
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
          if (await isCampaignPaused(campaignId)) {
            logger.info(`[Validate Campaign] Campaign paused at platform batch ${batchIdx + 1}/${platformBatchCount}`);
            break;
          }

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
                if (!inputSelector) {
                  row[validationIdx] = "platform_no_selector";
                  continue;
                }

                await page.waitForSelector(inputSelector, { visible: true, timeout: 8000 });
                await page.type(inputSelector, email, { delay: 30 });

                const nextSelector = config.selectors?.nextButton;
                if (nextSelector) {
                  try {
                    await page.click(nextSelector);
                    await new Promise(r => setTimeout(r, 2000));
                  } catch {}
                }

                // Check result
                const pageContent = await page.content();
                const pageUrl = page.url();

                const errorPatterns = [
                  "Couldn't find your Google Account",
                  "Enter a valid email",
                  "We couldn't find an account",
                  "That account doesn't exist",
                  "Incorrect email or password",
                  "isn't a valid email"
                ];

                const hasError = errorPatterns.some(p => pageContent.includes(p));
                if (hasError) {
                  row[validationIdx] = "not_exists";
                  row[providerMXIdx] = platform;
                  logger.info(`[Validate Campaign] Email ${email} does not exist on ${platform}`);
                } else {
                  row[validationIdx] = "verified_exists";
                  row[providerMXIdx] = platform;
                  logger.info(`[Validate Campaign] Email ${email} verified on ${platform}`);
                }
              } catch (err) {
                logger.warn(`[Validate Campaign] Platform verification failed for ${email} on ${platform}: ${err.message}`);
                row[validationIdx] = "unverifiable";
              }
            }
          } catch (browserErr) {
            logger.error(`[Validate Campaign] Browser launch failed for platform batch: ${browserErr.message}`);
            for (const row of batch) {
              if (row[validationIdx] === "valid_mx") row[validationIdx] = "unverifiable";
            }
          } finally {
            if (platformBrowser) {
              try { await platformBrowser.close(); } catch {}
            }
          }

          // Live CSV flush after each platform batch
          try {
            await drive.files.update({
              fileId,
              media: { mimeType: "text/csv", body: stringifyCSV(normalizedRows) }
            });
          } catch (flushErr) {
            logger.warn(`[Validate Campaign] Live CSV flush failed at platform batch ${batchIdx + 1}: ${flushErr.message}`);
          }

          logger.info(`[Validate Campaign] Platform batch ${batchIdx + 1}/${platformBatchCount} complete`);
        }
      } else {
        logger.info(`[Validate Campaign] No emails match known platforms for browser verification`);
      }
    }

    // 6. Final CSV flush
    logger.info(`[Validate Campaign] Final CSV flush to Drive: ${fileId}`);
    await drive.files.update({
      fileId,
      media: { mimeType: "text/csv", body: stringifyCSV(normalizedRows) }
    });

    // 7. Update campaign settings
    await updateCampaignSettings(campaignId, { validationStatus: "completed" });

    const stats = {
      total: dataRows.length,
      duplicates: duplicateCount,
      validMx: validCount,
      invalidMx: invalidCount,
      verifiedExists: dataRows.filter(r => r[validationIdx] === "verified_exists").length,
      notExists: dataRows.filter(r => r[validationIdx] === "not_exists").length,
      unverifiable: dataRows.filter(r => r[validationIdx] === "unverifiable").length
    };

    logger.info(`[Validate Campaign] Complete: ${JSON.stringify(stats)}`);

    return NextResponse.json({
      success: true,
      message: "Campaign email validation completed successfully",
      stats
    });

  } catch (error) {
    logger.error(`[Validate Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
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
