import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import logger from "../../../utils/logger.js";
import { sendViaSMTP, getNextSmtpConfig } from "../_shared/smtpSender.js";
import { sendViaBrowser, detectProvider } from "../_shared/wireSender.js";
import { processSearchInteractTask } from "../../socials/search-interact/route.js";
import { processPageInteractTask } from "../../socials/page-interact/route.js";
import { processInboxInteractTask } from "../../socials/inbox-interact/route.js";
import { processActivitiesInteractTask } from "../../socials/activities-interact/route.js";
import { POST as sendMessageHandler } from "../../socials/send-message/route.js";

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
  SOCIALPHONE: ['SOCIAL PHONE']
};

function normalizeAndMapCSV(rawCsvContent, targetSchema) {
  const parsedRows = parseCSV(rawCsvContent);
  if (parsedRows.length === 0) return [];

  const rawHeaders = parsedRows[0].map(h => h.trim().toUpperCase());
  const dataRows = parsedRows.slice(1);

  const normalizedRows = [];
  const headerMap = new Map();
  const unmappedImportantColumns = [];

  const IMPORTANT_COLUMNS = ['EMAIL', 'FIRSTNAME', 'LASTNAME', 'PHONE'];

  targetSchema.forEach((stdHeader, index) => {
    if (!stdHeader) return;

    const upperStd = stdHeader.toUpperCase();
    const exactIdx = rawHeaders.indexOf(upperStd);
    if (exactIdx !== -1) {
      headerMap.set(index, exactIdx);
      return;
    }

    const fuzzyKeys = FUZZY_MAP[upperStd];
    if (fuzzyKeys) {
      for (const alias of fuzzyKeys) {
        const aliasIdx = rawHeaders.findIndex(rh => rh === alias || rh.includes(alias));
        if (aliasIdx !== -1) {
          headerMap.set(index, aliasIdx);
          return;
        }
      }
    }

    if (IMPORTANT_COLUMNS.includes(upperStd)) {
      unmappedImportantColumns.push(upperStd);
    }
  });

  if (unmappedImportantColumns.length > 0) {
    logger.warn(`[CSV Mapping] Important columns not found in CSV headers: ${unmappedImportantColumns.join(', ')}. Raw headers: [${rawHeaders.join(', ')}]`);
  }

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

export const maxDuration = 60; // Up to 60 seconds
export const dynamic = "force-dynamic";

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

function columnIndexToLetter(index) {
  let result = "";
  while (index >= 0) {
    result = String.fromCharCode(65 + (index % 26)) + result;
    index = Math.floor(index / 26) - 1;
  }
  return result;
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

async function getSocialProfileCookies(profileId) {
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
    platform: platformIdx !== -1 ? String(row[platformIdx]).toLowerCase().trim() : "twitter"
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { campaignId } = body;

    logger.info(`[Execute Campaign] Received execution trigger for campaign: ${campaignId}`);

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    // 1. Fetch Campaign Details
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) {
      throw new Error(`Failed to fetch campaigns sheet: ${campaignsResult.error}`);
    }

    const cHeaders = campaignsResult.headers;
    const cIdIndex = cHeaders.indexOf("campaignId");
    const cSettingsIndex = cHeaders.indexOf("settings");

    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow) {
      return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
    }

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
      logger.error(`[Execute Campaign] Failed to parse settings JSON for campaign ${campaignId}: ${e.message}. Raw value: ${String(settingsStr).substring(0, 200)}`);
    }
    if (settingsParseError) {
      settings._parseError = settingsParseError;
    }

    const channel = settings.channel || "email";
    
    // Update campaign status to running
    await updateSheetRowApi("campaigns", "campaignId", campaignId, {
      status: "running",
      updatedOn: new Date().toLocaleString()
    });

    if (channel === "email") {
      // ===== EMAIL CAMPAIGN EXECUTION =====
      const fileUrl = settings.fileUrl || campaignRow[cHeaders.indexOf("fileUrl")];
      if (!fileUrl) {
        throw new Error("No CSV contact list fileUrl configured for email campaign");
      }

      const fileId = extractFileId(fileUrl);
      if (!fileId) {
        throw new Error("Invalid CSV contact list fileUrl");
      }

      const authClient = await getSheetsAuthClient();
      if (!authClient) {
        throw new Error("Failed to authenticate with Google APIs");
      }
      const drive = google.drive({ version: "v3", auth: authClient });

      logger.info(`[Execute Campaign] Downloading CSV file for campaign sending: ${fileId}`);
      const driveFile = await drive.files.get({
        fileId: fileId,
        alt: "media"
      });

      const csvContent = driveFile.data;
      if (typeof csvContent !== "string") {
        throw new Error("Failed to download CSV as text content");
      }

      // Step 3a: Normalize CSV to 88-column boilerplate
      const normalizedRows = normalizeAndMapCSV(csvContent, STANDARD_88_COLUMNS);
      if (normalizedRows.length <= 1) {
        throw new Error("CSV file is empty or contains no recipients after normalization");
      }

      const nHeaders = normalizedRows[0];
      const emailColIdx = nHeaders.indexOf("EMAIL");
      const nameColIdx = nHeaders.indexOf("FIRSTNAME");
      const companyColIdx = nHeaders.indexOf("BUSINESSNAME");
      const sendDateIdx = nHeaders.indexOf("sendDate");
      const sendTimeIdx = nHeaders.indexOf("sendTime");
      const sendStampIdx = nHeaders.indexOf("sendStamp");
      const validationIdx = nHeaders.indexOf("validation");
      const providerMXIdx = nHeaders.indexOf("providerMXResult");

      if (emailColIdx === -1) {
        throw new Error("EMAIL column not found in 88-column schema");
      }

      const deliveryMethod = settings.deliveryMethod || "smtp";
      const smtpSettings = settings.smtpSettings || [];

      if (deliveryMethod === "smtp" || deliveryMethod === "mixed") {
        if (smtpSettings.length === 0) {
          throw new Error("No SMTP accounts configured for SMTP/Mixed delivery");
        }
        for (let i = 0; i < smtpSettings.length; i++) {
          const cfg = smtpSettings[i];
          const errors = [];
          if (!cfg.host || typeof cfg.host !== 'string' || !cfg.host.trim()) errors.push('host is required');
          const port = parseInt(cfg.port, 10);
          if (isNaN(port) || port <= 0 || port > 65535) errors.push('valid port (1-65535) is required');
          if (!cfg.username || typeof cfg.username !== 'string' || !cfg.username.trim()) errors.push('username is required');
          if (!cfg.from_email || typeof cfg.from_email !== 'string' || !cfg.from_email.trim()) errors.push('from_email is required');
          const hasAuth = (cfg.password && String(cfg.password).trim()) || (cfg.appPassword && String(cfg.appPassword).trim()) || (cfg.oAuth2RefreshToken && String(cfg.oAuth2RefreshToken).trim());
          if (!hasAuth) errors.push('password, appPassword, or oAuth2RefreshToken is required');
          if (errors.length > 0) {
            throw new Error(`SMTP config #${i + 1} (${cfg.host || 'unknown'}): ${errors.join('; ')}`);
          }
        }
      }

      // Step 3b: Fetch plan limit (shootContactsLimit) from limits sheet
      let shootContactsLimit = Infinity;
      try {
        const limitsResult = await getSheetDataApi("Limits");
        if (limitsResult.success) {
          const lHeaders = limitsResult.headers;
          const categoryIdx = lHeaders.indexOf("category");
          const limitValueIdx = lHeaders.indexOf("shootContactsLimit");
          if (categoryIdx !== -1 && limitValueIdx !== -1) {
            const limitRow = limitsResult.data.find(r => String(r[categoryIdx]).trim().toLowerCase() === "campaign");
            if (limitRow && limitRow[limitValueIdx]) {
              shootContactsLimit = parseInt(limitRow[limitValueIdx], 10);
              if (isNaN(shootContactsLimit) || shootContactsLimit < 0) shootContactsLimit = Infinity;
            }
          }
        }
      } catch (limitErr) {
        logger.warn(`[Execute Campaign] Failed to fetch limits, proceeding without limit: ${limitErr.message}`);
      }

      let sentCount = 0;
      let deliveredCount = 0;
      let failedCount = 0;
      let limitReached = false;
      const failureDetails = [];

      // Step 3c: Deduplicate recipients by email address
      const uniqueEmails = new Set();
      const deduplicatedRows = [];
      let duplicateCount = 0;

      for (const row of dataRows) {
        const email = row[emailColIdx]?.trim().toLowerCase();
        if (!email) {
          // Keep empty rows to preserve row count in CSV
          deduplicatedRows.push(row);
          continue;
        }

        if (uniqueEmails.has(email)) {
          logger.warn(`[Execute Campaign] Skipping duplicate email: ${email}`);
          duplicateCount++;
          continue; // Skip duplicate
        }

        uniqueEmails.add(email);
        deduplicatedRows.push(row);
      }

      if (duplicateCount > 0) {
        logger.info(`[Execute Campaign] Removed ${duplicateCount} duplicate email(s) from recipient list`);
      }

      // Step 3d: Check for checkpoint to resume partial execution
      const lastProcessedRow = settings.lastProcessedRow || 0;
      if (lastProcessedRow > 0) {
        logger.info(`[Execute Campaign] Resuming from checkpoint row ${lastProcessedRow} (previously processed ${lastProcessedRow} rows)`);
      }

      const startIndex = Math.max(0, lastProcessedRow);
      const maxToProcess = Math.min(deduplicatedRows.length, shootContactsLimit, 30);
      logger.info(`[Execute Campaign] Sending emails: limit=${shootContactsLimit === Infinity ? 'unlimited' : shootContactsLimit}, batch=${maxToProcess} contacts (after dedup: ${deduplicatedRows.length}/${dataRows.length})`);

      // Step 3e: Processing loop over deduplicated rows with checkpointing
      for (let i = startIndex; i < deduplicatedRows.length; i++) {
        if (sentCount >= shootContactsLimit) {
          limitReached = true;
          logger.info(`[Execute Campaign] shootContactsLimit (${shootContactsLimit}) reached, stopping.`);
          break;
        }
        if (sentCount >= 30) {
          logger.info(`[Execute Campaign] Vercel timeout safety cap (30) reached, stopping.`);
          break;
        }

        const row = deduplicatedRows[i];
        const email = row[emailColIdx]?.trim();
        if (!email) continue;

        const firstName = nameColIdx !== -1 && row[nameColIdx] ? row[nameColIdx] : "there";
        const company = companyColIdx !== -1 && row[companyColIdx] ? row[companyColIdx] : "your company";

        const subject = settings.subject || `Outreach to ${company}`;
        const message = settings.body || `Hello ${firstName}, let's connect.`;

        const { config: smtp } = getNextSmtpConfig(smtpSettings, sentCount);
        const now = new Date();
        let senderHost = "WIRE";

        try {
          if (deliveryMethod === "smtp" || deliveryMethod === "mixed") {
            await sendViaSMTP(email, subject, message, smtp);
            senderHost = smtp?.host || "SMTP";
            deliveredCount++;
          }

          if (deliveryMethod === "wire" || deliveryMethod === "mixed") {
            // Use WIRE account from settings for browser-based sending
            const wireAccount = settings.wireAccount || settings.accounts?.[0];
            const wireCookies = wireAccount?.cookieJSON || wireAccount?.cookies;
            if (wireCookies) {
              const provider = detectProvider(wireAccount?.email || smtp?.user || email) || "gmail";
              await sendViaBrowser(email, subject, message, wireCookies, provider);
            } else {
              logger.info(`[Execute Campaign] No WIRE browser session available for ${email}, using SMTP fallback`);
              if (deliveryMethod === "wire") {
                await sendViaSMTP(email, subject, message, smtp);
                senderHost = smtp?.host || "SMTP_FALLBACK";
              }
            }
            deliveredCount++;
          }

          sentCount++;

          if (sendDateIdx !== -1) row[sendDateIdx] = now.toLocaleDateString();
          if (sendTimeIdx !== -1) row[sendTimeIdx] = now.toLocaleTimeString();
          if (sendStampIdx !== -1) row[sendStampIdx] = now.toISOString();
          if (validationIdx !== -1) row[validationIdx] = "sent";
          if (providerMXIdx !== -1) row[providerMXIdx] = senderHost;
        } catch (err) {
          logger.error(`[Execute Campaign] Failed to send to ${email} via ${senderHost}: ${err.message}`);
          failedCount++;
          sentCount++;
          failureDetails.push({ email, error: err.message, host: senderHost });

          if (validationIdx !== -1) row[validationIdx] = "failed";
          if (providerMXIdx !== -1) row[providerMXIdx] = err.message;
        }

        // Checkpoint: save progress every 5 rows
        if ((i + 1) % 5 === 0) {
          logger.info(`[Execute Campaign] Checkpoint at row ${i + 1}/${deduplicatedRows.length}`);
          try {
            settings.lastProcessedRow = i + 1;
            await updateSheetRowApi("campaigns", "campaignId", campaignId, {
              settings: JSON.stringify(settings),
              updatedOn: new Date().toLocaleString()
            });
          } catch (cpErr) {
            logger.warn(`[Execute Campaign] Checkpoint save failed at row ${i + 1}: ${cpErr.message}`);
          }
        }
      }

      // Step 3d: Single-flush Drive save — rebuild CSV and overwrite file
      logger.info(`[Execute Campaign] Flushing updated CSV back to Drive: ${fileId}`);
      const updatedCSVContent = stringifyCSV(normalizedRows);
      await drive.files.update({
        fileId: fileId,
        media: {
          mimeType: "text/csv",
          body: updatedCSVContent
        }
      });

      // Step 3e: Single campaign status update
      const finalStatus = limitReached ? "Limit Reached" : "completed";
      const analytics = {
        totalRows: dataRows.length,
        sent: sentCount,
        delivered: deliveredCount,
        failed: failedCount,
        limitReached,
        failureDetails: failureDetails.slice(0, 20)
      };

      delete settings.lastProcessedRow;
      settings.analytics = analytics;
      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify(settings),
        status: finalStatus,
        updatedOn: new Date().toLocaleString()
      });

      return NextResponse.json({
        success: true,
        message: `Email campaign executed successfully (${finalStatus})`,
        analytics
      });

    } else if (channel === "social") {
      // ===== SOCIAL CAMPAIGN EXECUTION =====
      const activeProfiles = settings.accounts || [];
      const interactionTypes = settings.socialInteractionTypes || ["search"];
      const keywords = settings.socialKeywords || [];

      if (activeProfiles.length === 0) {
        throw new Error("No active SOCIAL profiles selected for social campaign");
      }
      if (keywords.length === 0) {
        throw new Error("No keywords configured for social outreach campaign");
      }

      // Step 4a: Optionally normalize CSV if fileUrl is present
      const socialFileUrl = settings.fileUrl || settings.csvFileUrl;
      let socialCsvRows = null;
      let drive = null;
      let socialFileId = null;
      if (socialFileUrl) {
        socialFileId = extractFileId(socialFileUrl);
        if (socialFileId) {
          const auth = await getSheetsAuthClient();
          if (auth) {
            drive = google.drive({ version: "v3", auth });
            logger.info(`[Execute Campaign] Downloading social CSV file: ${socialFileId}`);
            const dFile = await drive.files.get({ fileId: socialFileId, alt: "media" });
            if (typeof dFile.data === "string") {
              const normalized = normalizeAndMapCSV(dFile.data, STANDARD_88_COLUMNS);
              if (normalized.length > 1) socialCsvRows = normalized;
            }
          }
        }
      }

      // Step 4b: Fetch both shootContactsLimit and interactionLimit from limits sheet
      let shootContactsLimit = Infinity;
      let interactionLimit = Infinity;
      try {
        const limitsResult = await getSheetDataApi("Limits");
        if (limitsResult.success) {
          const lHeaders = limitsResult.headers;
          const categoryIdx = lHeaders.indexOf("category");
          const shootIdx = lHeaders.indexOf("shootContactsLimit");
          const interactIdx = lHeaders.indexOf("interactionLimit");
          if (categoryIdx !== -1) {
            const limitRow = limitsResult.data.find(r => String(r[categoryIdx]).trim().toLowerCase() === "campaign");
            if (limitRow) {
              if (shootIdx !== -1 && limitRow[shootIdx]) {
                const val = parseInt(limitRow[shootIdx], 10);
                if (!isNaN(val) && val >= 0) shootContactsLimit = val;
              }
              if (interactIdx !== -1 && limitRow[interactIdx]) {
                const val = parseInt(limitRow[interactIdx], 10);
                if (!isNaN(val) && val >= 0) interactionLimit = val;
              }
            }
          }
        }
      } catch (limitErr) {
        logger.warn(`[Execute Campaign] Failed to fetch social limits: ${limitErr.message}`);
      }

      logger.info(`[Execute Campaign] Queueing social tasks for ${activeProfiles.length} profiles (interactionLimit=${interactionLimit === Infinity ? 'unlimited' : interactionLimit})...`);

      // Step 4c: Accumulate all tasks in-memory with priority ordering
      const PRIORITY_MAP = { "inbox-interact": 0, "activities-interact": 1, "page-interact": 2, "search-interact": 3 };
      const pendingSocialTasks = [];

      for (const profileId of activeProfiles) {
        const profileData = await getSocialProfileCookies(profileId);
        if (!profileData || !profileData.cookies) {
          logger.warn(`[Execute Campaign] No cookies found for active profile: ${profileId}`);
          continue;
        }

        const platform = profileData.platform || "twitter";

        // If CSV rows exist, derive keywords from SOCIALUSERNAME column for this profile
        const profileKeywords = socialCsvRows
          ? socialCsvRows.slice(1).map(r => {
              const userIdx = socialCsvRows[0].indexOf("SOCIALUSERNAME");
              return userIdx !== -1 ? String(r[userIdx]).trim() : "";
            }).filter(Boolean)
          : keywords;

        for (const keyword of profileKeywords) {
          for (const op of interactionTypes) {
            if (pendingSocialTasks.length >= interactionLimit) break;

            const operation = op === "search" ? "search-interact"
              : op === "inbox" ? "inbox-interact"
              : op === "activities" ? "activities-interact"
              : "page-interact";
            const taskId = "task-" + Math.random().toString(36).substring(2, 11);

            pendingSocialTasks.push({
              taskId,
              platform,
              operation,
              priority: PRIORITY_MAP[operation] !== undefined ? PRIORITY_MAP[operation] : 99,
              searchQuery: keyword,
              cookieJSON: typeof profileData.cookies === "string" ? profileData.cookies : JSON.stringify(profileData.cookies),
              status: "PENDING",
              createdAt: new Date().toISOString()
            });
          }
          if (pendingSocialTasks.length >= interactionLimit) break;
        }
        if (pendingSocialTasks.length >= interactionLimit) break;
      }

      // Step 4d: Sort tasks by priority (inbox > activities > page > search)
      pendingSocialTasks.sort((a, b) => a.priority - b.priority);

      // Step 4e: Execute tasks directly via social route handlers
      const tasksToExecute = pendingSocialTasks.slice(0, Math.min(pendingSocialTasks.length, shootContactsLimit));
      const executionResults = [];
      let executedCount = 0;
      let failedCount = 0;

      const ROUTE_MAP = {
        "search-interact": processSearchInteractTask,
        "page-interact": processPageInteractTask,
        "inbox-interact": processInboxInteractTask,
        "activities-interact": processActivitiesInteractTask,
      };

      for (const task of tasksToExecute) {
        const handler = ROUTE_MAP[task.operation];
        if (!handler) {
          logger.warn(`[Execute Campaign] No handler for operation: ${task.operation}`);
          failedCount++;
          continue;
        }

        try {
          logger.info(`[Execute Campaign] Executing ${task.operation} task: ${task.taskId}`);

          // Enrich task payload with campaign context
          const taskPayload = {
            ...task,
            profileId: task.platform === "twitter" || task.platform === "tiktok" ? task.searchQuery : null,
            socialStrategyPrompt: settings.socialStrategyPrompt || null,
            projectId: settings.projectId || null,
            messageText: settings.socialMessage || "",
          };

          const result = await handler(taskPayload);
          executionResults.push(result);
          executedCount++;
          logger.info(`[Execute Campaign] Task ${task.taskId} completed: ${result.status}`);
        } catch (taskError) {
          logger.error(`[Execute Campaign] Task ${task.taskId} failed: ${taskError.message}`);
          executionResults.push({ taskId: task.taskId, status: "FAILED", error: taskError.message });
          failedCount++;
        }

        // Inter-task delay for rate limiting
        await new Promise(res => setTimeout(res, 500));
      }

      // Step 4f: Send direct messages to all social profiles in CSV if enabled
      const shouldSendMessage = settings.shouldSendMessage === true || settings.shouldSendMessage === "true" || settings.sendToAll === true;
      if (shouldSendMessage && socialFileUrl) {
        logger.info(`[Execute Campaign] sendToAll enabled — sending DMs to all CSV social profiles`);
        try {
          const dmRequest = new Request("http://localhost/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              campaignId,
              platform: "",
              messageText: settings.socialMessage || settings.message || "",
              sendToAll: true,
              accountIds: activeProfiles,
            }),
          });
          const dmResponse = await sendMessageHandler(dmRequest);
          const dmResult = await dmResponse.json();
          logger.info(`[Execute Campaign] send-message result: ${dmResult.message}`);
          settings.dmResults = dmResult;
        } catch (dmErr) {
          logger.error(`[Execute Campaign] send-message failed: ${dmErr.message}`);
          settings.dmResults = { error: dmErr.message };
        }
      }

      // Step 4g: Single-flush Drive update if CSV was used
      let csvUpdated = false;
      if (socialCsvRows && socialFileId && drive) {
        const nHeaders = socialCsvRows[0];
        for (let i = 1; i < socialCsvRows.length; i++) {
          const row = socialCsvRows[i];
          const username = row[nHeaders.indexOf("SOCIALUSERNAME")] || "";
          const relatedResults = executionResults.filter(r => r.taskId && tasksToExecute.find(t => t.searchQuery === username && t.taskId === r.taskId));
          if (relatedResults.length > 0) {
            const searchKeysIdx = nHeaders.indexOf("searchKeys");
            const searchStatusIdx = nHeaders.indexOf("searchStatus");
            const searchStampIdx = nHeaders.indexOf("searchStamp");
            const interactStatusIdx = nHeaders.indexOf("interactStatus");
            const interactStampIdx = nHeaders.indexOf("interactStamp");
            if (searchKeysIdx !== -1) row[searchKeysIdx] = relatedResults.map(r => r.status).join("; ");
            if (searchStatusIdx !== -1) row[searchStatusIdx] = "executed";
            if (searchStampIdx !== -1) row[searchStampIdx] = new Date().toISOString();
            if (interactStatusIdx !== -1) row[interactStatusIdx] = "executed";
            if (interactStampIdx !== -1) row[interactStampIdx] = new Date().toISOString();
          }
        }
        const updatedCSV = stringifyCSV(socialCsvRows);
        await drive.files.update({
          fileId: socialFileId,
          media: { mimeType: "text/csv", body: updatedCSV }
        });
        csvUpdated = true;
      }

      // Step 4g: Single campaign status update
      const limitReached = executedCount < pendingSocialTasks.length || executedCount >= shootContactsLimit;
      const finalStatus = limitReached ? "Limit Reached" : "completed";
      const analytics = {
        totalRows: tasksToExecute.length,
        sent: executedCount,
        delivered: executedCount - failedCount,
        failed: failedCount,
        limitReached,
        csvUpdated,
        executionResults,
      };

      settings.analytics = analytics;
      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify(settings),
        status: finalStatus,
        updatedOn: new Date().toLocaleString()
      });

      return NextResponse.json({
        success: true,
        message: `Social campaign executed (${finalStatus})`,
        queuedTasks: tasksToExecute.length,
        executed: executedCount,
        failed: failedCount,
        analytics
      });
    }

    return NextResponse.json({ success: false, error: "Invalid channel type" }, { status: 400 });

  } catch (error) {
    logger.error(`[Execute Campaign] Error executing campaign: ${error.message}`, { stack: error.stack });
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
