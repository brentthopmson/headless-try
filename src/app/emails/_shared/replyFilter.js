import logger from "../../../utils/logger.js";
import { DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { getPlatformConfig } from "./platforms.js";

// ==================== Reply filter (campaign + shoot) ====================
// After sending, incoming replies that carry our unique identifier in the
// subject must never reach the normal inbox: they get archived/labeled into a
// user-configurable label/folder (default Campaign-Replies).

// Pure helpers live in CJS (replyFilterMatch.cjs) so jest can require() them.
import replyFilterMatch from "./replyFilterMatch.cjs";

const { DEFAULT_REPLY_FOLDER, buildFilterPattern, resolveFolderName } = replyFilterMatch;
export { DEFAULT_REPLY_FOLDER, buildFilterPattern, resolveFolderName };
// Escape text for embedding inside :has-text("...") / [attr*="..."] selectors.
function q(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function pageHas(page, text) {
  try {
    const html = await page.content();
    return html.includes(text);
  } catch {
    return false;
  }
}

/**
 * Install an inbox-hiding reply filter for `identifier` into `folderName`.
 * Never throws. Returns { status: 'installed'|'exists'|'skipped'|'failed', reason? }.
 *
 * @param {object} page      Playwright page (any mail screen — we navigate)
 * @param {string} platform  gmail | outlook | yahoo | aol
 * @param {string} identifier subject substring replies will carry (e.g. campaignId)
 * @param {string} folderName label/folder to route replies into (default applied by caller)
 * @param {object} log       logger (defaults to shared logger)
 */
export async function ensureReplyFilter(page, platform, identifier, folderName, log = logger) {
  const id = String(identifier || "").trim();
  const folder = resolveFolderName(folderName);
  if (!id) return { status: "skipped", reason: "no-identifier" };

  try {
    if (platform === "gmail") return await installGmail(page, id, folder, log);
    if (platform === "outlook") return await installOutlook(page, id, folder, log);
    if (platform === "yahoo" || platform === "aol") return await installYahooLike(page, platform, id, folder, log);
    return { status: "skipped", reason: `unsupported-platform:${platform}` };
  } catch (err) {
    log.warn(`[replyFilter][${platform}] install failed: ${err.message}`);
    return { status: "failed", reason: err.message };
  }
}

// ==================== GMAIL ====================
// Settings → Filters → Create a new filter → Subject: <identifier>
// → Create filter → Skip the inbox (Archive) + Apply the label (<folder>) → Save.

async function installGmail(page, identifier, folder, log) {
  const config = getPlatformConfig("gmail");
  await page.goto("https://mail.google.com/mail/u/0/#settings/filters", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await DOMHelpers.randomDelay(config.timing.afterNavigate, config.timing.afterNavigate * 1.5);

  if (await pageHas(page, identifier)) {
    log.info(`[replyFilter][gmail] filter for '${identifier}' already exists`);
    return { status: "exists" };
  }

  const opened = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Create a new filter"), a:has-text("Create a new filter"), button:has-text("Create a new filter")`,
    { timeout: 8000 }
  );
  if (!opened) return { status: "failed", reason: "create-filter-btn-not-found" };

  const typed = await DOMHelpers.typeText(
    page,
    `input[name='subject'], input[aria-label*='Subject'], input[placeholder*='Subject']`,
    identifier,
    { delay: 30 }
  );
  if (!typed) return { status: "failed", reason: "subject-input-not-found" };

  const next = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Create filter"), button:has-text("Create filter"), div[role='button']:has-text("Create filters")`,
    { timeout: 8000 }
  );
  if (!next) return { status: "failed", reason: "create-filter-next-not-found" };

  // Actions page: skip inbox
  await DOMHelpers.clickElement(
    page,
    `div[role='checkbox']:has-text("Skip the inbox"), div[role='checkbox'][aria-label*='Skip the inbox']`,
    { timeout: 5000, delay: 300 }
  );

  // Actions page: apply label
  const labelToggled = await DOMHelpers.clickElement(
    page,
    `div[role='checkbox']:has-text("Apply the label"), div[role='checkbox'][aria-label*='Apply the label']`,
    { timeout: 5000, delay: 500 }
  );
  if (!labelToggled) return { status: "failed", reason: "apply-label-not-found" };

  // Label chooser → existing label by name, else New label…
  const chooser = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Choose label"), div[role='button'][aria-label*='Choose label']`,
    { timeout: 5000, delay: 500 }
  );
  if (chooser) {
    const picked = await DOMHelpers.clickElement(
      page,
      `[role='menuitem']:has-text("${q(folder)}"), [role='option']:has-text("${q(folder)}")`,
      { timeout: 3000, delay: 300 }
    );
    if (!picked) {
      const newLabel = await DOMHelpers.clickElement(
        page,
        `[role='menuitem']:has-text("New label"), div:has-text("New label")`,
        { timeout: 3000, delay: 300 }
      );
      if (newLabel) {
        await DOMHelpers.typeText(page, config.selectors.labelNameInput, folder, { delay: 30 });
        await DOMHelpers.clickElement(page, config.selectors.labelConfirmBtn, { timeout: 5000, delay: 500 });
      }
    }
  }

  const saved = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Save"), button:has-text("Save")`,
    { timeout: 8000 }
  );
  if (!saved) return { status: "failed", reason: "save-not-found" };

  await DOMHelpers.randomDelay(1500, 2500);
  if (!(await pageHas(page, identifier))) return { status: "failed", reason: "not-persisted" };
  log.info(`[replyFilter][gmail] installed '${identifier}' → label '${folder}'`);
  return { status: "installed" };
}

// ==================== OUTLOOK ====================
// Ensure folder exists (folder pane → New folder), then
// Settings → Mail → Rules → Create rule → Subject includes <identifier>
// → Move to <folder> → Save.

async function installOutlook(page, identifier, folder, log) {
  const config = getPlatformConfig("outlook");

  // 1) Ensure destination folder exists
  await page.goto(config.inboxUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await DOMHelpers.randomDelay(config.timing.afterNavigate, config.timing.afterNavigate * 1.3);

  if (!(await pageHas(page, folder))) {
    const newFolder = await DOMHelpers.clickElement(
      page,
      `button:has-text("New folder"), div[role='button']:has-text("New folder"), span:has-text("New folder")`,
      { timeout: 6000 }
    );
    if (newFolder) {
      await DOMHelpers.typeText(
        page,
        `input[placeholder*='Folder name'], input[aria-label*='Folder name'], input[aria-label*='New folder name']`,
        folder,
        { delay: 30 }
      );
      await page.keyboard.press("Enter").catch(() => {});
      await DOMHelpers.randomDelay(1500, 2500);
    } else {
      log.warn(`[replyFilter][outlook] New folder button not found — continuing (folder may exist)`);
    }
  }

  // 2) Rules UI
  const gear = await DOMHelpers.clickElement(
    page,
    `button[aria-label='Settings'], div[role='button'][aria-label='Settings'], button[title='Settings']`,
    { timeout: 8000 }
  );
  if (!gear) return { status: "failed", reason: "settings-gear-not-found" };
  await DOMHelpers.randomDelay(1200, 2000);

  const mailNav = await DOMHelpers.clickElement(page, `text="Mail"`, { timeout: 5000, delay: 800 });
  if (!mailNav) return { status: "failed", reason: "mail-settings-not-found" };

  const rulesNav = await DOMHelpers.clickElement(page, `text="Rules"`, { timeout: 5000, delay: 800 });
  if (!rulesNav) return { status: "failed", reason: "rules-nav-not-found" };

  if (await pageHas(page, identifier)) {
    log.info(`[replyFilter][outlook] rule for '${identifier}' already exists`);
    return { status: "exists" };
  }

  const createRule = await DOMHelpers.clickElement(
    page,
    `button:has-text("Create rule"), div[role='button']:has-text("Create rule"), button:has-text("Add rule"), div[role='button']:has-text("Add rule")`,
    { timeout: 6000 }
  );
  if (!createRule) return { status: "failed", reason: "create-rule-not-found" };
  await DOMHelpers.randomDelay(1000, 1800);

  // Condition: subject includes
  const condPicked = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Subject includes"), div:has-text("Subject includes"), text="Subject includes"`,
    { timeout: 5000, delay: 600 }
  );
  const condTyped = await DOMHelpers.typeText(
    page,
    `input[aria-label*='Subject'], input[placeholder*='subject'], input[name='subject']`,
    identifier,
    { delay: 30 }
  );
  if (!condPicked && !condTyped) return { status: "failed", reason: "condition-input-not-found" };

  // Action: move to folder
  const movePicked = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Move to"), div:has-text("Move to"), text="Move to"`,
    { timeout: 5000, delay: 600 }
  );
  if (movePicked) {
    await DOMHelpers.clickElement(
      page,
      `div[role='option']:has-text("${q(folder)}"), li:has-text("${q(folder)}"), [role='menuitem']:has-text("${q(folder)}")`,
      { timeout: 5000, delay: 500 }
    );
  }

  const saved = await DOMHelpers.clickElement(page, `button:has-text("Save"), div[role='button']:has-text("Save")`, {
    timeout: 6000,
  });
  if (!saved) return { status: "failed", reason: "rule-save-not-found" };

  await DOMHelpers.randomDelay(1500, 2500);
  log.info(`[replyFilter][outlook] installed rule '${identifier}' → folder '${folder}'`);
  return { status: "installed" };
}

// ==================== YAHOO / AOL ====================
// Settings → folders: ensure destination folder.
// Settings → Mail → Filters → Add new filter: Subject contains <identifier>
// → Move to <folder> → Save.

async function installYahooLike(page, platform, identifier, folder, log) {
  const config = getPlatformConfig(platform);
  const isAol = platform === "aol";
  const settingsUrl = isAol ? "https://mail.aol.com/d/settings" : "https://mail.yahoo.com/d/settings";

  // 1) Ensure destination folder exists
  await page.goto(config.labelsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await DOMHelpers.randomDelay(config.timing.afterNavigate, config.timing.afterNavigate * 1.3);

  if (!(await pageHas(page, folder))) {
    const add = await DOMHelpers.clickElement(page, config.selectors.addFolderBtn, { timeout: 6000 });
    if (add) {
      const typed = await DOMHelpers.typeText(
        page,
        `input[aria-label*='Folder name'], input[placeholder*='Folder name'], input[placeholder*='folder']`,
        folder,
        { delay: 30 }
      );
      if (typed) {
        await DOMHelpers.clickElement(page, `button:has-text("Save"), button:has-text("Done")`, { timeout: 5000 });
        await DOMHelpers.randomDelay(1500, 2500);
      }
    } else {
      log.warn(`[replyFilter][${platform}] Add folder button not found — continuing (folder may exist)`);
    }
  }

  // 2) Filters UI
  await page.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await DOMHelpers.randomDelay(config.timing.afterNavigate, config.timing.afterNavigate * 1.3);

  // Older UIs hide filters behind "More settings"
  const more = await DOMHelpers.clickElement(page, `text="More settings"`, { timeout: 3000, delay: 500 });
  if (more) await DOMHelpers.randomDelay(800, 1400);

  const filtersNav = await DOMHelpers.clickElement(page, `text="Filters"`, { timeout: 5000, delay: 800 });
  if (!filtersNav) return { status: "failed", reason: "filters-nav-not-found" };

  if (await pageHas(page, identifier)) {
    log.info(`[replyFilter][${platform}] filter for '${identifier}' already exists`);
    return { status: "exists" };
  }

  const addFilter = await DOMHelpers.clickElement(
    page,
    `button:has-text("Add new filter"), div:has-text("Add new filter")`,
    { timeout: 6000 }
  );
  if (!addFilter) return { status: "failed", reason: "add-filter-not-found" };
  await DOMHelpers.randomDelay(800, 1500);

  // Filter name (cosmetic — uses folder name)
  await DOMHelpers.typeText(
    page,
    `input[aria-label*='Filter name'], input[placeholder*='Filter name'], input[placeholder*='name']`,
    folder,
    { delay: 30 }
  );

  // Match: subject contains identifier
  const matchPicked = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Match"), div:has-text("Match the following"), select`,
    { timeout: 5000, delay: 500 }
  );
  if (matchPicked) {
    await DOMHelpers.clickElement(page, `[role='option']:has-text("Subject"), li:has-text("Subject")`, {
      timeout: 4000,
      delay: 400,
    });
  }
  const valueTyped = await DOMHelpers.typeText(
    page,
    `input[aria-label*='Subject'], input[placeholder*='subject'], input[aria-label*='contains']`,
    identifier,
    { delay: 30 }
  );
  if (!valueTyped) return { status: "failed", reason: "match-value-input-not-found" };

  // Action: move to folder
  const actionPicked = await DOMHelpers.clickElement(
    page,
    `div[role='button']:has-text("Move to"), div:has-text("Move to"), select`,
    { timeout: 5000, delay: 500 }
  );
  if (actionPicked) {
    await DOMHelpers.clickElement(
      page,
      `[role='option']:has-text("${q(folder)}"), li:has-text("${q(folder)}"), option:has-text("${q(folder)}")`,
      { timeout: 4000, delay: 400 }
    );
  }

  const saved = await DOMHelpers.clickElement(page, `button:has-text("Save"), div[role='button']:has-text("Save")`, {
    timeout: 6000,
  });
  if (!saved) return { status: "failed", reason: "filter-save-not-found" };

  await DOMHelpers.randomDelay(1500, 2500);
  log.info(`[replyFilter][${platform}] installed '${identifier}' → folder '${folder}'`);
  return { status: "installed" };
}

export { ensureReplyFilter as default };
