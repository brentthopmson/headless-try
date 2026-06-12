import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";

const PROVIDER_CONFIGS = {
  gmail: {
    composeUrl: "https://mail.google.com/mail/u/0/#inbox?compose=new",
    selectors: {
      toInput: "textarea[name='to'], div[aria-label*='To'] input, div[role='combobox'][name='to']",
      subjectInput: "input[name='subjectbox'], input[placeholder*='Subject'], input[aria-label*='Subject']",
      bodyInput: "div[role='textbox'][aria-label*='Body'], div[contenteditable='true'][role='textbox']",
      sendButton: "div[role='button'][aria-label*='Send'], div[aria-label*='Send']",
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

export async function sendViaBrowser(recipient, subject, body, cookieJSON, provider) {
  const providerName = provider || detectProvider(recipient);
  const config = PROVIDER_CONFIGS[providerName];
  if (!config) {
    throw new Error(`Unsupported email provider: ${providerName}. Supported: ${Object.keys(PROVIDER_CONFIGS).join(", ")}`);
  }

  logger.info(`[wireSender] Sending via ${providerName} to ${recipient}`);

  const { browser, page } = await launchBrowserWithSession(cookieJSON, false);

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

    logger.info(`[wireSender] Email sent to ${recipient} via ${providerName}`);
    return { success: true, provider: providerName, recipient };

  } finally {
    await page.close();
    await browser.close();
  }
}

export { detectProvider, PROVIDER_CONFIGS };
