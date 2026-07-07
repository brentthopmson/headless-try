import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import logger from "../../../../utils/logger.js";
import { isDev, localExecutablePath, remoteExecutablePath } from "../../../../utils/utils.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const activeSessions = new Map();

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
  indeed: "https://secure.indeed.com/auth",
  threads: "https://www.threads.net/login",
};

const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};

async function launchInspectorBrowser(sessionId, platform) {
  if (activeSessions.has(sessionId)) {
    const existing = activeSessions.get(sessionId);
    if (existing.browser && existing.browser.isConnected()) {
      logger.info(`[inspector] Reusing existing browser session: ${sessionId}`);
      return existing;
    }
    activeSessions.delete(sessionId);
  }

  logger.info(`[inspector] Launching new browser for session: ${sessionId} platform: ${platform}`);

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

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

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

  const session = { browser, page, navigationHistory, platform };
  activeSessions.set(sessionId, session);

  browser.on('disconnected', () => {
    logger.info(`[inspector] Browser disconnected for session: ${sessionId}`);
    activeSessions.delete(sessionId);
  });

  return session;
}

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
      qrCodes: [],
      cookieBanners: [],
      loginMethodTabs: [],
      securityElements: [],
      allSelectable: [],
      html: document.documentElement.outerHTML.slice(0, 50000),
    };

    // Collect all input fields
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

      const selectors = [];
      if (el.id) selectors.push(`#${el.id}`);
      if (el.name) selectors.push(`${tag}[name="${el.name}"]`);
      if (el.placeholder) selectors.push(`${tag}[placeholder="${el.placeholder}"]`);
      if (el.autocomplete) selectors.push(`${tag}[autocomplete="${el.autocomplete}"]`);
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) selectors.push(`${tag}[aria-label="${ariaLabel}"]`);
      const testId = el.getAttribute('data-testid');
      if (testId) selectors.push(`${tag}[data-testid="${testId}"]`);

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

      const selectors = [];
      if (el.id) selectors.push(`#${el.id}`);
      if (text.length < 50) {
        selectors.push(`button::-p-text("${text.replace(/"/g, '\\"')}")`);
      }
      const testId = el.getAttribute('data-testid');
      if (testId) selectors.push(`[data-testid="${testId}"]`);

      results.allSelectable.push({
        purpose: `button: ${text.slice(0, 40)}`,
        cssSelectors: selectors,
        uniqueSelector: el.id ? `#${el.id}` : `button:nth-of-type(${[...document.querySelectorAll('button, input[type="submit"], input[type="button"], a[role="button"], [role="button"]')].indexOf(el) + 1})`,
      });
    });

    // Collect headings
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
      "doesn't exist", 'try again', 'failed', 'unable to', 'problem', 'sorry', 'blocked', 'locked',
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

    // Detect verification method choice buttons
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

    // Detect QR codes
    document.querySelectorAll('img[alt*="qr" i], img[alt*="qrcode" i], img[src*="qr" i], [class*="qr" i], [id*="qr" i]').forEach(el => {
      results.qrCodes.push({
        tag: el.tagName.toLowerCase(),
        alt: el.getAttribute('alt') || '',
        src: el.getAttribute('src') || '',
        id: el.id || '',
        className: el.className || '',
        visible: el.offsetParent !== null,
        rect: (() => {
          const r = el.getBoundingClientRect();
          return `(${Math.round(r.x)},${Math.round(r.y)}) ${Math.round(r.w)}x${Math.round(r.h)}`;
        })(),
      });
    });

    // Detect login method tabs (QR / Email / Phone / SSO)
    const loginMethodKeywords = ['qr code', 'use phone', 'use email', 'phone number', 'email',
      'log in with google', 'log in with apple', 'continue with google', 'continue with apple',
      'sign in with google', 'sign in with apple', 'use qr', 'scan qr', 'login with qr'];

    document.querySelectorAll('button, a, div[role="tab"], [role="button"], span, li').forEach(el => {
      const text = el.textContent?.trim().toLowerCase() || '';
      if (text.length > 1 && text.length < 60) {
        const matched = loginMethodKeywords.find(k => text.includes(k));
        if (matched) {
          const existing = results.loginMethodTabs.find(t => t.label.toLowerCase() === text);
          if (!existing) {
            results.loginMethodTabs.push({
              label: el.textContent?.trim() || '',
              type: matched.includes('qr') ? 'qr' : matched.includes('phone') ? 'phone' : matched.includes('google') ? 'google' : matched.includes('apple') ? 'apple' : 'email',
              selector: el.id ? `#${el.id}` : text.length < 40 ? `button::-p-text("${el.textContent?.trim()}")` : '',
              tag: el.tagName.toLowerCase(),
            });
          }
        }
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

async function detectLoginMethods(page) {
  const methods = await page.evaluate(() => {
    const results = [];

    const methodKeywords = [
      { type: 'qr', keywords: ['qr code', 'use qr', 'scan qr', 'login with qr', 'qr'] },
      { type: 'email', keywords: ['use email', 'email', 'log in with email'] },
      { type: 'phone', keywords: ['phone number', 'use phone', 'phone', 'log in with phone'] },
      { type: 'google', keywords: ['google', 'continue with google'] },
      { type: 'apple', keywords: ['apple', 'continue with apple', 'sign in with apple'] },
    ];

    document.querySelectorAll('button, a, div[role="tab"], [role="button"], span, li, label').forEach(el => {
      const text = el.textContent?.trim().toLowerCase() || '';
      if (text.length < 1 || text.length > 80) return;

      for (const mk of methodKeywords) {
        if (mk.keywords.some(k => text.includes(k))) {
          const existing = results.find(r => r.label.toLowerCase() === el.textContent?.trim().toLowerCase());
          if (!existing) {
            results.push({
              type: mk.type,
              label: el.textContent?.trim() || '',
              selector: el.id ? `#${el.id}` : text.length < 50 ? `::-p-text("${el.textContent?.trim().replace(/"/g, '\\"')}")` : '',
              tag: el.tagName.toLowerCase(),
            });
          }
          break;
        }
      }
    });

    // Also check for QR code image
    document.querySelectorAll('img[alt*="qr" i], img[alt*="qrcode" i], canvas, svg').forEach(el => {
      const parent = el.closest('div, section')?.textContent?.toLowerCase() || '';
      if (parent.includes('qr') || parent.includes('scan')) {
        const existing = results.find(r => r.type === 'qr');
        if (!existing) {
          results.push({
            type: 'qr',
            label: 'QR Code',
            selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(),
            tag: el.tagName.toLowerCase(),
          });
        }
      }
    });

    return results;
  });

  return methods;
}

function generatePlatformConfig(platform, inspection) {
  const config = {
    platform,
    url: inspection.url || PLATFORM_URLS[platform] || '',
    selectors: {},
    additionalViews: [],
    verificationScreens: [],
    inboxUrlPatterns: [],
    flow: [],
    loginMethods: inspection.loginMethodTabs || [],
  };

  const emailInputs = inspection.inputs.filter(i =>
    i.autocomplete === 'username' || i.autocomplete === 'email' ||
    (i.placeholder || '').toLowerCase().includes('email') ||
    (i.placeholder || '').toLowerCase().includes('username') ||
    (i.placeholder || '').toLowerCase().includes('phone') ||
    (i.name || '').toLowerCase().includes('email') ||
    (i.name || '').toLowerCase().includes('user') ||
    (i.name || '').toLowerCase().includes('phone') ||
    (i['aria-label'] || '').toLowerCase().includes('email') ||
    (i['aria-label'] || '').toLowerCase().includes('username') ||
    (i.placeholder || '').toLowerCase().includes('account')
  );

  const passwordInputs = inspection.inputs.filter(i =>
    i.type === 'password' ||
    i.autocomplete === 'current-password' ||
    (i.placeholder || '').toLowerCase().includes('password') ||
    (i['aria-label'] || '').toLowerCase().includes('password') ||
    (i.name || '').toLowerCase().includes('password') ||
    (i.name || '').toLowerCase().includes('passwd')
  );

  const phoneInputs = inspection.inputs.filter(i =>
    (i.type === 'tel' || i.type === 'phone' || i.name?.toLowerCase().includes('phone') || i.name?.toLowerCase().includes('tel') ||
     i.placeholder?.toLowerCase().includes('phone') || i.placeholder?.toLowerCase().includes('mobile') || i.id?.toLowerCase().includes('phone'))
  );

  const loginButtons = inspection.buttons.filter(b => {
    const t = b.text.toLowerCase();
    return t.includes('next') || t.includes('sign in') || t.includes('log in') ||
      t.includes('login') || t.includes('continue') || t.includes('submit') ||
      t.includes('signin') || t.includes('sign-in');
  });

  const emailInput = emailInputs[0];
  const passwordInput = passwordInputs[0];
  const phoneInput = phoneInputs[0];
  const nextBtn = loginButtons.find(b => b.text.toLowerCase().includes('next')) || loginButtons[0];
  const loginBtn = loginButtons.find(b =>
    b.text.toLowerCase().includes('log in') || b.text.toLowerCase().includes('sign in')
  ) || loginButtons[0];

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

  if (emailInput || phoneInput) {
    const primaryInput = emailInput || phoneInput;
    config.selectors.input = buildSelector(primaryInput);
  }
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

  // Error messages
  if (inspection.errorMessages.length > 0) {
    const errorTexts = [...new Set(inspection.errorMessages.map(e => {
      const t = e.text.toLowerCase().split(/[.!?]/)[0].trim();
      return t.length > 10 ? t : null;
    }).filter(Boolean))];

    if (errorTexts.length > 0) {
      const xpathParts = errorTexts.map(t => `contains(text(), '${t}')`);
      config.selectors.errorMessage = `//*[${xpathParts.join(' or ')}]`;
      config.selectors.loginFailed = `//*[${xpathParts.join(' or ')}]`;
    }
  }

  // Verification code selectors
  const codeInput = inspection.verificationElements.find(v => v.type === 'code_input');
  if (codeInput) {
    config.selectors.verificationCodeInput = codeInput.id
      ? `#${codeInput.id}`
      : codeInput.autocomplete
        ? `input[autocomplete='${codeInput.autocomplete}']`
        : `input[placeholder*='code' i]`;

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

  // Additional views from cookie banners
  inspection.cookieBanners.forEach(banner => {
    if (banner.buttons.length > 0) {
      const rejectBtn = banner.buttons.find(b => /reject|decline|essential only|deny/i.test(b));
      const targetBtn = rejectBtn || banner.buttons[0];
      config.additionalViews.push({
        name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Cookie Consent`,
        match: { selector: ['*'], text: 'cookie' },
        action: {
          type: 'click',
          selector: [`button::-p-text("${targetBtn}")`],
          navigationWaitUntil: 'networkidle0'
        }
      });
    }
  });

  // Verification screens
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

  const choiceOptions = inspection.verificationElements.filter(v => v.type === 'choice_option');
  if (choiceOptions.length > 0) {
    config.verificationScreens.push({
      name: `${platform.charAt(0).toUpperCase() + platform.slice(1)} Verification Choice`,
      isVerificationChoiceScreen: true,
      requiresVerification: true,
      match: { selector: ['*'], text: 'verify' }
    });
  }

  // Flow steps
  if (emailInput || phoneInput) {
    config.flow.push({ action: 'waitForSelector', selector: 'input' });
    config.flow.push({ action: 'type', selector: 'input', value: emailInput ? 'EMAIL' : 'PHONE' });
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

  try {
    const urlObj = new URL(inspection.url);
    config.inboxUrlPatterns = [new RegExp(`${urlObj.hostname.replace(/\./g, '\\.')}\\/`)];
  } catch (e) {
    config.inboxUrlPatterns = [new RegExp(`${platform}\\.com\\/`)];
  }

  // QR detection
  if (inspection.qrCodes.length > 0) {
    config.qrCode = {
      detected: true,
      selector: inspection.qrCodes[0].id ? `#${inspection.qrCodes[0].id}` : 'img[alt*="qr" i]',
    };
  }

  return config;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, sessionId, platform, url, script } = body;
    const sid = sessionId || `inspector-${Date.now()}`;

    logger.info(`[inspector] action=${action} sessionId=${sid} platform=${platform || 'none'}`);

    switch (action) {
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

        const session = await launchInspectorBrowser(sid, platform);
        const { page } = session;

        try {
          await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(res => setTimeout(res, 2000));
        } catch (navError) {
          logger.warn(`[inspector] Navigation warning: ${navError.message}`);
        }

        const inspection = await inspectPage(page);
        const methods = await detectLoginMethods(page);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          platform,
          url: targetUrl,
          browserAlive: session.browser.isConnected(),
          loginMethods: methods,
          inspectionSummary: {
            inputsFound: inspection.inputs.length,
            buttonsFound: inspection.buttons.length,
            headingsFound: inspection.headings.length,
            errorMessagesFound: inspection.errorMessages.length,
            verificationElementsFound: inspection.verificationElements.length,
            qrCodesFound: inspection.qrCodes.length,
            cookieBannersFound: inspection.cookieBanners.length,
            loginMethodTabsFound: inspection.loginMethodTabs.length,
          },
        }));
      }

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

      case 'detect-methods': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session. Launch one first."
          }, { status: 400 }));
        }

        const methods = await detectLoginMethods(session.page);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          loginMethods: methods,
        }));
      }

      case 'generate': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session. Launch one first."
          }, { status: 400 }));
        }

        const inspection = await inspectPage(session.page);
        const platformKey = platform || session.platform || 'custom';
        const config = generatePlatformConfig(platformKey, inspection);

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          platform: platformKey,
          config,
          inspectionSummary: {
            inputsFound: inspection.inputs.length,
            buttonsFound: inspection.buttons.length,
            errorMessagesFound: inspection.errorMessages.length,
            verificationElementsFound: inspection.verificationElements.length,
            qrCodesFound: inspection.qrCodes.length,
            loginMethodTabsFound: inspection.loginMethodTabs.length,
          }
        }));
      }

      case 'capture': {
        const session = activeSessions.get(sid);
        if (!session || !session.browser.isConnected()) {
          return setCorsHeaders(NextResponse.json({
            error: "No active browser session. Launch one first."
          }, { status: 400 }));
        }

        const page = session.page;
        const state = await page.evaluate(() => ({
          url: window.location.href,
          title: document.title,
          visibleInputs: [...document.querySelectorAll('input, textarea, select')]
            .filter(el => el.offsetParent !== null)
            .map(el => ({
              tag: el.tagName.toLowerCase(),
              type: el.type || '',
              name: el.name || '',
              placeholder: el.placeholder || '',
              visible: true,
            })),
          visibleButtons: [...document.querySelectorAll('button, [role="button"], input[type="submit"]')]
            .filter(el => el.offsetParent !== null)
            .map(el => ({
              text: (el.textContent || el.value || '').trim().slice(0, 60),
              visible: true,
            })),
          qrPresent: !!document.querySelector('img[alt*="qr" i], img[alt*="qrcode" i], canvas'),
        }));

        return setCorsHeaders(NextResponse.json({
          success: true,
          sessionId: sid,
          state,
        }));
      }

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
          platform: session?.platform || null,
          pageInfo,
          navigationHistory: session?.navigationHistory || [],
        }));
      }

      case 'close': {
        const session = activeSessions.get(sid);
        if (session) {
          try { await session.page.close(); } catch (e) { /* ignore */ }
          try { await session.browser.close(); } catch (e) { /* ignore */ }
          activeSessions.delete(sid);
          logger.info(`[inspector] Session closed: ${sid}`);
        }

        return setCorsHeaders(NextResponse.json({
          success: true,
          message: `Session ${sid} closed`,
        }));
      }

      default:
        return setCorsHeaders(NextResponse.json({
          error: `Unknown action: ${action}. Available: launch, inspect, detect-methods, generate, capture, navigate, execute, status, close`
        }, { status: 400 }));
    }
  } catch (e) {
    logger.error(`[inspector] Error: ${e.message}`);
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
