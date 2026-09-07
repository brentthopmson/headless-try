import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { getSheetDataApi } from "../../api/googlesheets.js";
import { getPlatformConfig, detectEmailPlatform } from "../_shared/platforms.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

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

export async function POST(request) {
  try {
    const body = await request.json();
    const { browserId, contactEmail, maxResults } = body;

    if (!browserId || !contactEmail) {
      return NextResponse.json({ success: false, error: "Missing browserId or contactEmail" }, { status: 400 });
    }

    const log = logger.child({ browserId, action: "search-history" });
    log.info(`Searching mailbox history for ${contactEmail}`);

    const hubRow = await getHubRowByBrowserId(browserId);
    if (!hubRow) {
      return NextResponse.json({ success: false, error: "Profile not found" }, { status: 404 });
    }

    const cookieJSON = hubRow.formattedCookie || hubRow.cookieJSON || "";
    if (!cookieJSON || String(cookieJSON).length < 10) {
      return NextResponse.json({ success: false, error: "No valid cookies" }, { status: 400 });
    }

    const accountEmail = hubRow.email || "";
    const platform = detectEmailPlatform(accountEmail);
    const config = getPlatformConfig(platform);

    const { browser, page } = await launchBrowserWithSession(cookieJSON, false);
    const limit = maxResults || 20;

    try {
      await page.goto(config.inboxUrl, { waitUntil: "networkidle0", timeout: 30000 });
      await DOMHelpers.randomDelay(config.timing.afterNavigate, config.timing.afterNavigate * 1.5);

      // Search
      const searchSelector = config.selectors.searchBox || config.selectors.searchInput;
      const searchEl = await page.$(searchSelector);
      if (!searchEl) {
        return NextResponse.json({ success: false, error: "Search box not found" });
      }

      await searchEl.click();
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.type(searchSelector, `from:${contactEmail} OR to:${contactEmail}`, { delay: 15 });
      await page.keyboard.press("Enter");
      await DOMHelpers.randomDelay(config.timing.afterSearch, config.timing.afterSearch * 1.5);

      // Read threads
      const threads = [];
      const rows = await page.$$(config.selectors.threadRow);
      for (const row of rows.slice(0, limit)) {
        try {
          const subjectEl = await row.$(config.selectors.threadSubject);
          const snippetEl = await row.$(config.selectors.threadSnippet);
          const senderEl = await row.$(config.selectors.threadSender);

          const subject = subjectEl ? (await subjectEl.textContent()).trim() : "";
          const snippet = snippetEl ? (await snippetEl.textContent()).trim() : "";
          const sender = senderEl ? (await senderEl.textContent()).trim() : "";

          if (subject || snippet) {
            threads.push({ subject, snippet, sender });
          }
        } catch {
          // skip
        }
      }

      log.info(`Found ${threads.length} threads for ${contactEmail}`);
      return NextResponse.json({ success: true, threads });

    } finally {
      await page.close();
      await browser.close();
    }

  } catch (error) {
    logger.error(`[search-history] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
