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
    const { browserId, labelName } = body;

    if (!browserId || !labelName) {
      return NextResponse.json({ success: false, error: "Missing browserId or labelName" }, { status: 400 });
    }

    const log = logger.child({ browserId, action: "delete-label" });
    log.info(`Deleting label: ${labelName}`);

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

    try {
      await page.goto(config.labelsUrl, { waitUntil: "networkidle0", timeout: 30000 });
      await DOMHelpers.randomDelay(config.timing.afterNavigate, config.timing.afterNavigate * 1.5);

      // Find the label row and click delete/more options
      const labelRows = await page.$$(`tr, div[role='listitem']`);
      let found = false;
      for (const row of labelRows) {
        try {
          const text = await row.textContent();
          if (text && text.includes(labelName)) {
            // Click more options (three dots or dropdown)
            const moreBtn = await row.$("button[aria-label*='More'], div[role='button'][aria-label*='More'], td:last-child button");
            if (moreBtn) {
              await moreBtn.click();
              await DOMHelpers.randomDelay(500, 1000);

              // Click delete/remove
              const deleteBtn = await page.$("div[role='menuitem']:has-text('Remove'), div[role='menuitem']:has-text('Delete'), button:has-text('Remove')");
              if (deleteBtn) {
                await deleteBtn.click();
                await DOMHelpers.randomDelay(1000, 2000);
                found = true;
                break;
              }
            }
          }
        } catch {
          // skip
        }
      }

      if (!found) {
        log.warn(`Label "${labelName}" not found or could not be deleted`);
        return NextResponse.json({ success: false, error: "Label not found or could not be deleted" });
      }

      log.info(`Label deleted: ${labelName}`);
      return NextResponse.json({ success: true, labelName });

    } finally {
      await page.close();
      await browser.close();
    }

  } catch (error) {
    logger.error(`[delete-label] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
