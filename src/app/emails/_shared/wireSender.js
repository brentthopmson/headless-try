import logger from "../../../utils/logger.js";
import { resolveSocialSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { checkSendAllowed, incrementSendCount, detectEmailProvider } from "../../../utils/sendRateLimiter.js";
import { getPlatformConfig } from "./platforms.js";
import { deleteSentMessage } from "./threadOps.js";

const PROVIDER_CONFIGS = {
  gmail: {
    composeUrl: "https://mail.google.com/mail/u/0/#inbox?compose=new",
    selectors: {
      toInput: "textarea[name='to'], div[aria-label*='To'] input, div[role='combobox'][name='to']",
      subjectInput: "input[name='subjectbox'], input[placeholder*='Subject'], input[aria-label*='Subject']",
      bodyInput: "div[role='textbox'][aria-label*='Body'], div[contenteditable='true'][role='textbox']",
      sendButton: "div[role='button'][aria-label*='Send'], div[aria-label*='Send']",
      scheduleDropdownArrow: "div[role='button'][aria-label*='More send options'], div.T-I.J-J5-Ji[act='20'] + div.T-I.J-J5-Ji",
      scheduleSendOption: "div[role='menuitem'][data-value*='schedule'], div[role='menuitem']:not([data-value]) span",
      scheduleModal: "div[role='dialog']:has-text('Schedule send'), div.nH.hF",
      scheduleDatePicker: "input[aria-label*='Date'], input[type='date']",
      scheduleTimePicker: "input[aria-label*='Time'], input[type='time']",
      scheduleConfirmBtn: "div[role='button'][act='20']:has-text('Schedule send'), div.T-I.J-J5-Ji[act='20']",
    },
    waitAfterNavigate: 4000,
    waitAfterFill: 1500,
  },
  outlook: {
    composeUrl: "https://outlook.live.com/mail/0/",
    selectors: {
      newMessageButton: [
        "button[aria-label='New mail']",
        "button[aria-label*='New mail']",
        "button[aria-label*='New message']",
        "button[name='New message']",
        "div[role='button'][aria-label*='New mail']",
        "[data-icon-name='ComposeRegular']",
      ].join(", "),
      toInput: [
        "div[aria-label='To'][contenteditable='true']",
        "div.EditorClass[aria-label='To'][contenteditable='true']",
        "div[aria-label='To'][role='textbox']",
        "div[aria-label*='To'][contenteditable='true']",
        "input[aria-label='To']",
        "input[aria-label*='To']",
        "input[placeholder='To']",
        "div[aria-label*='To recipients'] input",
        "div[aria-label*='To'] input",
        "div[data-testid='toRecipientInput'] input",
        "[aria-label='To recipients'] input",
        "div[role='combobox'][aria-label*='To']",
      ].join(", "),
      subjectInput: [
        "input[aria-label='Subject']",
        "input[placeholder='Add a subject']",
        "input[aria-label*='Add a subject']",
        "input[aria-label*='Subject']",
        "input[placeholder*='Subject']",
      ].join(", "),
      bodyInput: [
        "div[role='textbox'][aria-label='Message body'][contenteditable='true']",
        "div[aria-label='Message body'][contenteditable='true']",
        "div[aria-label='Message body']",
        "div[role='textbox'][aria-label*='Message body']",
        "div[aria-label*='Message body'][contenteditable='true']",
        "div[role='textbox'][aria-label*='Message']",
        "div[contenteditable='true'][role='textbox']",
      ].join(", "),
      sendButton: [
        "button[aria-label='Send']",
        "button[name='Send']",
        "button[type='button'][aria-label*='Send']",
        "button[title*='Send']",
      ].join(", "),
      scheduleDropdownArrow: [
        "button[aria-label='More send options']",
        "button[aria-label*='More send options']",
        "button[aria-label*='more send options']",
        "div[role='button'][aria-label*='More send options']",
      ].join(", "),
      scheduleSendOption: [
        "div[role='menuitem'][data-testid*='schedule']",
      ].join(", "),
      scheduleModal: "div[role='dialog']",
      scheduleDatePicker: "input[id^='datePicker-input'], input[role='combobox'][aria-haspopup='dialog'][aria-label*='date' i], input[aria-label*='Date']",
      scheduleTimePicker: "input.fui-TimePicker__input, input[role='combobox'].fui-TimePicker__input, input[aria-label*='Time']",
      scheduleConfirmBtn: "button[aria-label='Send'], button[aria-label*='Schedule']",
    },
    waitAfterNavigate: 6000,
    waitAfterFill: 2000,
  },
  yahoo: {
    composeUrl: "https://mail.yahoo.com/d/compose",
    selectors: {
      toInput: "input[aria-label*='To'], input#to-field",
      subjectInput: "input[aria-label*='Subject'], input#subject-field",
      bodyInput: "div[role='textbox'][aria-label*='Message body'], div[contenteditable='true']",
      sendButton: "button[aria-label*='Send'], button:has-text('Send')",
      scheduleDropdownArrow: "button[data-test-id='compose-send-dropdown'], button[aria-label='More send options']",
      scheduleSendOption: "button:has-text('Schedule send'), div[role='menuitem']:has-text('Schedule')",
      scheduleModal: "div[role='dialog']:has-text('Schedule')",
      scheduleDatePicker: "input[aria-label*='Date'], input[type='date']",
      scheduleTimePicker: "input[aria-label*='Time'], input[type='time']",
      scheduleConfirmBtn: "button[data-test-id='schedule-send-button'], button:has-text('Schedule')",
    },
    waitAfterNavigate: 4000,
    waitAfterFill: 1500,
  },
  aol: {
    composeUrl: "https://mail.aol.com/d/compose",
    selectors: {
      toInput: "input[aria-label*='To'], input#to-field",
      subjectInput: "input[aria-label*='Subject'], input#subject-field",
      bodyInput: "div[role='textbox'][aria-label*='Message body'], div[contenteditable='true']",
      sendButton: "button[aria-label*='Send']",
      scheduleDropdownArrow: "button[data-test-id='compose-send-dropdown'], button[aria-label='More send options']",
      scheduleSendOption: "button:has-text('Schedule send'), div[role='menuitem']:has-text('Schedule')",
      scheduleModal: "div[role='dialog']:has-text('Schedule')",
      scheduleDatePicker: "input[aria-label*='Date'], input[type='date']",
      scheduleTimePicker: "input[aria-label*='Time'], input[type='time']",
      scheduleConfirmBtn: "button[data-test-id='schedule-send-button'], button:has-text('Schedule')",
    },
    waitAfterNavigate: 4000,
    waitAfterFill: 1500,
  },
};

function detectProvider(email) {
  const domain = email.split("@")[1]?.toLowerCase() || "";
  if (domain.includes("gmail")) return "gmail";
  if (domain.includes("outlook") || domain.includes("hotmail") || domain.includes("live")) return "outlook";
  if (domain.includes("yahoo")) return "yahoo";
  if (domain.includes("aol")) return "aol";
  return null;
}

export async function sendViaBrowser(recipient, subject, body, cookieJSON, provider, options = {}) {
  const providerName = provider || detectProvider(recipient);
  const config = PROVIDER_CONFIGS[providerName];
  if (!config) {
    throw new Error(`Unsupported email provider: ${providerName}. Supported: ${Object.keys(PROVIDER_CONFIGS).join(", ")}`);
  }

  // Rate limit check — keyed by the SENDING account (wire profile), never the
  // recipient: recipient-keyed counters give every recipient its own budget,
  // so the mailbox's real quota was never enforced.
  const platform = detectEmailProvider(providerName);
  const accountId = options.profileId || options.browserId || recipient || "unknown";

  const rateCheck = await checkSendAllowed(platform, accountId);
  if (!rateCheck.allowed) {
    logger.warn(`[wireSender] Rate limited for ${accountId} (${platform}): ${rateCheck.reason}`);
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  logger.info(`[wireSender] Sending via ${providerName} to ${recipient} (account=${accountId}, subject ${String(subject || '').length} chars, body ${String(body || '').length} chars)`);

  // Hybrid session: use Drive profile + identity if available, else CDP cookies + identity
  const profile = {
    cookies: cookieJSON,
    browserIdentity: options.browserIdentity || null,
    driveUrl: options.driveUrl || "",
    profileId: options.profileId || accountId,
    platform,
  };
  let browser, page, profileDir;
  try {
    ({ browser, page, profileDir } = await resolveSocialSession(profile, false));
    logger.info(`[wireSender] Session resolved for ${accountId} (${providerName}) — opening compose.`);
  } catch (sessErr) {
    logger.error(`[wireSender] Session resolution FAILED for ${accountId}: ${sessErr.message}`);
    throw sessErr;
  }

  try {
    // Suppress "Leave site? Changes you made may not be saved" dialogs/unload prompts
    page.on("dialog", async (dialog) => {
      try {
        const type = dialog.type();
        if (type === "beforeunload") await dialog.accept();
        else await dialog.dismiss().catch(() => dialog.accept().catch(() => {}));
      } catch {}
    });
    try {
      await page.evaluateOnNewDocument(() => {
        try {
          window.addEventListener("beforeunload", (e) => { try { delete e.returnValue; } catch {} }, { capture: true });
          Object.defineProperty(window, "onbeforeunload", { configurable: true, get() { return null; }, set() {} });
        } catch {}
      });
    } catch {}
    await page.goto(config.composeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.evaluate(() => { try { window.onbeforeunload = null; } catch {} }); } catch {}
    await DOMHelpers.randomDelay(config.waitAfterNavigate * 0.8, config.waitAfterNavigate * 1.2);

    const splitSelectors = (sel) => String(sel || "").split(",").map(s => s.trim()).filter(Boolean);
    const waitForAnySelector = async (selectors, timeoutMs = 15000) => {
      const list = splitSelectors(selectors);
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (const sel of list) {
          try {
            const el = await page.$(sel);
            if (el) {
              const visible = await page.evaluate((node) => {
                if (!node) return false;
                const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
                const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
                return !!(r && r.width > 0 && r.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none')));
              }, el).catch(() => true);
              if (visible) return { el, selector: sel };
            }
          } catch {}
        }
        await DOMHelpers.randomDelay(250, 450);
      }
      return null;
    };
    const tryClickAny = async (selectors) => {
      const found = await waitForAnySelector(selectors, 3000);
      if (!found) return false;
      try { await page.click(found.selector); return true; } catch { return false; }
    };
    const clickByText = async (texts, options = {}) => {
      const wanted = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
      if (!wanted.length) return false;
      const rootSelector = options.rootSelector || null;
      const roles = options.roles || null;
      return await page.evaluate(({ wanted, rootSelector, roles }) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
          return !!(r && r.width > 0 && r.height > 0 && (!st || (st.visibility !== 'hidden' && st.display !== 'none')));
        };
        const root = rootSelector ? document.querySelector(rootSelector) : document;
        if (!root) return false;
        const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], div, span'));
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          if (roles && roles.length) {
            const role = el.getAttribute && el.getAttribute('role');
            const tag = (el.tagName || '').toLowerCase();
            if (!roles.includes(role) && !roles.includes(tag)) continue;
          }
          const txt = norm(el.innerText || el.textContent || '');
          const aria = norm(el.getAttribute ? el.getAttribute('aria-label') : '');
          const label = norm((el.querySelector && (el.querySelector('span,div')?.innerText || el.querySelector('span,div')?.textContent)) || '');
          const match = wanted.some(w => txt === w || aria === w || label === w || txt.includes(w) || aria.includes(w) || label.includes(w));
          if (!match) continue;
          const clickable = el.closest('button,[role="button"],[role="menuitem"]') || el;
          try { clickable.click(); return true; } catch {}
        }
        return false;
      }, { wanted, rootSelector, roles }).catch(() => false);
    };
    const waitAndClickByText = async (texts, timeoutMs = 8000, options = {}) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const ok = await clickByText(texts, options);
        if (ok) return true;
        await DOMHelpers.randomDelay(250, 450);
      }
      return false;
    };
    const ensureComposeReady = async () => {
      // Slow-connection patience: let the compose chrome render before probing.
      await DOMHelpers.randomDelay(3000, 5000);
      let toFound = await waitForAnySelector(config.selectors.toInput, 15000);
      if (toFound) return toFound;
      // Try explicit "New mail/message" controls (CSS + text)
      if (config.selectors.newMessageButton) {
        await tryClickAny(config.selectors.newMessageButton).catch(() => false);
        await DOMHelpers.randomDelay(3000, 5000);
        toFound = await waitForAnySelector(config.selectors.toInput, 15000);
        if (toFound) return toFound;
      }
      await waitAndClickByText(['New mail', 'New message'], 8000, { roles: ['button', 'role="button"'] }).catch(() => false);
      await DOMHelpers.randomDelay(1200, 2000);
      toFound = await waitForAnySelector(config.selectors.toInput, 7000);
      if (toFound) return toFound;
      // Outlook deeplink compose fallback
      if (providerName === 'outlook') {
        try {
          await page.goto('https://outlook.live.com/mail/0/deeplink/compose?popoutv2=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await DOMHelpers.randomDelay(8000, 12000);
          toFound = await waitForAnySelector(config.selectors.toInput, 20000);
          if (toFound) return toFound;
        } catch {}
      }
      return null;
    };
    const fillField = async (selectors, value, label) => {
      const found = await waitForAnySelector(selectors, 15000);
      if (!found) throw new Error(`${label} input not found (${providerName})`);
      const { selector } = found;
      await page.click(selector).catch(async () => {
        try { await page.evaluate((sel) => document.querySelector(sel)?.focus?.(), selector); } catch {}
      });
      await DOMHelpers.randomDelay(150, 350);
      // Clear any prefilled content for input/textarea/contenteditable
      try {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
          }
        }, selector);
      } catch {}
      try {
        await page.type(selector, String(value ?? ""), { delay: 20 });
      } catch {
        await page.evaluate((sel, text) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            el.focus?.();
            document.execCommand?.('insertText', false, text);
            if (!el.textContent) el.textContent = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, selector, String(value ?? ""));
      }
      await DOMHelpers.randomDelay(400, 900);
      return selector;
    };

    // Fill recipient (missing field = loud failure, never a silent skip)
    const ensuredTo = await ensureComposeReady();
    if (!ensuredTo) {
      let dbg = '';
      try { dbg = ` url=${await page.url()} title=${JSON.stringify(await page.title())}`; } catch {}
      throw new Error(`To input not found (${providerName})${dbg}`);
    }
    await fillField(config.selectors.toInput, recipient, "To");
    // Commit recipient chip in UIs like Outlook (Enter/Tab often required)
    try { await page.keyboard.press("Enter"); await DOMHelpers.randomDelay(200, 400); } catch {}

    // Fill subject
    await fillField(config.selectors.subjectInput, subject, "Subject");

    // Fill body
    await fillField(config.selectors.bodyInput, body, "Body");
    await DOMHelpers.randomDelay(config.waitAfterFill * 0.8, config.waitAfterFill * 1.2);
    logger.info(`[wireSender] Compose filled for ${recipient} (${providerName}) — clicking send.`);

    // Click send
    const sendSelector = config.selectors.sendButton;
    let sent = await DOMHelpers.clickElement(page, sendSelector).catch(() => false);
    if (!sent && providerName === 'outlook') {
      // Try text-based Send button (split button primary) if selector missed
      sent = await clickByText(['Send'], { roles: ['button'] }).catch(() => false);
    }
    if (!sent) {
      // Try keyboard shortcut (Ctrl+Enter for Gmail / common compose)
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");
    }

    // Wait for a positive send-completion signal instead of assuming success
    // after a short delay. Closing/navigating too early can trigger Outlook's
    // "Leave site? Changes you made may not be saved" prompt and race teardown.
    const completionDeadline = Date.now() + 25000;
    let sendVerified = false;
    let completionSignal = "timeout";
    while (Date.now() < completionDeadline) {
      try {
        const state = await page.evaluate((provider) => {
          const bodyCandidates = provider === "outlook"
            ? ['div[role="textbox"][aria-label="Message body"]', 'div[aria-label="Message body, press Alt+F10 to exit"][contenteditable="true"]', 'div.EditorClass[contenteditable="true"]', 'div[role="textbox"][contenteditable="true"]']
            : ['div[role="textbox"][aria-label*="Body"]', 'div[contenteditable="true"][role="textbox"]', 'div[role="textbox"]'];
          const sendCandidates = provider === "outlook"
            ? ['button[aria-label="Send"]', 'button[aria-label*="Send"]']
            : ['div[role="button"][aria-label*="Send"]', 'div[aria-label*="Send"]'];
          const subjectCandidates = provider === "outlook"
            ? ['input[aria-label="Subject"]', 'input[placeholder="Add a subject"]']
            : ['input[name="subjectbox"]', 'input[placeholder*="Subject"]', 'input[aria-label*="Subject"]'];
          const visible = (el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const bodyVisible = bodyCandidates.some((s) => visible(document.querySelector(s)));
          const sendVisible = sendCandidates.some((s) => visible(document.querySelector(s)));
          const subjectVisible = subjectCandidates.some((s) => visible(document.querySelector(s)));
          const sentToast = Array.from(document.querySelectorAll('[role="alert"], [aria-live], [data-testid], .ms-MessageBar, span, div'))
            .some((el) => {
              const t = String(el.textContent || "").trim().toLowerCase();
              return t === "message sent" || t.includes("message sent");
            });
          const inCompose = bodyVisible || (sendVisible && subjectVisible) || /compose|mailto|isCompose/i.test(String(location.href || ""));
          return { bodyVisible, sendVisible, subjectVisible, sentToast, inCompose };
        }, providerName);

        if (state.sentToast) { sendVerified = true; completionSignal = "sent-toast"; break; }
        if (!state.inCompose) { sendVerified = true; completionSignal = "compose-closed"; break; }
        if (!state.bodyVisible && !state.sendVisible) { sendVerified = true; completionSignal = "compose-elements-gone"; break; }
      } catch (e) {
        const msg = String(e && e.message || e);
        if (/Execution context was destroyed|Target closed|Session closed|Navigating/i.test(msg)) {
          sendVerified = true;
          completionSignal = "context-destroyed-after-send";
          break;
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!sendVerified) {
      logger.warn(`[wireSender] Send not verified for ${recipient} (${providerName}, signal=${completionSignal})`);
      throw new Error(`Send unverified (compose still open/ambiguous) for ${recipient} via ${providerName}`);
    }

    logger.info(`[wireSender] Send verified for ${recipient} (${providerName}, signal=${completionSignal})`);
    try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 5000 }); } catch {}
    await new Promise(r => setTimeout(r, 1500));

    // Increment counter only after verified send completion
    await incrementSendCount(platform, accountId);

    // Campaign hygiene: best-effort purge after verified send; never flips a
    // verified-sent result if purge/navigation fails or is aborted.
    try {
      try { await page.evaluate(() => { try { window.onbeforeunload = null; } catch {} }); } catch {}
      const purge = await deleteSentMessage(page, getPlatformConfig(providerName), subject, options.accountEmail || options.fromEmail || "", logger);
      logger.info(
        `[wireSender] post-send purge: ${purge.status}${purge.reason ? ` (${purge.reason})` : ""}${purge.trashPurged !== undefined ? ` trashPurged=${purge.trashPurged}` : ""}`
      );
    } catch (e) {
      logger.warn(`[wireSender] post-send purge failed (send still counted): ${e.message}`);
    }

    logger.info(`[wireSender] Email sent to ${recipient} via ${providerName}`);
    return { success: true, provider: providerName, recipient, verified: true, completionSignal };

  } finally {
    if (page) {
      try { await page.evaluate(() => { try { window.onbeforeunload = null; } catch {} }); } catch {}
      try { await new Promise(r => setTimeout(r, 800)); } catch {}
    }
    try { if (page) await page.close(); } catch (e) { logger.warn(`[wireSender] Error closing page: ${e.message}`); }
    try { if (browser) await browser.close(); } catch (e) { logger.warn(`[wireSender] Error closing browser: ${e.message}`); }
    if (profileDir) {
      const fs = await import('fs-extra');
      await fs.remove(profileDir).catch(() => {});
    }
  }
}

export async function scheduleViaBrowser(recipient, subject, body, cookieJSON, provider, scheduleTime, options = {}) {
  const providerName = provider || detectProvider(recipient);
  const config = PROVIDER_CONFIGS[providerName];
  if (!config) {
    throw new Error(`Unsupported email provider: ${providerName}. Supported: ${Object.keys(PROVIDER_CONFIGS).join(", ")}`);
  }

  // Keyed by sending account (wire profile) — see sendViaBrowser.
  const platform = detectEmailProvider(providerName);
  const accountId = options.profileId || options.browserId || recipient || "unknown";

  const rateCheck = await checkSendAllowed(platform, accountId);
  if (!rateCheck.allowed) {
    logger.warn(`[wireSender] Rate limited for ${accountId} (${platform}): ${rateCheck.reason}`);
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  logger.info(`[wireSender] Scheduling via ${providerName} to ${recipient} at ${scheduleTime}`);

  const profile = {
    cookies: cookieJSON,
    browserIdentity: options.browserIdentity || null,
    driveUrl: options.driveUrl || "",
    profileId: options.profileId || accountId,
    platform,
  };
  let browser, page, profileDir;
  try {
    ({ browser, page, profileDir } = await resolveSocialSession(profile, false));
    logger.info(`[wireSender] Session resolved for ${accountId} (${providerName}) — opening compose for schedule.`);
  } catch (sessErr) {
    logger.error(`[wireSender] Session resolution FAILED for ${accountId}: ${sessErr.message}`);
    throw sessErr;
  }

  try {
    page.on("dialog", async (dialog) => {
      try {
        const type = dialog.type();
        if (type === "beforeunload") await dialog.accept();
        else await dialog.dismiss().catch(() => dialog.accept().catch(() => {}));
      } catch {}
    });
    try {
      await page.evaluateOnNewDocument(() => {
        try {
          window.addEventListener("beforeunload", (e) => { try { delete e.returnValue; } catch {} }, { capture: true });
          Object.defineProperty(window, "onbeforeunload", { configurable: true, get() { return null; }, set() {} });
        } catch {}
      });
    } catch {}

    // Step 1: Navigate to compose
    await page.goto(config.composeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    try { await page.evaluate(() => { try { window.onbeforeunload = null; } catch {} }); } catch {}
    await DOMHelpers.randomDelay(config.waitAfterNavigate * 0.8, config.waitAfterNavigate * 1.2);

    const splitSelectors = (sel) => String(sel || "").split(",").map(s => s.trim()).filter(Boolean);
    const waitForAnySelector = async (selectors, timeoutMs = 15000) => {
      const list = splitSelectors(selectors);
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        for (const sel of list) {
          try {
            const el = await page.$(sel);
            if (el) {
              const visible = await page.evaluate((node) => {
                if (!node) return false;
                const r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
                const style = window.getComputedStyle ? window.getComputedStyle(node) : null;
                return !!(r && r.width > 0 && r.height > 0 && (!style || (style.visibility !== 'hidden' && style.display !== 'none')));
              }, el).catch(() => true);
              if (visible) return { el, selector: sel };
            }
          } catch {}
        }
        await DOMHelpers.randomDelay(250, 450);
      }
      return null;
    };
    const tryClickAny = async (selectors) => {
      const found = await waitForAnySelector(selectors, 3000);
      if (!found) return false;
      try { await page.click(found.selector); return true; } catch { return false; }
    };
    const clickByText = async (texts, options = {}) => {
      const wanted = (Array.isArray(texts) ? texts : [texts]).map(t => String(t || '').trim().toLowerCase()).filter(Boolean);
      if (!wanted.length) return false;
      const rootSelector = options.rootSelector || null;
      const roles = options.roles || null;
      return await page.evaluate(({ wanted, rootSelector, roles }) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
          return !!(r && r.width > 0 && r.height > 0 && (!st || (st.visibility !== 'hidden' && st.display !== 'none')));
        };
        const root = rootSelector ? document.querySelector(rootSelector) : document;
        if (!root) return false;
        const candidates = Array.from(root.querySelectorAll('button, [role="button"], [role="menuitem"], div, span, input'));
        for (const el of candidates) {
          if (!isVisible(el)) continue;
          if (roles && roles.length) {
            const role = el.getAttribute && el.getAttribute('role');
            const tag = (el.tagName || '').toLowerCase();
            if (!roles.includes(role) && !roles.includes(tag)) continue;
          }
          const txt = norm(el.innerText || el.textContent || el.value || '');
          const aria = norm(el.getAttribute ? el.getAttribute('aria-label') : '');
          const label = norm((el.querySelector && (el.querySelector('span,div')?.innerText || el.querySelector('span,div')?.textContent)) || '');
          const match = wanted.some(w => txt === w || aria === w || label === w || txt.includes(w) || aria.includes(w) || label.includes(w));
          if (!match) continue;
          const clickable = el.closest('button,[role="button"],[role="menuitem"]') || el;
          try { clickable.click(); return true; } catch {}
        }
        return false;
      }, { wanted, rootSelector, roles }).catch(() => false);
    };
    const waitAndClickByText = async (texts, timeoutMs = 8000, options = {}) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const ok = await clickByText(texts, options);
        if (ok) return true;
        await DOMHelpers.randomDelay(250, 450);
      }
      return false;
    };
    const ensureComposeReady = async () => {
      // Slow-connection patience: let the compose chrome render before probing.
      await DOMHelpers.randomDelay(3000, 5000);
      let toFound = await waitForAnySelector(config.selectors.toInput, 15000);
      if (toFound) return toFound;
      if (config.selectors.newMessageButton) {
        await tryClickAny(config.selectors.newMessageButton).catch(() => false);
        await DOMHelpers.randomDelay(3000, 5000);
        toFound = await waitForAnySelector(config.selectors.toInput, 15000);
        if (toFound) return toFound;
      }
      await waitAndClickByText(['New mail', 'New message'], 8000, { roles: ['button'] }).catch(() => false);
      await DOMHelpers.randomDelay(1200, 2000);
      toFound = await waitForAnySelector(config.selectors.toInput, 7000);
      if (toFound) return toFound;
      if (providerName === 'outlook') {
        try {
          await page.goto('https://outlook.live.com/mail/0/deeplink/compose?popoutv2=1', { waitUntil: 'domcontentloaded', timeout: 30000 });
          await DOMHelpers.randomDelay(8000, 12000);
          toFound = await waitForAnySelector(config.selectors.toInput, 20000);
          if (toFound) return toFound;
        } catch {}
      }
      return null;
    };
    const setInputLikeValue = async (selector, value) => {
      const found = await waitForAnySelector(selector, 10000);
      if (!found) throw new Error(`Input not found: ${selector}`);
      const sel = found.selector;
      await page.click(sel).catch(() => {});
      await DOMHelpers.randomDelay(120, 250);
      try {
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (!el) return;
          el.focus?.();
          if ('value' in el) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, sel);
      } catch {}
      try {
        await page.evaluate((s) => {
          const el = document.querySelector(s);
          if (el && el.select) el.select();
        }, sel);
      } catch {}
      await page.keyboard.down('Control').catch(() => {});
      await page.keyboard.press('A').catch(() => {});
      await page.keyboard.up('Control').catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      try {
        await page.type(sel, String(value ?? ''), { delay: 25 });
      } catch {
        await page.evaluate((s, v) => {
          const el = document.querySelector(s);
          if (!el) return;
          if ('value' in el) {
            el.value = v;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, sel, String(value ?? ''));
      }
      await DOMHelpers.randomDelay(250, 500);
      return sel;
    };
    const fillField = async (selectors, value, label) => {
      const found = await waitForAnySelector(selectors, 15000);
      if (!found) throw new Error(`${label} input not found`);
      const { selector } = found;
      await page.click(selector).catch(async () => {
        try { await page.evaluate((sel) => document.querySelector(sel)?.focus?.(), selector); } catch {}
      });
      await DOMHelpers.randomDelay(150, 350);
      try {
        await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (el.isContentEditable) {
            el.textContent = '';
          }
        }, selector);
      } catch {}
      try {
        await page.type(selector, String(value ?? ""), { delay: 20 });
      } catch {
        await page.evaluate((sel, text) => {
          const el = document.querySelector(sel);
          if (!el) return;
          if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
            el.value = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            el.focus?.();
            document.execCommand?.('insertText', false, text);
            if (!el.textContent) el.textContent = text;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, selector, String(value ?? ""));
      }
      await DOMHelpers.randomDelay(400, 900);
      return selector;
    };

    // Step 2: Fill recipient
    const ensuredTo = await ensureComposeReady();
    if (!ensuredTo) {
      let dbg = '';
      try { dbg = ` url=${await page.url()} title=${JSON.stringify(await page.title())}`; } catch {}
      throw new Error(`To input not found (${providerName})${dbg}`);
    }
    await fillField(config.selectors.toInput, recipient, "To");
    try { await page.keyboard.press("Enter"); await DOMHelpers.randomDelay(200, 400); } catch {}

    // Step 3: Fill subject
    await fillField(config.selectors.subjectInput, subject, "Subject");

    // Step 4: Fill body
    await fillField(config.selectors.bodyInput, body, "Body");
    logger.info(`[wireSender] Compose filled for ${recipient} (${providerName}) — opening schedule picker.`);

    // Step 5: Open schedule UI
    let dropdownClicked = await DOMHelpers.clickElement(page, config.selectors.scheduleDropdownArrow, { timeout: 5000 }).catch(() => false);
    if (!dropdownClicked && providerName === 'outlook') {
      // Fallback: click a button near/with "More send options" text/icon via evaluate
      dropdownClicked = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          const st = window.getComputedStyle ? window.getComputedStyle(el) : null;
          return !!(r && r.width > 0 && r.height > 0 && (!st || (st.visibility !== 'hidden' && st.display !== 'none')));
        };
        const sendBtn = document.querySelector('button[aria-label="Send"]');
        const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
        const byLabel = candidates.find(el => /more send options/i.test(el.getAttribute('aria-label') || ''));
        const nearSend = sendBtn ? candidates.find(el => el !== sendBtn && sendBtn.parentElement && sendBtn.parentElement.contains(el) && el.querySelector('i')) : null;
        const target = byLabel || nearSend;
        if (!target) return false;
        try { target.click(); return true; } catch { return false; }
      }).catch(() => false);
    }
    if (!dropdownClicked) {
      await page.keyboard.press("Escape").catch(() => {});
      await DOMHelpers.randomDelay(400, 800);
      await DOMHelpers.clickElement(page, config.selectors.scheduleDropdownArrow, { timeout: 3000 }).catch(() => false);
    }
    await DOMHelpers.randomDelay(500, 1000);

    let optionClicked = await DOMHelpers.clickElement(page, config.selectors.scheduleSendOption, { timeout: 3000 }).catch(() => false);
    if (!optionClicked) {
      optionClicked = await waitAndClickByText(['Schedule send', 'Send later'], 6000, { roles: ['menuitem', 'button'] });
    }
    if (!optionClicked) {
      throw new Error("Schedule send option not found");
    }
    await DOMHelpers.randomDelay(800, 1500);

    // Step 6: Custom time (Outlook flow) / modal
    if (providerName === 'outlook') {
      await waitAndClickByText(['Custom time'], 5000, { roles: ['button'] }).catch(() => false);
      await DOMHelpers.randomDelay(700, 1200);
    } else {
      try {
        await DOMHelpers.waitForSelector(page, config.selectors.scheduleModal, { timeout: 5000, visible: true });
      } catch {}
    }

    // Step 7: Set date and time
    const scheduleDate = new Date(scheduleTime);
    if (isNaN(scheduleDate.getTime())) throw new Error(`Invalid scheduleTime: ${scheduleTime}`);
    const dateStrIso = `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, "0")}-${String(scheduleDate.getDate()).padStart(2, "0")}`;
    const dateStrUs = `${String(scheduleDate.getMonth() + 1).padStart(2, "0")}/${String(scheduleDate.getDate()).padStart(2, "0")}/${scheduleDate.getFullYear()}`;
    const hours24 = String(scheduleDate.getHours()).padStart(2, "0");
    const mins = String(scheduleDate.getMinutes()).padStart(2, "0");
    const timeStr24 = `${hours24}:${mins}`;
    const h12 = scheduleDate.getHours() % 12 || 12;
    const ampm = scheduleDate.getHours() >= 12 ? 'PM' : 'AM';
    const timeStr12 = `${h12}:${mins} ${ampm}`;

    if (providerName === 'outlook') {
      // Outlook custom time: date combobox + TimePicker combobox (as per UI snippets)
      await setInputLikeValue(config.selectors.scheduleDatePicker || "input[id^='datePicker-input']", dateStrUs).catch(async () => {
        await setInputLikeValue("input[id^='datePicker-input'], input[aria-label*='Date']", dateStrIso);
      });
      await page.keyboard.press('Enter').catch(() => {});
      await DOMHelpers.randomDelay(300, 600);
      await setInputLikeValue(config.selectors.scheduleTimePicker || 'input.fui-TimePicker__input', timeStr12).catch(async () => {
        await setInputLikeValue('input.fui-TimePicker__input, input[role="combobox"][autocomplete="off"]', timeStr24);
      });
      await page.keyboard.press('Enter').catch(() => {});
      await DOMHelpers.randomDelay(500, 900);
    } else {
      const dateFound = await waitForAnySelector(config.selectors.scheduleDatePicker, 5000);
      if (dateFound) await setInputLikeValue(config.selectors.scheduleDatePicker, dateStrIso).catch(() => {});
      const timeFound = await waitForAnySelector(config.selectors.scheduleTimePicker, 5000);
      if (timeFound) await setInputLikeValue(config.selectors.scheduleTimePicker, timeStr24).catch(() => {});
    }

    // Step 8: Confirm schedule
    let confirmed = false;
    if (providerName === 'outlook') {
      // In custom-time dialog, primary action is often "Send" (scheduled)
      confirmed = await waitAndClickByText(['Send', 'Schedule send', 'Schedule'], 6000, { roles: ['button'] });
      if (!confirmed) confirmed = await DOMHelpers.clickElement(page, config.selectors.scheduleConfirmBtn, { timeout: 3000 }).catch(() => false);
    } else {
      confirmed = await DOMHelpers.clickElement(page, config.selectors.scheduleConfirmBtn, { timeout: 5000 }).catch(() => false);
      if (!confirmed) confirmed = await waitAndClickByText(['Schedule send', 'Schedule', 'Send'], 4000, { roles: ['button'] });
    }
    if (!confirmed) {
      await page.keyboard.press("Enter").catch(() => {});
    }

    await DOMHelpers.randomDelay(2000, 3000);

    await incrementSendCount(platform, accountId);

    logger.info(`[wireSender] Email scheduled for ${recipient} at ${scheduleTime} via ${providerName}`);
    return { success: true, provider: providerName, recipient, scheduledFor: scheduleTime };

  } finally {
    if (page) {
      try { await page.evaluate(() => { try { window.onbeforeunload = null; } catch {} }); } catch {}
      try { await new Promise(r => setTimeout(r, 800)); } catch {}
    }
    try { if (page) await page.close(); } catch (e) { logger.warn(`[wireSender] Error closing page: ${e.message}`); }
    try { if (browser) await browser.close(); } catch (e) { logger.warn(`[wireSender] Error closing browser: ${e.message}`); }
    if (profileDir) {
      const fs = await import('fs-extra');
      await fs.remove(profileDir).catch(() => {});
    }
  }
}

export { detectProvider, PROVIDER_CONFIGS };
