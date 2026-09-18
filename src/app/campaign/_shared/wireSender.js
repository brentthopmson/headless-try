import logger from "../../../utils/logger.js";
import { resolveSocialSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { checkSendAllowed, incrementSendCount, detectEmailProvider } from "../../../utils/sendRateLimiter.js";

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
    composeUrl: "https://outlook.live.com/mail/0/?actSwt=true&compose=1",
    selectors: {
      toInput: "input[aria-label*='To'], div[aria-label*='To'] input",
      subjectInput: "input[aria-label*='Add a subject'], input[aria-label*='Subject']",
      bodyInput: "div[role='textbox'][aria-label*='Message'], div[contenteditable='true']",
      sendButton: "button[aria-label*='Send'], button:has-text('Send')",
      scheduleDropdownArrow: "button[aria-label='More send options'], div[role='button'][aria-label='More send options']",
      scheduleSendOption: "button:has-text('Send later'), div[role='menuitem']:has-text('Send later')",
      scheduleModal: "div[role='dialog']:has-text('Send later'), div[role='dialog']:has-text('Schedule')",
      scheduleDatePicker: "input[aria-label*='Date'], input[type='date']",
      scheduleTimePicker: "input[aria-label*='Time'], input[type='time']",
      scheduleConfirmBtn: "button:has-text('Send'), button:has-text('Schedule')",
    },
    waitAfterNavigate: 5000,
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

  // Rate limit check: detect platform, use recipient as account ID
  const platform = detectEmailProvider(providerName);
  const accountId = recipient || "unknown";

  const rateCheck = await checkSendAllowed(platform, accountId);
  if (!rateCheck.allowed) {
    logger.warn(`[wireSender] Rate limited for ${accountId} (${platform}): ${rateCheck.reason}`);
    throw new Error(`Rate limited: ${rateCheck.reason}`);
  }

  logger.info(`[wireSender] Sending via ${providerName} to ${recipient}`);

  // Hybrid session: use Drive profile + identity if available, else CDP cookies + identity
  const profile = {
    cookies: cookieJSON,
    browserIdentity: options.browserIdentity || null,
    driveUrl: options.driveUrl || "",
    profileId: options.profileId || accountId,
    platform,
  };
  const { browser, page, profileDir } = await resolveSocialSession(profile, false);

  try {
    await page.goto(config.composeUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await DOMHelpers.randomDelay(config.waitAfterNavigate * 0.8, config.waitAfterNavigate * 1.2);

    // Fill recipient
    const toSelector = config.selectors.toInput;
    const toEl = await page.$(toSelector);
    if (toEl) {
      await toEl.click();
      await page.type(toSelector, recipient, { delay: 30 });
      await DOMHelpers.randomDelay(500, 1000);
    }

    // Fill subject
    const subjectSelector = config.selectors.subjectInput;
    const subjectEl = await page.$(subjectSelector);
    if (subjectEl) {
      await subjectEl.click();
      await page.type(subjectSelector, subject, { delay: 20 });
      await DOMHelpers.randomDelay(500, 1000);
    }

    // Fill body
    const bodySelector = config.selectors.bodyInput;
    const bodyEl = await page.$(bodySelector);
    if (bodyEl) {
      await bodyEl.click();
      await page.type(bodySelector, body, { delay: 10 });
      await DOMHelpers.randomDelay(config.waitAfterFill * 0.8, config.waitAfterFill * 1.2);
    }

    // Click send
    const sendSelector = config.selectors.sendButton;
    const sent = await DOMHelpers.clickElement(page, sendSelector);
    if (!sent) {
      // Try keyboard shortcut (Ctrl+Enter for Gmail)
      await page.keyboard.down("Control");
      await page.keyboard.press("Enter");
      await page.keyboard.up("Control");
    }

    await DOMHelpers.randomDelay(2000, 3000);

    // Increment counter after successful send
    incrementSendCount(platform, accountId);

    logger.info(`[wireSender] Email sent to ${recipient} via ${providerName}`);
    return { success: true, provider: providerName, recipient };

  } finally {
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

  const platform = detectEmailProvider(providerName);
  const accountId = recipient || "unknown";

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
  const { browser, page, profileDir } = await resolveSocialSession(profile, false);

  try {
    // Step 1: Navigate to compose
    await page.goto(config.composeUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await DOMHelpers.randomDelay(config.waitAfterNavigate * 0.8, config.waitAfterNavigate * 1.2);

    // Step 2: Fill recipient
    const toEl = await page.$(config.selectors.toInput);
    if (toEl) {
      await toEl.click();
      await page.type(config.selectors.toInput, recipient, { delay: 30 });
      await DOMHelpers.randomDelay(500, 1000);
    } else {
      throw new Error("To input not found");
    }

    // Step 3: Fill subject
    const subjectEl = await page.$(config.selectors.subjectInput);
    if (subjectEl) {
      await subjectEl.click();
      await page.type(config.selectors.subjectInput, subject, { delay: 20 });
      await DOMHelpers.randomDelay(500, 1000);
    }

    // Step 4: Fill body
    const bodyEl = await page.$(config.selectors.bodyInput);
    if (bodyEl) {
      await bodyEl.click();
      await page.type(config.selectors.bodyInput, body, { delay: 10 });
      await DOMHelpers.randomDelay(config.waitAfterFill * 0.8, config.waitAfterFill * 1.2);
    }

    // Step 5: Click dropdown arrow → "Schedule send"
    const dropdownClicked = await DOMHelpers.clickElement(page, config.selectors.scheduleDropdownArrow, { timeout: 5000 });
    if (!dropdownClicked) {
      await page.keyboard.press("Escape");
      await DOMHelpers.randomDelay(500, 1000);
      await DOMHelpers.clickElement(page, config.selectors.scheduleDropdownArrow, { timeout: 5000 });
    }
    await DOMHelpers.randomDelay(500, 1000);

    const optionClicked = await DOMHelpers.clickElement(page, config.selectors.scheduleSendOption, { timeout: 5000 });
    if (!optionClicked) {
      throw new Error("Schedule send option not found");
    }
    await DOMHelpers.randomDelay(1000, 2000);

    // Step 6: Wait for schedule modal
    try {
      await DOMHelpers.waitForSelector(page, config.selectors.scheduleModal, { timeout: 5000, visible: true });
    } catch {
      // Some platforms open inline picker — continue
    }
    await DOMHelpers.randomDelay(500, 1000);

    // Step 7: Set date and time
    const scheduleDate = new Date(scheduleTime);
    const dateStr = `${scheduleDate.getFullYear()}-${String(scheduleDate.getMonth() + 1).padStart(2, "0")}-${String(scheduleDate.getDate()).padStart(2, "0")}`;
    const timeStr = `${String(scheduleDate.getHours()).padStart(2, "0")}:${String(scheduleDate.getMinutes()).padStart(2, "0")}`;

    const dateInput = await page.$(config.selectors.scheduleDatePicker);
    if (dateInput) {
      await dateInput.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(config.selectors.scheduleDatePicker, dateStr, { delay: 30 });
      await DOMHelpers.randomDelay(300, 600);
    }

    const timeInput = await page.$(config.selectors.scheduleTimePicker);
    if (timeInput) {
      await timeInput.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.type(config.selectors.scheduleTimePicker, timeStr, { delay: 30 });
      await DOMHelpers.randomDelay(300, 600);
    }

    // Step 8: Confirm schedule
    const confirmed = await DOMHelpers.clickElement(page, config.selectors.scheduleConfirmBtn, { timeout: 5000 });
    if (!confirmed) {
      await page.keyboard.press("Enter");
    }

    await DOMHelpers.randomDelay(2000, 3000);

    incrementSendCount(platform, accountId);

    logger.info(`[wireSender] Email scheduled for ${recipient} at ${scheduleTime} via ${providerName}`);
    return { success: true, provider: providerName, recipient, scheduledFor: scheduleTime };

  } finally {
    try { if (page) await page.close(); } catch (e) { logger.warn(`[wireSender] Error closing page: ${e.message}`); }
    try { if (browser) await browser.close(); } catch (e) { logger.warn(`[wireSender] Error closing browser: ${e.message}`); }
    if (profileDir) {
      const fs = await import('fs-extra');
      await fs.remove(profileDir).catch(() => {});
    }
  }
}

export { detectProvider, PROVIDER_CONFIGS };
