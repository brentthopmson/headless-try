// Shared Gmail identifier-error detector.
//
// This is the exact logic proven by the cookie-login flow. It is dependency-free
// (no Sheets/Drive/AI imports) so both cookie-api-login and campaign validation
// can call the SAME implementation instead of drifting copies.
//
// Google renders "Couldn't find this account" inside a closed shadow DOM and may
// use a typographic apostrophe (U+2019). Strong DOM-only/XPath checks miss it,
// hence the 3 layers: accessibility tree -> TreeWalker -> behavioral URL check.

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function hasAccountDeleted(text) {
  return /account deleted|account was recently deleted|recently deleted and may be recoverable/i.test(String(text || ''));
}

function accountDeletedResult(logger, layer, instanceId, url) {
  logger?.info?.(`[detectGmailEmailError][${instanceId}] Account deleted detected via ${layer}. URL: ${String(url || '').substring(0, 120)}`);
  return { found: true, code: 'ACCOUNT_DELETED', text: 'This Google account has been deleted.' };
}

function hasText(text, logger, layer, url) {
  const signals = [
    "Couldn't find",
    "Couldn\u2019t find",
    "Could not find",
    "No se pudo encontrar",
    "Impossible de trouver",
    "Konto nicht gefunden",
  ];
  const hit = signals.some(s => text.includes(s));
  if (hit) {
    logger?.info?.(`[detectGmailEmailError][${layer}] Email error detected. URL: ${String(url || '').substring(0, 120)}`);
  }
  return hit;
}

/**
 * @param {object} page Puppeteer page positioned on the Gmail identifier step.
 * @param {string} instanceId Diagnostic id (browser id / campaign id).
 * @param {boolean} postCaptcha Skip the CAPTCHA guard after a CAPTCHA solve.
 * @param {object} logger Optional logger with info()/warn().
 */
export async function detectGmailIdentifierError(page, instanceId, postCaptcha = false, logger = null) {
  const url = page.url();
  if (!url.includes('/signin/') && !url.includes('accounts.google.com')) return { found: false, text: '' };

  // Layer 1: accessibility snapshot reads rendered text through shadow DOM boundaries.
  try {
    const snapshot = await page.accessibility?.snapshot?.().catch(() => null);
    if (snapshot && hasAccountDeleted(JSON.stringify(snapshot))) {
      return accountDeletedResult(logger, 'accessibility', instanceId, url);
    }
    if (snapshot && hasText(JSON.stringify(snapshot), logger, instanceId, url)) {
      return { found: true, text: "Couldn't find this account." };
    }
  } catch {}

  // Layer 2: TreeWalker scans all text nodes in the document.
  try {
    const pageText = await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let text = '';
      while (walker.nextNode()) text += walker.currentNode.textContent + ' ';
      return text;
    });
    if (hasAccountDeleted(pageText)) {
      return accountDeletedResult(logger, 'text walker', instanceId, url);
    }
    if (hasText(pageText, logger, instanceId, url)) {
      return { found: true, text: "Couldn't find this account." };
    }
  } catch {}

  // Layer 3: behavioral fallback. Still on /signin/identifier after submitting
  // the identifier means the account was rejected. Valid emails navigate to
  // /challenge/pwd, /challenge/selection, etc.
  try {
    if (!postCaptcha) {
      const hasCaptcha = await page.$('#captchaimg').catch(() => null);
      if (hasCaptcha) {
        logger?.info?.(`[detectGmailEmailError][${instanceId}] CAPTCHA present - skipping behavioral check. URL: ${url.substring(0, 120)}`);
        return { found: false, text: '' };
      }
    }

    const hasRecaptcha = await page.$('iframe[title*="reCAPTCHA"], [data-sitekey]').catch(() => null);
    const hasPasswordInput = await page.$('input[type="password"], #password').catch(() => null);
    if (!hasRecaptcha && !hasPasswordInput) {
      // A valid email may briefly sit on /signin/identifier while the password
      // step loads. Re-verify after a short delay; an invalid error page is static.
      await sleep(1500);
      const urlNow = page.url();
      const stillRecaptcha = await page.$('iframe[title*="reCAPTCHA"], [data-sitekey]').catch(() => null);
      const stillPassword = await page.$('input[type="password"], #password').catch(() => null);
      if (urlNow.includes('/signin/identifier') && !stillRecaptcha && !stillPassword) {
        logger?.info?.(`[detectGmailEmailError][${instanceId}] Behavioral signal (confirmed): still on /signin/identifier with no password form - email invalid. URL: ${urlNow.substring(0, 120)}`);
        return { found: true, text: "Couldn't find this account (behavioral)." };
      }
      logger?.info?.(`[detectGmailEmailError][${instanceId}] Behavioral signal not confirmed (page transitioned). URL: ${urlNow.substring(0, 120)}`);
    }
  } catch {}

  logger?.info?.(`[detectGmailEmailError][${instanceId}] No email error on /signin/identifier. URL: ${url.substring(0, 120)}`);
  return { found: false, text: '' };
}
