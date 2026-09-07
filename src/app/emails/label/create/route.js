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

    const log = logger.child({ browserId, action: "create-label" });
    log.info(`Creating label: ${labelName}`);

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

      // Click create label button
      const createBtn = config.selectors.createLabelBtn || config.selectors.addFolderBtn;
      const clicked = await DOMHelpers.clickElement(page, createBtn, { timeout: 5000 });
      if (!clicked) {
        throw new Error("Create label button not found");
      }
      await DOMHelpers.randomDelay(1000, 2000);

      // Type label name
      const nameInput = config.selectors.labelNameInput || config.selectors.folderNameInput;
      const typed = await DOMHelpers.typeText(page, nameInput, labelName, { delay: 30 });
      if (!typed) {
        throw new Error("Label name input not found");
      }
      await DOMHelpers.randomDelay(500, 1000);

      // Confirm
      const confirmBtn = config.selectors.labelConfirmBtn || config.selectors.folderSaveBtn;
      await DOMHelpers.clickElement(page, confirmBtn, { timeout: 5000 });
      await DOMHelpers.randomDelay(2000, 3000);

      log.info(`Label created: ${labelName}`);
      return NextResponse.json({ success: true, labelName });

    } finally {
      await page.close();
      await browser.close();
    }

  } catch (error) {
    logger.error(`[create-label] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
