import { sendViaSMTP, getNextSmtpConfig } from "../../emails/_shared/smtpSender.js";
import { sendViaBrowser, scheduleViaBrowser, detectProvider } from "../../emails/_shared/wireSender.js";

function isPositiveInt(val) {
  const n = Number(val);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1;
}

export function normalizeWireProvider(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "gmail" || v === "google" || v.includes("gmail")) return "gmail";
  if (v === "outlook" || v === "hotmail" || v === "live" || v === "msn" || v === "microsoft" || v === "office365" || v.includes("outlook") || v.includes("hotmail") || v.includes("live")) return "outlook";
  if (v === "yahoo" || v.includes("yahoo")) return "yahoo";
  if (v === "aol" || v.includes("aol")) return "aol";
  return "";
}

export function resolveWireProvider(profileData, profileId) {
  const candidates = [
    profileData?.platform,
    profileData?.provider,
    profileData?.accountPlatform,
    profileData?.identifier,
    profileData?.email,
    profileData?.username,
    profileId,
  ];
  for (const c of candidates) {
    const normalized = normalizeWireProvider(c);
    if (normalized) return normalized;
    if (typeof c === "string" && c.includes("@")) {
      const byEmail = normalizeWireProvider(detectProvider(c));
      if (byEmail) return byEmail;
    }
  }
  return "";
}

export function validateSmtpConfigs(smtpSettings) {
  if (!smtpSettings || smtpSettings.length === 0) {
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
    // Optional display name / reply-to. When present they must be usable values.
    if (cfg.senderName != null && String(cfg.senderName).trim() && String(cfg.senderName).length > 120) {
      errors.push('senderName must be 120 characters or fewer');
    }
    const replyTo = cfg.replyTo || cfg.reply_to;
    if (replyTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(replyTo).trim())) {
      errors.push('replyTo must be a valid email address');
    }
    const hasAuth = (cfg.password && String(cfg.password).trim()) || (cfg.appPassword && String(cfg.appPassword).trim()) || (cfg.oAuth2RefreshToken && String(cfg.oAuth2RefreshToken).trim());
    if (!hasAuth) errors.push('password, appPassword, or oAuth2RefreshToken is required');
    // Per-server send limits are MANDATORY (no fallbacks to provider/platform defaults).
    if (!isPositiveInt(cfg.hourlyLimit)) errors.push('hourlyLimit is required (whole number >= 1)');
    if (!isPositiveInt(cfg.dailyLimit)) errors.push('dailyLimit is required (whole number >= 1)');
    if (!isPositiveInt(cfg.monthlyLimit)) errors.push('monthlyLimit is required (whole number >= 1)');
    if (errors.length > 0) {
      throw new Error(`SMTP config #${i + 1} (${cfg.host || 'unknown'}): ${errors.join('; ')}`);
    }
  }
}

export function smtpAccountKey(config) {
  return String((config && (config.user || config.username)) || "").trim() ||
    String((config && config.host) || "smtp");
}

export function createSmtpSendCap({ smtpSettings, accountSendPerRunLimit }) {
  const accountSendCounts = new Map();

  const pick = (seed) => {
    if (accountSendPerRunLimit <= 0 || smtpSettings.length === 0) {
      return getNextSmtpConfig(smtpSettings, seed);
    }
    for (let k = 0; k < smtpSettings.length; k++) {
      const candidate = getNextSmtpConfig(smtpSettings, seed + k);
      if (!candidate) return candidate;
      if ((accountSendCounts.get(smtpAccountKey(candidate.config)) || 0) < accountSendPerRunLimit) return candidate;
    }
    return null;
  };

  const note = (config) => {
    if (!config) return;
    const key = smtpAccountKey(config);
    accountSendCounts.set(key, (accountSendCounts.get(key) || 0) + 1);
  };

  return { accountSendCounts, pick, note };
}

export async function sendWarmupEmail({ email, subject, message, seed, pickSmtp, noteSmtp, method = "smtp", smtpAccount = null, profileId = null, profileData = null }) {
  if (method === "wire" && profileData?.cookies) {
    const provider = resolveWireProvider(profileData, profileId);
    if (!provider) {
      throw new Error(`Cannot determine email provider/platform for warmup session account ${profileId || "unknown"}.`);
    }
    await sendViaBrowser(email, subject, message, profileData.cookies, provider, {
      browserIdentity: profileData?.browserIdentity || null,
      driveUrl: profileData?.driveUrl || "",
      profileId,
    });
    return { method: "wire", provider };
  }
  // Default: SMTP (use provided account or pick one)
  const smtp = smtpAccount || (pickSmtp ? (pickSmtp(seed) || {}).config : null);
  if (!smtp) throw new Error("No SMTP account available for warmup");
  await sendViaSMTP(email, subject, message, smtp);
  noteSmtp?.(smtp);
  return { method: "smtp", host: smtp?.host };
}

export function normalizeSendMethod(value) {
  const v = String(value || "").trim().toLowerCase();
  if (v === "smtp" || v === "wire") return v;
  if (v.startsWith("wire")) return "wire";
  if (v.startsWith("smtp")) return "smtp";
  return "";
}

export async function sendCampaignEmail({
  email,
  subject,
  message,
  smtp,
  isSchedule,
  deliveryMethod,
  profileId,
  profileData,
  scheduleTime,
  noteSmtp,
  log,
  rowIndex,
  preferredMethod = "",
  forceMethod = "",
  retryCount = 0,
  lastSendMethod = "",
  campaignKeyword = "",
  replyTo = "",
}) {
  let senderHost = "WIRE";
  let delivered = 0;
  let actualMethod = "wire";
  // Reply-To fallback: per-SMTP value wins; otherwise use the campaign/CSV value.
  const smtpForSend = (smtp && !(smtp.replyTo || smtp.reply_to) && replyTo)
    ? { ...smtp, replyTo }
    : smtp;

  if (isSchedule) {
    const wireCookies = profileData?.cookies;
    if (!wireCookies) {
      throw new Error(`No browser session available for profile ${profileId}`);
    }
    const provider = resolveWireProvider(profileData, profileId);
    if (!provider) {
      throw new Error(`Cannot determine email provider/platform for browser session account ${profileId || "unknown"}. Set the account platform (e.g. outlook/gmail) on the selected session profile.`);
    }
    log.info(`[Row schedule] ${email}: scheduling at ${scheduleTime} via ${provider} (account=${profileId || "unknown"})`);
    await scheduleViaBrowser(email, subject, message, wireCookies, provider, scheduleTime, {
      browserIdentity: profileData?.browserIdentity || null,
      driveUrl: profileData?.driveUrl || "",
      profileId,
    });
    senderHost = `SCHEDULE(${provider})`;
    delivered++;
    return { senderHost, delivered, actualMethod: "wire" };
  }

  const altIndex = (typeof rowIndex === "number") ? rowIndex : 0;
  const hasWire = !!profileData?.cookies;
  const hasSmtp = !!smtp;
  const forced = normalizeSendMethod(forceMethod);
  const last = normalizeSendMethod(lastSendMethod);
  const pref = normalizeSendMethod(preferredMethod);
  const rc = Number(retryCount) || 0;

  let useWire = false;
  if (deliveryMethod === "wire") {
    useWire = true;
  } else if (deliveryMethod === "smtp") {
    useWire = false;
  } else if (deliveryMethod === "mixed") {
    let chosen = "";
    if (forced === "smtp" || forced === "wire") chosen = forced;
    else if (pref === "smtp" || pref === "wire") chosen = pref;
    else if (rc > 0 && last) chosen = last === "smtp" ? "wire" : "smtp";
    else chosen = (altIndex % 2 === 0) ? "wire" : "smtp"; // preserve existing first-attempt bias

    if (chosen === "smtp" && !hasSmtp && hasWire) chosen = "wire";
    if (chosen === "wire" && !hasWire && hasSmtp) chosen = "smtp";
    if ((chosen !== "smtp" && chosen !== "wire") || (chosen === "smtp" && !hasSmtp) || (chosen === "wire" && !hasWire)) {
      throw new Error(`No available send method for mixed delivery (preferred=${chosen || "none"}, smtp=${hasSmtp}, wire=${hasWire}, profile=${profileId || "none"})`);
    }
    useWire = chosen === "wire";
    if (rc > 0) {
      log.info(`[Row retry] ${email}: mixed retry ${rc}, last=${last || "none"} -> chosen=${chosen}`);
    }
  } else {
    throw new Error(`Invalid delivery method: ${deliveryMethod}`);
  }

  if (!useWire) {
    if (!smtp) {
      if (deliveryMethod === "mixed" && hasWire) {
        useWire = true;
      } else {
        throw new Error("No SMTP account available for this row");
      }
    } else {
      await sendViaSMTP(email, subject, message, smtpForSend);
      noteSmtp(smtp);
      senderHost = smtp?.host || "SMTP";
      delivered++;
      return { senderHost, delivered, actualMethod: "smtp" };
    }
  }

  if (deliveryMethod === "wire" || deliveryMethod === "mixed") {
    const wireCookies = profileData?.cookies;
    if (wireCookies) {
      const provider = resolveWireProvider(profileData, profileId);
      if (!provider) {
        throw new Error(`Cannot determine email provider/platform for browser session account ${profileId || "unknown"}. Set the account platform (e.g. outlook/gmail) on the selected session profile.`);
      }
      log.info(`[Row wire] ${email}: sending via session ${profileId || "unknown"} (${provider})`);
      await sendViaBrowser(email, subject, message, wireCookies, provider, {
        browserIdentity: profileData?.browserIdentity || null,
        driveUrl: profileData?.driveUrl || "",
        profileId,
        campaignKeyword,
      });
      senderHost = `WIRE(${provider})`;
      actualMethod = "wire";
    } else {
      if (deliveryMethod === "wire") {
        log.info(` No WIRE browser session available for profile ${profileId}, using SMTP fallback`);
        if (!smtp) {
          throw new Error(`No browser session and no SMTP account available for profile ${profileId || "unknown"}`);
        }
        await sendViaSMTP(email, subject, message, smtpForSend);
        noteSmtp(smtp);
        senderHost = smtp?.host || "SMTP_FALLBACK";
        actualMethod = "smtp";
      } else {
        // mixed mode but wire session unavailable for this row: fall back to SMTP if possible
        if (smtp) {
          log.info(` No WIRE browser session available for profile ${profileId}, falling back to SMTP for ${email}`);
          await sendViaSMTP(email, subject, message, smtp);
          noteSmtp(smtp);
          senderHost = smtp?.host || "SMTP_FALLBACK";
          actualMethod = "smtp";
        } else {
          throw new Error(`No browser session available for profile ${profileId || "unknown"} and no SMTP account available`);
        }
      }
    }
    delivered++;
  }

  return { senderHost, delivered, actualMethod };
}
