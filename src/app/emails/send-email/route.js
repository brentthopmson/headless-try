import { NextResponse } from "next/server";
import fs from "fs-extra";
import logger from "../../../utils/logger.js";
import { DOMHelpers, updateSheetRow, resolveShootSession } from "../../socials/_shared/routeHelper.js";
import { checkSendAllowed, incrementSendCount, detectEmailProvider } from "../../../utils/sendRateLimiter.js";
import { getSheetDataApi } from "../../api/googlesheets.js";
import { getPlatformConfig, detectEmailPlatform } from "../_shared/platforms.js";
import { applyMailMerge } from "../_shared/mailMerge.js";
import { calculateScheduleTimes } from "../../../utils/scheduleCalculator.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// ==================== Hub Row Lookup ====================

async function getHubRowByBrowserId(browserId) {
  const result = await getSheetDataApi("hub");
  if (!result.success) return null;
  const headers = result.headers;
  const browserIdIdx = headers.indexOf("browserId");
  const submissionIdIdx = headers.indexOf("submissionId");
  for (const row of result.data) {
    const bid = row[browserIdIdx] || "";
    const sid = row[submissionIdIdx] || "";
    if (bid === browserId || sid === browserId) {
      const hubRow = {};
      for (let i = 0; i < headers.length; i++) hubRow[headers[i]] = row[i];
      return hubRow;
    }
  }
  return null;
}

// ==================== Account Expiry Check ====================

function isAccountExpired(hubRow) {
  const expiry = hubRow.expiry || hubRow.Expiry || "";
  if (!expiry) return false;
  try {
    return new Date(expiry) < new Date();
  } catch {
    return false;
  }
}

// ==================== Single Email Send ====================

async function sendSingleEmail(page, config, recipient, subject, body) {
  const { selectors, timing } = config;

  await page.goto(config.composeUrl, { waitUntil: "networkidle0", timeout: 30000 });
  await DOMHelpers.randomDelay(timing.afterNavigate * 0.8, timing.afterNavigate * 1.2);

  // Fill recipient
  const toEl = await page.$(selectors.toInput);
  if (toEl) {
    await toEl.click();
    await page.type(selectors.toInput, recipient, { delay: 30 });
    await DOMHelpers.randomDelay(500, 1000);
  } else {
    throw new Error("To input not found");
  }

  // Fill subject
  const subjectEl = await page.$(selectors.subjectInput);
  if (subjectEl) {
    await subjectEl.click();
    await page.type(selectors.subjectInput, subject, { delay: 20 });
    await DOMHelpers.randomDelay(500, 1000);
  }

  // Fill body
  const bodyEl = await page.$(selectors.bodyInput);
  if (bodyEl) {
    await bodyEl.click();
    await page.type(selectors.bodyInput, body, { delay: 10 });
    await DOMHelpers.randomDelay(timing.afterFill * 0.8, timing.afterFill * 1.2);
  }

  // Click send
  const sent = await DOMHelpers.clickElement(page, selectors.sendButton, { timeout: 5000 });
  if (!sent) {
    // Fallback: Ctrl+Enter
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
  }

  await DOMHelpers.randomDelay(2000, 3000);
}

// ==================== Single Email Schedule (Native "Schedule Send") ====================

async function scheduleSingleEmail(page, config, recipient, subject, body, scheduleTime) {
  const { selectors, timing } = config;
  if (!selectors.scheduleDropdownArrow) throw new Error(`Schedule send not configured for platform: ${config.platform}`);

  // Step 1: Navigate to compose
  await page.goto(config.composeUrl, { waitUntil: "networkidle0", timeout: 30000 });
  await DOMHelpers.randomDelay(timing.afterNavigate * 0.8, timing.afterNavigate * 1.2);

  // Step 2: Fill recipient
  const toEl = await page.$(selectors.toInput);
  if (toEl) {
    await toEl.click();
    await page.type(selectors.toInput, recipient, { delay: 30 });
    await DOMHelpers.randomDelay(500, 1000);
  } else {
    throw new Error("To input not found");
  }

  // Step 3: Fill subject
  const subjectEl = await page.$(selectors.subjectInput);
  if (subjectEl) {
    await subjectEl.click();
    await page.type(selectors.subjectInput, subject, { delay: 20 });
    await DOMHelpers.randomDelay(500, 1000);
  }

  // Step 4: Fill body
  const bodyEl = await page.$(selectors.bodyInput);
  if (bodyEl) {
    await bodyEl.click();
    await page.type(selectors.bodyInput, body, { delay: 10 });
    await DOMHelpers.randomDelay(timing.afterFill * 0.8, timing.afterFill * 1.2);
  }

  // Step 5: Click dropdown arrow next to Send → "Schedule send"
  const dropdownClicked = await DOMHelpers.clickElement(page, selectors.scheduleDropdownArrow, { timeout: 5000 });
  if (!dropdownClicked) {
    await page.keyboard.press("Escape");
    await DOMHelpers.randomDelay(500, 1000);
    await DOMHelpers.clickElement(page, selectors.scheduleDropdownArrow, { timeout: 5000 });
  }
  await DOMHelpers.randomDelay(500, 1000);

  // Step 6: Click "Schedule send" / "Send later" menu option
  const optionClicked = await DOMHelpers.clickElement(page, selectors.scheduleSendOption, { timeout: 5000 });
  if (!optionClicked) {
    throw new Error("Schedule send option not found in dropdown");
  }
  await DOMHelpers.randomDelay(1000, 2000);

  // Step 7: Wait for schedule modal to appear
  try {
    await DOMHelpers.waitForSelector(page, selectors.scheduleModal, { timeout: 5000, visible: true });
  } catch {
    // Some platforms open inline picker instead of modal — continue
  }
  await DOMHelpers.randomDelay(500, 1000);

  // Step 8: Set date
  const scheduleDate = new Date(scheduleTime);
  const dateStr = `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, "0")}-${String(scheduleDate.getDate()).padStart(2, "0")}`;
  const timeStr = `${String(scheduleDate.getHours()).padStart(2, "0")}:${String(scheduleDate.getMinutes()).padStart(2, "0")}`;

  // Try setting date via input
  const dateInput = await page.$(selectors.scheduleDatePicker);
  if (dateInput) {
    await dateInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(selectors.scheduleDatePicker, dateStr, { delay: 30 });
    await DOMHelpers.randomDelay(300, 600);
  }

  // Step 9: Set time
  const timeInput = await page.$(selectors.scheduleTimePicker);
  if (timeInput) {
    await timeInput.click({ clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(selectors.scheduleTimePicker, timeStr, { delay: 30 });
    await DOMHelpers.randomDelay(300, 600);
  }

  // Step 10: Confirm schedule
  const confirmed = await DOMHelpers.clickElement(page, selectors.scheduleConfirmBtn, { timeout: 5000 });
  if (!confirmed) {
    await page.keyboard.press("Enter");
  }

  await DOMHelpers.randomDelay(2000, 3000);
}

// ==================== POST Handler ====================

export async function POST(request) {
  try {
    const body = await request.json();
    const { browserId, contacts, subject, body: emailBody, method, mailMerge, projectId, sendMode, scheduleStartTime } = body;

    if (!browserId || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ success: false, error: "Missing browserId or contacts" }, { status: 400 });
    }

    if (!subject || !subject.trim()) {
      return NextResponse.json({ success: false, error: "Subject is required" }, { status: 400 });
    }

    const isSchedule = sendMode === "schedule";
    const log = logger.child({ browserId, action: isSchedule ? "shoot-schedule" : "shoot-send" });
    log.info(`[shoot] Request: mode=${isSchedule ? "schedule" : "now"}, contacts=${contacts.length}, method=${method}, project=${projectId || "none"}`);

    // 1. Get hub row
    const hubRow = await getHubRowByBrowserId(browserId);
    if (!hubRow) {
      return NextResponse.json({ success: false, error: "Profile not found in hub" }, { status: 404 });
    }

    // 2. Check account expiry
    if (isAccountExpired(hubRow)) {
      log.warn(`Account expired for ${browserId}`);
      return NextResponse.json({
        success: false,
        error: "Account expired",
        stopAll: true,
      });
    }

    // 3. Detect provider
    const accountEmail = hubRow.email || "";
    const platform = detectEmailPlatform(accountEmail);
    const config = getPlatformConfig(platform);
    const rateLimitPlatform = detectEmailProvider(platform);

    log.info(`[shoot] Platform: ${platform}, account: ${accountEmail}`);

    // 4. If schedule mode — calculate auto-populated sendDateAndTime per contact
    let scheduleMap = {};
    if (isSchedule) {
      const start = scheduleStartTime || new Date().toISOString();
      const scheduleResult = await calculateScheduleTimes(contacts, rateLimitPlatform, start);
      log.info(`[shoot] Schedule calculated: hourly=${scheduleResult.limits.hourly}, daily=${scheduleResult.limits.daily}, spread=${scheduleResult.totalDurationHours}h, startTime=${scheduleResult.startTime.toISOString()}`);

      for (let i = 0; i < scheduleResult.schedule.length; i++) {
        const email = contacts[i]?.email || "";
        if (email) {
          scheduleMap[email.toLowerCase()] = scheduleResult.schedule[i];
        }
      }
    }

    // 5. Launch browser with hybrid session (Drive profile or cookies + identity)
    const { browser, page, profileDir } = await resolveShootSession(browserId);

    const results = [];
    let sent = 0;
    let scheduled = 0;
    let failed = 0;

    try {
      for (let i = 0; i < contacts.length; i++) {
        const contact = contacts[i];
        const contactEmail = contact.email || "";

        if (!contactEmail) {
          results.push({ email: contactEmail, status: "skipped", reason: "no email" });
          continue;
        }

        // Rate limit check
        const rateCheck = await checkSendAllowed(rateLimitPlatform, browserId);
        if (!rateCheck.allowed) {
          log.warn(`[shoot] Rate limited: ${rateCheck.reason}`);
          const cooldownSeconds = rateCheck.retryAfterMs ? Math.ceil(rateCheck.retryAfterMs / 1000) : 60;
          results.push({
            email: contactEmail,
            status: "rate_limited",
            reason: rateCheck.reason,
            cooldownSeconds,
          });
          break;
        }

        // Apply mail merge if enabled
        let mergedSubject = subject;
        let mergedBody = emailBody || "";
        if (method === "manual" && mailMerge) {
          const merged = applyMailMerge(subject, contact);
          mergedSubject = merged;
          mergedBody = applyMailMerge(emailBody || "", contact);
        }

        try {
          if (isSchedule) {
            // Schedule mode — use native "Schedule Send" with calculated time
            const entry = scheduleMap[contactEmail.toLowerCase()];
            const scheduleTime = entry?.sendAt || new Date(scheduleStartTime);
            log.info(`[shoot] Scheduling ${i + 1}/${contacts.length}: ${contactEmail} at ${scheduleTime.toISOString()}`);

            await scheduleSingleEmail(page, config, contactEmail, mergedSubject, mergedBody, scheduleTime);
            incrementSendCount(rateLimitPlatform, browserId);
            scheduled++;
            results.push({
              email: contactEmail,
              status: "scheduled",
              scheduledFor: scheduleTime.toISOString(),
              sendDate: entry?.sendDate || "",
              sendTime: entry?.sendTime || "",
              sendStamp: entry?.sendStamp || "",
            });
            log.info(`[shoot] Scheduled OK: ${contactEmail} (${i + 1}/${contacts.length})`);
          } else {
            // Send Now — immediate send
            await sendSingleEmail(page, config, contactEmail, mergedSubject, mergedBody);
            incrementSendCount(rateLimitPlatform, browserId);
            sent++;
            results.push({ email: contactEmail, status: "sent", sentAt: new Date().toISOString() });
            log.info(`[shoot] Sent OK: ${contactEmail} (${i + 1}/${contacts.length})`);
          }

          // Delay between operations (1 min for schedule, betweenSends for now)
          if (i < contacts.length - 1) {
            const delayMs = isSchedule ? 60000 : config.timing.betweenSends[0] + Math.random() * (config.timing.betweenSends[1] - config.timing.betweenSends[0]);
            await DOMHelpers.randomDelay(delayMs, delayMs + 1000);
          }
        } catch (err) {
          failed++;
          results.push({ email: contactEmail, status: "failed", error: err.message });
          log.error(`[shoot] Failed: ${contactEmail}: ${err.message}`);
        }
      }
    } finally {
      await page.close();
      await browser.close();
      if (profileDir) {
        await fs.remove(profileDir).catch(() => {});
      }
    }

    // 6. Update hub usage columns
    try {
      const now = new Date().toISOString();
      const shotHistory = results
        .filter(r => r.status === "sent" || r.status === "scheduled")
        .map(r => ({
          email: r.email,
          method: method || "manual",
          sentAt: r.sentAt || r.scheduledFor || now,
          scheduledFor: r.scheduledFor || null,
          status: r.status,
          projectId: projectId || null,
        }));

      await updateSheetRow("hub", "browserId", browserId, {
        lastShotAt: now,
        shotHistory: JSON.stringify(shotHistory),
      });
    } catch (e) {
      log.warn(`[shoot] Failed to update hub usage: ${e.message}`);
    }

    const totalDone = sent + scheduled;
    log.info(`[shoot] Complete: ${sent} sent, ${scheduled} scheduled, ${failed} failed, total=${contacts.length}`);
    return NextResponse.json({
      success: true,
      sent,
      scheduled,
      failed,
      total: contacts.length,
      results,
    });

  } catch (error) {
    logger.error(`[shoot] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
