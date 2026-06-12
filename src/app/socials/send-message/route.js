import { NextResponse } from "next/server";
import { getSheetsAuthClient, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import logger from "../../../utils/logger.js";
import { getPlatformConfig, getWorkflow, getTiming } from "./platforms.js";
import { getBrowser, executeWorkflowSteps } from "../_shared/routeHelper.js";
import { checkActionAllowed } from "../_shared/limits.js";
import { updateAccountUsage } from "../_shared/hubUpdater.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

const STANDARD_88_COLUMNS = [
  'FIRSTNAME', 'LASTNAME', 'EMAIL', 'ADDRESS', 'CITY', 'STATE', 'COUNTRY', 'ZIPCODE', 'PHONE', 'SEX',
  'BUSINESSNAME', 'BUSINESSADDRESS', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'BUSINESSZIPCODE', 'BUSINESSPHONE', 'BUSINESSEMAIL',
  'SOCIALPLATFORM', 'SOCIALUSERNAME', 'SOCIALPHONE',
  'CONTEXT',
  '', '', '', '', '', '',
  'campaignType', 'engine', 'provider',
  'shooterFirstName', 'shooterLastName', 'shooterEmail', 'shooterAddress', 'shooterCity', 'shooterState', 'shooterCountry', 'shooterZipCode', 'shooterPhone', 'shooterSex',
  'smtp', 'port', 'username', 'password', 'appPassword', 'backupCode', 'oAuth2ClientId', 'oAuth2ClientSecret', 'oAuth2RefreshToken',
  '',
  'shouldValidate', 'shouldEnhance', 'shouldSearchInteract', 'shouldPageInteract', 'shouldInboxInteract', 'shouldActivitiesInteract',
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
  SOCIALPLATFORM: ['SOCIAL', 'SOCIAL PLATFORM', 'PLATFORM', 'SOCIAL MEDIA'],
  SOCIALUSERNAME: ['SOCIAL USERNAME', 'USERNAME', 'HANDLE', 'SOCIAL HANDLE', 'SOCIAL NAME'],
  SOCIALPHONE: ['SOCIAL PHONE'],
  EMAIL: ['EMAIL', 'MAIL', 'E-MAIL', 'LEAD'],
  FIRSTNAME: ['FIRST', 'FIRST NAME', 'FNAME', 'GIVEN'],
  LASTNAME: ['LAST', 'LAST NAME', 'LNAME', 'SURNAME', 'FAMILY'],
};

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
        else inQuotes = false;
      } else row[row.length - 1] += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') row.push("");
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else row[row.length - 1] += c;
    }
  }
  if (row.length > 1 || row[0] !== "") lines.push(row);
  return lines;
}

function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? "" : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r'))
        return '"' + str.replace(/"/g, '""') + '"';
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
  dataRows.forEach(row => {
    const newRow = new Array(targetSchema.length).fill('');
    targetSchema.forEach((_, stdIndex) => {
      if (headerMap.has(stdIndex)) {
        const rawIndex = headerMap.get(stdIndex);
        newRow[stdIndex] = row[rawIndex] !== undefined && row[rawIndex] !== null ? String(row[rawIndex]) : '';
      }
    });
    normalizedRows.push(newRow);
  });
  return normalizedRows;
}

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

async function getCookieForProfile(profileId) {
  if (!profileId) return null;
  const cookieResult = await getSheetDataApi("cookie");
  if (!cookieResult.success) return null;
  const headers = cookieResult.headers;
  const browserIdIdx = headers.indexOf("browserId");
  const cookieIdx = headers.indexOf("formattedCookie") !== -1 ? headers.indexOf("formattedCookie") : headers.indexOf("cookieJSON");
  const platformIdx = headers.indexOf("category") !== -1 ? headers.indexOf("category") : headers.indexOf("platform");

  if (browserIdIdx === -1) return null;
  const row = cookieResult.data.find(r => String(r[browserIdIdx]).trim() === String(profileId).trim());
  if (!row) return null;

  return {
    cookies: row[cookieIdx] || "",
    platform: platformIdx !== -1 ? String(row[platformIdx]).toLowerCase().trim() : null
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { campaignId, fileUrl, platform, messageText, sendToAll, profileId, accountIds } = body;

    if (!fileUrl && !campaignId) {
      return NextResponse.json({ success: false, error: "Missing fileUrl or campaignId" }, { status: 400 });
    }

    // Resolve settings from campaignId if provided
    let settings = {};
    let resolvedFileUrl = fileUrl;
    let resolvedPlatform = platform || "";
    let resolvedMessageText = messageText || "";
    let resolvedSendToAll = sendToAll === true;
    let resolvedAccountIds = accountIds || [];

    if (campaignId) {
      const campaignsResult = await getSheetDataApi("campaigns");
      if (campaignsResult.success) {
        const cHeaders = campaignsResult.headers;
        const cIdIndex = cHeaders.indexOf("campaignId");
        const cSettingsIndex = cHeaders.indexOf("settings");
        const row = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
        if (row) {
          try {
            settings = JSON.parse(row[cSettingsIndex] || "{}");
          } catch (e) { settings = row[cSettingsIndex] || {}; }
          resolvedFileUrl = resolvedFileUrl || settings.fileUrl || settings.csvFileUrl;
          resolvedPlatform = resolvedPlatform || settings.platform || settings.socialPlatform || "";
          resolvedMessageText = resolvedMessageText || settings.socialMessage || settings.message || "";
          resolvedSendToAll = sendToAll === true || settings.sendToAll === true || settings.sendToAll === "true";
          resolvedAccountIds = resolvedAccountIds.length > 0 ? resolvedAccountIds : (settings.accounts || []);
        }
      }
    }

    // Build profile list: prefer accountIds array, fall back to single profileId
    const activeProfileIds = resolvedAccountIds.length > 0
      ? resolvedAccountIds
      : (profileId ? [profileId] : settings.accounts || []);

    if (activeProfileIds.length === 0) {
      return NextResponse.json({ success: false, error: "No active social profiles selected. Please select at least one logged-in account." }, { status: 400 });
    }

    if (!resolvedFileUrl) {
      return NextResponse.json({ success: false, error: "No CSV file URL found" }, { status: 400 });
    }

    // Download CSV
    const fileId = extractFileId(resolvedFileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid CSV file URL" }, { status: 400 });
    }

    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
    }
    const drive = google.drive({ version: "v3", auth: authClient });

    logger.info(`[Send Message] Downloading CSV: ${fileId}`);
    const driveFile = await drive.files.get({ fileId, alt: "media" });
    const csvContent = driveFile.data;
    if (typeof csvContent !== "string") {
      return NextResponse.json({ success: false, error: "Failed to download CSV as text" }, { status: 500 });
    }

    const normalizedRows = normalizeAndMapCSV(csvContent, STANDARD_88_COLUMNS);
    if (normalizedRows.length <= 1) {
      return NextResponse.json({ success: false, error: "CSV is empty after normalization" }, { status: 400 });
    }

    const nHeaders = normalizedRows[0];
    const socialPlatformIdx = nHeaders.indexOf("SOCIALPLATFORM");
    const socialUsernameIdx = nHeaders.indexOf("SOCIALUSERNAME");
    const socialPhoneIdx = nHeaders.indexOf("SOCIALPHONE");
    const contextIdx = nHeaders.indexOf("CONTEXT");
    const firstNameIdx = nHeaders.indexOf("FIRSTNAME");
    const sendDateIdx = nHeaders.indexOf("sendDate");
    const sendTimeIdx = nHeaders.indexOf("sendTime");
    const sendStampIdx = nHeaders.indexOf("sendStamp");
    const validationIdx = nHeaders.indexOf("validation");
    const searchStatusIdx = nHeaders.indexOf("searchStatus");
    const searchStampIdx = nHeaders.indexOf("searchStamp");

    // Resolve cookie profiles for all selected accounts (round-robin)
    const profileCookies = [];
    for (const pid of activeProfileIds) {
      const data = await getCookieForProfile(pid);
      if (data && data.cookies) {
        profileCookies.push({
          profileId: pid,
          cookies: typeof data.cookies === "string" ? data.cookies : JSON.stringify(data.cookies),
          platform: data.platform || "",
        });
      }
    }

    if (profileCookies.length === 0) {
      return NextResponse.json({ success: false, error: "No browser session cookies found for any selected profile. Log in first." }, { status: 400 });
    }

    const profilePlatform = profileCookies[0].platform || "";

    // Collect recipients
    const recipients = [];
    for (let i = 1; i < normalizedRows.length; i++) {
      const row = normalizedRows[i];
      let targetPlatform = (resolvedPlatform || profilePlatform || "").toLowerCase().trim();
      let recipient = "";

      if (resolvedSendToAll || !targetPlatform) {
        targetPlatform = String(row[socialPlatformIdx] || "").toLowerCase().trim();
      }

      if (!targetPlatform) {
        targetPlatform = profilePlatform;
      }

      if (resolvedSendToAll || !recipient) {
        recipient = String(row[socialUsernameIdx] || row[socialPhoneIdx] || "").trim();
      }

      if (!recipient) continue;

      recipients.push({
        rowIndex: i,
        platform: targetPlatform,
        recipient,
        context: contextIdx !== -1 ? String(row[contextIdx] || "") : "",
        firstName: firstNameIdx !== -1 ? String(row[firstNameIdx] || "") : "",
      });
    }

    if (recipients.length === 0) {
      return NextResponse.json({ success: false, error: "No recipients found in CSV (no SOCIALUSERNAME or SOCIALPLATFORM columns)" }, { status: 400 });
    }

    logger.info(`[Send Message] ${recipients.length} recipients to process (sendToAll=${resolvedSendToAll}, platform=${resolvedPlatform || profilePlatform})`);

    // Process each recipient with round-robin profile rotation
    const results = [];
    let sentCount = 0;
    let failedCount = 0;
    let profileIndex = 0;

    for (const entry of recipients) {
      let entrySent = false;
      const attempts = [];

      // Try each profile (starting from current round-robin position) until one succeeds
      for (let p = 0; p < profileCookies.length; p++) {
        const profile = profileCookies[(profileIndex + p) % profileCookies.length];

        // Skip profile if platform doesn't match recipient's platform
        const profilePlatform = profile.platform || "";
        if (entry.platform && profilePlatform && profilePlatform !== entry.platform) continue;

        try {
          // Check limits
          const { allowed, reason } = await checkActionAllowed("sendMessage", entry.platform);
          if (!allowed) {
            logger.warn(`[Send Message] Limit reached for ${entry.platform}: ${reason}`);
            attempts.push({ profileId: profile.profileId, status: "SKIPPED", reason });
            continue;
          }

          // Verify platform config exists
          const platformConfig = getPlatformConfig(entry.platform);
          const workflow = getWorkflow(entry.platform);
          const timing = getTiming(entry.platform);

          // Build personalized message
          let personalizedMessage = resolvedMessageText;
          if (entry.firstName) {
            personalizedMessage = personalizedMessage.replace(/\{\{firstName\}\}/gi, entry.firstName);
            personalizedMessage = personalizedMessage.replace(/\{\{name\}\}/gi, entry.firstName);
          }
          if (entry.context) {
            personalizedMessage = personalizedMessage.replace(/\{\{context\}\}/gi, entry.context);
          }

          // Execute send via browser using this profile's cookies
          const browser = await getBrowser({ headless: true });
          const page = await browser.newPage();
          const parsedCookies = typeof profile.cookies === "string" ? JSON.parse(profile.cookies) : profile.cookies;
          await page.setCookie(...parsedCookies);

          await executeWorkflowSteps(page, workflow, {
            recipient: entry.recipient,
            messageText: personalizedMessage,
            selectors: platformConfig.selectors,
            timing,
          });

          await browser.close();

          entrySent = true;
          profileIndex = (profileIndex + p + 1) % profileCookies.length;
          sentCount++;

          // Update CSV row
          const row = normalizedRows[entry.rowIndex];
          const now = new Date();
          if (sendDateIdx !== -1) row[sendDateIdx] = now.toLocaleDateString();
          if (sendTimeIdx !== -1) row[sendTimeIdx] = now.toLocaleTimeString();
          if (sendStampIdx !== -1) row[sendStampIdx] = now.toISOString();
          if (validationIdx !== -1) row[validationIdx] = "sent";
          if (searchStatusIdx !== -1) row[searchStatusIdx] = "messaged";
          if (searchStampIdx !== -1) row[searchStampIdx] = now.toISOString();

          // Update hub usage
          await updateAccountUsage(profile.profileId, "sendMessage", 1);

          results.push({ recipient: entry.recipient, platform: entry.platform, profileId: profile.profileId, status: "SENT" });
          logger.info(`[Send Message] Sent to ${entry.recipient} via ${entry.platform} (profile: ${profile.profileId})`);

          // Inter-recipient delay
          const delay = Math.floor(Math.random() * (timing.maxDelay - timing.minDelay + 1)) + timing.minDelay;
          await new Promise(res => setTimeout(res, delay));

          break; // Success — stop trying other profiles

        } catch (err) {
          logger.warn(`[Send Message] Profile ${profile.profileId} failed for ${entry.recipient}: ${err.message}`);
          attempts.push({ profileId: profile.profileId, status: "FAILED", error: err.message });
        }
      }

      if (!entrySent) {
        failedCount++;
        results.push({ recipient: entry.recipient, platform: entry.platform, status: "FAILED", attempts });

        const row = normalizedRows[entry.rowIndex];
        if (validationIdx !== -1) row[validationIdx] = "failed";
        if (searchStatusIdx !== -1) row[searchStatusIdx] = attempts.map(a => a.error).join("; ");
      }
    }

    // Flush CSV back to Drive
    logger.info(`[Send Message] Flushing updated CSV to Drive: ${fileId}`);
    const updatedCSV = stringifyCSV(normalizedRows);
    await drive.files.update({
      fileId,
      media: { mimeType: "text/csv", body: updatedCSV },
    });

    // Update campaign status if campaignId was provided
    if (campaignId) {
      settings.analytics = {
        totalRecipients: recipients.length,
        sent: sentCount,
        failed: failedCount,
        results,
      };
      const { updateSheetRowApi } = await import("../../api/googlesheets.js");
      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify(settings),
        status: failedCount > 0 && sentCount === 0 ? "failed" : "completed",
        updatedOn: new Date().toLocaleString(),
      });
    }

    return NextResponse.json({
      success: true,
      message: `Sent ${sentCount} messages, ${failedCount} failed`,
      totalRecipients: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    });

  } catch (error) {
    logger.error(`[Send Message] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
