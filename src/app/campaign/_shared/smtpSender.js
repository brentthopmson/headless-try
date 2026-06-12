import nodemailer from "nodemailer";
import logger from "../../../utils/logger.js";

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

export async function sendViaSMTP(recipient, subject, body, smtpConfig) {
  const transporter = createTransporter(smtpConfig);
  const fromName = smtpConfig.senderName || "Outreach Manager";
  const fromEmail = smtpConfig.user || smtpConfig.username;

  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: recipient,
    subject,
    text: body,
    html: body.replace(/\n/g, "<br>"),
  });

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

  for (let i = 0; i < recipients.length; i++) {
    if (results.sent >= limit) break;

    const recipient = recipients[i];
    const { config: smtpConfig } = getNextSmtpConfig(smtpSettings, results.sent);
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
      logger.error(`[smtpSender] Failed to send to ${recipient.email}: ${err.message}`);
      results.failed++;
      results.sent++;
      results.errors.push({ recipient: recipient.email, error: err.message });
    }

    if (onProgress) onProgress(results);
  }

  return results;
}
