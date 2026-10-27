import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import logger from "../../../utils/logger.js";
import { detectProvider } from "../../emails/_shared/wireSender.js";
import { validateSmtpConfigs, createSmtpSendCap, sendWarmupEmail, sendCampaignEmail } from "../../shooting/email/campaignSender.js";
import { resolveSocialSession } from "../../socials/_shared/routeHelper.js";
import { ensureReplyFilter } from "../../emails/_shared/replyFilter.js";
import { processSearchInteractTask } from "../../socials/search-interact/route.js";
import { processPageInteractTask } from "../../socials/page-interact/route.js";
import { processInboxInteractTask } from "../../socials/inbox-interact/route.js";
import { processActivitiesInteractTask } from "../../socials/activities-interact/route.js";
import { processSendMessages } from "../../shooting/social/dm.js";
import { platformConfigs as sendPlatformConfigs } from "../../shooting/social/platforms.js";
import { getCampaignLimits, checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";
import { resolveAccountGate, isLimitSkipError } from "../../socials/_shared/accountGate.js";
import workflowOps from "../../socials/_shared/workflowOps.js";

const { resolveSocialMessage } = workflowOps;
import { requireFeature } from "../../../utils/featureGate.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { getMaxConcurrentTasks } from "../../../utils/campaignConcurrency.js";
import { getSelfUrl, getSelfUrlWithFallback, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { dispatchToServers } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, getFirestickEmails, getPerformancePresets, updateCampaignSettings, getCampaignSettings, getAccountTagStatuses } from "../_shared/pipelineUtils.js";
import { notifyCampaignFailure } from "../../../utils/notifyCampaignFailure.js";
import { calculateScheduleTimes } from "../../../utils/scheduleCalculator.js";
import { detectEmailProvider } from "../../../utils/sendRateLimiter.js";

// ── Re-entrancy guard ──────────────────────────────────────────────────
// The orchestrator retries a timed-out execute POST (~300s undici
// headersTimeout). Without this guard the retry re-runs the whole campaign
// (duplicate queueSocialTask → duplicate profile downloads). A second POST
// for a campaignId that is already executing short-circuits to skipped.
const _executingCampaigns = new Set();

function embedCampaignIdentifier(subject, body, campaignId) {
  const identifier = `[${campaignId}]`;
  const taggedSubject = subject.includes(identifier) ? subject : `${subject} ${identifier}`;
  const identifierComment = `<!-- campaign:${campaignId} -->`;
  const taggedBody = body.includes(identifierComment) ? body : `${body}\n\n${identifierComment}`;
  return { subject: taggedSubject, body: taggedBody };
}

/**
 * Per-server fan-out completion bookkeeping. Each scoped run registers its
 * finished accounts under its serverScope; the campaign-level `status` column
 * flips only once every account in the FULL list has been covered by some
 * scope — no premature "completed" while sibling servers still run.
 * @returns {Promise<{ allDone: boolean }>}
 */
async function finalizeScopedRun(campaignId, serverScope, scopedAccounts, finalStatus) {
  try {
    const fresh = await getCampaignSettings(campaignId);
    if (!fresh) return { allDone: false };
    const s = fresh.settings || {};
    const done = s._scopedCompleted || {};
    done[serverScope || "unknown"] = {
      accounts: (scopedAccounts || []).map(String),
      status: finalStatus || "completed",
      at: new Date().toISOString(),
    };
    const covered = new Set();
    Object.values(done).forEach(e => (e.accounts || []).forEach(id => covered.add(String(id))));
    const full = (s._fullAccounts || s.accounts || []).map(String);
    const allDone = full.length > 0 && full.every(id => covered.has(id));
    await updateCampaignSettings(campaignId, { _scopedCompleted: done });
    if (allDone && finalStatus) {
      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        status: finalStatus,
        updatedOn: new Date().toISOString(),
      });
      // Clear transient scope bookkeeping
      await updateCampaignSettings(campaignId, { _scopedCompleted: {}, _fullAccounts: [] });
    }
    return { allDone };
  } catch (err) {
    logger.warn(`[execute-campaign] finalizeScopedRun failed for ${campaignId}: ${err.message}`);
    return { allDone: false };
  }
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

const KNOWN_SOCIAL_PLATFORMS = ['tiktok', 'twitter', 'instagram', 'facebook', 'whatsapp', 'discord', 'linkedin'];

// Normalize free-form sheet values (type/platform/category) to a social
// platform token. Non-platform values (WIRE/SOCIAL/BANK, gmail/outlook, …)
// normalize to "" so callers can fall through the resolution chain.
function normalizeSocialPlatform(value) {
  const p = String(value || '').toLowerCase().trim();
  if (!p) return '';
  if (p.includes('tiktok')) return 'tiktok';
  if (p.includes('twitter')) return 'twitter';
  if (p.includes('instagram')) return 'instagram';
  if (p.includes('facebook')) return 'facebook';
  if (p.includes('whatsapp')) return 'whatsapp';
  if (p.includes('discord')) return 'discord';
  if (p.includes('linkedin')) return 'linkedin';
  if (p === 'x') return 'twitter';
  return KNOWN_SOCIAL_PLATFORMS.includes(p) ? p : '';
}

// Verified actions that count toward the user-level interactionUsage quota.
// DMs (coldMessage/message) are tracked separately by senderUsage.
const DM_QUOTA_KEYS = new Set(["coldMessage", "message"]);
function interactionActionsFromQuota(quota) {
  if (!quota || typeof quota !== "object") return 1; // legacy handler, no tally
  return Object.entries(quota)
    .filter(([k]) => k !== "total" && !DM_QUOTA_KEYS.has(k))
    .reduce((a, [, v]) => a + (Number(v) || 0), 0);
}

async function getSocialProfileCookies(profileId) {
  const sid = String(profileId).trim();
  let cookies = "";
  let platform = "";
  let browserIdentity = null;
  let driveUrl = "";

  // Cookie sheet (legacy capture table) — first choice when it has data.
  const cookieResult = await getSheetDataApi("cookie");
  if (cookieResult.success) {
    const headers = cookieResult.headers;
    const browserIdIdx = headers.indexOf("browserId");
    const cookieIdx = headers.indexOf("formattedCookie") !== -1 ? headers.indexOf("formattedCookie") : headers.indexOf("cookieJSON");
    const platformIdx = headers.indexOf("platform");
    const categoryIdx = headers.indexOf("category");
    const identityIdx = headers.indexOf("browserIdentity");
    const driveUrlIdx = headers.indexOf("driveUrl");
    if (browserIdIdx !== -1) {
      const row = cookieResult.data.find(r => String(r[browserIdIdx]).trim() === sid);
      if (row) {
        cookies = row[cookieIdx] || "";
        platform = normalizeSocialPlatform(platformIdx !== -1 ? row[platformIdx] : '');
        if (!platform && categoryIdx !== -1) platform = normalizeSocialPlatform(row[categoryIdx]);
        if (identityIdx !== -1 && row[identityIdx]) {
          try { browserIdentity = typeof row[identityIdx] === 'string' ? JSON.parse(row[identityIdx]) : row[identityIdx]; } catch (_) {}
        }
        driveUrl = driveUrlIdx !== -1 ? row[driveUrlIdx] || "" : "";
      }
    }
  }

  // Hub sheet (live account registry) — fallback when the cookie sheet row is
  // missing or an empty shell. Accounts logged in via the hub carry cookieJSON,
  // the profile ZIP link (cookieFileURL), platform and identity here only.
  let hub = null;
  if (!cookies || !platform) {
    try {
      const hubResult = await getSheetDataApi("hub");
      if (hubResult.success) {
        const hh = hubResult.headers;
        const sidIdx = hh.indexOf("submissionId");
        if (sidIdx !== -1) {
          const hubRow = hubResult.data.find(r => String(r[sidIdx]).trim() === sid);
          if (hubRow) hub = { headers: hh, row: hubRow };
        }
      }
    } catch (_) { /* hub lookup is best-effort */ }
  }

  if (hub) {
    const getH = (name) => { const i = hub.headers.indexOf(name); return i !== -1 ? hub.row[i] : ""; };
    if (!cookies) cookies = getH("cookieJSON") || "";
    if (!driveUrl) driveUrl = getH("cookieFileURL") || "";
    if (!browserIdentity) {
      const raw = getH("browserIdentity");
      if (raw) { try { browserIdentity = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {} }
    }
    if (!platform) platform = normalizeSocialPlatform(getH("platform"));
    if (!platform) platform = normalizeSocialPlatform(getH("type"));
    // Oldest rows predate the hub platform column — resolve via the project's
    // templateTitle.
    if (!platform) {
      const hubProjectId = String(getH("projectId") || "").trim();
      if (hubProjectId) {
        try {
          const projResult = await getSheetDataApi("projects");
          if (projResult.success) {
            const ph = projResult.headers;
            const pIdIdx = ph.indexOf("projectId");
            const templateTitleIdx = ph.indexOf("templateTitle");
            if (pIdIdx !== -1 && templateTitleIdx !== -1) {
              const projRow = projResult.data.find(r => String(r[pIdIdx]).trim() === hubProjectId);
              if (projRow) platform = normalizeSocialPlatform(projRow[templateTitleIdx]);
            }
          }
        } catch (_) { /* project lookup is best-effort */ }
      }
    }
  }

  return {
    cookies,
    platform,
    browserIdentity,
    driveUrl,
  };
}

export async function POST(request) {
  let campaignId = null;
  // True only when THIS invocation claimed the re-entrancy slot. A skipped
  // duplicate request must NOT delete the other run's slot in finally.
  let _isExecuting = false;
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const gate = await requireFeature('allowShooting', 'campaign shooting');
    if (gate) return gate;
    const body = await request.json();
    ({ campaignId } = body);

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    const log = logger.child({ campaignId, stage: 'execute' });

    // Re-entrancy guard: if this campaign is already executing in this
    // process, the orchestrator's retry (after its fetch timeout) must NOT
    // re-run the whole campaign — that caused duplicate profile downloads.
    if (_executingCampaigns.has(campaignId)) {
      log.info(`[reentrancy] Execute already in-flight for ${campaignId} — returning skipped`);
      return NextResponse.json({
        success: true,
        skipped: true,
        message: "Campaign execute already in-flight on this server",
      });
    }
    _executingCampaigns.add(campaignId);
    _isExecuting = true;
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
    const userId = settings.userId || null;

    // Gate maximum accounts per campaign (from SETTINGS sheet maxAccountsPerCampaign, default 1)
    const maxAccountsSetting = await getSetting('maxAccountsPerCampaign');
    const parsedMax = parseInt(maxAccountsSetting?.value1, 10);
    const maxCampaignAccounts = (!isNaN(parsedMax) && parsedMax > 0) ? parsedMax : 1;
    const allConfiguredAccounts = (settings._fullAccounts || settings.accounts || []).map(String);
    if (allConfiguredAccounts.length > maxCampaignAccounts) {
      log.warn(` Campaign ${campaignId} exceeds maxAccountsPerCampaign (${allConfiguredAccounts.length} > ${maxCampaignAccounts}). Capping to top ${maxCampaignAccounts}.`);
      settings.accounts = (settings.accounts || []).slice(0, maxCampaignAccounts);
    }

    // ── Per-server fan-out scope (GAS dispatchCampaignToServers) ──────────
    // body.accountIds = this server's account subset; body.serverScope = the
    // owning server URL (or 'fallback'). Absent → full-list legacy behavior.
    // Scoping intersects with settings.accounts so a stale/malicious payload
    // can never shoot accounts outside the campaign.
    const scopedIds = Array.isArray(body.accountIds) ? body.accountIds.map(String) : null;
    const serverScope = typeof body.serverScope === "string" && body.serverScope ? body.serverScope : null;
    const isScopedRun = !!(scopedIds && scopedIds.length > 0);
    if (isScopedRun) {
      const fullAccounts = (settings.accounts || []).map(String);
      settings._fullAccounts = fullAccounts;
      settings.accounts = fullAccounts.filter(id => scopedIds.includes(id));
      log.info(` Scoped run (serverScope=${serverScope}): ${settings.accounts.length}/${fullAccounts.length} accounts on this instance`);
      if (settings.accounts.length === 0) {
        return NextResponse.json({ success: true, message: "No accounts in scope for this server", emptyScope: true });
      }
      // Persist the full account list so finalizeScopedRun (fresh sheet read)
      // can compute cross-server coverage even if settings.accounts is later
      // narrowed. Merge-write keeps sibling scopes' bookkeeping intact.
      await updateCampaignSettings(campaignId, { _fullAccounts: fullAccounts });
    }

    // USER tier — monthly shootCampaign budget gates the email run before any
    // browser launches or CSV is downloaded. Social stage is gated per task
    // below; campaign starts are no longer quota-gated (plan row *Limit only).
    if (userId && channel === "email") {
      const userQuota = await checkUserQuota(userId, { keys: ["shootCampaignUsage"] });
      if (!userQuota.allowed) {
        log.warn(` [user-limit] Campaign ${campaignId} blocked: ${userQuota.reason}`);
        await updateCampaignSettings(campaignId, { executionStatus: "completed", status: "Limit Reached" });
        return NextResponse.json({
          success: true,
          message: `Execution blocked: ${userQuota.reason}`,
          limitReached: true,
          userMonthlyLimit: true,
        });
      }
    }

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
      const interactionOnly = !fileUrl && (settings.campaignMode === "interactions-only" || settings.interactionStaged === true);

      if (!fileUrl && !interactionOnly) {
        throw new Error("No CSV contact list fileUrl configured for email campaign");
      }

      if (interactionOnly) {
        // ===== EMAIL INTERACTIONS-ONLY MODE (no contact list) =====
        // The AI inbox watcher (interact-inbox) handles keyword discovery and
        // AI replies against the selected hub email accounts. Nothing to send here.
        log.info(` Interaction-only email campaign (no contact list) — marking execute complete, AI inbox watcher will drive interactions`);
        if (isScopedRun) {
          // Fan-out sibling scopes may still be finalizing — coverage-gated flip.
          const { allDone } = await finalizeScopedRun(campaignId, serverScope, (settings.accounts || []).map(String), "completed");
          if (allDone) {
            await updateSheetRowApi("campaigns", "campaignId", campaignId, {
              status: "completed",
              updatedOn: new Date().toISOString()
            });
          }
        } else {
          await updateSheetRowApi("campaigns", "campaignId", campaignId, {
            status: "completed",
            updatedOn: new Date().toISOString()
          });
        }
        await updateCampaignSettings(campaignId, {
          executionStatus: "completed",
          campaignMode: "interactions-only",
          targetLink: settings.targetLink || "",
          interactionStatus: settings.interactionStatus || "idle",
          interactionStartedAt: settings.interactionStartedAt || ""
        });
        return NextResponse.json({
          success: true,
          message: "Interaction-only email campaign: no send phase. AI inbox interactions will be driven by the interact stage.",
          interactionOnly: true
        });
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
        // USER tier — monthly smtpChecker budget counts one full run's SMTP
        // config validation pass (Q6=B). Gated before any validation work.
        if (userId) {
          const scQuota = await checkUserQuota(userId, { keys: ["smtpCheckerUsage"] });
          if (!scQuota.allowed) {
            log.info(` [user-limit] ${scQuota.reason} — blocking SMTP validation for campaign ${campaignId}.`);
            await updateCampaignSettings(campaignId, { executionStatus: "completed", status: "Limit Reached" });
            return NextResponse.json({
              success: true,
              message: `Execution blocked: ${scQuota.reason}`,
              limitReached: true,
              userMonthlyLimit: true,
            });
          }
        }
        validateSmtpConfigs(smtpSettings);
        if (userId) {
          try {
            await updateUserUsage(userId, "smtpCheckerUsage");
          } catch (uErr) {
            log.warn(` [user-limit] smtpCheckerUsage increment failed: ${uErr.message}`);
          }
        }
      }

      // Step 3b: Fetch the per-run email cap from SETTINGS (shootingBatchLimit)
      let shootCampaignLimit = 0;
      let accountSendPerRunLimit = 0;
      try {
        const campaignLimits = await getCampaignLimits();
        shootCampaignLimit = campaignLimits.shootCampaignLimit;
        accountSendPerRunLimit = parseInt(campaignLimits.accountSendPerRunLimit, 10) || 0;
      } catch (limitErr) {
        log.warn(` Failed to fetch limits, blocking: ${limitErr.message}`);
      }

      if (shootCampaignLimit <= 0) {
        log.info(` shootingBatchLimit is 0 or unavailable, blocking execution - set shootingBatchLimit in the SETTINGS sheet`);
        await updateCampaignSettings(campaignId, { executionStatus: "completed", status: "Limit Reached" });
        return NextResponse.json({ success: true, message: "Execution blocked: shootingBatchLimit is 0 - set it in the SETTINGS sheet", limitReached: true });
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

      // ACCOUNT tier — the wire profile may be CANCELLED or RATE_LIMITED when
      // this stage starts (or was flipped by a previous stage). Decision: skip
      // the account, continue the campaign with other stages — the email run
      // stops with limitReached, never FAILED.
      const wireProfileId = settings.accounts?.[0] || settings.wireAccount;
      if (wireProfileId) {
        const wireData = await getSocialProfileCookies(wireProfileId).catch(() => null);
        const wirePlatform = String(wireData?.platform || detectProvider(smtpSettings[0]?.user || wireProfileId) || "").trim();
        const wireGate = await resolveAccountGate(wireProfileId, wirePlatform);
        if (wireGate.blocked) {
          log.warn(` [account-limit] Wire profile ${wireProfileId} blocked (${wireGate.reason}) — stopping email run.`);
          limitReached = true;
          return NextResponse.json({
            success: true,
            message: `Email run stopped by account limits: ${wireGate.reason}`,
            limitReached: true,
            accountBlocked: true,
            skippedAccount: wireProfileId,
          });
        }
      }

      // ─── REPLY FILTER (campaign hygiene) ────────────────────────────
      // Every campaign subject carries '[campaignId]' (embedCampaignIdentifier)
      // — install ONE filter per run so inbound replies are moved out of the
      // normal inbox into the reply folder (campaign setup, default
      // 'Campaign-Replies'). Own short-lived session via the wire account;
      // best-effort — a failure never blocks sends (STEALTH-SENDING-PLAN.MD).
      const replyFolder = String(settings.replyFolder || "").trim() || "Campaign-Replies";
      {
        const profileId = settings.accounts?.[0] || settings.wireAccount;
        const profileData = profileId ? await getSocialProfileCookies(profileId) : null;
        if (profileData?.cookies) {
          try {
            const provider =
              profileData.platform || detectProvider(smtpSettings[0]?.user || settings.wireAccount || "") || "gmail";
            const { browser, page, profileDir } = await resolveSocialSession(
              {
                cookies: profileData.cookies,
                browserIdentity: profileData.browserIdentity || null,
                driveUrl: profileData.driveUrl || "",
                profileId,
                platform: detectEmailProvider(provider),
              },
              false
            );
            try {
              const res = await ensureReplyFilter(page, provider, campaignId, replyFolder, log);
              log.info(
                ` Reply filter: ${res.status}${res.reason ? ` (${res.reason})` : ""} → '${replyFolder}' (identifier=${campaignId})`
              );
            } finally {
              await page.close().catch(() => {});
              await browser.close().catch(() => {});
              if (profileDir) {
                const fs = await import("fs-extra");
                await fs.remove(profileDir).catch(() => {});
              }
            }
          } catch (filterErr) {
            log.warn(` Reply filter setup failed (continuing with sends): ${filterErr.message}`);
          }
        } else {
          log.warn(` Reply filter skipped — no browser session for profile ${profileId || "none"}`);
        }
      }

      // Step 3e: Processing loop over deduplicated rows with checkpointing
      let pausedByAdmin = false;
      let firestickIndex = 0;
      // Per-run send cap per SMTP account (plan cell accountSendPerRunLimit,
      // campaign default 5, 0 = off): rotate across accounts; when every
      // account hit its cap, stop the run with limitReached.
      const smtpCap = createSmtpSendCap({ smtpSettings, accountSendPerRunLimit });
      const pickSmtpWithinCap = smtpCap.pick;
      const noteSmtpSend = smtpCap.note;
      for (let i = startIndex; i < deduplicatedRows.length; i++) {
        if (await isCampaignPaused(campaignId)) {
          pausedByAdmin = true;
          log.info(` Campaign ${campaignId} was paused during run. Stopping at row ${i}.`);
          break;
        }
        // USER tier — monthly shootCampaign budget re-checked per row so a
        // campaign stops mid-run as soon as the user's budget is exhausted.
        if (userId) {
          const uq = await checkUserQuota(userId, { keys: ["shootCampaignUsage"] });
          if (!uq.allowed) {
            limitReached = true;
            log.info(` [user-limit] ${uq.reason} — stopping email run at row ${i}.`);
            break;
          }
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

        let smtpPick = pickSmtpWithinCap(sentCount);
        if (!smtpPick && accountSendPerRunLimit > 0 && smtpSettings.length > 0) {
          limitReached = true;
          log.info(` accountSendPerRunLimit (${accountSendPerRunLimit}) reached on every SMTP account, stopping email run.`);
          break;
        }
        const { config: smtp } = smtpPick || {};
        const now = new Date();
        let senderHost = "WIRE";
        const isSchedule = settings.sendMode === "schedule";

        // Firestick warm-up: send to familiar inbox before the actual lead
        if (firestickEnabled && firestickList.length > 0) {
          try {
            const firestick = firestickList[firestickIndex % firestickList.length];
            firestickIndex++;
            await sendWarmupEmail({
              email: firestick.email,
              subject,
              message,
              seed: sentCount,
              pickSmtp: pickSmtpWithinCap,
              noteSmtp: noteSmtpSend,
            });
            log.info(` Firestick warm-up sent to ${firestick.email}`);
            // Small delay between firestick and lead send
            await new Promise(r => setTimeout(r, 500));
          } catch (firestickErr) {
            log.warn(` Firestick warm-up failed: ${firestickErr.message}, continuing with lead send`);
          }
        }

        try {
          const needsBrowser = isSchedule || deliveryMethod === "wire" || deliveryMethod === "mixed";
          const profileId = needsBrowser ? (settings.accounts?.[0] || settings.wireAccount) : null;
          const profileData = profileId ? await getSocialProfileCookies(profileId) : null;

          let scheduleTime = null;
          if (isSchedule) {
            // Use per-row sendDate/sendTime if available, else use scheduleStartTime
            const rowSendDate = sendDateIdx !== -1 ? row[sendDateIdx] : "";
            const rowSendTime = sendTimeIdx !== -1 ? row[sendTimeIdx] : "";
            if (rowSendDate && rowSendTime) {
              scheduleTime = new Date(`${rowSendDate} ${rowSendTime}`);
            } else if (settings.scheduleStartTime) {
              scheduleTime = new Date(settings.scheduleStartTime);
              // Offset by sentCount * 1 minute to space out
              scheduleTime = new Date(scheduleTime.getTime() + sentCount * 60000);
            } else {
              scheduleTime = new Date(now.getTime() + sentCount * 60000);
            }
          }

          const sendResult = await sendCampaignEmail({
            email,
            subject,
            message,
            smtp,
            isSchedule,
            deliveryMethod,
            profileId,
            profileData,
            scheduleTime: scheduleTime ? scheduleTime.toISOString() : null,
            noteSmtp: noteSmtpSend,
            log,
          });
          senderHost = sendResult.senderHost;
          deliveredCount += sendResult.delivered;

          sentCount++;
          if (userId) {
            try {
              await updateUserUsage(userId, "shootCampaignUsage");
            } catch (uErr) {
              log.warn(` [user-limit] usage increment failed: ${uErr.message}`);
            }
          }
          log.info(`[Row ${isSchedule ? "schedule" : "send"}] ${email}: ${isSchedule ? "scheduled" : "sent"} via ${senderHost} (${sentCount}/${maxToProcess})`);

          if (isSchedule) {
            // For schedule mode, write the scheduled time back to CSV
            const scheduleTime = settings.scheduleStartTime || new Date().toISOString();
            if (sendDateIdx !== -1) row[sendDateIdx] = new Date(scheduleTime).toLocaleDateString();
            if (sendTimeIdx !== -1) row[sendTimeIdx] = new Date(scheduleTime).toLocaleTimeString();
            if (sendStampIdx !== -1) row[sendStampIdx] = new Date(scheduleTime).toISOString();
          } else {
            if (sendDateIdx !== -1) row[sendDateIdx] = now.toLocaleDateString();
            if (sendTimeIdx !== -1) row[sendTimeIdx] = now.toLocaleTimeString();
            if (sendStampIdx !== -1) row[sendStampIdx] = now.toISOString();
          }
          if (executionStatusIdx !== -1) row[executionStatusIdx] = isSchedule ? "scheduled" : "sent";
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
      // Scoped runs: capture this server's account subset, restore the full
      // account list before persisting settings (settings.accounts was
      // narrowed to this server's subset in-memory only). _fullAccounts stays
      // persisted so sibling scopes can compute coverage; finalizeScopedRun
      // clears it once every account is covered.
      const scopedRunAccounts = isScopedRun ? (settings.accounts || []).map(String) : null;
      if (isScopedRun) {
        settings.accounts = settings._fullAccounts || settings.accounts;
      }
      if (isScopedRun) {
        // Merge-write (preserves sibling scopes' _scopedCompleted records —
        // a full settings blob overwrite would wipe them).
        const scopedUpdate = { analytics, accounts: settings.accounts };
        if (pausedByAdmin) {
          // Preserve checkpoint so resume continues from where the pause interrupted.
          scopedUpdate.lastProcessedRow = startIndex + sentCount;
          await updateCampaignSettings(campaignId, scopedUpdate);
          await updateSheetRowApi("campaigns", "campaignId", campaignId, {
            status: "paused",
            updatedOn: new Date().toISOString()
          });
        } else {
          // lastProcessedRow: undefined → key dropped by JSON.stringify.
          scopedUpdate.lastProcessedRow = undefined;
          await updateCampaignSettings(campaignId, scopedUpdate);
          // Status flips only once every account in the full list is covered.
          await finalizeScopedRun(campaignId, serverScope, scopedRunAccounts, finalStatus);
        }
      } else {
        const statusUpdate = {
          settings: JSON.stringify(settings),
          updatedOn: new Date().toISOString()
        };
        if (!pausedByAdmin) {
          delete settings.lastProcessedRow;
          statusUpdate.settings = JSON.stringify(settings);
          statusUpdate.status = finalStatus;
        } else {
          // Preserve checkpoint so resume continues from where the pause interrupted.
          settings.lastProcessedRow = startIndex + sentCount;
          statusUpdate.settings = JSON.stringify(settings);
          statusUpdate.status = "paused";
        }
        await updateSheetRowApi("campaigns", "campaignId", campaignId, statusUpdate);
      }

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
      const engagementMode = settings.engagementMode === true || String(settings.engagementMode || "").toLowerCase() === "true";
      if (engagementMode) log.info(" engagementMode enabled — tasks will run engagement workflows instead of read/scrape only.");

      if (activeProfiles.length === 0) {
        throw new Error("No active SOCIAL profiles selected for social campaign");
      }
      // Target validation happens AFTER the CSV load below: campaigns driven
      // purely by an uploaded CSV (SOCIALUSERNAME column) or inbox-only
      // campaigns (no list required) are valid and must not be rejected here.

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

      // Step 4a2: Resolve campaign-wide targets. CSV handles (SOCIALUSERNAME)
      // override the campaign-level keyword chips when a CSV is present.
      const csvHandleIdx = socialCsvRows ? socialCsvRows[0].indexOf("SOCIALUSERNAME") : -1;
      const csvPlatformIdx = socialCsvRows ? socialCsvRows[0].indexOf("SOCIALPLATFORM") : -1;
      let csvHandles = [];
      if (socialCsvRows && csvHandleIdx !== -1) {
        csvHandles = socialCsvRows.slice(1).map(r => String(r[csvHandleIdx] || "").trim()).filter(Boolean);
      }
      const effectiveKeywords = csvHandles.length > 0 ? csvHandles : keywords;
      const inboxHookEnabled = interactionTypes.includes("inbox");
      if (effectiveKeywords.length === 0 && !inboxHookEnabled) {
        throw new Error("No targets configured: add targeting keywords, upload a CSV with a SOCIALUSERNAME column, or enable an interaction hook (inbox works without a list)");
      }

      // Step 4b: Fetch interactionLimit (the social per-run cap) from the
      // SETTINGS sheet (interactionBatchLimit). Strict fail-closed: unset/empty/
      // 0 blocks — the admin must set interactionBatchLimit in the SETTINGS
      // sheet. shootCampaignLimit/shootingBatchLimit is email-only ("Campaign
      // sends") and must never gate social runs. Monthly spend stays gated by
      // checkUserQuota(interactionUsage) per task; platform actions stay gated
      // by the Limits platform rows vs per-account hub usage.
      // Step 4b: interactionLimit from SETTINGS (interactionBatchLimit)
      // Removed fail-closed blocking: social interaction tasks run without artificial batch gates;
      // quotas are strictly governed by platform limits and user monthly quota.
      let interactionLimit = Infinity;
      try {
        const campaignLimits = await getCampaignLimits();
        if (campaignLimits.interactionLimit > 0) {
          interactionLimit = campaignLimits.interactionLimit;
        }
      } catch (limitErr) {
        log.warn(` Failed to fetch social limits (using unlimited batch): ${limitErr.message}`);
      }

      log.info(` Queueing social tasks for ${activeProfiles.length} profiles (interactionLimit=${interactionLimit})...`);

      // Step 4c: Accumulate all tasks in-memory with priority ordering
      const PRIORITY_MAP = { "inbox-interact": 0, "page-interact": 1, "search-interact": 2, "activities-interact": 3 };
      const pendingSocialTasks = [];
      const profilePlatforms = {};
      // Batch engagement settings from campaign settings JSON (safe defaults).
      const maxResultsPerKeyword = Math.max(1, parseInt(settings.maxResultsPerKeyword, 10) || 5);

      // Batch task: ONE task per profile per operation, carrying ALL target
      // keywords/queries in searchQueries[]. The route opens the browser once
      // and loops the queries inside the single session (no per-keyword
      // browser reopen). searchQuery is kept as the first query for CSV
      // flush compatibility.
      const queueSocialTask = (operation, queries, platform, profileData, profileId) => {
        if (pendingSocialTasks.some(t => t.profileId === profileId && t.operation === operation)) {
          return;
        }
        const queryList = Array.isArray(queries) ? queries : [queries];
        pendingSocialTasks.push({
          taskId: "task-" + Math.random().toString(36).substring(2, 11),
          campaignId,
          platform,
          operation,
          priority: PRIORITY_MAP[operation] !== undefined ? PRIORITY_MAP[operation] : 99,
          engagementMode,
          searchQuery: queryList[0] || "",
          searchQueries: queryList,
          maxResultsPerKeyword,
          cookieJSON: typeof profileData.cookies === "string" ? profileData.cookies : JSON.stringify(profileData.cookies),
          browserIdentity: profileData.browserIdentity || null,
          driveUrl: profileData.driveUrl || "",
          profileId,
          // AI context: strategy + target link so messages are crafted with the destination in mind
          targetLink: settings.targetLink || "",
          socialStrategyPrompt: settings.socialStrategyPrompt || "",
          campaignMode: settings.campaignMode || "",
          // Campaign direct-execute tasks have no row in the social-tasks
          // sheet — the route skips updateTaskRow for these (avoids
          // "Unable to parse range: social-tasks!1:1" + GAS Invalid action).
          directExecute: true,
          status: "PENDING",
          createdAt: new Date().toISOString()
        });
      };

      for (const profileId of activeProfiles) {
        const profileData = await getSocialProfileCookies(profileId);
        if (!profileData || !profileData.cookies) {
          log.warn(` No cookies found for active profile: ${profileId}`);
          continue;
        }

        const platform = profileData.platform || normalizeSocialPlatform(settings.platform) || "twitter";
        profilePlatforms[profileId] = platform;

        // ACCOUNT-tier status gate — skip blocked profiles entirely (no tasks
        // queued for them); the rest of the campaign continues normally.
        try {
          const profileGate = await resolveAccountGate(profileId, platform);
          if (profileGate.blocked) {
            log.warn(` [account-limit] skipped profile ${profileId}: ${profileGate.reason}`);
            continue;
          }
        } catch (gateErr) {
          log.warn(` Account gate check failed for ${profileId} (continuing): ${gateErr.message}`);
        }

        // Per-profile targets. CSV rows carrying a SOCIALPLATFORM value only
        // feed accounts of that platform (rows without a platform match every
        // account); campaign keywords are the fallback when no CSV handles exist.
        let profileKeywords;
        if (csvHandles.length > 0 && socialCsvRows && csvPlatformIdx !== -1) {
          profileKeywords = socialCsvRows.slice(1)
            .filter(r => {
              const handle = String(r[csvHandleIdx] || "").trim();
              if (!handle) return false;
              const rowPlatform = normalizeSocialPlatform(String(r[csvPlatformIdx] || ""));
              return !rowPlatform || rowPlatform === platform;
            })
            .map(r => String(r[csvHandleIdx] || "").trim());
        } else {
          profileKeywords = effectiveKeywords;
        }

        // Inbox hook: exactly ONE task per profile — it monitors/answers DMs
        // and needs no per-keyword fan-out (previously it was duplicated once
        // per keyword, and queued zero tasks when no keywords existed).
        if (inboxHookEnabled && pendingSocialTasks.length < interactionLimit) {
          queueSocialTask("inbox-interact", [""], platform, profileData, profileId);
        }

        // ONE batch task per profile per operation — searchQueries carries
        // ALL keywords. The route opens the browser once and loops inside a
        // single session (no per-keyword browser reopen). interactionLimit
        // now caps task count = profile×operation combos (not keyword count).
        const filterPageKeywords = (kws) => kws.filter(kw =>
          // page-interact opens /<handle> directly — hashtags, search phrases
          // and URLs would produce broken profile URLs, so only handle-shaped
          // targets are queued for it.
          /^[A-Za-z0-9._-]+$/.test(kw.replace(/^@+/, ""))
        );

        let queuedForProfile = 0;
        for (const op of interactionTypes) {
          if (pendingSocialTasks.length >= interactionLimit) break;
          if (op === "inbox") continue; // queued once per profile above

          const operation = op === "search" ? "search-interact"
            : op === "activities" ? "activities-interact"
            : "page-interact";
          let opQueries = operation === "page-interact" ? filterPageKeywords(profileKeywords) : profileKeywords;
          // Tag resume: skip tags already marked done for this account (set
          // after an hourly-limit stop) so a resumed run only processes the
          // still-pending tags.
          if (operation === "search-interact") {
            const doneTags = getAccountTagStatuses(settings, profileId);
            const accountPosts = (settings.postStatus && settings.postStatus[String(profileId)]) || {};
            const totalEngagedPosts = Object.keys(accountPosts).length;

            // Stale doneTags recovery: If an account has doneTags recorded, but 0 posts
            // were ever engaged for this account, those tags were marked done by the prior
            // failed navigation bug. Clear them so the newly fixed navigation can run them!
            if (totalEngagedPosts === 0 && Object.keys(doneTags).length > 0) {
              log.info(` [tag-resume] profile ${profileId}: 0 posts ever engaged for this profile — clearing stale done tags to allow clean run.`);
              opQueries = profileKeywords;
            } else {
              opQueries = opQueries.filter(k => doneTags[String(k).trim()] !== "done");
            }

            if (opQueries.length === 0) {
              log.info(` [tag-resume] profile ${profileId}: all search tags already done — queueing activities-interact fallback`);
              queueSocialTask("activities-interact", [""], platform, profileData, profileId);
              queuedForProfile++;
              continue;
            }
          }
          if (opQueries.length === 0) continue;
          queueSocialTask(operation, opQueries, platform, profileData, profileId);
          queuedForProfile++;
        }

        // Automatic fallback: if no tasks were queued for this active profile (e.g. all search tags completed),
        // trigger activities-interact so the profile continues engaging (notifications, follower interactions, FYP)
        if (queuedForProfile === 0 && pendingSocialTasks.length < interactionLimit) {
          log.info(` [activities-fallback] profile ${profileId}: no pending tag tasks — queueing activities-interact`);
          queueSocialTask("activities-interact", [""], platform, profileData, profileId);
        }
        if (pendingSocialTasks.length >= interactionLimit) break;
      }

      // Step 4d: Sort tasks by priority (inbox > activities > page > search)
      pendingSocialTasks.sort((a, b) => a.priority - b.priority);

      // Step 4e: Execute tasks directly via social route handlers.
      // pendingSocialTasks is already capped at interactionLimit during
      // queueing (Step 4c) — no second cap.
      const tasksToExecute = pendingSocialTasks;
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
          // Batch tasks carry searchQueries[] — match when username is in the
          // array OR equals the legacy single searchQuery field.
          const relatedResults = executionResults.filter(r => r.taskId && tasksToExecute.find(t => {
            if (t.taskId !== r.taskId) return false;
            if (Array.isArray(t.searchQueries) && t.searchQueries.includes(username)) return true;
            return t.searchQuery === username;
          }));
          if (relatedResults.length > 0) {
            const searchKeysIdx = nHeaders.indexOf("searchKeys");
            const searchStatusIdx = nHeaders.indexOf("searchStatus");
            const searchStampIdx = nHeaders.indexOf("searchStamp");
            const interactStatusIdx = nHeaders.indexOf("interactStatus");
            const interactStampIdx = nHeaders.indexOf("interactStamp");
          const anyFailed = relatedResults.some(r => r.status === "FAILED");
          const anySkipped = relatedResults.some(r => r.status === "SKIPPED");
          const outcome = anyFailed ? "failed" : (anySkipped ? "skipped" : "executed");
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
      let skippedLimitCount = 0;
      let quotaStopped = false;

      // Concurrency governor: run up to MAX_CONCURRENT_TASKS social tasks in
      // parallel (SETTINGS key, read via campaignConcurrency). Previously this
      // loop was serial, so N accounts never overlapped.
      const maxConcurrentSocial = Math.max(1, await getMaxConcurrentTasks());

      // updateUserUsage is an unguarded read-modify-write and flushSocialCsv
      // rewrites the whole Drive CSV — serialize both so parallel tasks can't
      // clobber each other.
      let usageChain = Promise.resolve();
      // `count` = number of ACTIONS the task actually verified (success-only).
      const incrementInteractionUsage = (uid, count = 1) => {
        const n = Number(count) || 0;
        if (n <= 0) return usageChain;
        usageChain = usageChain
          .then(() => updateUserUsage(uid, "interactionUsage", n))
          .catch((uErr) => { log.warn(` [user-limit] usage increment failed: ${uErr.message}`); });
        return usageChain;
      };
      let flushChain = Promise.resolve();
      const flushSocialCsvSafe = (label) => {
        flushChain = flushChain
          .then(() => flushSocialCsv())
          .catch((flushErr) => { log.warn(` Social CSV flush failed after ${label}: ${flushErr.message}`); });
        return flushChain;
      };

      const runSocialTask = async (task) => {
        if (await isCampaignPaused(campaignId)) {
          pausedByAdmin = true;
          log.info(` Campaign ${campaignId} was paused during social run. Stopping.`);
          return;
        }
        // USER tier — daily action quota re-checked before every task
        if (userId) {
          const uq = await checkUserQuota(userId, { keys: ["interactionUsage"] });
          if (!uq.allowed) {
            log.info(` [user-limit] ${uq.reason} — stopping social run.`);
            quotaStopped = true;
            return;
          }
        }
        const handler = ROUTE_MAP[task.operation];
        if (!handler) {
          log.warn(` No handler for operation: ${task.operation}`);
          failedCount++;
          return;
        }

        try {
          log.info(` Executing ${task.operation} task: ${task.taskId}`);

          // Enrich task payload with campaign context
          const perRowMessage = socialMessageMap[task.searchQuery] || "";
          const taskPayload = {
            ...task,
            targetProfileId: task.searchQuery || null,
            socialStrategyPrompt: settings.socialStrategyPrompt || null,
            projectId: settings.projectId || null,
            messageText: resolveSocialMessage(perRowMessage, settings),
          };

          const result = await handler(taskPayload);
          executionResults.push(result);
          executedCount++;
          // Verified action count from the handler. DMs (coldMessage/message)
          // stay on senderUsage, so they are excluded from the user-level
          // interaction usage. Legacy handlers with no tally keep the previous
          // 1-per-task behaviour.
          const actionCount = interactionActionsFromQuota(result?.quota);
          if (userId) await incrementInteractionUsage(userId, actionCount);
          log.info(` Task ${task.taskId} completed: ${result.status} (actions=${actionCount})`);

          // Live-progress CSV flush after each task so the file view advances mid-run
          await flushSocialCsvSafe(`task ${task.taskId}`);
        } catch (taskError) {
          // Actions performed before the error are still real spend.
          const partial = taskError?.quota?.total;
          if (userId && Number.isFinite(partial) && partial > 0) {
            await incrementInteractionUsage(userId, partial);
            log.info(` Task ${task.taskId} failed after ${partial} actions — counted.`);
          }
          // Limit-type errors are SKIPS (account over quota / account blocked),
          // not failures — the campaign moves on to the next account/task.
          if (isLimitSkipError(taskError.message)) {
            skippedLimitCount++;
            executionResults.push({ taskId: task.taskId, status: "SKIPPED", error: taskError.message });
            log.warn(` [account-limit] Task ${task.taskId} skipped: ${taskError.message}`);
          } else {
            log.error(` Task ${task.taskId} failed: ${taskError.message}`);
            executionResults.push({ taskId: task.taskId, status: "FAILED", error: taskError.message });
            failedCount++;
          }

          // Live-progress CSV flush after a failure so the row is marked failed
          await flushSocialCsvSafe(`failed task ${task.taskId}`);
        }

        // Inter-task delay for rate limiting
        await new Promise(res => setTimeout(res, 500));
      };

      const socialQueue = tasksToExecute.slice();
      log.info(` Social dispatch: ${socialQueue.length} task(s), concurrency ${maxConcurrentSocial}`);
      const socialRunners = Array.from(
        { length: Math.min(maxConcurrentSocial, socialQueue.length) },
        async () => {
          while (!pausedByAdmin && !quotaStopped) {
            const task = socialQueue.shift();
            if (!task) break;
            await runSocialTask(task);
          }
        }
      );
      await Promise.all(socialRunners);

      // Step 4f: Send direct messages to all social profiles in CSV if enabled
      const shouldSendMessage = settings.shouldSendMessage === true || settings.shouldSendMessage === "true" || settings.sendToAll === true;
      if (shouldSendMessage && socialFileUrl) {
        const dmAccounts = activeProfiles.filter(id => {
          const p = profilePlatforms[id];
          return p && sendPlatformConfigs[p];
        });
        if (dmAccounts.length < activeProfiles.length) {
          log.warn(` Skipping DM step for ${activeProfiles.length - dmAccounts.length} account(s) whose platform has no send-message support.`);
        }
        if (dmAccounts.length > 0) {
          log.info(` sendToAll enabled — sending DMs to ${dmAccounts.length} CSV social profile(s)`);
          try {
            const dmResponse = await processSendMessages({
              campaignId,
              userId: userId || null,
              platform: "",
              messageText: resolveSocialMessage(null, settings),
              sendToAll: true,
              accountIds: dmAccounts,
            });
            const dmResult = await dmResponse.json();
            log.info(` send-message result: ${dmResult.message}`);
            settings.dmResults = dmResult;
          } catch (dmErr) {
            log.error(` send-message failed: ${dmErr.message}`);
            settings.dmResults = { error: dmErr.message };
          }
        } else {
          log.warn(" sendToAll enabled but no account supports send-message — skipping DM step.");
        }
      }

      // Step 4g: Single campaign status update
      const hasHourlyRateLimits = executionResults.some(r => r.status === 'COMPLETED' && (r.results || []).some(sub => sub.status === 'rate_limited' || sub.resumedNextCycle));
      if (hasHourlyRateLimits) {
        settings.restUntil = Date.now() + 3600000; // 1-hour rest before auto-resume
        log.info(` [campaign-rest] Hourly rate limit hit — resting campaign ${campaignId} until ${new Date(settings.restUntil).toISOString()}`);
      }
      const limitReached = executedCount < pendingSocialTasks.length || (interactionLimit !== Infinity && executedCount >= interactionLimit) || hasHourlyRateLimits;
      const finalStatus = pausedByAdmin ? "paused" : (hasHourlyRateLimits ? "resting" : (limitReached ? "Limit Reached" : "completed"));
      const analytics = {
        totalRows: tasksToExecute.length,
        sent: executedCount,
        delivered: executedCount - failedCount,
        failed: failedCount,
        skippedLimit: skippedLimitCount,
        limitReached,
        paused: pausedByAdmin,
        csvUpdated,
        executionResults,
      };

      // Alert the admin when the campaign run had any failed tasks (debug sheet + Telegram).
      if (failedCount > 0) {
        await notifyCampaignFailure({
          campaignId,
          stage: 'execute',
          channelType: 'social',
          failedCount,
          reason: analytics.limitReached ? 'Some social tasks failed during run' : `${failedCount} social task(s) failed during run`,
          details: { status: finalStatus, executedCount, totalRows: tasksToExecute.length, executionResults },
        });
      }

      settings.analytics = analytics;
      // Scoped runs: capture this server's subset, restore the full account
      // list before persisting (same pattern as the email path above).
      const scopedRunAccounts = isScopedRun ? (settings.accounts || []).map(String) : null;
      if (isScopedRun) {
        settings.accounts = settings._fullAccounts || settings.accounts;
      }
      if (isScopedRun && !pausedByAdmin) {
        // Merge-write (preserves sibling scopes' _scopedCompleted records —
        // a full settings blob overwrite would wipe them). Status flips only
        // once every account in the full list is covered.
        await updateCampaignSettings(campaignId, {
          analytics,
          accounts: settings.accounts,
        });
        await finalizeScopedRun(campaignId, serverScope, scopedRunAccounts, finalStatus);
      } else {
        const socialStatusUpdate = {
          settings: JSON.stringify(settings),
          status: finalStatus,
          updatedOn: new Date().toISOString()
        };
        await updateSheetRowApi("campaigns", "campaignId", campaignId, socialStatusUpdate);
      }

      return NextResponse.json({
        success: true,
        message: `Social campaign executed (${finalStatus})`,
        queuedTasks: tasksToExecute.length,
        executed: executedCount,
        failed: failedCount,
        skippedLimit: skippedLimitCount,
        analytics
      });
    }

    return NextResponse.json({ success: false, error: "Invalid channel type" }, { status: 400 });

  } catch (error) {
    logger.error(` Error executing campaign: ${error.message}`, { stack: error.stack });
    await notifyCampaignFailure({
      campaignId: campaignId,
      stage: 'execute',
      channelType: 'campaign',
      failedCount: 1,
      error: error.message,
      details: { stack: error.stack },
    });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    // Only the run that claimed the slot releases it. A skipped duplicate
    // returns before claiming, so it never touches the set here.
    if (_isExecuting && campaignId) _executingCampaigns.delete(campaignId);
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
