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
export async function ensureReplyFilter(page, platform, keyword, log = logger) {
  const kw = String(keyword || "").trim();
  const folder = resolveFolderName(kw);
  if (!kw) return { status: "skipped", reason: "no-keyword" };

  try {
    if (platform === "gmail") return await installGmail(page, kw, folder, log);
    if (platform === "outlook") return await installOutlook(page, kw, folder, log);
    if (platform === "yahoo" || platform === "aol") return await installYahooLike(page, platform, kw, folder, log);
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

  // 1) Navigate directly to the Outlook rules settings page (bypasses the
  //    slow settings-gear → Mail tab → Rules tab chain on slow connections).
  await page.goto("https://outlook.live.com/mail/0/options/mail/rules", {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await DOMHelpers.randomDelay(5000, 9000);

  // 2) Wait for the rules page to render its "Add rule" button.
  const rulesPageDeadline = Date.now() + 40000;
  while (Date.now() < rulesPageDeadline) {
    const ready = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return text.includes("Add rule") || text.includes("Create rule") || text.includes("Add new rule");
    }).catch(() => false);
    if (ready) break;
    await DOMHelpers.randomDelay(1500, 2500);
  }
  await DOMHelpers.randomDelay(2000, 3500);

  // Already exists?
  if (await pageHas(page, identifier)) {
    log.info(`[replyFilter][outlook] rule for '${identifier}' already exists`);
    return { status: "exists" };
  }

  // 5) Rules page readiness gate (already waited above; this is a no-op safety check).
  //    Reuse the existing deadline variable name to avoid redeclaration.
  while (Date.now() < rulesPageDeadline) {
    const ready = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return text.includes("Add rule") || text.includes("Create rule");
    }).catch(() => false);
    if (ready) break;
    await DOMHelpers.randomDelay(1500, 2500);
  }
  await DOMHelpers.randomDelay(2000, 3500);

  // 5b) Add rule (retry)
  let addRule = null;
  const addRuleDeadline = Date.now() + 40000;
  while (Date.now() < addRuleDeadline && !addRule) {
    try {
      addRule = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, [role='button']"));
        const btn = btns.find((b) => {
          const t = (b.textContent || "").trim().toLowerCase();
          return t === "add rule" || t.includes("add rule") || t.includes("create rule") || t.includes("add new rule");
        });
        if (btn) { btn.click(); return true; }
        return false;
      });
    } catch (e) {
      log.warn(`[replyFilter][outlook] add-rule click attempt failed: ${e.message}`);
    }
    if (!addRule) await DOMHelpers.randomDelay(2000, 3500);
  }
  if (!addRule) return { status: "failed", reason: "add-rule-not-found" };
  await DOMHelpers.randomDelay(2000, 3500);

  // 6) Rule name
  const named = await DOMHelpers.typeText(
    page,
    `input[placeholder='Name your rule']`,
    folder || identifier,
    { delay: 30 }
  );
  if (!named) return { status: "failed", reason: "rule-name-input-not-found" };
  await DOMHelpers.randomDelay(800, 1500);

  // 7) Condition dropdown -> Subject or body includes (Down x10 then Enter)
  const condDropdown = await DOMHelpers.clickElement(
    page,
    `button[aria-label='Select a conditional']`,
    { timeout: 12000, delay: 800 }
  );
  if (!condDropdown) return { status: "failed", reason: "condition-dropdown-not-found" };
  await DOMHelpers.randomDelay(800, 1500);
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await DOMHelpers.randomDelay(1200, 2000);

  // 8) Keyword input
  const kwTyped = await DOMHelpers.typeText(
    page,
    `input[placeholder='Enter words to look for']`,
    identifier,
    { delay: 30 }
  );
  if (!kwTyped) return { status: "failed", reason: "keyword-input-not-found" };
  await page.keyboard.press("Enter").catch(() => {});
  await DOMHelpers.randomDelay(1200, 2000);

  // 9) Action dropdown -> Move to (Right once then Enter)
  const actionDropdown = await DOMHelpers.clickElement(
    page,
    `button[aria-label='Select a action']`,
    { timeout: 12000, delay: 800 }
  );
  if (!actionDropdown) return { status: "failed", reason: "action-dropdown-not-found" };
  await DOMHelpers.randomDelay(800, 1500);
  await page.keyboard.press("ArrowRight").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await DOMHelpers.randomDelay(1200, 2000);

  // 10) Folder selector (inline creation): click "Select a folder", then
  //     ArrowDown x5 + Enter to switch to new-folder-name input, type the
  //     keyword, Enter to create + select the folder.
  let folderBtn = false;
  const folderBtnDeadline = Date.now() + 20000;
  while (Date.now() < folderBtnDeadline && !folderBtn) {
    try {
      folderBtn = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, [role='button']"));
        const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase().includes("select a folder"));
        if (btn) { btn.click(); return true; }
        return false;
      });
    } catch (e) {
      log.warn(`[replyFilter][outlook] folder-selector click attempt failed: ${e.message}`);
    }
    if (!folderBtn) await DOMHelpers.randomDelay(2000, 3000);
  }
  if (!folderBtn) return { status: "failed", reason: "folder-selector-not-found" };
  await DOMHelpers.randomDelay(1200, 2000);

  // Inline folder creation: type a long rubbish string to filter the folder
  // list down to "No results" + "Create new folder", then ArrowDown x2 + Enter
  // to switch to the new-folder-name input, type the real folder name, Enter.
  const rubbish = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
  const searchTyped = await DOMHelpers.typeText(
    page,
    `input[placeholder='Search folders']`,
    rubbish,
    { delay: 20 }
  );
  await DOMHelpers.randomDelay(1000, 1800);

  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("ArrowDown").catch(() => {});
  await page.keyboard.press("Enter").catch(() => {});
  await DOMHelpers.randomDelay(2000, 3000);

  // Type folder name into the now-focused new-folder input (creates + selects).
  // Use document.activeElement to be robust to placeholder differences.
  let folderTyped = false;
  try {
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    await page.type("input:focus, textarea:focus", folder, { delay: 30 }).catch(async () => {
      // fallback: type into whatever is focused
      await page.keyboard.type(folder, { delay: 30 });
    });
    folderTyped = true;
  } catch (e) {
    log.warn(`[replyFilter][outlook] folder-name typing failed: ${e.message}`);
    // last resort
    try { await page.keyboard.type(folder, { delay: 30 }); folderTyped = true; } catch {}
  }
  if (folderTyped) {
    await page.keyboard.press("Enter").catch(() => {});
    await DOMHelpers.randomDelay(1500, 2500);
  }

  // 11+12) Toggle checkboxes via page.evaluate (Puppeteer has no getAttribute on ElementHandle)
  try {
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll("label"));
      const stopLbl = labels.find((l) => (l.textContent || "").includes("Stop processing more rules"));
      if (stopLbl) {
        const cb = document.getElementById(stopLbl.getAttribute("for"));
        if (cb && cb.checked) cb.click();
      }
      const runLbl = labels.find((l) => (l.textContent || "").includes("Run rule now"));
      if (runLbl) {
        const cb = document.getElementById(runLbl.getAttribute("for"));
        if (cb && !cb.checked) cb.click();
      }
    });
  } catch (e) {
    log.warn(`[replyFilter][outlook] checkbox toggle failed: ${e.message}`);
  }
  await DOMHelpers.randomDelay(500, 900);

  // 13) Save
  let saved = false;
  const saveDeadline = Date.now() + 20000;
  while (Date.now() < saveDeadline && !saved) {
    try {
      saved = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, [role='button']"));
        const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "save");
        if (btn) { btn.click(); return true; }
        return false;
      });
    } catch (e) {
      log.warn(`[replyFilter][outlook] save click attempt failed: ${e.message}`);
    }
    if (!saved) await DOMHelpers.randomDelay(2000, 3000);
  }
  if (!saved) return { status: "failed", reason: "rule-save-not-found" };
  await DOMHelpers.randomDelay(2500, 4000);

  // 14) "Folder name already exists" dialog -> OK
  try {
    const hasDialog = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return text.includes("Folder name already exists");
    });
    if (hasDialog) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, [role='button']"));
        const btn = btns.find((b) => (b.textContent || "").trim().toLowerCase() === "ok");
        if (btn) btn.click();
      });
      await DOMHelpers.randomDelay(800, 1400);
    }
  } catch (e) {
    log.warn(`[replyFilter][outlook] already-exists dialog handling failed: ${e.message}`);
  }

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
