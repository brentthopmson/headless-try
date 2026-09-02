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
import { getCampaignLimits } from "../../socials/_shared/limits.js";
import { requireFeature } from "../../../utils/featureGate.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { getSelfUrl, getSelfUrlWithFallback, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { dispatchToServers } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, getFirestickEmails, getPerformancePresets } from "../_shared/pipelineUtils.js";

function embedCampaignIdentifier(subject, body, campaignId) {
  const identifier = `[${campaignId}]`;
  const taggedSubject = subject.includes(identifier) ? subject : `${subject} ${identifier}`;
  const identifierComment = `<!-- campaign:${campaignId} -->`;
  const taggedBody = body.includes(identifierComment) ? body : `${body}\n\n${identifierComment}`;
  return { subject: taggedSubject, body: taggedBody };
}

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
  'enrichmentStatus',
  '',
  'sendDate', 'sendTime', 'sendStamp',
  '', '', '',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  '',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp',
  '', 'personalizationStatus', 'executionStatus'
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

  dataRows.forEach((row, idx) => {
    const newRow = new Array(targetSchema.length).fill('');
    targetSchema.forEach((_, stdIndex) => {
      if (headerMap.has(stdIndex)) {
        const rawIndex = headerMap.get(stdIndex);
        newRow[stdIndex] = row[rawIndex] !== undefined && row[rawIndex] !== null ? String(row[rawIndex]) : '';
      }
    });
    // SN: preserve a raw SN value when present, otherwise number the row so the
    // flushed CSV stays aligned with the frontend's 88-column schema.
    if (!headerMap.has(0) && targetSchema[0] && String(targetSchema[0]).toUpperCase() === 'SN') {
      newRow[0] = String(idx + 1);
    }
    normalizedRows.push(newRow);
  });

  return normalizedRows;
}

export const maxDuration = 60; // Up to 60 seconds
export const dynamic = "force-dynamic";

function columnIndexToLetter(index) {
  let result = "";
  while (index >= 0) {
    result = String.fromCharCode(65 + (index % 26)) + result;
    index = Math.floor(index / 26) - 1;
  }
  return result;
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
    await identifySelfFromHost(request.headers.get('host'));
    const gate = await requireFeature('allowShooting', 'campaign shooting');
    if (gate) return gate;
    const body = await request.json();
    const { campaignId } = body;

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    const log = logger.child({ campaignId, stage: 'execute' });
    log.info(`Received execution trigger`);

    // 1. Fetch Campaign Details
    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) {
      throw new Error(`Failed to fetch campaigns sheet: ${campaignsResult.error}`);
    }

    const cHeaders = campaignsResult.headers;
    const cIdIndex = cHeaders.indexOf("campaignId");
    const cSettingsIndex = cHeaders.indexOf("settings");
    const cStatusIndex = cHeaders.indexOf("status");

    const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
    if (!campaignRow) {
      return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
    }

    // Paused campaigns must not shoot. Resume flips status back to running first.
    const campaignStatus = cStatusIndex !== -1 ? String(campaignRow[cStatusIndex] || "").trim().toLowerCase() : "";
    if (campaignStatus === "paused") {
      return NextResponse.json({ success: false, error: "Campaign is paused. Resume it to continue shooting." }, { status: 409 });
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
      log.error(` Failed to parse settings JSON for campaign ${campaignId}: ${e.message}. Raw value: ${String(settingsStr).substring(0, 200)}`);
    }
    if (settingsParseError) {
      settings._parseError = settingsParseError;
    }

    const channel = settings.channel || "email";

    // Read batch limits from SETTINGS
    const perfLevelSetting = await getSetting('performanceLevel');
    const perfPresets = getPerformancePresets(perfLevelSetting?.value1 || 'balanced');

    const shootingBatchSetting = await getSetting('shootingBatchLimit');
    const SHOOTING_BATCH_SIZE = parseInt(shootingBatchSetting?.value1) || perfPresets.shootingBatchLimit;
    const checkpointSetting = await getSetting('checkpointInterval');
    const CHECKPOINT_INTERVAL = parseInt(checkpointSetting?.value1) || perfPresets.checkpointInterval;
    const delaySetting = await getSetting('interBatchDelayMs');
    const INTER_BATCH_DELAY = parseInt(delaySetting?.value1) || perfPresets.interBatchDelayMs;
    const multiServerSetting = await getSetting('multiServerEnabled');
    const MULTI_SERVER_ENABLED = multiServerSetting?.value1 === 'true';

    log.info(` shooting=${SHOOTING_BATCH_SIZE}, checkpoint=${CHECKPOINT_INTERVAL}, delay=${INTER_BATCH_DELAY}ms, multiServer=${MULTI_SERVER_ENABLED}, level=${perfLevelSetting?.value1 || 'balanced'}`);
    
    // Update campaign status to running
    await updateSheetRowApi("campaigns", "campaignId", campaignId, {
      status: "running",
      updatedOn: new Date().toISOString()
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

      log.info(` Downloading CSV file for campaign sending: ${fileId}`);
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

      const dataRows = normalizedRows.slice(1);

      const nHeaders = normalizedRows[0];
      const emailColIdx = nHeaders.indexOf("EMAIL");
      const nameColIdx = nHeaders.indexOf("FIRSTNAME");
      const companyColIdx = nHeaders.indexOf("BUSINESSNAME");
      const sendDateIdx = nHeaders.indexOf("sendDate");
      const sendTimeIdx = nHeaders.indexOf("sendTime");
      const sendStampIdx = nHeaders.indexOf("sendStamp");
      const validationIdx = nHeaders.indexOf("validation");
      const providerMXIdx = nHeaders.indexOf("providerMXResult");
      const enhancedSubjectIdx = nHeaders.indexOf("enhancedSubject");
      const enhancedBodyIdx = nHeaders.indexOf("enhancedBody");
      const emailSubjectIdx = nHeaders.indexOf("emailSubject");
      const emailBodyIdx = nHeaders.indexOf("emailBody");
      const executionStatusIdx = nHeaders.findIndex(h => h.toLowerCase().trim() === "executionstatus");

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

      // Step 3b: Fetch plan limit (shootCampaignLimit) from the cached Limits sheet
      let shootCampaignLimit = 0;
      try {
        const campaignLimits = await getCampaignLimits();
        shootCampaignLimit = campaignLimits.shootCampaignLimit;
      } catch (limitErr) {
        log.warn(` Failed to fetch limits, blocking: ${limitErr.message}`);
      }

      if (shootCampaignLimit <= 0) {
        log.info(` shootCampaignLimit is 0 or unavailable, blocking execution`);
        await updateCampaignSettings(campaignId, { executionStatus: "completed" });
        return NextResponse.json({ success: true, message: "Execution blocked: shootCampaignLimit is 0", limitReached: true });
      }

      // Load firestick emails if warm-up is enabled
      const firestickEnabled = settings.firestickEnabled === true;
      let firestickList = [];
      if (firestickEnabled) {
        firestickList = await getFirestickEmails();
        if (firestickList.length > 0) {
          shootCampaignLimit = Math.floor(shootCampaignLimit / 2);
          log.info(` Firestick warm-up enabled: ${firestickList.length} firestick emails loaded, limit halved to ${shootCampaignLimit}`);
        } else {
          log.warn(` Firestick warm-up enabled but no firestick emails found in SETTINGS, proceeding without warm-up`);
        }
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
          log.warn(` Skipping duplicate email: ${email}`);
          duplicateCount++;
          continue; // Skip duplicate
        }

        uniqueEmails.add(email);
        deduplicatedRows.push(row);
      }

      if (duplicateCount > 0) {
        log.info(` Removed ${duplicateCount} duplicate email(s) from recipient list`);
      }

      // ─── MULTI-SERVER DISPATCH ────────────────────────────────────
      if (MULTI_SERVER_ENABLED) {
        const dispatchResult = await dispatchToServers(campaignId, 'execute', fileUrl, deduplicatedRows.length);
        if (dispatchResult) {
          return NextResponse.json({
            success: true,
            message: `Email campaign distributed across ${dispatchResult.servers.length} servers`,
            dispatched: true,
            servers: dispatchResult.servers,
          });
        }
      }

      // ─── SINGLE-SERVER FALLBACK ────────────────────────────────────
      // Step 3d: Check for checkpoint to resume partial execution
      const lastProcessedRow = settings.lastProcessedRow || 0;
      if (lastProcessedRow > 0) {
        log.info(` Resuming from checkpoint row ${lastProcessedRow} (previously processed ${lastProcessedRow} rows)`);
      }

      const startIndex = Math.max(0, lastProcessedRow);
      const maxToProcess = Math.min(deduplicatedRows.length, shootCampaignLimit, SHOOTING_BATCH_SIZE);
      log.info(` Sending emails: limit=${shootCampaignLimit === Infinity ? 'unlimited' : shootCampaignLimit}, batch=${maxToProcess} contacts (after dedup: ${deduplicatedRows.length}/${dataRows.length})`);

      // Step 3e: Processing loop over deduplicated rows with checkpointing
      let pausedByAdmin = false;
      let firestickIndex = 0;
      for (let i = startIndex; i < deduplicatedRows.length; i++) {
        if (await isCampaignPaused(campaignId)) {
          pausedByAdmin = true;
          log.info(` Campaign ${campaignId} was paused during run. Stopping at row ${i}.`);
          break;
        }
        if (sentCount >= shootCampaignLimit) {
          limitReached = true;
          log.info(` shootCampaignLimit (${shootCampaignLimit}) reached, stopping.`);
          break;
        }
        if (sentCount >= 30) {
          log.info(` Vercel timeout safety cap (30) reached, stopping.`);
          break;
        }

        const row = deduplicatedRows[i];
        const email = row[emailColIdx]?.trim();
        if (!email) continue;

        const firstName = nameColIdx !== -1 && row[nameColIdx] ? row[nameColIdx] : "";
        const company = companyColIdx !== -1 && row[companyColIdx] ? row[companyColIdx] : "";

        // Priority: AI personalized > merged template > campaign settings > default
        let subject = (enhancedSubjectIdx !== -1 && row[enhancedSubjectIdx]?.trim())
          || (emailSubjectIdx !== -1 && row[emailSubjectIdx]?.trim())
          || settings.subject
          || "";
        let message = (enhancedBodyIdx !== -1 && row[enhancedBodyIdx]?.trim())
          || (emailBodyIdx !== -1 && row[emailBodyIdx]?.trim())
          || settings.body
          || "";

        // Embed campaign identifier for interaction tracking
        const tagged = embedCampaignIdentifier(subject, message, campaignId);
        subject = tagged.subject;
        message = tagged.body;

        const { config: smtp } = getNextSmtpConfig(smtpSettings, sentCount);
        const now = new Date();
        let senderHost = "WIRE";

        // Firestick warm-up: send to familiar inbox before the actual lead
        if (firestickEnabled && firestickList.length > 0) {
          try {
            const firestick = firestickList[firestickIndex % firestickList.length];
            firestickIndex++;
            const { config: firestickSmtp } = getNextSmtpConfig(smtpSettings, sentCount);
            await sendViaSMTP(firestick.email, subject, message, firestickSmtp);
            log.info(` Firestick warm-up sent to ${firestick.email}`);
            // Small delay between firestick and lead send
            await new Promise(r => setTimeout(r, 500));
          } catch (firestickErr) {
            log.warn(` Firestick warm-up failed: ${firestickErr.message}, continuing with lead send`);
          }
        }

        try {
          if (deliveryMethod === "smtp" || deliveryMethod === "mixed") {
            await sendViaSMTP(email, subject, message, smtp);
            senderHost = smtp?.host || "SMTP";
            deliveredCount++;
          }

          if (deliveryMethod === "wire" || deliveryMethod === "mixed") {
            // Fetch stored browser session from cookie sheet by profile ID
            const profileId = settings.accounts?.[0] || settings.wireAccount;
            const profileData = profileId ? await getSocialProfileCookies(profileId) : null;
            const wireCookies = profileData?.cookies;
            if (wireCookies) {
              const provider = profileData?.platform || detectProvider(smtp?.user || email) || "gmail";
              await sendViaBrowser(email, subject, message, wireCookies, provider);
            } else {
              log.info(` No WIRE browser session available for profile ${profileId}, using SMTP fallback`);
              if (deliveryMethod === "wire") {
                await sendViaSMTP(email, subject, message, smtp);
                senderHost = smtp?.host || "SMTP_FALLBACK";
              }
            }
            deliveredCount++;
          }

          sentCount++;
          log.info(`[Row send] ${email}: sent via ${senderHost} (${sentCount}/${maxToProcess})`);

          if (sendDateIdx !== -1) row[sendDateIdx] = now.toLocaleDateString();
          if (sendTimeIdx !== -1) row[sendTimeIdx] = now.toLocaleTimeString();
          if (sendStampIdx !== -1) row[sendStampIdx] = now.toISOString();
          if (executionStatusIdx !== -1) row[executionStatusIdx] = "sent";
          if (providerMXIdx !== -1) row[providerMXIdx] = senderHost;
        } catch (err) {
          log.error(` Failed to send to ${email} via ${senderHost}: ${err.message}`);
          failedCount++;
          sentCount++;
          failureDetails.push({ email, error: err.message, host: senderHost });

          if (executionStatusIdx !== -1) row[executionStatusIdx] = "failed";
          if (providerMXIdx !== -1) row[providerMXIdx] = err.message;
        }

        // Inter-email delay to prevent SMTP rate limiting
        if (INTER_BATCH_DELAY > 0) {
          await new Promise(r => setTimeout(r, INTER_BATCH_DELAY));
        }

        // Checkpoint: save progress every N rows (configurable from SETTINGS)
        if ((i + 1) % CHECKPOINT_INTERVAL === 0) {
          log.info(` Checkpoint at row ${i + 1}/${deduplicatedRows.length}`);
          try {
            settings.lastProcessedRow = i + 1;
            await updateSheetRowApi("campaigns", "campaignId", campaignId, {
              settings: JSON.stringify(settings),
              updatedOn: new Date().toISOString()
            });
          } catch (cpErr) {
            log.warn(` Checkpoint save failed at row ${i + 1}: ${cpErr.message}`);
          }
          // Live-progress flush: overwrite the Drive CSV so the file view reflects
          // progress mid-run. Uses the Drive API directly (no Apps Script), so the
          // backend/AppScript cache and quota are untouched.
          try {
            await drive.files.update({
              fileId,
              media: { mimeType: "text/csv", body: stringifyCSV(normalizedRows) }
            });
          } catch (flushErr) {
            log.warn(` Live CSV flush failed at row ${i + 1}: ${flushErr.message}`);
          }
        }
      }

      // Step 3d: Single-flush Drive save — rebuild CSV and overwrite file
      log.info(` Flushing updated CSV back to Drive: ${fileId}`);
      const updatedCSVContent = stringifyCSV(normalizedRows);
      await drive.files.update({
        fileId: fileId,
        media: {
          mimeType: "text/csv",
          body: updatedCSVContent
        }
      });

      // Step 3e: Single campaign status update
      const finalStatus = pausedByAdmin ? "paused" : (limitReached ? "Limit Reached" : "completed");
      const analytics = {
        totalRows: dataRows.length,
        sent: sentCount,
        delivered: deliveredCount,
        failed: failedCount,
        limitReached,
        paused: pausedByAdmin,
        failureDetails: failureDetails.slice(0, 20),
        server: getSelfUrl(),
        batchConfig: { shootingBatchSize: SHOOTING_BATCH_SIZE, checkpointInterval: CHECKPOINT_INTERVAL }
      };

      settings.analytics = analytics;
      const statusUpdate = {
        settings: JSON.stringify(settings),
        updatedOn: new Date().toISOString()
      };
      if (!pausedByAdmin) {
        delete settings.lastProcessedRow;
        statusUpdate.status = finalStatus;
      } else {
        // Preserve checkpoint so resume continues from where the pause interrupted.
        settings.lastProcessedRow = startIndex + sentCount;
        statusUpdate.settings = JSON.stringify(settings);
        statusUpdate.status = "paused";
      }
      await updateSheetRowApi("campaigns", "campaignId", campaignId, statusUpdate);

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
            log.info(` Downloading social CSV file: ${socialFileId}`);
            const dFile = await drive.files.get({ fileId: socialFileId, alt: "media" });
            if (typeof dFile.data === "string") {
              const normalized = normalizeAndMapCSV(dFile.data, STANDARD_88_COLUMNS);
              if (normalized.length > 1) socialCsvRows = normalized;
            }
          }
        }
      }

      // Step 4b: Fetch both shootCampaignLimit and interactionLimit from the cached Limits sheet
      let shootCampaignLimit = 0;
      let interactionLimit = 0;
      try {
        const campaignLimits = await getCampaignLimits();
        shootCampaignLimit = campaignLimits.shootCampaignLimit;
        interactionLimit = campaignLimits.interactionLimit;
      } catch (limitErr) {
        log.warn(` Failed to fetch social limits, blocking: ${limitErr.message}`);
      }

      if (shootCampaignLimit <= 0) {
        log.info(` shootCampaignLimit is 0 or unavailable, blocking social execution`);
        await updateCampaignSettings(campaignId, { executionStatus: "completed" });
        return NextResponse.json({ success: true, message: "Execution blocked: shootCampaignLimit is 0", limitReached: true });
      }

      log.info(` Queueing social tasks for ${activeProfiles.length} profiles (interactionLimit=${interactionLimit})...`);

      // Step 4c: Accumulate all tasks in-memory with priority ordering
      const PRIORITY_MAP = { "inbox-interact": 0, "activities-interact": 1, "page-interact": 2, "search-interact": 3 };
      const pendingSocialTasks = [];

      for (const profileId of activeProfiles) {
        const profileData = await getSocialProfileCookies(profileId);
        if (!profileData || !profileData.cookies) {
          log.warn(` No cookies found for active profile: ${profileId}`);
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
      const tasksToExecute = pendingSocialTasks.slice(0, Math.min(pendingSocialTasks.length, shootCampaignLimit));
      const executionResults = [];
      let executedCount = 0;
      let failedCount = 0;

      const ROUTE_MAP = {
        "search-interact": processSearchInteractTask,
        "page-interact": processPageInteractTask,
        "inbox-interact": processInboxInteractTask,
        "activities-interact": processActivitiesInteractTask,
      };

      // Build SOCIALUSERNAME → enhancedSocialMessage lookup for per-row DM personalization
      const socialMessageMap = {};
      if (socialCsvRows) {
        const h = socialCsvRows[0];
        const uidIdx = h.indexOf("SOCIALUSERNAME");
        const msgIdx = h.indexOf("enhancedSocialMessage");
        if (uidIdx !== -1 && msgIdx !== -1) {
          for (let r = 1; r < socialCsvRows.length; r++) {
            const uid = String(socialCsvRows[r][uidIdx] || "").trim();
            const msg = String(socialCsvRows[r][msgIdx] || "").trim();
            if (uid && msg) socialMessageMap[uid] = msg;
          }
        }
      }

      // Live-progress CSV flush: writes per-row interaction outcomes back to Drive
      // (Drive API only, no Apps Script) so the file view updates mid-run.
      let csvUpdated = false;
      const flushSocialCsv = async () => {
        if (!socialCsvRows || !socialFileId || !drive) return;
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
            const anyFailed = relatedResults.some(r => r.status === "FAILED");
            const outcome = anyFailed ? "failed" : "executed";
            if (searchKeysIdx !== -1) row[searchKeysIdx] = relatedResults.map(r => r.status).join("; ");
            if (searchStatusIdx !== -1) row[searchStatusIdx] = outcome;
            if (searchStampIdx !== -1) row[searchStampIdx] = new Date().toISOString();
            if (interactStatusIdx !== -1) row[interactStatusIdx] = outcome;
            if (interactStampIdx !== -1) row[interactStampIdx] = new Date().toISOString();
          }
        }
        const updatedCSV = stringifyCSV(socialCsvRows);
        await drive.files.update({
          fileId: socialFileId,
          media: { mimeType: "text/csv", body: updatedCSV }
        });
        csvUpdated = true;
      };

      let pausedByAdmin = false;
      for (const task of tasksToExecute) {
        if (await isCampaignPaused(campaignId)) {
          pausedByAdmin = true;
          log.info(` Campaign ${campaignId} was paused during social run. Stopping.`);
          break;
        }
        const handler = ROUTE_MAP[task.operation];
        if (!handler) {
          log.warn(` No handler for operation: ${task.operation}`);
          failedCount++;
          continue;
        }

        try {
          log.info(` Executing ${task.operation} task: ${task.taskId}`);

          // Enrich task payload with campaign context
          const perRowMessage = socialMessageMap[task.searchQuery] || "";
          const taskPayload = {
            ...task,
            profileId: task.searchQuery || null,
            socialStrategyPrompt: settings.socialStrategyPrompt || null,
            projectId: settings.projectId || null,
            messageText: perRowMessage || settings.socialMessage || "",
          };

          const result = await handler(taskPayload);
          executionResults.push(result);
          executedCount++;
          log.info(` Task ${task.taskId} completed: ${result.status}`);

          // Live-progress CSV flush after each task so the file view advances mid-run
          try {
            await flushSocialCsv();
          } catch (flushErr) {
            log.warn(` Social CSV flush failed after task ${task.taskId}: ${flushErr.message}`);
          }
        } catch (taskError) {
          log.error(` Task ${task.taskId} failed: ${taskError.message}`);
          executionResults.push({ taskId: task.taskId, status: "FAILED", error: taskError.message });
          failedCount++;

          // Live-progress CSV flush after a failure so the row is marked failed
          try {
            await flushSocialCsv();
          } catch (flushErr) {
            log.warn(` Social CSV flush failed after failed task ${task.taskId}: ${flushErr.message}`);
          }
        }

        // Inter-task delay for rate limiting
        await new Promise(res => setTimeout(res, 500));
      }

      // Step 4f: Send direct messages to all social profiles in CSV if enabled
      const shouldSendMessage = settings.shouldSendMessage === true || settings.shouldSendMessage === "true" || settings.sendToAll === true;
      if (shouldSendMessage && socialFileUrl) {
        log.info(` sendToAll enabled — sending DMs to all CSV social profiles`);
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
          log.info(` send-message result: ${dmResult.message}`);
          settings.dmResults = dmResult;
        } catch (dmErr) {
          log.error(` send-message failed: ${dmErr.message}`);
          settings.dmResults = { error: dmErr.message };
        }
      }

      // Step 4g: Single campaign status update
      const limitReached = executedCount < pendingSocialTasks.length || executedCount >= shootCampaignLimit;
      const finalStatus = pausedByAdmin ? "paused" : (limitReached ? "Limit Reached" : "completed");
      const analytics = {
        totalRows: tasksToExecute.length,
        sent: executedCount,
        delivered: executedCount - failedCount,
        failed: failedCount,
        limitReached,
        paused: pausedByAdmin,
        csvUpdated,
        executionResults,
      };

      settings.analytics = analytics;
      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        settings: JSON.stringify(settings),
        status: finalStatus,
        updatedOn: new Date().toISOString()
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
    log.error(` Error executing campaign: ${error.message}`, { stack: error.stack });
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
