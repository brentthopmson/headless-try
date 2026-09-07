import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers, updateSheetRow } from "../../socials/_shared/routeHelper.js";
import { checkSendAllowed, incrementSendCount, detectEmailProvider } from "../../../utils/sendRateLimiter.js";
import { getSheetDataApi } from "../../api/googlesheets.js";
import { getPlatformConfig, detectEmailPlatform } from "../_shared/platforms.js";
import { applyMailMerge } from "../_shared/mailMerge.js";

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

// ==================== POST Handler ====================

export async function POST(request) {
  try {
    const body = await request.json();
    const { browserId, contacts, subject, body: emailBody, method, mailMerge, projectId } = body;

    if (!browserId || !contacts || !Array.isArray(contacts) || contacts.length === 0) {
      return NextResponse.json({ success: false, error: "Missing browserId or contacts" }, { status: 400 });
    }

    if (!subject || !subject.trim()) {
      return NextResponse.json({ success: false, error: "Subject is required" }, { status: 400 });
    }

    const log = logger.child({ browserId, action: "shoot-send" });
    log.info(`Shoot send requested: ${contacts.length} contacts, method=${method}, project=${projectId || "none"}`);

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

    // 3. Get cookies
    const cookieJSON = hubRow.formattedCookie || hubRow.cookieJSON || "";
    if (!cookieJSON || String(cookieJSON).length < 10) {
      return NextResponse.json({ success: false, error: "No valid cookies for this profile" }, { status: 400 });
    }

    // 4. Detect provider
    const accountEmail = hubRow.email || "";
    const platform = detectEmailPlatform(accountEmail);
    const config = getPlatformConfig(platform);
    const rateLimitPlatform = detectEmailProvider(platform);

    log.info(`Platform: ${platform}, account: ${accountEmail}`);

    // 5. Launch browser
    const { browser, page } = await launchBrowserWithSession(cookieJSON, false);

    const results = [];
    let sent = 0;
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
          log.warn(`Rate limited: ${rateCheck.reason}`);
          results.push({ email: contactEmail, status: "rate_limited", reason: rateCheck.reason });
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
          await sendSingleEmail(page, config, contactEmail, mergedSubject, mergedBody);
          incrementSendCount(rateLimitPlatform, browserId);
          sent++;
          results.push({ email: contactEmail, status: "sent", sentAt: new Date().toISOString() });
          log.info(`Sent to ${contactEmail} (${i + 1}/${contacts.length})`);

          // Delay between sends
          const [minDelay, maxDelay] = config.timing.betweenSends;
          if (i < contacts.length - 1) {
            await DOMHelpers.randomDelay(minDelay, maxDelay);
          }
        } catch (err) {
          failed++;
          results.push({ email: contactEmail, status: "failed", error: err.message });
          log.error(`Failed to send to ${contactEmail}: ${err.message}`);
        }
      }
    } finally {
      await page.close();
      await browser.close();
    }

    // 6. Update hub usage columns
    try {
      const now = new Date().toISOString();
      const shotHistory = results
        .filter(r => r.status === "sent")
        .map(r => ({
          email: r.email,
          method: method || "manual",
          sentAt: r.sentAt || now,
          status: "sent",
          projectId: projectId || null,
        }));

      await updateSheetRow("hub", "browserId", browserId, {
        lastShotAt: now,
        shotHistory: JSON.stringify(shotHistory),
      });
    } catch (e) {
      log.warn(`Failed to update hub usage: ${e.message}`);
    }

    log.info(`Shoot complete: ${sent} sent, ${failed} failed`);
    return NextResponse.json({
      success: true,
      sent,
      failed,
      total: contacts.length,
      results,
    });

  } catch (error) {
    logger.error(`[shoot/send] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
