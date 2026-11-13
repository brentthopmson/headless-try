import { sendViaSMTP, getNextSmtpConfig } from "../../emails/_shared/smtpSender.js";
import { sendViaBrowser, scheduleViaBrowser, detectProvider } from "../../emails/_shared/wireSender.js";

function isPositiveInt(val) {
  const n = Number(val);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1;
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

export async function sendWarmupEmail({ email, subject, message, seed, pickSmtp, noteSmtp }) {
  const { config: smtp } = pickSmtp(seed) || {};
  await sendViaSMTP(email, subject, message, smtp);
  noteSmtp(smtp);
  return smtp;
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
}) {
  let senderHost = "WIRE";
  let delivered = 0;

  if (isSchedule) {
    const wireCookies = profileData?.cookies;
    if (!wireCookies) {
      throw new Error(`No browser session available for profile ${profileId}`);
    }
    const provider = profileData?.platform || detectProvider(smtp?.user || email) || "gmail";
    log.info(`[Row schedule] ${email}: scheduling at ${scheduleTime} via ${provider}`);
    await scheduleViaBrowser(email, subject, message, wireCookies, provider, scheduleTime, {
      browserIdentity: profileData?.browserIdentity || null,
      driveUrl: profileData?.driveUrl || "",
      profileId,
    });
    senderHost = `SCHEDULE(${provider})`;
    delivered++;
    return { senderHost, delivered };
  }

  // Mixed = load-balance across methods PER ROW: pick exactly ONE sender
  // per recipient (never both — sending twice to the same list is a spam
  // report waiting to happen). Wire sessions are scarcer, so alternate.
  // Use rowIndex for deterministic alternation (not email length, which
  // could result in all odd-length emails going via SMTP).
  const altIndex = (typeof rowIndex === "number") ? rowIndex : 0;
  const useWire = deliveryMethod === "wire"
    || (deliveryMethod === "mixed" && profileData?.cookies && (altIndex % 2 === 0));

  if (!useWire) {
    await sendViaSMTP(email, subject, message, smtp);
    noteSmtp(smtp);
    senderHost = smtp?.host || "SMTP";
    delivered++;
    return { senderHost, delivered };
  }

  if (deliveryMethod === "wire" || deliveryMethod === "mixed") {
    const wireCookies = profileData?.cookies;
    if (wireCookies) {
      const provider = profileData?.platform || detectProvider(smtp?.user || email) || "gmail";
      await sendViaBrowser(email, subject, message, wireCookies, provider, {
        browserIdentity: profileData?.browserIdentity || null,
        driveUrl: profileData?.driveUrl || "",
        profileId,
      });
      senderHost = `WIRE(${provider})`;
    } else {
      log.info(` No WIRE browser session available for profile ${profileId}, using SMTP fallback`);
      if (deliveryMethod === "wire") {
        await sendViaSMTP(email, subject, message, smtp);
        noteSmtp(smtp);
        senderHost = smtp?.host || "SMTP_FALLBACK";
      }
    }
    delivered++;
  }

  return { senderHost, delivered };
}
