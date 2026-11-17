import logger from "../../../utils/logger.js";
import { DOMHelpers } from "../../socials/_shared/routeHelper.js";
import threadScore from "./threadScore.js";

const { decideAction } = threadScore;

// Search results come back date-descending on all four clients; when a row has
// no parseable date we approximate recency from result order (idx * 3 days,
// capped by STEALTH_MAX_CANDIDATES so the worst case is ~6 days off).
const STEALTH_MAX_CANDIDATES = 2;
const ORDER_RECENCY_STEP_MS = 3 * 86400000;

function normEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function extractEmail(text) {
  const m = String(text || "").match(/[\w.+-]+@[\w.-]+\.[\w.-]+/);
  return m ? m[0].toLowerCase() : String(text || "").trim().toLowerCase();
}

/**
 * Parse a mail-row date title. Handles full dates, en-IN day-first
 * dd/mm/yyyy, bare clock times (row is from today) and weekday names
 * (row is from this week — approximated to yesterday for scoring).
 * @returns {number|null} epoch ms
 */
function parseRowDate(title, nowMs) {
  const raw = String(title || "").trim();
  if (!raw) return null;

  const direct = Date.parse(raw);
  if (!Number.isNaN(direct) && /\d{4}/.test(raw)) return direct;

  const dmy = raw.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    let [, a, b, y] = dmy;
    a = Number(a); b = Number(b); y = Number(y);
    if (y < 100) y += 2000;
    const dayFirst = a > 12 ? true : b > 12 ? false : true; // default day-first (en-IN)
    const day = dayFirst ? a : b;
    const month = dayFirst ? b : a;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return Date.UTC(y, month - 1, day);
    }
  }

  const clock = raw.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (clock) {
    const d = new Date(nowMs);
    let h = Number(clock[1]);
    const mm = Number(clock[2]);
    const ap = (clock[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    d.setHours(h, mm, 0, 0);
    return d.getTime() <= nowMs ? d.getTime() : d.getTime() - 86400000;
  }

  if (/^(mon|tues|wednes|thurs|fri|satur|sun)day$/i.test(raw)) {
    return nowMs - 86400000;
  }

  return null;
}

function orderHeuristicDate(nowMs, idx) {
  return nowMs - Math.min(idx, STEALTH_MAX_CANDIDATES) * ORDER_RECENCY_STEP_MS;
}

function directionFrom(senders, accountEmail) {
  const me = normEmail(accountEmail);
  const list = (senders || []).map(extractEmail).filter(Boolean);
  if (!me || list.length === 0) return "unknown";
  const hasMe = list.some((s) => s === me);
  const hasThem = list.some((s) => s !== me);
  if (hasMe && hasThem) return "both";
  if (hasMe) return "out";
  if (hasThem) return "in";
  return "unknown";
}

// ==================== Candidate reading (shared row scraper) ====================

async function readThreadRows(page, selectors) {
  return await page.evaluate((sels) => {
    const rows = [...document.querySelectorAll(sels.threadRow)].slice(0, 6);
    return rows.map((row, idx) => {
      const subjectEl = sels.threadSubject ? row.querySelector(sels.threadSubject) : null;
      const senderEl = sels.threadSender ? row.querySelector(sels.threadSender) : null;
      const dateEl = sels.threadDate ? row.querySelector(sels.threadDate) : null;
      return {
        idx,
        subject: (subjectEl?.textContent || "").trim(),
        sender: (senderEl?.getAttribute("title") || senderEl?.textContent || "").trim(),
        dateTitle: (dateEl?.getAttribute("title") || dateEl?.textContent || "").trim(),
        legacyId: row.getAttribute("data-legacy-id") || row.id || "",
      };
    });
  }, selectors);
}

async function clickRow(page, selectors, idx) {
  await page.evaluate(
    (sel, i) => {
      const rows = document.querySelectorAll(sel);
      if (rows[i]) rows[i].click();
    },
    selectors.threadRow,
    idx
  );
  await DOMHelpers.randomDelay(2500, 4000);
}

async function readConversationDetail(page, selectors, accountEmail) {
  return await page.evaluate(
    (sels, me) => {
      const fromEls = sels.messageFrom ? [...document.querySelectorAll(sels.messageFrom)] : [];
      const senders = fromEls.map((el) =>
        String(el.getAttribute("email") || el.getAttribute("aria-label") || el.textContent || "").trim()
      );
      const legacy = Math.max(
        document.querySelectorAll("[data-legacy-id]").length,
        document.querySelectorAll("div.adn").length
      );
      const messageCount = legacy > 0 ? legacy : fromEls.length || null;
      return { senders, messageCount, me };
    },
    selectors,
    accountEmail || ""
  );
}

function buildCandidate(row, nowMs, extra = {}) {
  const parsed = parseRowDate(row.dateTitle, nowMs);
  return {
    idx: row.idx,
    subject: row.subject,
    legacyId: row.legacyId,
    lastDate: parsed !== null ? parsed : orderHeuristicDate(nowMs, row.idx),
    lastDateSource: parsed !== null ? "row" : "order-heuristic",
    direction: "unknown",
    messageCount: null,
    ...extra,
  };
}

// ==================== findThreads (per platform) ====================

function gmailSearchUrl(contactEmail) {
  const q = `from:${contactEmail} OR to:${contactEmail} newer_than:30d`;
  return `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`;
}

async function findGmailThreads(page, config, contactEmail, accountEmail, log) {
  const { selectors: sels, timing } = config;
  const searchUrl = gmailSearchUrl(contactEmail);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);

  const rows = await readThreadRows(page, sels);
  const now = Date.now();
  const candidates = rows.slice(0, STEALTH_MAX_CANDIDATES).map((r) =>
    buildCandidate(r, now, {
      reopen: async (p) => {
        await p.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await DOMHelpers.randomDelay(timing.afterSearch * 0.8, timing.afterSearch);
        await clickRow(p, sels, r.idx);
      },
    })
  );

  for (const cand of candidates) {
    try {
      await clickRow(page, sels, cand.idx);
      const detail = await readConversationDetail(page, sels, accountEmail);
      cand.direction = directionFrom(detail.senders, accountEmail);
      cand.messageCount = detail.messageCount;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await DOMHelpers.randomDelay(timing.afterSearch * 0.8, timing.afterSearch);
    } catch (err) {
      log.warn(`[stealth][gmail] candidate enrichment failed (idx=${cand.idx}): ${err.message}`);
      cand.direction = "unknown";
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    }
  }
  return candidates;
}

async function outlookSearch(page, config, contactEmail) {
  const { selectors: sels, timing } = config;
  const query = `from:${contactEmail} OR to:${contactEmail}`;
  const searchUrl = `https://outlook.live.com/mail/0/search?q=${encodeURIComponent(query)}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);

  let rows = await readThreadRows(page, sels);
  if (rows.length === 0) {
    // Fallback: proven compose-email pattern — type the query into search box
    await page.goto(config.inboxUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await DOMHelpers.randomDelay(timing.afterNavigate, timing.afterNavigate * 1.3);
    const searchSel = sels.searchBox;
    const has = await DOMHelpers.clickElement(page, searchSel, { timeout: 5000 });
    if (has) {
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.type(searchSel, query, { delay: 15 });
      await page.keyboard.press("Enter");
      await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);
      rows = await readThreadRows(page, sels);
    }
  }
  return { rows, searchUrl };
}

async function findOutlookThreads(page, config, contactEmail, accountEmail, log) {
  const { selectors: sels, timing } = config;
  const { rows, searchUrl } = await outlookSearch(page, config, contactEmail);
  const now = Date.now();
  const candidates = rows.slice(0, STEALTH_MAX_CANDIDATES).map((r) =>
    buildCandidate(r, now, {
      reopen: async (p) => {
        await p.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await DOMHelpers.randomDelay(timing.afterSearch * 0.8, timing.afterSearch);
        await clickRow(p, sels, r.idx);
      },
    })
  );

  for (const cand of candidates) {
    try {
      await clickRow(page, sels, cand.idx);
      const detail = await readConversationDetail(page, sels, accountEmail);
      cand.direction = directionFrom(detail.senders, accountEmail);
      cand.messageCount = detail.messageCount;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
      await DOMHelpers.randomDelay(timing.afterSearch * 0.8, timing.afterSearch);
    } catch (err) {
      log.warn(`[stealth][outlook] candidate enrichment failed (idx=${cand.idx}): ${err.message}`);
      cand.direction = "unknown";
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    }
  }
  return candidates;
}

async function yahooLikeSearch(page, config, contactEmail) {
  const { selectors: sels, timing } = config;
  const query = `from:${contactEmail} OR to:${contactEmail}`;
  const run = async (p) => {
    await p.goto(config.inboxUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await DOMHelpers.randomDelay(timing.afterNavigate, timing.afterNavigate * 1.3);
    const clicked = await DOMHelpers.clickElement(p, sels.searchBox, { timeout: 5000 });
    if (!clicked) return false;
    await p.keyboard.down("Control");
    await p.keyboard.press("a");
    await p.keyboard.up("Control");
    await p.type(sels.searchBox, query, { delay: 15 });
    await p.keyboard.press("Enter");
    await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);
    return true;
  };
  const ok = await run(page);
  const rows = ok ? await readThreadRows(page, sels) : [];
  return { rows, rerun: run };
}

async function findYahooLikeThreads(page, config, contactEmail, accountEmail, log) {
  const { selectors: sels, timing } = config;
  const { rows, rerun } = await yahooLikeSearch(page, config, contactEmail);
  const now = Date.now();
  const candidates = rows.slice(0, STEALTH_MAX_CANDIDATES).map((r) =>
    buildCandidate(r, now, {
      reopen: async (p) => {
        await rerun(p);
        await clickRow(p, sels, r.idx);
      },
    })
  );

  for (const cand of candidates) {
    try {
      await clickRow(page, sels, cand.idx);
      const detail = await readConversationDetail(page, sels, accountEmail);
      cand.direction = directionFrom(detail.senders, accountEmail);
      cand.messageCount = detail.messageCount;
      await rerun(page);
    } catch (err) {
      log.warn(`[stealth][${config.platform}] candidate enrichment failed (idx=${cand.idx}): ${err.message}`);
      cand.direction = "unknown";
      await rerun(page).catch(() => {});
    }
  }
  return candidates;
}

export async function findThreads(page, config, contactEmail, accountEmail, log = logger) {
  if (config.platform === "gmail") return await findGmailThreads(page, config, contactEmail, accountEmail, log);
  if (config.platform === "outlook") return await findOutlookThreads(page, config, contactEmail, accountEmail, log);
  return await findYahooLikeThreads(page, config, contactEmail, accountEmail, log);
}

// ==================== Post-decision ops ====================

/**
 * Reply into the currently open thread. Throws on pre-send failure with
 * err.replySendAttempted=false (caller may fall back to fresh compose);
 * after the send button is touched the flag flips so callers never double-send.
 */
export async function replyInThread(page, config, body, log = logger) {
  const { selectors: sels, timing } = config;
  let sendAttempted = false;
  try {
    const opened = await DOMHelpers.clickElement(page, sels.replyButton, { timeout: 8000 });
    if (!opened) {
      const err = new Error("reply button not found");
      err.replySendAttempted = false;
      throw err;
    }
    await DOMHelpers.randomDelay(800, 1500);

    const composerReady = await DOMHelpers.waitForSelector(page, sels.replyBodyInput, {
      timeout: 8000,
      visible: true,
    }).catch(() => null);
    if (!composerReady) {
      const err = new Error("reply composer did not open");
      err.replySendAttempted = false;
      throw err;
    }

    await page.click(sels.replyBodyInput).catch(async () => {
      await page.evaluate((sel) => document.querySelector(sel)?.focus(), sels.replyBodyInput);
    });
    await page.type(sels.replyBodyInput, body, { delay: 10 });
    await DOMHelpers.randomDelay(timing.afterFill * 0.8, timing.afterFill * 1.2);

    sendAttempted = true;
    const sent = await DOMHelpers.clickElement(page, sels.sendButton, { timeout: 5000 });
    if (!sent) {
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");
    }
    await DOMHelpers.randomDelay(2000, 3000);
    log.info(`[stealth][${config.platform}] reply sent`);
    return { status: "done" };
  } catch (err) {
    if (err && typeof err === "object" && !("replySendAttempted" in err)) {
      err.replySendAttempted = sendAttempted;
    }
    throw err;
  }
}

/**
 * Mute/ignore the open conversation. Yahoo/AOL have no native mute —
 * returns {status:'skipped'} (plan: skip + honest log, never an error).
 */
export async function muteThread(page, config, log = logger) {
  const { selectors: sels } = config;
  if (config.platform === "yahoo" || config.platform === "aol") {
    log.info(`[stealth][${config.platform}] no native conversation mute — skipping mute step`);
    return { status: "skipped", reason: "no-native-mute" };
  }
  try {
    const menuOpen = await DOMHelpers.clickElement(page, sels.threadMenuBtn, { timeout: 6000 });
    if (!menuOpen) return { status: "failed", reason: "thread-menu-not-found" };
    await DOMHelpers.randomDelay(500, 1000);
    const muted = await DOMHelpers.clickElement(page, sels.muteMenuItem, { timeout: 5000 });
    if (!muted) return { status: "failed", reason: "mute-item-not-found" };
    await DOMHelpers.randomDelay(800, 1500);
    log.info(`[stealth][${config.platform}] conversation muted`);
    return { status: "done" };
  } catch (err) {
    return { status: "failed", reason: err.message };
  }
}

// ==================== Sent + Trash purge helpers ====================

async function rowsCount(page, selector) {
  return await page.$$eval(selector, (rows) => rows.length).catch(() => 0);
}

// Rows can lag right after a send/delete — poll before giving up.
async function waitForRows(page, selector, attempts = 3) {
  let count = await rowsCount(page, selector);
  for (let i = 0; i < attempts - 1 && !count; i++) {
    await DOMHelpers.randomDelay(1500, 2500);
    count = await rowsCount(page, selector);
  }
  return count;
}

// Click the row matching subject (Re:/Fwd: normalized); falls back to row 0.
async function clickRowBySubject(page, selectors, subject) {
  await page.evaluate(
    (sel, subj) => {
      const rows = [...document.querySelectorAll(sel)];
      const norm = (s) =>
        String(s || "")
          .replace(/^((re|fwd?):\s*)+/i, "")
          .trim()
          .toLowerCase();
      let idx = rows.findIndex((r) => {
        const el = r.querySelector("[data-test-id='subject'], .subject");
        return el && norm(el.textContent) === norm(subj);
      });
      if (idx < 0) idx = 0;
      if (rows[idx]) rows[idx].click();
    },
    selectors.threadRow,
    subject
  );
  await DOMHelpers.randomDelay(2000, 3000);
}

// Outlook folder-based purge helpers (verified against live OWA DOM).
// Sent/Deleted folders are treeitems with stable data-folder-name values.
async function outlookOpenFolder(page, folderName) {
  const sel = `div[role="treeitem"][data-folder-name="${folderName}"]`;
  const ok = await DOMHelpers.clickElement(page, sel, { timeout: 8000 }).catch(() => false);
  if (!ok) return false;
  await DOMHelpers.randomDelay(1200, 2000);
  return true;
}

// Select every visible message row whose aria-label contains the plain campaign
// keyword. The list is virtualized, so scroll in passes until no new rows appear.
async function outlookSelectKeywordRows(page, keyword, log = logger) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return 0;
  const scroller = '[data-testid="virtuoso-scroller"]';
  let selected = 0;
  for (let pass = 0; pass < 6; pass++) {
    const inPass = await page.evaluate((kw) => {
      const rows = [...document.querySelectorAll('div[role="option"][data-focusable-row="true"]')];
      let n = 0;
      for (const row of rows) {
        const label = String(row.getAttribute('aria-label') || '').toLowerCase();
        if (!label.includes(kw)) continue;
        const cb = row.querySelector('div[role="checkbox"][aria-label="Select a conversation"], input.fui-Checkbox__input');
        if (!cb) continue;
        const checked = cb.getAttribute('aria-checked') === 'true' || (cb.tagName === 'INPUT' && cb.checked);
        if (checked) { n++; continue; }
        try { cb.click(); n++; } catch {}
      }
      return n;
    }, kw);
    selected += inPass;
    await DOMHelpers.randomDelay(500, 900);
    const beforeScroll = selected;
    await page.$eval(scroller, (el) => { el.scrollTop += el.clientHeight * 0.8; }).catch(() => {});
    await DOMHelpers.randomDelay(400, 800);
    if (inPass === 0 && beforeScroll === selected && pass > 1) break;
  }
  if (selected) log.info(`[stealth][outlook] selected ${selected} message(s) matching '${kw}'`);
  return selected;
}

async function outlookClickRibbonDelete(page) {
  const ok = await DOMHelpers.clickElement(
    page,
    'button:has(i[data-icon-name="DeleteRegular"]), [role="button"]:has(i[data-icon-name="DeleteRegular"])',
    { timeout: 6000 }
  ).catch(() => false);
  if (!ok) return false;
  await DOMHelpers.randomDelay(800, 1400);
  return true;
}

async function outlookConfirmPermanentDelete(page, log = logger) {
  for (let i = 0; i < 6; i++) {
    const done = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('.fui-DialogBody, [role="dialog"]')];
      const d = dialogs.find((el) => String(el.textContent || '').toLowerCase().includes('permanently delete'));
      if (!d) return false;
      const actions = [...d.querySelectorAll('.fui-DialogActions')];
      const scope = actions.length ? actions[actions.length - 1] : d;
      const btn = [...scope.querySelectorAll('button')].find((b) => String(b.textContent || '').trim().toLowerCase() === 'ok');
      if (btn) { try { btn.click(); return true; } catch {} }
      return false;
    });
    if (done) {
      log.info('[stealth][outlook] permanent delete confirmed (OK)');
      await DOMHelpers.randomDelay(800, 1400);
      return true;
    }
    await DOMHelpers.randomDelay(400, 700);
  }
  return false;
}

// Gmail: hover newest message block → Message options → menu item.
// Returns null on success, or a failure reason string.
async function gmailDeleteViaOptions(page, selectors, menuItemSelector, timeout = 5000) {
  await page.evaluate(() => {
    const blocks = [...document.querySelectorAll("div.adn")];
    if (blocks.length) {
      blocks[blocks.length - 1].dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    }
  });
  await DOMHelpers.randomDelay(400, 800);

  let optBtns = await page.$$(selectors.msgOptionsBtn);
  if (!optBtns.length) {
    await page.mouse.move(400, 300);
    await DOMHelpers.randomDelay(400, 800);
    optBtns = await page.$$(selectors.msgOptionsBtn);
  }
  if (!optBtns.length) return "msg-options-not-found";

  const target = optBtns[optBtns.length - 1];
  await target.hover().catch(() => {});
  await DOMHelpers.randomDelay(400, 800);
  await target.click().catch(async () => {
    await DOMHelpers.clickElement(page, selectors.msgOptionsBtn, { timeout: 4000 });
  });
  await DOMHelpers.randomDelay(500, 1000);

  const clicked = await DOMHelpers.clickElement(page, menuItemSelector, { timeout });
  if (!clicked) return "delete-item-not-found";
  return null;
}

/**
 * Phase 2 of the purge: the Sent copy now lives in Trash/Deleted Items —
 * remove it from there too so zero copy remains in the account.
 * Never throws — returns { status:'done'|'failed', reason? }.
 */
async function purgeFromTrash(page, platform, subject, config, log, keyword = "") {
  const { selectors: sels, timing } = config;
  try {
    if (platform === "gmail") {
      const q = `in:trash subject:"${subject}"`;
      const url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);
      const count = await waitForRows(page, sels.threadRow);
      if (!count) return { status: "failed", reason: "trash-no-results" };

      await clickRow(page, sels, 0);
      let failReason = await gmailDeleteViaOptions(
        page,
        sels,
        "[role='menuitem']:has-text('Delete forever')"
      );
      if (failReason) {
        const direct = await DOMHelpers.clickElement(page, `text="Delete forever"`, { timeout: 4000 });
        if (direct) failReason = null;
      }
      if (failReason) return { status: "failed", reason: failReason };
      await DOMHelpers.randomDelay(1000, 2000);
      log.info("[stealth][gmail] trash copy deleted forever");
      return { status: "done" };
    }

    if (platform === "outlook") {
      // Deleted Items -> select keyword rows -> ribbon Delete -> OK on the
      // "Do you want to permanently delete" dialog.
      const opened = await outlookOpenFolder(page, 'deleted items');
      if (!opened) return { status: "failed", reason: "trash-folder-not-found" };

      let selected = await outlookSelectKeywordRows(page, keyword || subject, log);
      if (!selected) {
        await DOMHelpers.randomDelay(1200, 2000);
        selected = await outlookSelectKeywordRows(page, keyword || subject, log);
      }
      if (!selected) return { status: "failed", reason: "trash-no-results" };

      const deleted = await outlookClickRibbonDelete(page);
      if (!deleted) return { status: "failed", reason: "delete-button-not-found" };
      const confirmed = await outlookConfirmPermanentDelete(page, log);
      if (!confirmed) return { status: "failed", reason: "permanent-confirm-not-found" };
      log.info("[stealth][outlook] trash copy permanently deleted");
      return { status: "done", selected };
    }

    // yahoo / aol — Trash folder → select → delete (permanent)
    const navOk = await DOMHelpers.clickElement(page, sels.trashNavLink, { timeout: 6000 });
    if (!navOk) return { status: "failed", reason: "trash-nav-not-found" };
    await DOMHelpers.randomDelay(timing.afterNavigate, timing.afterNavigate * 1.3);

    const count = await waitForRows(page, sels.threadRow);
    if (!count) return { status: "failed", reason: "trash-empty" };

    await clickRowBySubject(page, sels, subject);
    const deleted = await DOMHelpers.clickElement(page, sels.rowDeleteBtn, { timeout: 6000 });
    if (!deleted) return { status: "failed", reason: "delete-button-not-found" };
    await DOMHelpers.randomDelay(1000, 2000);
    log.info(`[stealth][${platform}] trash copy deleted`);
    return { status: "done" };
  } catch (err) {
    return { status: "failed", reason: err.message };
  }
}

async function deleteSentGmail(page, config, subject, log) {
  const { selectors: sels, timing } = config;
  const q = `in:sent subject:"${subject}"`;
  const url = `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(q)}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);

  const count = await waitForRows(page, sels.threadRow);
  if (!count) return { status: "failed", reason: "no-sent-results" };

  await clickRow(page, sels, 0);

  // Newest message = the copy we just sent; its Message options lives on hover.
  const failReason = await gmailDeleteViaOptions(page, sels, sels.deleteMsgMenuItem);
  if (failReason) return { status: "failed", reason: failReason };
  await DOMHelpers.randomDelay(1000, 2000);
  log.info("[stealth][gmail] sent copy deleted");
  return { status: "done" };
}

async function deleteSentOutlook(page, config, keyword, log) {
  // Folder-based purge: navigate to Sent Items, tick the checkboxes of every
  // row whose aria-label contains the plain keyword, then ribbon-delete.
  const opened = await outlookOpenFolder(page, 'sent items');
  if (!opened) return { status: "failed", reason: "sent-folder-not-found" };

  let selected = await outlookSelectKeywordRows(page, keyword, log);
  if (!selected) {
    // OWA indexing can lag right after a send - retry once.
    await DOMHelpers.randomDelay(1500, 2500);
    selected = await outlookSelectKeywordRows(page, keyword, log);
  }
  if (!selected) return { status: "failed", reason: "no-sent-results" };

  const deleted = await outlookClickRibbonDelete(page);
  if (!deleted) return { status: "failed", reason: "delete-button-not-found" };
  log.info("[stealth][outlook] sent copy deleted");
  return { status: "done", selected };
}

async function deleteSentYahooLike(page, config, subject, log) {
  const { selectors: sels, timing } = config;
  const navOk = await DOMHelpers.clickElement(page, sels.sentNavLink, { timeout: 6000 });
  if (!navOk) return { status: "failed", reason: "sent-nav-not-found" };
  await DOMHelpers.randomDelay(timing.afterNavigate, timing.afterNavigate * 1.3);

  const count = await waitForRows(page, sels.threadRow);
  if (!count) return { status: "failed", reason: "sent-folder-empty" };

  await clickRowBySubject(page, sels, subject);

  const deleted = await DOMHelpers.clickElement(page, sels.rowDeleteBtn, { timeout: 6000 });
  if (!deleted) return { status: "failed", reason: "delete-button-not-found" };
  await DOMHelpers.randomDelay(1000, 2000);
  log.info(`[stealth][${config.platform}] sent copy deleted`);
  return { status: "done" };
}

/**
 * Delete our sent copy of the just-delivered message AND purge it from
 * Trash/Deleted Items — zero copy remains in the account (STEALTH plan Q3).
 * Never throws — returns {status:'done'|'failed'|'skipped', trashPurged?, trashReason?, reason?}.
 */
export async function deleteSentMessage(page, config, subject, accountEmail, log = logger, keyword = "") {
  if (!subject) return { status: "skipped", reason: "no-subject" };
  const kw = String(keyword || subject).trim();

  let sent;
  try {
    if (config.platform === "gmail") sent = await deleteSentGmail(page, config, subject, log);
    else if (config.platform === "outlook") sent = await deleteSentOutlook(page, config, kw, log);
    else sent = await deleteSentYahooLike(page, config, subject, log);
  } catch (err) {
    sent = { status: "failed", reason: err.message };
  }
  if (sent.status !== "done") return sent;

  const trash = await purgeFromTrash(page, config.platform, subject, config, log, kw);
  return {
    status: "done",
    trashPurged: trash.status === "done",
    ...(trash.status !== "done" ? { trashReason: trash.reason } : {}),
  };
}

// ==================== Orchestrator ====================

/**
 * Attempt the full stealth flow for one contact:
 *   find+score threads → reply in thread → mute → delete sent copy.
 * Returns:
 *   { mode:'reply', score, mute, sentCopy, threadSubject }
 *   { mode:'new', reason, score?, error? }  → caller falls back to sendSingleEmail
 * Never throws.
 */
export async function attemptStealthSend(page, config, opts) {
  const { contactEmail, body, accountEmail, projectSubject, threshold, log = logger } = opts;
  try {
    const threads = await findThreads(page, config, contactEmail, accountEmail, log);
    const decision = decideAction(threads, { threshold, projectSubject });
    log.info(
      `[stealth][${config.platform}] ${contactEmail}: candidates=${threads.length} -> ${decision.action} (${decision.reason}, score=${decision.score})`
    );

    if (decision.action !== "reply") {
      return { mode: "new", reason: decision.reason, score: decision.score };
    }

    const winner = decision.thread;
    if (winner && typeof winner.reopen === "function") {
      await winner.reopen(page);
    }

    await replyInThread(page, config, body, log);

    let mute = { status: "skipped", reason: "not-run" };
    try {
      mute = await muteThread(page, config, log);
    } catch (err) {
      mute = { status: "failed", reason: err.message };
    }

    let sentCopy = { status: "skipped", reason: "not-run" };
    try {
      sentCopy = await deleteSentMessage(page, config, winner?.subject || projectSubject, accountEmail, log);
    } catch (err) {
      sentCopy = { status: "failed", reason: err.message };
    }

    log.info(
      `[stealth][${config.platform}] reply flow done for ${contactEmail}: score=${decision.score}, mute=${mute.status}, sentCopy=${sentCopy.status}, trashPurged=${sentCopy.trashPurged === true}`
    );
    return {
      mode: "reply",
      score: decision.score,
      mute: mute.status,
      sentCopy: sentCopy.status,
      trashPurged: sentCopy.trashPurged === true,
      threadSubject: winner?.subject || "",
    };
  } catch (err) {
    if (err && err.replySendAttempted) {
      log.warn(`[stealth][${config.platform}] post-send step failed: ${err.message} — counting as sent, skipping fallback`);
      return { mode: "reply", score: null, mute: "failed", sentCopy: "skipped", threadSubject: "", error: err.message };
    }
    log.warn(
      `[stealth][${config.platform}] reply path unavailable for ${contactEmail} (${err?.message || err}) — falling back to fresh compose`
    );
    return { mode: "new", reason: "reply-failed", error: err?.message || String(err) };
  }
}
