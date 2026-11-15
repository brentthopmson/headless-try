import { NextResponse } from "next/server";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";
import dns from "dns";
import { promisify } from "util";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { launchBrowser } from "../../../utils/utils.js";
import { platformConfigs } from "../../emails/cookie/cookie-api-login/platforms.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings, getPerformancePresets } from "../_shared/pipelineUtils.js";
import { getSelfUrl, getSelfUrlWithFallback, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits, checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 0;
export const dynamic = "force-dynamic";

const STANDARD_88_COLUMNS = [
  'SN',
  'FIRSTNAME', 'LASTNAME', 'EMAIL', 'ADDRESS', 'CITY', 'STATE', 'COUNTRY', 'ZIPCODE', 'PHONE', 'SEX',
  'BUSINESSNAME', 'BUSINESSADDRESS', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'BUSINESSZIPCODE', 'BUSINESSPHONE', 'BUSINESSEMAIL',
  'SOCIALPLATFORM', 'SOCIALUSERNAME', 'SOCIALPHONE',
  'CONTEXT',
  'URL', '', '', '', '', '',
  'campaignType', 'engine', 'provider',
  'shooterFirstName', 'shooterLastName', 'shooterEmail', 'shooterAddress', 'shooterCity', 'shooterState', 'shooterCountry', 'shooterZipCode', 'shooterPhone', 'shooterSex',
  'smtp', 'port', 'username', 'password', 'appPassword', 'backupCode', 'oAuth2ClientId', 'oAuth2ClientSecret', 'oAuth2RefreshToken',
  '',
  'shouldValidate', 'shouldEnhance', 'shouldSearchInteract', 'shouldPageInteract', 'shouldInboxInteract', 'shouldActivitiesInteract', 'shouldSendMessage',
  '', '',
  'emailSubject', 'emailBody', 'socialMessage', 'replyTo',
  '', '', '',
  'validation', 'providerMXResult', 'enhancedSubject', 'enhancedBody', 'enhancedSocialMessage',
  'enrichmentStatus',
  '',
  'sendDate', 'sendTime', 'sendStamp',
  '', '', '',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  '',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp',
  '', 'personalizationStatus', 'executionStatus'
];

const FUZZY_MAP = {
  EMAIL: ['EMAIL', 'MAIL', 'E-MAIL', 'LEAD'],
  FIRSTNAME: ['FIRST', 'FIRST NAME', 'FNAME', 'GIVEN'],
  LASTNAME: ['LAST', 'LAST NAME', 'LNAME', 'SURNAME', 'FAMILY'],
  ADDRESS: ['ADDRESS', 'STREET'],
  CITY: ['CITY', 'TOWN'],
  STATE: ['STATE', 'PROVINCE', 'REGION'],
  COUNTRY: ['COUNTRY', 'NATION'],
  ZIPCODE: ['ZIP', 'ZIPCODE', 'ZIP CODE', 'POSTAL', 'POSTCODE'],
  PHONE: ['PHONE', 'PHONENUMBER', 'PHONE NUMBER', 'TELEPHONE', 'TEL', 'MOBILE', 'CELL'],
  SEX: ['SEX', 'GENDER'],
  BUSINESSNAME: ['BUSINESS', 'BUSINESS NAME', 'COMPANY', 'ORGANIZATION', 'ORG'],
  BUSINESSADDRESS: ['BUSINESS ADDRESS', 'COMPANY ADDRESS'],
  BUSINESSCITY: ['BUSINESS CITY', 'COMPANY CITY'],
  BUSINESSSTATE: ['BUSINESS STATE', 'COMPANY STATE'],
  BUSINESSCOUNTRY: ['BUSINESS COUNTRY', 'COMPANY COUNTRY'],
  BUSINESSZIPCODE: ['BUSINESS ZIP', 'BUSINESS POSTAL', 'COMPANY ZIP'],
  BUSINESSPHONE: ['BUSINESS PHONE', 'COMPANY PHONE'],
  BUSINESSEMAIL: ['BUSINESS EMAIL', 'COMPANY EMAIL'],
  SOCIALPLATFORM: ['SOCIAL', 'SOCIAL PLATFORM', 'PLATFORM'],
  SOCIALUSERNAME: ['SOCIAL USERNAME', 'USERNAME', 'HANDLE', 'SOCIAL HANDLE'],
  SOCIALPHONE: ['SOCIAL PHONE'],
  URL: ['URL', 'LINK', 'WEBSITE', 'WEB', 'REFERENCE']
};

function normalizeAndMapCSV(rawCsvContent, targetSchema) {
  const parsedRows = parseCSV(rawCsvContent);
  if (parsedRows.length === 0) return [];

  const rawHeaders = parsedRows[0].map(h => h.trim().toUpperCase());
  const dataRows = parsedRows.slice(1);

  const normalizedRows = [];
  const headerMap = new Map();

  targetSchema.forEach((stdHeader, index) => {
    if (!stdHeader) return;
    const upperStd = stdHeader.toUpperCase();
    const exactIdx = rawHeaders.indexOf(upperStd);
    if (exactIdx !== -1) { headerMap.set(index, exactIdx); return; }
    const fuzzyKeys = FUZZY_MAP[upperStd];
    if (fuzzyKeys) {
      for (const alias of fuzzyKeys) {
        const aliasIdx = rawHeaders.findIndex(rh => rh === alias || rh.includes(alias));
        if (aliasIdx !== -1) { headerMap.set(index, aliasIdx); return; }
      }
    }
  });

  normalizedRows.push(targetSchema);

  dataRows.forEach((row, idx) => {
    const newRow = new Array(targetSchema.length).fill('');
    targetSchema.forEach((_, stdIndex) => {
      if (headerMap.has(stdIndex)) {
        const rawIndex = headerMap.get(stdIndex);
        newRow[stdIndex] = row[rawIndex] !== undefined && row[rawIndex] !== null ? String(row[rawIndex]) : '';
      }
    });
    if (!headerMap.has(0) && targetSchema[0] && String(targetSchema[0]).toUpperCase() === 'SN') {
      newRow[0] = String(idx + 1);
    }
    normalizedRows.push(newRow);
  });

  return normalizedRows;
}

function detectPlatform(domain) {
  for (const [name, config] of Object.entries(platformConfigs)) {
    if (config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw))) {
      return name;
    }
  }
  return null;
}

function normalizeSelectorList(sel) {
  if (!sel) return [];
  return Array.isArray(sel) ? sel.filter(Boolean) : [sel];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function isVisibleHandle(handle) {
  try {
    return await handle.evaluate(el => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      if (!style) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  } catch { return false; }
}

async function findFirstVisibleSelector(page, selectors, timeoutMs = 10000) {
  const list = normalizeSelectorList(selectors);
  if (list.length === 0) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const sel of list) {
      try {
        if (typeof sel !== 'string') continue;
        if (sel.startsWith('//') || sel.startsWith('(//')) {
          const handles = await page.$x(sel);
          for (const h of handles) {
            if (await isVisibleHandle(h)) return { type: 'xpath', selector: sel, handle: h };
          }
        } else {
          const h = await page.$(sel);
          if (h && await isVisibleHandle(h)) return { type: 'css', selector: sel, handle: h };
        }
      } catch {}
    }
    await sleep(250);
  }
  return null;
}

async function clickFirstVisibleSelector(page, selectors) {
  const found = await findFirstVisibleSelector(page, selectors, 5000);
  if (!found) return false;
  try {
    if (found.type === 'css') await page.click(found.selector);
    else await found.handle.click();
    return true;
  } catch {
    try { await found.handle.evaluate(el => el.click()); return true; } catch { return false; }
  }
}

async function findVisibleErrorMessage(page, xpath) {
  try {
    return await page.evaluate((xpathArg) => {
      try {
        const snapshot = document.evaluate(xpathArg, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const matched = snapshot.snapshotLength > 0;
        let best = null;
        for (let i = 0; i < snapshot.snapshotLength; i++) {
          const el = snapshot.snapshotItem(i);
          if (!el || el.nodeType !== 1) continue;
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'html' || tag === 'body' || tag === 'script' || tag === 'style' || tag === 'noscript') continue;
          if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') continue;
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
          const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          const cls = typeof el.className === 'string' ? el.className : (el.className?.baseVal || '');
          if (!best || text.length < best.len) best = { tag, len: text.length, text, cls };
        }
        return { matched, best };
      } catch (e) { return { matched: false, best: null }; }
    }, xpath);
  } catch { return { matched: false, best: null }; }
}

async function detectPlatformNotFoundError(page, config) {
  const selectors = normalizeSelectorList(config?.selectors?.errorMessage || config?.selectors?.incorrectEmailMessage);
  for (const sel of selectors) {
    if (typeof sel !== 'string') continue;
    if (sel.startsWith('//') || sel.startsWith('(//')) {
      const scan = await findVisibleErrorMessage(page, sel);
      if (scan?.best && scan.best.len <= 500) return { found: true, text: scan.best.text };
    } else {
      try {
        const h = await page.$(sel);
        if (h && await isVisibleHandle(h)) {
          const text = await h.evaluate(el => (el.textContent || '').trim());
          if (text) return { found: true, text };
        }
      } catch {}
    }
  }
  return { found: false, text: '' };
}

async function detectPostEmailProgress(page, config) {
  // If password input, verification/code inputs, challenge/captcha, or obvious verification UI appears, email was accepted.
  try {
    const passwordSelectors = normalizeSelectorList(config?.selectors?.passwordInput);
    for (const sel of passwordSelectors) {
      if (typeof sel !== 'string') continue;
      const h = sel.startsWith('//') ? (await page.$x(sel))[0] : await page.$(sel);
      if (h && await isVisibleHandle(h)) return { progressed: true, reason: 'password_input' };
    }
    const progressed = await page.evaluate(() => {
      const body = (document.body?.innerText || '').toLowerCase();
      const signals = [
        'verify it', "verify it's you", '2-step verification', 'enter the code', 'enter code',
        'get a verification code', 'confirm your recovery', 'choose how you want to sign in',
        'use your password', 'enter password', 'password', 'help us protect your account',
        'verify your identity'
      ];
      if (signals.some(s => body.includes(s))) return true;
      const codeSelectors = ['input[type="tel"]', 'input[name="ca"]', '#idvPinId', '#iOttText', 'input[id^="codeEntry-"]', '#phoneNumberId'];
      for (const s of codeSelectors) { const el = document.querySelector(s); if (el) { const r = el.getBoundingClientRect(); if (r.width>0&&r.height>0) return true; } }
      if (document.querySelector('iframe[src*="recaptcha"], iframe[title*="recaptcha" i], #captchaimg, img[alt*="captcha" i]')) return true;
      return false;
    });
    if (progressed) return { progressed: true, reason: 'challenge_or_verification' };
  } catch {}
  return { progressed: false, reason: '' };
}

async function verifySingleEmailOnPlatform(browser, email, platformName, config, log, attempt = 1) {
  let page = null;
  try {
    page = (await browser.pages())[0] || await browser.newPage();
    try { await page.setViewport({ width: 1280, height: 900 }); } catch {}
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1200);

    const inputSelectors = normalizeSelectorList(config?.selectors?.input);
    const inputFound = await findFirstVisibleSelector(page, inputSelectors, 15000);
    if (!inputFound) {
      // Sometimes challenge/redirect appears; check for error/progress before giving up
      const err = await detectPlatformNotFoundError(page, config);
      if (err.found) return { status: 'not_exists', detail: err.text };
      const prog = await detectPostEmailProgress(page, config);
      if (prog.progressed) return { status: 'verified_exists', detail: prog.reason };
      return { status: 'inconclusive', detail: 'email_input_not_found' };
    }

    // Type email
    try {
      await inputFound.handle.click({ clickCount: 3 }).catch(() => {});
      if (inputFound.type === 'css') {
        await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, inputFound.selector).catch(() => {});
        await page.type(inputFound.selector, email, { delay: 30 });
      } else {
        await inputFound.handle.evaluate(el => { el.value = ''; }).catch(() => {});
        await inputFound.handle.type(email, { delay: 30 });
      }
    } catch (e) {
      return { status: 'inconclusive', detail: `type_failed:${e.message}` };
    }

    // Click next/submit
    const nextSelectors = normalizeSelectorList(config?.selectors?.nextButton);
    let clicked = false;
    if (nextSelectors.length) clicked = await clickFirstVisibleSelector(page, nextSelectors);
    if (!clicked) {
      try { await page.keyboard.press('Enter'); clicked = true; } catch {}
    }

    // Wait for result state to settle (error OR progress). Slow loads/CAPTCHA are expected.
    const deadline = Date.now() + 25000;
    let lastDetail = 'waiting_for_result';
    while (Date.now() < deadline) {
      const err = await detectPlatformNotFoundError(page, config);
      if (err.found) return { status: 'not_exists', detail: err.text };
      const prog = await detectPostEmailProgress(page, config);
      if (prog.progressed) return { status: 'verified_exists', detail: prog.reason };

      // If email input disappeared and no error, likely progressed/loading into next step
      const stillHasInput = await findFirstVisibleSelector(page, inputSelectors, 500);
      if (!stillHasInput) {
        lastDetail = 'email_input_gone_no_error';
        // give it a bit more time to render password/challenge, but absence of error is strong
      } else {
        lastDetail = 'email_input_still_present';
      }
      await sleep(700);
    }

    // Final checks
    const errFinal = await detectPlatformNotFoundError(page, config);
    if (errFinal.found) return { status: 'not_exists', detail: errFinal.text };
    const progFinal = await detectPostEmailProgress(page, config);
    if (progFinal.progressed) return { status: 'verified_exists', detail: progFinal.reason };

    const stillHasInputFinal = await findFirstVisibleSelector(page, inputSelectors, 800);
    if (!stillHasInputFinal) {
      // Per requirement: no detected platform error after submitting email => treat as exists.
      return { status: 'verified_exists', detail: 'no_error_after_submit' };
    }

    return { status: 'inconclusive', detail: lastDetail };
  } catch (err) {
    return { status: 'inconclusive', detail: `exception:${err.message}` };
  } finally {
    try { if (page) await page.goto('about:blank').catch(() => {}); } catch {}
  }
}

async function verifyEmailWithRetries(email, platformName, config, log, maxAttempts = 2) {
  let last = { status: 'inconclusive', detail: 'not_attempted' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let browser = null;
    try {
      browser = await launchBrowser({ headless: process.env.SHOW_BROWSER === 'true' || process.env.BROWSER_VISIBLE === 'true' || process.env.VISUAL === 'true' ? false : (process.env.HEADLESS === 'false' ? false : "new") });
      last = await verifySingleEmailOnPlatform(browser, email, platformName, config, log, attempt);
      log.info(`[Row verify] ${email} @${platformName}: attempt ${attempt} => ${last.status} (${last.detail})`);
      if (last.status === 'verified_exists' || last.status === 'not_exists') return last;
    } catch (e) {
      last = { status: 'inconclusive', detail: `browser_exception:${e.message}` };
      log.warn(`[Row verify] ${email} @${platformName}: attempt ${attempt} browser error (${e.message})`);
    } finally {
      if (browser) { try { await browser.close(); } catch {} }
    }
    if (attempt < maxAttempts) await sleep(1500);
  }
  return last;
}

function isMxFinal(status) {
  return status === 'invalid_domain' || status === 'no_mx' || status === 'invalid_format' || status === 'empty';
}
function isPlatformFinal(status) {
  return status === 'verified_exists' || status === 'not_exists' || status === 'platform_no_selector';
}
function isRowValidationFinal(status, platformEligible) {
  if (!status) return false;
  if (status === 'duplicate' || status === 'social_valid' || status === 'social_no_platform') return true;
  if (isMxFinal(status)) return true;
  if (status === 'valid_mx') return !platformEligible; // valid_mx is final only when not platform-eligible
  if (isPlatformFinal(status)) return true;
  // 'unverifiable' treated as not-final to force retry unless we explicitly decide; but we avoid producing it now.
  return false;
}

async function runMxValidation({ rows, rowStart, rowEnd, emailColIdx, validationIdx, providerMXIdx, campaignId, log, fileId, mxBatchSize, onCheckpoint }) {
  const mxCache = new Map();
  let validCount = 0;
  let invalidCount = 0;
  let paused = false;
  let processedUpTo = rowStart;

  for (let i = rowStart; i < rowEnd; i++) {
    const fullIdx = i + 1;
    if (fullIdx >= rows.length) break;
    const row = rows[fullIdx];
    processedUpTo = i;

    if (await isCampaignPaused(campaignId, 'validate')) { paused = true; break; }

    const existing = String(row[validationIdx] || '').trim();
    if (existing === 'duplicate') continue;

    const email = String(row[emailColIdx] || '').trim();
    if (!email) {
      row[validationIdx] = 'empty';
      row[providerMXIdx] = row[providerMXIdx] || '';
      log.info(`[Row MX] (row ${i + 1}) empty: empty`);
      continue;
    }

    // Skip if MX already resolved (resumable)
    if (existing === 'valid_mx' || isMxFinal(existing) || isPlatformFinal(existing)) {
      if (existing === 'valid_mx') validCount++; else if (isMxFinal(existing)) invalidCount++;
      // cache domain result if possible
      const parts = email.split('@');
      if (parts.length === 2) {
        const domain = parts[1].toLowerCase().trim();
        if (domain && !mxCache.has(domain) && (existing === 'valid_mx' || isMxFinal(existing))) {
          mxCache.set(domain, { status: existing === 'valid_mx' ? 'valid_mx' : existing, mx: row[providerMXIdx] || (existing === 'valid_mx' ? '' : 'error') });
        }
      }
      continue;
    }

    const parts = email.split('@');
    if (parts.length !== 2) {
      row[validationIdx] = 'invalid_format';
      log.info(`[Row MX] ${email}: invalid_format`);
      invalidCount++;
      continue;
    }

    const domain = parts[1].toLowerCase().trim();

    if (mxCache.has(domain)) {
      const cached = mxCache.get(domain);
      row[validationIdx] = cached.status;
      row[providerMXIdx] = cached.mx;
      if (cached.status === 'valid_mx') validCount++; else invalidCount++;
      log.info(`[Row MX] ${email}: ${cached.status} (cached)`);
    } else {
      try {
        const mxRecords = await resolveMx(domain);
        if (mxRecords && mxRecords.length > 0) {
          row[validationIdx] = 'valid_mx';
          row[providerMXIdx] = mxRecords[0].exchange || 'mx';
          mxCache.set(domain, { status: 'valid_mx', mx: row[providerMXIdx] });
          log.info(`[Row MX] ${email}: valid_mx (${row[providerMXIdx]})`);
          validCount++;
        } else {
          row[validationIdx] = 'no_mx';
          row[providerMXIdx] = 'none';
          mxCache.set(domain, { status: 'no_mx', mx: 'none' });
          log.info(`[Row MX] ${email}: no_mx`);
          invalidCount++;
        }
      } catch (err) {
        row[validationIdx] = 'invalid_domain';
        row[providerMXIdx] = 'error';
        mxCache.set(domain, { status: 'invalid_domain', mx: 'error' });
        log.info(`[Row MX] ${email}: invalid_domain (${err.message})`);
        invalidCount++;
      }
    }

    if ((i - rowStart + 1) % mxBatchSize === 0) {
      if (onCheckpoint) await onCheckpoint(i + 1);
      else if (fileId) await mergeAndFlush(campaignId, 'validate', rows, fileId);
    }
  }

  return { paused, processedUpTo: paused ? processedUpTo : rowEnd, validCount, invalidCount, mxCache };
}

async function runPlatformVerification({ rows, rowStart, rowEnd, emailColIdx, validationIdx, providerMXIdx, campaignId, log, fileId, platformBatchSize, onCheckpoint }) {
  let paused = false;
  let processedUpTo = rowStart;

  // Build list of rows needing platform verification
  const pending = [];
  for (let i = rowStart; i < rowEnd; i++) {
    const fullIdx = i + 1;
    if (fullIdx >= rows.length) break;
    const row = rows[fullIdx];
    const status = String(row[validationIdx] || '').trim();
    if (status !== 'valid_mx') continue; // only verify rows still at valid_mx
    const email = String(row[emailColIdx] || '').trim();
    if (!email || !email.includes('@')) continue;
    const domain = email.split('@')[1].toLowerCase().trim();
    const platformName = detectPlatform(domain);
    if (!platformName || !platformConfigs[platformName]) continue;
    pending.push({ i, row, email, domain, platformName, config: platformConfigs[platformName] });
  }

  if (pending.length === 0) return { paused: false, processedUpTo: rowEnd, verified: 0, notExists: 0, inconclusive: 0 };

  log.info(` Platform verification: ${pending.length} eligible valid_mx row(s)`);

  const batchCount = Math.ceil(pending.length / platformBatchSize);
  let verified = 0, notExists = 0, inconclusive = 0;

  for (let b = 0; b < batchCount; b++) {
    if (await isCampaignPaused(campaignId, 'validate')) { paused = true; break; }
    const start = b * platformBatchSize;
    const end = Math.min(start + platformBatchSize, pending.length);
    const batch = pending.slice(start, end);

    for (const item of batch) {
      if (await isCampaignPaused(campaignId, 'validate')) { paused = true; break; }
      processedUpTo = item.i;

      // Re-check in case state changed
      if (String(item.row[validationIdx] || '').trim() !== 'valid_mx') continue;

      const result = await verifyEmailWithRetries(item.email, item.platformName, item.config, log, 2);
      if (result.status === 'not_exists') {
        item.row[validationIdx] = 'not_exists';
        item.row[providerMXIdx] = item.row[providerMXIdx] || item.platformName;
        notExists++;
      } else if (result.status === 'verified_exists') {
        item.row[validationIdx] = 'verified_exists';
        // keep MX host in providerMXResult if present, otherwise set platform
        if (!item.row[providerMXIdx]) item.row[providerMXIdx] = item.platformName;
        verified++;
      } else {
        // Inconclusive after retries: keep valid_mx floor (do NOT mark unverifiable/contradict valid MX)
        item.row[validationIdx] = 'valid_mx';
        inconclusive++;
        log.warn(`[Row verify] ${item.email} @${item.platformName}: inconclusive after retries (${result.detail}) - keeping valid_mx`);
      }

      // Flush periodically per row-batch checkpoint
    }

    if (paused) break;

    if (onCheckpoint) await onCheckpoint(batch[batch.length - 1].i + 1);
    else if (fileId) await mergeAndFlush(campaignId, 'validate', rows, fileId);
  }

  return { paused, processedUpTo: paused ? processedUpTo : rowEnd, verified, notExists, inconclusive };
}

function computeValidationStats(dataRows, validationIdx) {
  const stats = {
    total: dataRows.length,
    duplicates: 0,
    empty: 0,
    invalidFormat: 0,
    validMx: 0,
    invalidMx: 0,
    verifiedExists: 0,
    notExists: 0,
    unverifiable: 0,
    socialValid: 0,
    pending: 0,
  };
  for (const r of dataRows) {
    const s = String(r[validationIdx] || '').trim();
    if (!s) { stats.pending++; continue; }
    if (s === 'duplicate') stats.duplicates++;
    else if (s === 'empty') stats.empty++;
    else if (s === 'invalid_format') stats.invalidFormat++;
    else if (s === 'valid_mx') stats.validMx++;
    else if (s === 'invalid_domain' || s === 'no_mx') stats.invalidMx++;
    else if (s === 'verified_exists') stats.verifiedExists++;
    else if (s === 'not_exists') stats.notExists++;
    else if (s === 'unverifiable') stats.unverifiable++;
    else if (s === 'social_valid' || s === 'social_no_platform') stats.socialValid++;
    else stats.pending++;
  }
  return stats;
}

function isValidationFullyComplete(dataRows, emailColIdx, validationIdx) {
  for (const row of dataRows) {
    const status = String(row[validationIdx] || '').trim();
    if (!status) return false;
    if (status === 'valid_mx') {
      const email = String(row[emailColIdx] || '').trim();
      const domain = email.includes('@') ? email.split('@')[1].toLowerCase().trim() : '';
      const platformEligible = domain ? !!detectPlatform(domain) : false;
      if (platformEligible) return false; // still needs platform verification
    }
    // any non-final transitional states
    if (status === 'unverifiable' || status === 'processing') return false;
  }
  return true;
}

export async function POST(request) {
  let browser = null;
  let log = logger.child({ campaignId: null, stage: 'validate' });
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const { campaignId, fileUrl, serverBatch } = body;

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    log = logger.child({ campaignId, stage: 'validate' });
    log.info(`Received validation request${serverBatch ? ` [worker rowStart=${serverBatch.rowStart} rowEnd=${serverBatch.rowEnd}]` : ''}`);

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
    }

    // USER tier — monthly validateUsage gate
    let stageUserId = body.settings?.userId || body.userId || null;
    if (!stageUserId) {
      try { stageUserId = (await getCampaignSettings(campaignId))?.userId || null; } catch (e) { /* fail open */ }
    }
    if (stageUserId) {
      const quota = await checkUserQuota(stageUserId, { keys: ["validateUsage"] });
      if (!quota.allowed) {
        log.info(`[user-limit] ${quota.reason} — blocking validation for ${campaignId}`);
        await updateCampaignSettings(campaignId, { validationStatus: "completed" });
        return NextResponse.json({ success: true, limitReached: true, userMonthlyLimit: true, message: `Validation blocked: ${quota.reason}` });
      }
    }

    if (serverBatch) {
      return await handleWorkerMode(campaignId, fileId, serverBatch, log);
    }

    return await handleCoordinatorMode(campaignId, fileId, fileUrl, log, stageUserId);

  } catch (error) {
    (log || logger).error(`Error: ${error.message}`, { stack: error.stack });
    // On error, do NOT mark completed; leave as failed/retryable so orchestrator doesn't advance incorrectly
    try {
      if (campaignId) await updateCampaignSettings(campaignId, { validationStatus: "failed" });
    } catch {}
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function handleCoordinatorMode(campaignId, fileId, fileUrl, log, stageUserId) {
  const perfLevelSetting = await getSetting('performanceLevel');
  const perfPresets = getPerformancePresets(perfLevelSetting?.value1 || 'balanced');

  const mxBatchSetting = await getSetting('validateBatchLimit');
  const MX_BATCH_SIZE = parseInt(mxBatchSetting?.value1) || perfPresets.validateMxBatchLimit;
  const platformBatchSetting = await getSetting('platformVerificationBatchLimit');
  const PLATFORM_BATCH_SIZE = parseInt(platformBatchSetting?.value1) || perfPresets.validatePlatformBatchLimit;
  const platformEnabledSetting = await getSetting('platformVerificationEnabled');
  const PLATFORM_VERIFICATION_ENABLED = platformEnabledSetting?.value1 !== 'false';

  log.info(` Downloading CSV file: ${fileId}`);
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  const csvContent = dl.content;
  const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

  const normalizedRows = normalizeAndMapCSV(cleanContent, STANDARD_88_COLUMNS);
  if (normalizedRows.length <= 1) {
    throw new Error("CSV file is empty or contains no data rows after normalization");
  }

  const headers = normalizedRows[0];
  const emailColIdx = headers.indexOf("EMAIL");
  const validationIdx = headers.indexOf("validation");
  const providerMXIdx = headers.indexOf("providerMXResult");
  if (emailColIdx === -1) throw new Error("EMAIL column not found in 88-column schema");

  const dataRows = normalizedRows.slice(1);

  // Per-run cap from SETTINGS (validateBatchLimit)
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.validateLimit > 0)) {
    log.info(` validateBatchLimit is 0 or unavailable, blocking validation`);
    return NextResponse.json({ success: true, limitReached: true, message: "Validation blocked: validateBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const originalCount = dataRows.length;
  let limitApplied = false;
  if (dataRows.length > campaignLimits.validateLimit) {
    dataRows.length = campaignLimits.validateLimit;
    normalizedRows.length = campaignLimits.validateLimit + 1; // header + limited rows
    limitApplied = true;
    log.info(` validateLimit (${campaignLimits.validateLimit}) applied: ${originalCount} → ${dataRows.length} rows`);
  }

  // Dedup by email (only for rows not already finalized as duplicate)
  const uniqueEmails = new Map();
  let duplicateCount = 0;
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const existing = String(row[validationIdx] || '').trim();
    const email = String(row[emailColIdx] || '').trim().toLowerCase();
    if (!email) continue;
    if (existing === 'duplicate') { duplicateCount++; uniqueEmails.set(email, i); continue; }
    if (uniqueEmails.has(email)) {
      // don't overwrite if this row is already fully finalized for some reason; but duplicates take precedence as dedup marker
      row[validationIdx] = "duplicate";
      log.info(`[Row ${i + 1}] ${email}: duplicate`);
      duplicateCount++;
    } else {
      uniqueEmails.set(email, i);
    }
  }
  if (duplicateCount > 0) log.info(` Marked/kept ${duplicateCount} duplicate emails`);

  // Social channel validation (only where not already finalized by email validation)
  const socialPlatformIdx = headers.indexOf("SOCIALPLATFORM");
  const socialUsernameIdx = headers.indexOf("SOCIALUSERNAME");
  if (socialPlatformIdx !== -1 && socialUsernameIdx !== -1) {
    for (const row of dataRows) {
      const v = String(row[validationIdx] || '').trim();
      if (v === "duplicate") continue;
      const email = String(row[emailColIdx] || '').trim();
      const socialUsername = String(row[socialUsernameIdx] || '').trim();
      const socialPlatform = String(row[socialPlatformIdx] || '').trim();
      if (!email && socialUsername && !v) {
        row[validationIdx] = socialPlatform ? "social_valid" : "social_no_platform";
        log.info(`[Row social] ${socialUsername}@${socialPlatform || 'unknown'}: ${row[validationIdx]}`);
      }
    }
  }

  // Mark processing (do not mark completed yet)
  await updateCampaignSettings(campaignId, { validationStatus: "processing" });

  // Multi-server dispatch (only if starting fresh enough? keep existing behavior)
  if (await isMultiServerEnabled()) {
    const dispatchResult = await dispatchToServers(campaignId, 'validate', fileUrl, dataRows.length);
    if (dispatchResult) {
      return NextResponse.json({
        success: true,
        processing: true,
        message: `Campaign validation distributed across ${dispatchResult.servers.length} servers`,
        dispatched: true,
        servers: dispatchResult.servers,
      });
    }
  }

  log.info(` MX batch=${MX_BATCH_SIZE}, platform batch=${PLATFORM_BATCH_SIZE}, platform verification=${PLATFORM_VERIFICATION_ENABLED}`);
  log.info(` Processing ${dataRows.length} rows (single-server)`);

  // MX validation (resumable - skips finalized rows)
  const mxResult = await runMxValidation({
    rows: normalizedRows,
    rowStart: 0,
    rowEnd: dataRows.length,
    emailColIdx, validationIdx, providerMXIdx,
    campaignId, log, fileId,
    mxBatchSize: MX_BATCH_SIZE,
  });

  if (mxResult.paused || await isCampaignPaused(campaignId, 'validate')) {
    await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId).catch(() => uploadCsvText(fileId, stringifyCSV(normalizedRows)).catch(()=>{}));
    await updateCampaignSettings(campaignId, { validationStatus: "processing" });
    return NextResponse.json({ success: true, processing: true, paused: true, message: "Validation paused during MX check", stats: computeValidationStats(dataRows, validationIdx) });
  }

  // Flush after MX
  await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId).catch(() => uploadCsvText(fileId, stringifyCSV(normalizedRows)).catch(()=>{}));

  // Platform verification (only for rows still valid_mx and eligible)
  let platformResult = { paused: false, verified: 0, notExists: 0, inconclusive: 0 };
  if (PLATFORM_VERIFICATION_ENABLED) {
    platformResult = await runPlatformVerification({
      rows: normalizedRows,
      rowStart: 0,
      rowEnd: dataRows.length,
      emailColIdx, validationIdx, providerMXIdx,
      campaignId, log, fileId,
      platformBatchSize: Math.max(1, PLATFORM_BATCH_SIZE),
    });
  }

  if (platformResult.paused || await isCampaignPaused(campaignId, 'validate')) {
    await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId).catch(() => uploadCsvText(fileId, stringifyCSV(normalizedRows)).catch(()=>{}));
    await updateCampaignSettings(campaignId, { validationStatus: "processing" });
    return NextResponse.json({ success: true, processing: true, paused: true, message: "Validation paused during platform verification", stats: computeValidationStats(dataRows, validationIdx) });
  }

  // Final flush
  await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId).catch(() => uploadCsvText(fileId, stringifyCSV(normalizedRows)).catch(()=>{}));

  const complete = isValidationFullyComplete(dataRows, emailColIdx, validationIdx);
  const stats = computeValidationStats(dataRows, validationIdx);
  log.info(` Validation stats: ${JSON.stringify(stats)} complete=${complete}`);

  if (!complete) {
    // Do NOT mark completed or advance; leave for retry/resume
    await updateCampaignSettings(campaignId, { validationStatus: "processing" });
    return NextResponse.json({
      success: true,
      processing: true,
      completed: false,
      message: "Validation incomplete - some rows still pending platform verification",
      stats,
    });
  }

  // Only now mark completed
  await updateCampaignSettings(campaignId, { validationStatus: "completed" });

  // Usage accounting (single-server run)
  if (stageUserId && dataRows.length > 0) {
    try { await updateUserUsage(stageUserId, "validateUsage", dataRows.length); } catch (e) { log.warn(`[user-limit] validateUsage increment failed: ${e.message}`); }
  }

  return NextResponse.json({ success: true, completed: true, message: "Campaign email validation completed successfully", stats, limitApplied, originalCount: originalCount, processedCount: dataRows.length });
}

async function handleWorkerMode(campaignId, fileId, serverBatch, log) {
  const myAssignment = await findMyAssignment(campaignId, 'validate');
  if (!myAssignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  }

  await updateMyAssignment(campaignId, 'validate', { status: 'running' });

  const perfLevelSetting = await getSetting('performanceLevel');
  const perfPresets = getPerformancePresets(perfLevelSetting?.value1 || 'balanced');

  const mxBatchSetting = await getSetting('validateBatchLimit');
  const MX_BATCH_SIZE = parseInt(mxBatchSetting?.value1) || perfPresets.validateMxBatchLimit;
  const platformBatchSetting = await getSetting('platformVerificationBatchLimit');
  const PLATFORM_BATCH_SIZE = parseInt(platformBatchSetting?.value1) || perfPresets.validatePlatformBatchLimit;
  const platformEnabledSetting = await getSetting('platformVerificationEnabled');
  const PLATFORM_VERIFICATION_ENABLED = platformEnabledSetting?.value1 !== 'false';

  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  const csvContent = dl.content;
  const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

  const normalizedRows = normalizeAndMapCSV(cleanContent, STANDARD_88_COLUMNS);
  if (normalizedRows.length <= 1) throw new Error("CSV empty after normalization");

  const headers = normalizedRows[0];
  const emailColIdx = headers.indexOf("EMAIL");
  const validationIdx = headers.indexOf("validation");
  const providerMXIdx = headers.indexOf("providerMXResult");
  if (emailColIdx === -1) throw new Error("EMAIL column not found");

  const { rowStart, rowEnd } = serverBatch;
  log.info(`[Worker] Processing rows ${rowStart}-${rowEnd - 1}`);

  let wasPaused = false;
  let mxResult = { validCount: 0, invalidCount: 0 };
  let platformResult = { paused: false };

  try {
    mxResult = await runMxValidation({
      rows: normalizedRows,
      rowStart, rowEnd,
      emailColIdx, validationIdx, providerMXIdx,
      campaignId, log, fileId,
      mxBatchSize: MX_BATCH_SIZE,
      onCheckpoint: async (processedUpTo) => {
        await updateMyAssignment(campaignId, 'validate', { processedUpTo });
        await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId);
      }
    });

    if (mxResult.paused || await isCampaignPaused(campaignId, 'validate')) {
      wasPaused = true;
    } else if (PLATFORM_VERIFICATION_ENABLED) {
      platformResult = await runPlatformVerification({
        rows: normalizedRows,
        rowStart, rowEnd,
        emailColIdx, validationIdx, providerMXIdx,
        campaignId, log, fileId,
        platformBatchSize: Math.max(1, PLATFORM_BATCH_SIZE),
        onCheckpoint: async (processedUpTo) => {
          await updateMyAssignment(campaignId, 'validate', { processedUpTo });
          await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId);
        }
      });
      if (platformResult.paused || await isCampaignPaused(campaignId, 'validate')) wasPaused = true;
    }
  } catch (error) {
    log.error(`[Worker] Error: ${error.message}`, { stack: error.stack });
    await updateMyAssignment(campaignId, 'validate', { status: 'failed', error: error.message });
    throw error;
  }

  await mergeAndFlush(campaignId, 'validate', normalizedRows, fileId).catch(() => uploadCsvText(fileId, stringifyCSV(normalizedRows)).catch(()=>{}));

  const assignmentUpdates = {
    status: wasPaused ? 'paused' : 'completed',
    processedUpTo: wasPaused ? Math.max(rowStart, mxResult.processedUpTo || rowStart) : rowEnd,
    validMx: mxResult.validCount || 0,
    invalidMx: mxResult.invalidCount || 0,
  };
  await updateMyAssignment(campaignId, 'validate', assignmentUpdates);

  // Only mark campaign complete / advance if all workers done AND this worker actually completed
  if (!wasPaused) {
    const allDone = await checkAllComplete(campaignId, 'validate');
    if (allDone) {
      // Verify global completion before marking/advancing
      const allDataRows = normalizedRows.slice(1);
      const complete = isValidationFullyComplete(allDataRows, emailColIdx, validationIdx);
      if (complete) {
        await updateCampaignSettings(campaignId, { validationStatus: "completed" });
        log.info(` All workers complete — validation finished`);
        try {
          const selfUrl = getSelfUrlWithFallback();
          fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaignId })
          }).catch(err => log.warn(` Worker auto-advance failed: ${err.message}`));
        } catch {}
      } else {
        await updateCampaignSettings(campaignId, { validationStatus: "processing" });
        log.warn(` All worker assignments done but validation rows still incomplete; leaving in processing`);
      }
    }
  }

  return NextResponse.json({
    success: true,
    completed: !wasPaused,
    paused: wasPaused,
    message: `Worker ${wasPaused ? 'paused' : 'completed'} validation for rows ${rowStart}-${rowEnd - 1}`,
    stats: { validMx: mxResult.validCount || 0, invalidMx: mxResult.invalidCount || 0, allComplete: false },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
