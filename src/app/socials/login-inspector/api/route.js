import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import logger from "../../../../utils/logger.js";
import { isDev, localExecutablePath, remoteExecutablePath } from "../../../../utils/utils.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

// Store active browser sessions by sessionId
const activeSessions = new Map();

// ==================== PLATFORM LOGIN URL MAP ====================
const PLATFORM_URLS = {
  twitter: "https://x.com/login",
  x: "https://x.com/login",
  tiktok: "https://www.tiktok.com/login",
  instagram: "https://www.instagram.com/accounts/login/",
  facebook: "https://www.facebook.com/login",
  messenger: "https://www.messenger.com/login",
  linkedin: "https://www.linkedin.com/login",
  youtube: "https://accounts.google.com/ServiceLogin?service=youtube",
  gmail: "https://accounts.google.com/ServiceLogin?service=mail",
  outlook: "https://login.live.com/",
  hotmail: "https://login.live.com/",
  yahoo: "https://login.yahoo.com/",
  aol: "https://login.aol.com/",
  protonmail: "https://mail.proton.me/login",
  quora: "https://www.quora.com/login",
  reddit: "https://www.reddit.com/login/",
  pinterest: "https://www.pinterest.com/login/",
  discord: "https://discord.com/login",
  telegram: "https://web.telegram.org/",
  whatsapp: "https://web.whatsapp.com/",
  snapchat: "https://accounts.snapchat.com/accounts/login",
  spotify: "https://accounts.spotify.com/en/login",
  twitch: "https://www.twitch.tv/login",
  netflix: "https://www.netflix.com/login",
  amazon: "https://www.amazon.com/ap/signin",
  apple: "https://appleid.apple.com/sign-in",
  microsoft: "https://login.live.com/",
  google: "https://accounts.google.com/ServiceLogin",
  github: "https://github.com/login",
  ok: "https://ok.ru/login",
  vk: "https://vk.com/login",
  signup: null, // Will prompt for custom URL
  custom: null, // Will prompt for custom URL
};

// ==================== SET CORS ====================
const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};

// ==================== LAUNCH BROWSER ====================
async function launchInspectorBrowser(sessionId) {
  if (activeSessions.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing.browser && existing.browser.isConnected()) {
      logger.info(`[login-inspector] Reusing existing browser session: ${sessionId}`);
      return existing;
    }
    // Clean up stale session
    activeSessions.delete(sessionId);
  }

  logger.info(`[login-inspector] Launching new browser for session: ${sessionId}`);

  const browser = await puppeteer.launch({
    ignoreDefaultArgs: ["--enable-automation"],
    args: isDev
      ? [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=site-per-process",
          "-disable-site-isolation-trials",
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--window-size=1366,768",
        ]
      : [
          ...chromium.args,
          "--disable-blink-features=AutomationControlled",
          "--window-size=1366,768",
        ],
    executablePath: isDev
      ? localExecutablePath
      : await chromium.executablePath(remoteExecutablePath),
    headless: false,
    defaultViewport: null,
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  );

  // Enable request interception for logging
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Track navigation for URL history
  let navigationHistory = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      navigationHistory.push({
        url: frame.url(),
        timestamp: new Date().toISOString()
      });
      if (navigationHistory.length > 50) navigationHistory.shift();
    }
  });

  const session = { browser, page, navigationHistory };
  activeSessions.set(sessionId, session);

  // Auto-cleanup on browser close
  browser.on('disconnected', () => {
    logger.info(`[login-inspector] Browser disconnected for session: ${sessionId}`);
    activeSessions.delete(sessionId);
  });

  return session;
}

// ==================== INSPECT CURRENT PAGE ====================
async function inspectPage(page) {
  const inspection = await page.evaluate(() => {
    const results = {
      url: window.location.href,
      title: document.title,
      inputs: [],
      buttons: [],
      links: [],
      headings: [],
      labels: [],
      forms: [],
      errorMessages: [],
      verificationElements: [],
      cookieBanners: [],
      securityElements: [],
      allSelectable: [],
      html: document.documentElement.outerHTML.slice(0, 50000), // First 50k chars
    };

    // Collect all input fields with detailed attributes
    document.querySelectorAll('input, textarea, select').forEach(el => {
      const tag = el.tagName.toLowerCase();
      const inputInfo = {
        tag,
        type: el.type || '',
        name: el.name || '',
        id: el.id || '',
        className: el.className || '',
        placeholder: el.placeholder || '',
        'aria-label': el.getAttribute('aria-label') || '',
        autocomplete: el.autocomplete || '',
        'data-testid': el.getAttribute('data-testid') || '',
        'data-e2e': el.getAttribute('data-e2e') || '',
        role: el.getAttribute('role') || '',
        required: el.required || false,
        visible: el.offsetParent !== null,
        value: el.value ? '(has value)' : '(empty)',
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        })(),
        parentText: el.closest('div, form, fieldset')?.querySelector('label, span, div:not(:has(*))')?.textContent?.trim() || '',
      };
      results.inputs.push(inputInfo);

      // Build CSS selector candidates
      const selectors = [];
      if (el.id) selectors.push(`#${el.id}`);
      if (el.name) selectors.push(`${tag}[name="${el.name}"]`);
      if (el.placeholder) selectors.push(`${tag}[placeholder="${el.placeholder}"]`);
      if (el.autocomplete) selectors.push(`${tag}[autocomplete="${el.autocomplete}"]`);
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) selectors.push(`${tag}[aria-label="${ariaLabel}"]`);
      const testId = el.getAttribute('data-testid');
      if (testId) selectors.push(`${tag}[data-testid="${testId}"]`);
      const e2e = el.getAttribute('data-e2e');
      if (e2e) selectors.push(`${tag}[data-e2e="${e2e}"]`);

      results.allSelectable.push({
        purpose: inputInfo.placeholder || ariaLabel || el.name || el.id || 'input',
        cssSelectors: selectors,
        uniqueSelector: el.id
          ? `#${el.id}`
          : el.name
            ? `${tag}[name="${el.name}"]`
            : `${tag}:nth-of-type(${[...document.querySelectorAll(tag)].indexOf(el) + 1})`,
      });
    });

    // Collect buttons
    document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]').forEach(el => {
      const text = el.textContent?.trim() || el.getAttribute('aria-label') || el.value || '';
      if (!text) return;
      const info = {
        text: text.slice(0, 100),
        tag: el.tagName.toLowerCase(),
        type: el.type || '',
        id: el.id || '',
        className: el.className || '',
        'aria-label': el.getAttribute('aria-label') || '',
        'data-testid': el.getAttribute('data-testid') || '',
        'data-e2e': el.getAttribute('data-e2e') || '',
        role: el.getAttribute('role') || '',
        visible: el.offsetParent !== null,
        rect: (() => {
          const r = el.getBoundingClientRect();
          return `(${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.w)}x${Math.round(r.h)}`;
        })(),
      };
      results.buttons.push(info);

      // Build CSS selector for button
      const selectors = [];
      if (el.id) selectors.push(`#${el.id}`);
      if (text.length < 50) {
        selectors.push(`button::-p-text("${text.replace(/"/g, '\\"')}")`);
      }
      const testId = el.getAttribute('data-testid');
      if (testId) selectors.push(`[data-testid="${testId}"]`);
      const e2e = el.getAttribute('data-e2e');
      if (e2e) selectors.push(`[data-e2e="${e2e}"]`);

      results.allSelectable.push({
        purpose: `button: ${text.slice(0, 40)}`,
        cssSelectors: selectors,
        uniqueSelector: el.id ? `#${el.id}` : `button:nth-of-type(${[...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]')].indexOf(el) + 1})`,
      });
    });

    // Collect headings (h1-h3, role="heading")
    document.querySelectorAll('h1, h2, h3, [role="heading"]').forEach(el => {
      const text = el.textContent?.trim();
      if (text) {
        results.headings.push({
          tag: el.tagName.toLowerCase(),
          text: text.slice(0, 200),
          visible: el.offsetParent !== null,
        });
      }
    });

    // Collect labels
    document.querySelectorAll('label').forEach(el => {
      const text = el.textContent?.trim();
      if (text) {
        results.labels.push({
          text: text.slice(0, 200),
          htmlFor: el.htmlFor || '',
          visible: el.offsetParent !== null,
        });
      }
    });

    // Collect forms
    document.querySelectorAll('form').forEach((el, idx) => {
      results.forms.push({
        index: idx,
        id: el.id || '',
        action: el.action || '',
        method: el.method || '',
        fields: [...el.querySelectorAll('input, select, textarea')].map(i => i.name || i.id || '').filter(Boolean),
      });
    });

    // Detect error messages
    const errorKeywords = ['error', 'incorrect', 'wrong', 'invalid', 'not found', 'does not exist',
      'doesn\'t exist', 'try again', 'failed', 'unable to', 'problem', 'sorry', 'blocked', 'locked',
      'suspended', 'disabled', 'not recognized', 'mismatch', 'alert', 'warning', 'incorrect'];

    document.querySelectorAll('[class*="error"], [class*="alert"], [class*="warning"], [role="alert"], ' +
      '[class*="message"], [class*="notification"], [class*="feedback"], p, span, div:not(:has(*))').forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length > 5 && text.length < 300) {
        const lower = text.toLowerCase();
        if (errorKeywords.some(k => lower.includes(k))) {
          results.errorMessages.push({
            text: text.slice(0, 300),
            selector: el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : '',
            visible: el.offsetParent !== null,
          });
        }
      }
    });

    // Detect verification/2FA elements
    document.querySelectorAll('input[type="text"], input[type="tel"], input:not([type])').forEach(el => {
      const placeholder = (el.placeholder || '').toLowerCase();
      const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
      const parentText = (el.closest('div, form')?.textContent || '').toLowerCase();

      if (placeholder.includes('code') || placeholder.includes('otp') || placeholder.includes('verif') ||
        placeholder.includes('authenticator') || placeholder.includes('2fa') || placeholder.includes('2-step') ||
        placeholder.includes('sms') || placeholder.includes('token') || placeholder.includes('pin') ||
        ariaLabel.includes('code') || ariaLabel.includes('verif') || ariaLabel.includes('otp') ||
        parentText.includes('verification code') || parentText.includes('authenticator code') ||
        parentText.includes('security code') || parentText.includes('2-step verification')) {
        results.verificationElements.push({
          type: 'code_input',
          placeholder: el.placeholder || '',
          'aria-label': el.getAttribute('aria-label') || '',
          id: el.id || '',
          name: el.name || '',
          autocomplete: el.autocomplete || '',
          maxLength: el.maxLength || '',
          parentText: parentText.slice(0, 200),
        });
      }
    });

    // Detect "choose verification method" screens
    document.querySelectorAll('button, a[role="button"], [role="button"]').forEach(el => {
      const text = el.textContent?.trim().toLowerCase() || '';
      const verificationMethods = ['text me', 'email me', 'phone', 'sms', 'call', 'authenticator app',
        'approve from', 'push notification', 'security key', 'backup code', 'recovery code',
        'other way', 'try another', 'different method', 'get a code', 'send code'];

      if (verificationMethods.some(m => text.includes(m))) {
        results.verificationElements.push({
          type: 'choice_option',
          text: el.textContent?.trim().slice(0, 100) || '',
          selector: el.id ? `#${el.id}` : '',
        });
      }
    });

    // Detect cookie consent banners
    const cookieKeywords = ['cookie', 'consent', 'privacy', 'gdpr', 'accept all', 'reject', 'manage cookies',
      'cookie policy', 'allow cookies', 'necessary cookies'];
    document.querySelectorAll('[class*="cookie"], [class*="consent"], [class*="privacy"], ' +
      '[id*="cookie"], [id*="consent"], div[aria-label*="cookie"], div[role="dialog"]').forEach(el => {
      const text = el.textContent?.toLowerCase() || '';
      if (cookieKeywords.some(k => text.includes(k))) {
        const buttons = el.querySelectorAll('button, a[role="button"]');
        results.cookieBanners.push({
          text: text.slice(0, 200),
          buttons: [...buttons].map(b => b.textContent?.trim()).filter(Boolean),
        });
      }
    });

    return results;
  });

  return inspection;
}

// ==================== GENERATE PLATFORM CONFIG ====================
function generatePlatformConfig(platform, inspection) {
  const config = {
    platform,
    url: inspection.url || PLATFORM_URLS[platform] || '',
    selectors: {},
    additionalViews: [],
    verificationScreens: [],
    inboxUrlPatterns: [],
    flow: [],
  };

  // --- Determine selectors ---
  // Find the most likely email/username input
  const emailInputs = inspection.inputs.filter(i =>
    i.autocomplete === 'username' || i.autocomplete === 'email' ||
    (i.placeholder || '').toLowerCase().includes('email') ||
    (i.placeholder || '').toLowerCase().includes('username') ||
    (i.placeholder || '').toLowerCase().includes('phone') ||
    (i.name || '').toLowerCase().includes('email') ||
    (i.name || '').toLowerCase().includes('user') ||
    (i['aria-label'] || '').toLowerCase().includes('email') ||
    (i['aria-label'] || '').toLowerCase().includes('username') ||
    (i.placeholder || '').toLowerCase().includes('account') ||
    (i.placeholder || '').toLowerCase().includes('sign in') ||
    (i.placeholder || '').toLowerCase().includes('enter your')
  );

  // Find the most likely password input
  const passwordInputs = inspection.inputs.filter(i =>
    i.type === 'password' ||
    i.autocomplete === 'current-password' ||
    (i.placeholder || '').toLowerCase().includes('password') ||
    (i['aria-label'] || '').toLowerCase().includes('password') ||
    (i.name || '').toLowerCase().includes('password') ||
    (i.name || '').toLowerCase().includes('passwd')
  );

  // Find the most likely next/login buttons
  const loginButtons = inspection.buttons.filter(b => {
    const t = b.text.toLowerCase();
    return t.includes('next') || t.includes('sign in') || t.includes('log in') ||
      t.includes('login') || t.includes('continue') || t.includes('submit') ||
      t.includes('signin') || t.includes('log in') || t.includes('sign-in');
  });

  const emailInput = emailInputs[0];
  const passwordInput = passwordInputs[0];
  const nextBtn = loginButtons.find(b => b.text.toLowerCase().includes('next')) || loginButtons[0];
  const loginBtn = loginButtons.find(b =>
    b.text.toLowerCase().includes('log in') || b.text.toLowerCase().includes('sign in')
  ) || loginButtons[0];

  // Build selectors from what we found
  const buildSelector = (inputInfo) => {
    if (!inputInfo) return '';
    if (inputInfo.id) return `#${inputInfo.id}`;
    if (inputInfo.autocomplete && inputInfo.tag === 'input')
      return `input[autocomplete='${inputInfo.autocomplete}']`;
    if (inputInfo.placeholder)
      return `${inputInfo.tag}[placeholder='${inputInfo.placeholder}']`;
    if (inputInfo.name)
      return `${inputInfo.tag}[name='${inputInfo.name}']`;
    if (inputInfo['aria-label'])
      return `${inputInfo.tag}[aria-label='${inputInfo['aria-label']}']`;
    if (inputInfo['data-testid'])
      return `${inputInfo.tag}[data-testid='${inputInfo['data-testid']}']`;
    return inputInfo.tag;
  };

  if (emailInput) config.selectors.input = buildSelector(emailInput);
  if (nextBtn) {
    const sel = nextBtn.id ? `#${nextBtn.id}` :
      nextBtn['data-testid'] ? `[data-testid='${nextBtn['data-testid']}']` :
      `button::-p-text("${nextBtn.text}")`;
    config.selectors.nextButton = sel;
  }
  if (passwordInput) config.selectors.passwordInput = buildSelector(passwordInput);
  if (loginBtn) {
    const sel = loginBtn.id ? `#${loginBtn.id}` :
      loginBtn['data-testid'] ? `[data-testid='${loginBtn['data-testid']}']` :
      `button::-p-text("${loginBtn.text}")`;
    config.selectors.passwordNextButton = sel;
  }

  // Build error message XPath
  if (inspection.errorMessages.length > 0) {
    const errorTexts = [...new Set(inspection.errorMessages.map(e => {
      const t = e.text.toLowerCase().split(/[.!?]/)[0].trim();
      return t.length > 10 ? t : null;
    }).filter(Boolean))];

    if (errorTexts.length > 0) {
      const xpathParts = errorTexts.map(t =>
        `contains(text(), '${t}')`
      );
      config.selectors.errorMessage = `//*[${xpathParts.join(' or ')}]`;
      config.selectors.loginFailed = `//*[${xpathParts.join(' or ')}]`;
    }
  }

  // Build verification code selectors
  const codeInput = inspection.verificationElements.find(v => v.type === 'code_input');
  if (codeInput) {
    config.selectors.verificationCodeInput = codeInput.id
      ? `#${codeInput.id}`
      : codeInput.autocomplete
        ? `input[autocomplete='${codeInput.autocomplete}']`
        : `input[placeholder*='code' i]`;

    // Find submit button for verification code
    const codeSubmitBtns = inspection.buttons.filter(b => {
      const t = b.text.toLowerCase();
      return t.includes('verify') || t.includes('submit') || t.includes('confirm') ||
        t.includes('next') || t === '' || t.includes('done');
    });
    if (codeSubmitBtns[0]) {
      config.selectors.verificationCodeSubmit = codeSubmitBtns[0].id
        ? `#${codeSubmitBtns[0].id}`
        : `button::-p-text("${codeSubmitBtns[0].text}")`;
    }
  }
  // Also try to find a general submit/verify button if not found
  if (!config.selectors.verificationCodeSubmit) {
    const allSubmitBtns = inspection.buttons.filter(b => {
      const t = b.text.toLowerCase();
      return t.includes('verify') || t.includes('submit') || t.includes('confirm');
    });
    if (allSubmitBtns[0]) {
      config.selectors.verificationCodeSubmit = allSubmitBtns[0].id
        ? `#${allSubmitBtns[0].id}`
        : `button::-p-text("${allSubmitBtns[0].text}")`;
    }
  }

  // --- Build additionalViews (cookie banners, security prompts) ---
  inspection.cookieBanners.forEach(banner => {
    if (banner.buttons.length > 0) {
      config.additionalViews.push({
        name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Cookie Consent`,
        match: {
          selector: ['*'],
          text: banner.buttons[0] || 'cookie'
        },
        action: {
          type: 'click',
          selector: [`button::-p-text("${banner.buttons[0]}")`],
          navigationWaitUntil: 'networkidle0'
        }
      });
    }
  });

  // --- Build verificationScreens ---
  inspection.verificationElements.filter(v => v.type === 'code_input').forEach((v, idx) => {
    const parentText = v.parentText || '';
    let name = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Verification`;
    if (parentText.includes('email')) name = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Email Verification`;
    else if (parentText.includes('phone') || parentText.includes('sms')) name = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Phone Verification`;
    else if (parentText.includes('2-step') || parentText.includes('2fa') || parentText.includes('authenticator')) name = `${platform.charAt(0).toUpperCase() + platform.slice(1)} 2-Step Verification`;

    config.verificationScreens.push({
      name,
      isCodeEntryScreen: true,
      requiresVerification: true,
      match: {
        selector: ['h1', 'h2', 'div[role="heading"]'],
        text: parentText.toLowerCase().includes('verif') ? 'verification' : 'code'
      }
    });
  });

  // Add choice screen if found
  const choiceOptions = inspection.verificationElements.filter(v => v.type === 'choice_option');
  if (choiceOptions.length > 0) {
    const choiceScreenName = `${platform.charAt(0).toUpperCase() + platform.slice(1)} Verification Choice`;
    const hasVerificationScreen = config.verificationScreens.find(s => s.name === choiceScreenName);
    if (!hasVerificationScreen) {
      config.verificationScreens.push({
        name: choiceScreenName,
        isVerificationChoiceScreen: true,
        requiresVerification: true,
        match: {
          selector: ['*'],
          text: 'verify'
        }
      });
    }
  }

  // --- Build flow steps ---
  if (emailInput) {
    config.flow.push({ action: 'waitForSelector', selector: 'input' });
    config.flow.push({ action: 'type', selector: 'input', value: 'EMAIL' });
  }
  if (nextBtn) {
    config.flow.push({ action: 'click', selector: 'nextButton' });
  }
  if (passwordInput) {
    config.flow.push({ action: 'wait', duration: 2000 });
    config.flow.push({ action: 'type', selector: 'passwordInput', value: 'PASSWORD' });
  }
  if (loginBtn) {
    config.flow.push({ action: 'click', selector: 'passwordNextButton' });
  }

  // --- Build inboxUrlPatterns ---
  const urlObj = new URL(inspection.url);
  config.inboxUrlPatterns = [
    new RegExp(`${urlObj.hostname.replace('.', '\\.')}\\/`)
  ];

  return config;
}

// ==================== API ROUTES ====================

/**
 * POST /api/socials/login-inspector
 * 
 * Actions:
 * - "launch": Launch browser and navigate to platform login page
 * - "inspect": Inspect the current page and return all elements
 * - "navigate": Navigate to a different URL
 * - "save": Generate and return the platform config
 * - "close": Close the browser session
 * - "execute": Run a JavaScript snippet in the page
 * - "status": Check if browser is still alive
 */
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, sessionId, platform, url, script } = body;

    const sid = sessionId || 'default';

    logger.info(`[login-inspector] action=${action} sessionId=${sid} platform=${platform || 'none'}`);

    switch (action) {
      // ==================== LAUNCH ====================
      case 'launch': {
        if (!platform && !url) {
          return setCorsHeaders(NextResponse.json({
            error: "Platform or URL is required"
          }, { status: 400 }));
        }

        const targetUrl = url || PLATFORM_URLS[platform];
        if (!targetUrl) {
          return setCorsHeaders(NextResponse.json({
            error: `No URL configured for platform '${platform}'. Provide a custom URL.`,
            availablePlatforms: Object.keys(PLATFORM_URLS)
          }, { status: 400 }));
        }

        const session = await launchInspectorBrowser(sid);
        const { page } = session;

        // Navigate to the login URL
        try {
          await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(res => setTimeout(res, 2000)); // Let JS render
        } catch (navError) {
          logger.warn(`[login-inspector] Navigation warning: ${navError.message}`);
        }

        // Do initial inspection
        const inspection = await inspectPage(page);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          platform,
          url: targetUrl,
          browserAlive: session.browser.isConnected(),
          inspection,
        }));
      }

      // ==================== INSPECT ====================
      case 'inspect': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session. Launch one first."
          }, { status: 400 }));
        }

        const inspection = await inspectPage(session.page);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          inspection,
        }));
      }

      // ==================== NAVIGATE ====================
      case 'navigate': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session. Launch one first."
          }, { status: 400 }));
        }

        if (!url) {
          return setCorsHeaders(NextResponse.json({
            error: "URL is required for navigate action"
          }, { status: 400 }));
        }

        await session.page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(res => setTimeout(res, 1500));

        const inspection = await inspectPage(session.page);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          url: session.page.url(),
          inspection,
        }));
      }

      // ==================== SAVE / GENERATE CONFIG ====================
      case 'save': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session. Launch one first."
          }, { status: 400 }));
        }

        const inspection = await inspectPage(session.page);
        const platformKey = platform || 'custom';
        const config = generatePlatformConfig(platformKey, inspection);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          platform: platformKey,
          config,
          inspectionSummary: {
            inputsFound: inspection.inputs.length,
            buttonsFound: inspection.buttons.length,
            headingsFound: inspection.headings.length,
            errorMessagesFound: inspection.errorMessages.length,
            verificationElementsFound: inspection.verificationElements.length,
            cookieBannersFound: inspection.cookieBanners.length,
          }
        }));
      }

      // ==================== EXECUTE SCRIPT ====================
      case 'execute': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session."
          }, { status: 400 }));
        }

        if (!script) {
          return setCorsHeaders(NextResponse.json({
            error: "Script is required"
          }, { status: 400 }));
        }

        const result = await session.page.evaluate(script);
        return setCorsHeaders(NextResponse.json({
          success: true,
          result,
        }));
      }

      // ==================== STATUS ====================
      case 'status': {
        const session = activeSessions.get(sid);
        const alive = session && session.browser.isConnected();

        let pageInfo = null;
        if (alive) {
          try {
            pageInfo = {
              url: session.page.url(),
              title: await session.page.title(),
            };
          } catch (e) {
            pageInfo = { error: e.message };
          }
        }

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          active: !!alive,
          pageInfo,
          navigationHistory: session?.navigationHistory || [],
        }));
      }

      // ==================== CLOSE ====================
      case 'close': {
        const session = activeSessions.get(sid);
        if (session) {
          try {
            await session.page.close();
          } catch (e) { /* ignore */ }
          try {
            await session.browser.close();
          } catch (e) { /* ignore */ }
          activeSessions.delete(sid);
          logger.info(`[login-inspector] Session closed: ${sid}`);
        }

        return setCorsHeaders(NextResponse.json({
          success: true,
          message: `Session ${sid} closed`,
        }));
      }

      default:
        return setCorsHeaders(NextResponse.json({
          error: `Unknown action: ${action}. Available: launch, inspect, navigate, save, execute, status, close`
        }, { status: 400 }));
    }
  } catch (e) {
    logger.error(`[login-inspector] Error: ${e.message}`);
    return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}