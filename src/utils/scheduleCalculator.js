import logger from "./logger.js";
import { loadSendLimits } from "./sendRateLimiter.js";

// ==================== Schedule Calculator ====================
// Auto-populates sendDate/sendTime/sendStamp for each CSV row
// using platform limits to stretch sends across time windows.

/**
 * Calculate evenly-spaced schedule times for a list of contacts
 * based on the email platform's sending limits.
 *
 * @param {Array<{email: string}>} contacts - Array of contact objects
 * @param {string} platform - Detected platform key (GMAIL, MICROSOFT, etc.)
 * @param {Date|string} startTime - When to begin sending
 * @returns {Promise<{ schedule: Array<{email, sendDate, sendTime, sendStamp, sendAt}>, limits: {hourly, daily}, totalDurationHours: number }>}
 */
export async function calculateScheduleTimes(contacts, platform, startTime) {
  const limits = await loadSendLimits();
  const platformKey = (platform || "GMAIL").toUpperCase();
  const platformLimits = limits[platformKey] || { hourly: 20, daily: 500, monthly: 15000 };

  const hourlyLimit = platformLimits.hourly || 20;
  const dailyLimit = platformLimits.daily || 500;

  const start = startTime ? new Date(startTime) : new Date();
  const schedule = [];

  let currentHour = new Date(start);
  currentHour.setMinutes(0, 0, 0); // Snap to start of hour

  let hourlyCount = 0;
  let dailyCount = 0;

  // Calculate spacing: emails per hour spread evenly
  // Leave 30s buffer at end of each hour for safety
  const msPerHour = 3600000;
  const usableMsPerHour = msPerHour - 30000; // 59.5 min usable
  const gapBetweenEmails = hourlyLimit > 1 ? usableMsPerHour / hourlyLimit : usableMsPerHour;

  let cursor = new Date(currentHour);

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];
    const email = contact.email || "";

    // Check if we've hit hourly limit → roll to next hour
    if (hourlyCount >= hourlyLimit) {
      currentHour = new Date(currentHour.getTime() + msPerHour);
      cursor = new Date(currentHour);
      hourlyCount = 0;
    }

    // Check if we've hit daily limit → roll to next day at start time
    if (dailyCount >= dailyLimit) {
      const nextDay = new Date(currentHour);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setHours(start.getHours(), 0, 0, 0);
      currentHour = nextDay;
      cursor = new Date(currentHour);
      hourlyCount = 0;
      dailyCount = 0;
    }

    const sendAt = new Date(cursor);

    schedule.push({
      email,
      sendDate: sendAt.toLocaleDateString(),
      sendTime: sendAt.toLocaleTimeString(),
      sendStamp: sendAt.toISOString(),
      sendAt: sendAt,
    });

    hourlyCount++;
    dailyCount++;
    cursor = new Date(cursor.getTime() + gapBetweenEmails);
  }

  // Calculate total duration
  const lastSend = schedule.length > 0 ? schedule[schedule.length - 1].sendAt : new Date();
  const totalDurationMs = lastSend.getTime() - start.getTime();
  const totalDurationHours = Math.round((totalDurationMs / 3600000) * 10) / 10;

  logger.info(
    `[scheduleCalculator] Platform: ${platformKey}, ` +
    `limits: hourly=${hourlyLimit}, daily=${dailyLimit}, ` +
    `contacts: ${contacts.length}, ` +
    `spread: ${totalDurationHours}h, ` +
    `startTime: ${start.toISOString()}`
  );

  return {
    schedule,
    limits: { hourly: hourlyLimit, daily: dailyLimit },
    totalDurationHours,
    startTime: start,
    endTime: lastSend,
  };
}

/**
 * Format a human-readable summary of the schedule.
 * @param {object} result - Return value from calculateScheduleTimes
 * @returns {string}
 */
export function formatScheduleSummary(result) {
  const { schedule, limits, totalDurationHours, startTime, endTime } = result;
  const count = schedule.length;
  const days = Math.ceil(totalDurationHours / 24);

  if (days <= 1) {
    return `${count} emails scheduled over ${totalDurationHours}h (${limits.hourly}/hr, ${limits.daily}/day cap)`;
  }
  return `${count} emails scheduled over ~${days} days (${limits.hourly}/hr, ${limits.daily}/day cap)`;
}
