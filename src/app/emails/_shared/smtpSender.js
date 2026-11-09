import nodemailer from "nodemailer";
import logger from "../../../utils/logger.js";
import { checkSendAllowed, incrementSendCount, detectEmailProvider } from "../../../utils/sendRateLimiter.js";

export function createTransporter(smtpConfig) {
  const host = smtpConfig.host || smtpConfig.server;
  const port = parseInt(smtpConfig.port || "465", 10);

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user: smtpConfig.user || smtpConfig.username,
      pass: smtpConfig.pass || smtpConfig.password || smtpConfig.appPassword,
    },
  });
}

function parseRequiredLimit(val) {
  const n = Number(val);
  return Number.isFinite(n) && Number.isInteger(n) && n >= 1 ? n : null;
}

export async function sendViaSMTP(recipient, subject, body, smtpConfig) {
  // Rate limit check: detect provider from host, use smtp.user as account ID
  const platform = detectEmailProvider(smtpConfig.host || smtpConfig.user);
  const accountId = smtpConfig.user || smtpConfig.username || "unknown";

  // Per-server send limits are MANDATORY (no fallbacks to provider/platform defaults).
  const hourly = parseRequiredLimit(smtpConfig.hourlyLimit);
  const daily = parseRequiredLimit(smtpConfig.dailyLimit);
  const monthly = parseRequiredLimit(smtpConfig.monthlyLimit);
  if (hourly === null || daily === null || monthly === null) {
    throw new Error(`[smtpSender] Missing/invalid send limits for ${accountId} — hourly/daily/monthly are required (whole numbers >= 1), no fallbacks.`);
  }

  const rateCheck = await checkSendAllowed(platform, accountId, { hourly, daily, monthly });
  if (!rateCheck.allowed) {
    logger.warn(`[smtpSender] Rate limited for ${accountId} (${platform}): ${rateCheck.reason}`);
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  const transporter = createTransporter(smtpConfig);
  const fromName = smtpConfig.senderName || "Outreach Manager";
  const fromEmail = smtpConfig.user || smtpConfig.username;

  logger.info(`[smtpSender] Attempting send to ${recipient} via ${smtpConfig.host}:${smtpConfig.port} as ${fromEmail} (subject ${String(subject || '').length} chars, body ${String(body || '').length} chars)`);
  let info;
  try {
    info = await transporter.sendMail({
      from: `"${fromName}" <${fromEmail}>`,
      to: recipient,
      subject,
      text: body,
      html: body.replace(/\n/g, "<br>"),
    });
  } catch (err) {
    const code = (err && (err.code || err.responseCode)) || 'unknown';
    logger.error(`[smtpSender] FAILED to ${recipient} via ${smtpConfig.host} (${code}): ${err.message}`);
    throw err;
  }

  // Increment counter after successful send
  incrementSendCount(platform, accountId);

  logger.info(`[smtpSender] Sent to ${recipient} via ${smtpConfig.host}: ${info.messageId}`);
  return { success: true, messageId: info.messageId, host: smtpConfig.host };
}

export function getNextSmtpConfig(smtpSettings, currentIndex) {
  if (!smtpSettings || smtpSettings.length === 0) return null;
  const idx = currentIndex % smtpSettings.length;
  return { config: smtpSettings[idx], index: idx };
}

export async function sendBatchSMTP(recipients, subject, body, smtpSettings, options = {}) {
  const { onProgress, limit = Infinity } = options;
  const results = { sent: 0, failed: 0, delivered: 0, errors: [] };
  let attempted = 0;

  for (let i = 0; i < recipients.length; i++) {
    if (attempted >= limit) break;
    attempted++;

    const recipient = recipients[i];
    const { config: smtpConfig } = getNextSmtpConfig(smtpSettings, attempted - 1);
    if (!smtpConfig) {
      results.failed++;
      results.errors.push({ recipient, error: "No SMTP config available" });
      continue;
    }

    try {
      await sendViaSMTP(recipient.email, subject, body, smtpConfig);
      results.sent++;
      results.delivered++;
    } catch (err) {
      // Failures are attempts, not sends: never inflate the "sent" tally.
      logger.error(`[smtpSender] Failed to send to ${recipient.email}: ${err.message}`);
      results.failed++;
      results.errors.push({ recipient: recipient.email, error: err.message });
    }

    if (onProgress) onProgress(results);
  }

  return results;
}
