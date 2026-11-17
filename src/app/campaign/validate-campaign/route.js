import { NextResponse } from "next/server";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";
import dns from "dns";
import { promisify } from "util";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { launchBrowser } from "../../../utils/utils.js";
import { platformConfigs } from "../../emails/cookie/cookie-api-login/platforms.js";
import { detectGmailIdentifierError } from "../../emails/_shared/gmailIdentifierError.js";
import { CANONICAL_CSV_COLUMNS } from "../_shared/campaignCsvSchema.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings, startStageLease } from "../_shared/pipelineUtils.js";
import { getSelfUrl, getSelfUrlWithFallback, getInternalSelfUrl, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits, checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 0;
export const dynamic = "force-dynamic";

const STANDARD_88_COLUMNS = CANONICAL_CSV_COLUMNS;

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

// Provider-agnostic, evidence-based error signals. These are UI strings from the
// sign-in page itself (never fabricated row data); they complement the per-platform
// selectors in platformConfigs and cover localized/redesigned Google/Microsoft pages.
const PLATFORM_ERROR_PATTERNS = [
  // Google may render U+2019 (curly apostrophe) instead of a straight one.
  /couldn['’]?t find (?:this|your|the) (?:google )?account/i,
  /could not find (?:this|your|the) (?:google )?account/i,
  /that (?:microsoft|msn|outlook|hotmail) account doesn['’]?t exist/i,
  /(?:account|email|user) does not exist/i,
  /no (?:account|user) (?:exists|found)/i,
  /we couldn['’]?t find an account/i,
  /enter a valid email/i,
  /enter an email address/i,
  /invalid email address/i,
  /email (?:address )?not found/i,
];

async function detectGenericPlatformError(page) {
  try {
    return await page.evaluate((patternSources) => {
      const regexes = patternSources.map(s => new RegExp(s, 'i'));
      const nodes = document.querySelectorAll('[role="alert"], [aria-live="polite"], [aria-live="assertive"], [class*="error" i], [data-testid*="error" i]');
      let best = null;
      for (const el of nodes) {
        if (!el || el.nodeType !== 1) continue;
        const tag = (el.tagName || '').toLowerCase();
        if (tag === 'html' || tag === 'body' || tag === 'script' || tag === 'style') continue;
        if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') continue;
        const cs = window.getComputedStyle(el);
        if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 300) continue;
        if (!regexes.some(re => re.test(text))) continue;
        if (!best || text.length < best.len) best = { len: text.length, text };
      }
      return best ? { found: true, text: best.text } : { found: false, text: '' };
    }, PLATFORM_ERROR_PATTERNS.map(p => p.source));
  } catch { return { found: false, text: '' }; }
}

// Google renders identifier errors inside a CLOSED shadow DOM (jsshadow), so
// DOM-only/XPath checks miss them. Detection is delegated to the shared helper.
// Gmail identifier errors use the SAME shared detector as the cookie-login flow
// (emails/_shared/gmailIdentifierError.js) - no duplicated heuristics here.

async function detectPlatformNotFoundError(page, config) {
  const isGoogle = !!(config?.mxKeywords || []).some(k => /google|gmail/i.test(k))
    || /accounts\.google\.com/i.test(String(config?.url || ''));
  if (isGoogle) {
    const gmailErr = await detectGmailIdentifierError(page, 'validate', false, logger);
    if (gmailErr.found) return { found: true, text: gmailErr.text, code: gmailErr.code || null };
  }
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
  // Structural + text-based fallback for redesigned/localized pages.
  return detectGenericPlatformError(page);
}

async function hasVisibleSelectorNow(page, selectors) {
  for (const sel of normalizeSelectorList(selectors)) {
    if (typeof sel !== 'string') continue;
    try {
      if (sel.startsWith('//') || sel.startsWith('(//')) {
        const handles = await page.$x(sel);
        for (const h of handles) if (await isVisibleHandle(h)) return true;
      } else {
        const h = await page.$(sel);
        if (h && await isVisibleHandle(h)) return true;
      }
    } catch {}
  }
  return false;
}

// Snapshot of the page AFTER submitting the identifier. `verified_exists` may only
// be inferred from an observable transition (password step, challenge, or the
// identifier step actually being replaced) - never from the word "password"
// somewhere in the page body, which is present on Google's page before submit.
async function readPostSubmitState(page, config, inputSelectors) {
  const inputFound = await findFirstVisibleSelector(page, inputSelectors, 500);
  let inputValue = '';
  if (inputFound) {
    try { inputValue = String(await inputFound.handle.evaluate(el => el.value || '')).trim(); } catch {}
  }
  const passwordVisible = await hasVisibleSelectorNow(page, [
    ...normalizeSelectorList(config?.selectors?.passwordInput),
    'input[type="password"]'
  ]);
  const challengeVisible = await hasVisibleSelectorNow(page, [
    ...normalizeSelectorList(config?.selectors?.verificationCodeInput),
    ...normalizeSelectorList(config?.selectors?.gmailEmailCodeInput),
    ...normalizeSelectorList(config?.selectors?.smsCodeInput),
    ...normalizeSelectorList(config?.selectors?.phoneNumberInput),
    'input[type="tel"][name="ca"]', '#idvPinId', '#iOttText', 'input[id^="codeEntry-"]'
  ]);
  const captchaVisible = await hasVisibleSelectorNow(page, [
    'iframe[src*="recaptcha"]', '.g-recaptcha', '#captchaimg', 'img[alt*="captcha" i]'
  ]);
  return {
    url: page.url(),
    inputVisible: !!inputFound,
    inputValue,
    passwordVisible,
    challengeVisible,
    captchaVisible
  };
}

// A visible password field / challenge / captcha, or the identifier step actually
// being replaced by a different URL, is real evidence the email was accepted.
// The old `document.body.innerText.includes('password')` signal was a false
// positive: Google's identifier page already contains "Forgot password?".
function classifyPostSubmitState(state, initialUrl, transitionVotes) {
  if (state.passwordVisible) return { status: 'verified_exists', detail: 'password_step_visible' };
  // A page still sitting on the identifier step has NOT accepted the email,
  // even if a generic code/captcha selector happens to be present.
  if (state.url && state.url.includes('/signin/identifier')) return null;
  if (state.challengeVisible || state.captchaVisible) return { status: 'verified_exists', detail: 'challenge_visible' };
  if (!state.inputVisible && state.url && initialUrl && state.url !== initialUrl && transitionVotes >= 2) {
    return { status: 'verified_exists', detail: 'identifier_step_transitioned' };
  }
  return null;
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
      // Sometimes a challenge/redirect appears before we can find the identifier input.
      const err = await detectPlatformNotFoundError(page, config);
      if (err.found) return {
        status: 'not_exists',
        detail: err.code === 'ACCOUNT_DELETED' ? 'platform_error:Account deleted' : `platform_error:${err.text}`,
      };
      const state = await readPostSubmitState(page, config, inputSelectors);
      const accepted = classifyPostSubmitState(state, config.url, 2);
      if (accepted) return accepted;
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

    // Confirm the identifier actually holds the value we typed before submitting.
    let typedValue = '';
    try {
      typedValue = String(await inputFound.handle.evaluate(el => el.value || '')).trim().toLowerCase();
    } catch {}
    if (typedValue && typedValue !== String(email).trim().toLowerCase()) {
      return { status: 'inconclusive', detail: 'email_input_mismatch' };
    }

    const initialUrl = page.url();
    const nextSelectors = normalizeSelectorList(config?.selectors?.nextButton);
    let clicked = false;
    if (nextSelectors.length) clicked = await clickFirstVisibleSelector(page, nextSelectors);
    if (!clicked) {
      try { await page.keyboard.press('Enter'); clicked = true; } catch {}
    }

    // Mirror the proven cookie-login sequence instead of a long generic poll:
    // readyState (2s) -> 300ms -> transition selector (2s) -> 300ms ->
    // error detector (shared with cookie-login) -> observable transition ->
    // short bounded settle for slow redirects. No 25s loop / 2x retries.
    const isGoogle = /accounts\.google\.com/i.test(String(config?.url || ''))
      || (config?.mxKeywords || []).some(k => /google|gmail/i.test(k));
    const transitionSelectors = [
      "[data-testid='title']", "input[name='passwd']", "input[type='password']",
      '#proof-confirmation-email-input', 'h1',
    ];
    let lastDetail = 'waiting_for_result';
    let transitionVotes = 0;

    try {
      await Promise.race([
        page.waitForFunction(() => document.readyState === 'complete').catch(() => null),
        new Promise(res => setTimeout(res, 2000)),
      ]);
    } catch {}
    await sleep(300);

    try {
      await page.waitForSelector(transitionSelectors.join(', '), {
        visible: true,
        timeout: isGoogle ? 2000 : 4000,
      });
    } catch {}
    await sleep(300);

    // Error first. For Gmail this calls the shared detector (accessibility tree
    // -> TreeWalker -> behavioral fallback), including U+2019 apostrophes.
    const err = await detectPlatformNotFoundError(page, config);
    if (err.found) return {
        status: 'not_exists',
        detail: err.code === 'ACCOUNT_DELETED' ? 'platform_error:Account deleted' : `platform_error:${err.text}`,
      };

    const state = await readPostSubmitState(page, config, inputSelectors);
    const accepted = classifyPostSubmitState(state, initialUrl, 2);
    if (accepted) return accepted;

    const settleDeadline = Date.now() + (isGoogle ? 2500 : 10000);
    while (Date.now() < settleDeadline) {
      const st = await readPostSubmitState(page, config, inputSelectors);
      const acc = classifyPostSubmitState(st, initialUrl, transitionVotes);
      if (acc) return acc;
      const urlChanged = !!(st.url && initialUrl && st.url !== initialUrl);
      transitionVotes = (!st.inputVisible && urlChanged) ? transitionVotes + 1 : 0;
      lastDetail = `url_changed=${urlChanged},input_visible=${st.inputVisible}`;
      await sleep(400);
    }

    // Final error check (the detector's behavioral pass adds its own 1.5s confirm).
    const errFinal = await detectPlatformNotFoundError(page, config);
    if (errFinal.found) return {
      status: 'not_exists',
      detail: errFinal.code === 'ACCOUNT_DELETED' ? 'platform_error:Account deleted' : `platform_error:${errFinal.text}`,
    };
    const stateFinal = await readPostSubmitState(page, config, inputSelectors);
    const acceptedFinal = classifyPostSubmitState(stateFinal, initialUrl, Math.max(transitionVotes, 2));
    if (acceptedFinal) return acceptedFinal;

    // Diagnostic payload for any future miss.
    let visibleText = '';
    try {
      visibleText = await page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
    } catch {}
    log.warn(`[Row verify] ${email} @${platformName}: inconclusive detail=${lastDetail} url=${String(page.url()).slice(0, 140)} text=${visibleText}`);

    return { status: 'inconclusive', detail: `no_confirmation:${lastDetail}` };
  } catch (err) {
    return { status: 'inconclusive', detail: `exception:${err.message}` };
  } finally {
    try { if (page) await page.goto('about:blank').catch(() => {}); } catch {}
  }
}

async function verifyEmailWithBrowser(browser, email, platformName, config, log, attempt = 1) {
  try {
    const res = await verifySingleEmailOnPlatform(browser, email, platformName, config, log, attempt);
    log.info(`[Row verify] ${email} @${platformName}: attempt ${attempt} => ${res.status} (${res.detail})`);
    return res;
  } catch (e) {
    log.warn(`[Row verify] ${email} @${platformName}: attempt ${attempt} browser error (${e.message})`);
    return { status: 'inconclusive', detail: `browser_exception:${e.message}` };
  }
}

async function verifyEmailWithRetriesOnSameBrowser(getBrowser, email, platformName, config, log, maxAttempts = 2) {
  let last = { status: 'inconclusive', detail: 'not_attempted' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const browser = await getBrowser();
    if (!browser) {
      last = { status: 'inconclusive', detail: 'browser_unavailable' };
      break;
    }
    last = await verifyEmailWithBrowser(browser, email, platformName, config, log, attempt);
    if (last.status === 'verified_exists' || last.status === 'not_exists') return last;
    if (attempt < maxAttempts) await sleep(1200);
  }
  return last;
}

const PLATFORM_CHECKED_INCONCLUSIVE = '|pv=inconclusive';function hasPlatformInconclusiveMarker(row, providerMXIdx) {
  return String(row?.[providerMXIdx] || '').includes(PLATFORM_CHECKED_INCONCLUSIVE);
}
function markPlatformInconclusive(row, providerMXIdx, platformName) {
  const base = String(row[providerMXIdx] || platformName || 'mx')
    .replace(/\s*\|pv=[^|]*$/g, '')
    .trim();
  row[providerMXIdx] = `${base}${PLATFORM_CHECKED_INCONCLUSIVE}`;
}

// Persist a short, auditable reason next to the MX result so the CSV itself shows
// WHY a row was accepted/rejected by platform verification (e.g. password step,
// provider error text). Identifiers are never rewritten by this marker.
function attachPlatformEvidence(row, providerMXIdx, result) {
  const base = String(row[providerMXIdx] || '')
    .replace(PLATFORM_CHECKED_INCONCLUSIVE, '')
    .replace(/\s*\|pv=[^|]*$/g, '')
    .trim();
  const status = String(result?.status || 'unknown').replace(/[|\r\n]/g, '');
  const detail = String(result?.detail || 'unknown').replace(/[|\r\n]/g, ' ').slice(0, 120);
  row[providerMXIdx] = `${base}|pv=${status}:${detail}`.trim();
}
function isMxFinal(status) {
  return status === 'invalid_domain' || status === 'no_mx' || status === 'invalid_format' || status === 'empty';
}
function isPlatformFinal(status) {
  return status === 'verified_exists' || status === 'not_exists' || status === 'platform_no_selector';
}
function isRowValidationFinal(status, platformEligible, platformCheckedInconclusive = false) {
  if (!status) return false;
  if (status === 'duplicate' || status === 'social_valid' || status === 'social_no_platform') return true;
  if (isMxFinal(status)) return true;
  if (status === 'valid_mx') return !platformEligible || platformCheckedInconclusive; // inconclusive after platform check => terminal resolved valid_mx
  if (isPlatformFinal(status)) return true;
  return false;
}

async function flushValidationCsv(campaignId, rows, fileId, log) {
  try {
    await mergeAndFlush(campaignId, 'validate', rows, fileId);
  } catch (e) {
    log?.warn?.(`[validate] CSV flush failed: ${e.message} - retrying direct upload`);
    await uploadCsvText(fileId, stringifyCSV(rows));
  }
}

async function mapWithConcurrency(items, concurrency, fn) {
  const limit = Math.max(1, parseInt(concurrency, 10) || 1);
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      try { results[idx] = await fn(items[idx], idx); }
      catch (e) { results[idx] = { __error: e }; }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function resolveMxCached(domain, mxCache) {
  if (mxCache.has(domain)) return mxCache.get(domain);
  try {
    const mxRecords = await resolveMx(domain);
    if (mxRecords && mxRecords.length > 0) {
      const val = { status: 'valid_mx', mx: mxRecords[0].exchange || 'mx' };
      mxCache.set(domain, val);
      return val;
    }
    const val = { status: 'no_mx', mx: 'none' };
    mxCache.set(domain, val);
    return val;
  } catch (err) {
    const val = { status: 'invalid_domain', mx: 'error', err: err.message };
    mxCache.set(domain, val);
    return val;
  }
}

async function runMxValidation({ rows, rowStart, rowEnd, emailColIdx, validationIdx, providerMXIdx, campaignId, log, fileId, mxBatchSize, onCheckpoint }) {
  const mxCache = new Map();
  let validCount = 0;
  let invalidCount = 0;
  let paused = false;
  const concurrency = Math.max(1, parseInt(mxBatchSize, 10) || 1);

  // Prefill cache from already-resolved rows in range (resumable)
  for (let i = rowStart; i < rowEnd; i++) {
    const fullIdx = i + 1;
    if (fullIdx >= rows.length) break;
    const row = rows[fullIdx];
    const existing = String(row[validationIdx] || '').trim();
    const email = String(row[emailColIdx] || '').trim();
    if (existing === 'valid_mx' || isMxFinal(existing) || isPlatformFinal(existing)) {
      if (existing === 'valid_mx') validCount++; else if (isMxFinal(existing)) invalidCount++;
      const parts = email.split('@');
      if (parts.length === 2) {
        const domain = parts[1].toLowerCase().trim();
        if (domain && !mxCache.has(domain)) {
          mxCache.set(domain, { status: existing === 'valid_mx' ? 'valid_mx' : existing, mx: row[providerMXIdx] || (existing === 'valid_mx' ? '' : 'error') });
        }
      }
    }
  }

  const pendingIndexes = [];
  for (let i = rowStart; i < rowEnd; i++) {
    const fullIdx = i + 1;
    if (fullIdx >= rows.length) break;
    const row = rows[fullIdx];
    const existing = String(row[validationIdx] || '').trim();
    if (existing === 'duplicate') continue;
    const email = String(row[emailColIdx] || '').trim();
    if (!email) {
      row[validationIdx] = 'empty';
      row[providerMXIdx] = row[providerMXIdx] || '';
      log.info(`[Row MX] (row ${i + 1}) empty: empty`);
      continue;
    }
    if (existing === 'valid_mx' || isMxFinal(existing) || isPlatformFinal(existing)) continue;
    pendingIndexes.push(i);
  }

  for (let cursor = 0; cursor < pendingIndexes.length; cursor += concurrency) {
    if (await isCampaignPaused(campaignId, 'validate')) { paused = true; break; }
    const wave = pendingIndexes.slice(cursor, cursor + concurrency);

    // Resolve unique domains in parallel for this wave
    const domainsToResolve = [];
    const seen = new Set();
    for (const i of wave) {
      const row = rows[i + 1];
      const email = String(row[emailColIdx] || '').trim();
      const parts = email.split('@');
      if (parts.length !== 2) continue;
      const domain = parts[1].toLowerCase().trim();
      if (!domain || mxCache.has(domain) || seen.has(domain)) continue;
      seen.add(domain);
      domainsToResolve.push(domain);
    }
    await mapWithConcurrency(domainsToResolve, concurrency, async (domain) => resolveMxCached(domain, mxCache));

    // Apply results
    for (const i of wave) {
      const fullIdx = i + 1;
      const row = rows[fullIdx];
      const email = String(row[emailColIdx] || '').trim();
      const parts = email.split('@');
      if (parts.length !== 2) {
        row[validationIdx] = 'invalid_format';
        log.info(`[Row MX] ${email}: invalid_format`);
        invalidCount++;
        continue;
      }
      const domain = parts[1].toLowerCase().trim();
      const cached = mxCache.get(domain);
      if (!cached) continue;
      row[validationIdx] = cached.status;
      row[providerMXIdx] = cached.mx;
      if (cached.status === 'valid_mx') {
        validCount++;
        log.info(`[Row MX] ${email}: valid_mx (${cached.mx})`);
      } else {
        invalidCount++;
        log.info(`[Row MX] ${email}: ${cached.status}${cached.err ? ` (${cached.err})` : ''}`);
      }
    }

    // checkpoint/flush each wave
    if (onCheckpoint) await onCheckpoint(Math.min(wave[wave.length - 1] + 1, rowEnd));
    else if (fileId) await flushValidationCsv(campaignId, rows, fileId, log);
  }

  return { paused, processedUpTo: paused ? -1 : rowEnd, validCount, invalidCount, mxCache };
}

async function runPlatformVerification({ rows, rowStart, rowEnd, emailColIdx, validationIdx, providerMXIdx, campaignId, log, fileId, platformBatchSize, onCheckpoint }) {
  let paused = false;
  const maxWorkers = Math.max(1, parseInt(platformBatchSize, 10) || 1);

  // Build pending rows grouped by platform (skip already-checked inconclusive terminal)
  const groups = new Map(); // platformName -> { config, items: [] }
  let pendingCount = 0;
  for (let i = rowStart; i < rowEnd; i++) {
    const fullIdx = i + 1;
    if (fullIdx >= rows.length) break;
    const row = rows[fullIdx];
    const status = String(row[validationIdx] || '').trim();
    if (status !== 'valid_mx') continue; // only verify rows still at valid_mx
    if (hasPlatformInconclusiveMarker(row, providerMXIdx)) continue; // terminal resolved
    const email = String(row[emailColIdx] || '').trim();
    if (!email || !email.includes('@')) continue;
    const domain = email.split('@')[1].toLowerCase().trim();
    const platformName = detectPlatform(domain);
    if (!platformName || !platformConfigs[platformName]) continue;
    if (!groups.has(platformName)) groups.set(platformName, { platformName, config: platformConfigs[platformName], items: [] });
    groups.get(platformName).items.push({ i, row, email, domain, platformName, config: platformConfigs[platformName] });
    pendingCount++;
  }

  if (pendingCount === 0) return { paused: false, processedUpTo: rowEnd, verified: 0, notExists: 0, inconclusive: 0 };

  const groupList = Array.from(groups.values());
  const workerCount = Math.min(maxWorkers, groupList.length);
  log.info(` Platform verification: ${pendingCount} eligible row(s) across ${groupList.length} platform(s), workers=${workerCount} (batch=${maxWorkers})`);

  let verified = 0, notExists = 0, inconclusive = 0;
  let queueIdx = 0;

  async function flushCheckpoint(lastIdx) {
    const idx = Math.max(0, lastIdx || rowEnd);
    if (onCheckpoint) await onCheckpoint(idx);
    else if (fileId) await flushValidationCsv(campaignId, rows, fileId, log);
  }

  async function runWorker(workerId) {
    while (true) {
      if (paused) break;
      if (await isCampaignPaused(campaignId, 'validate')) { paused = true; break; }
      const myIdx = queueIdx++;
      if (myIdx >= groupList.length) break;
      const group = groupList[myIdx];
      let browser = null;

      const ensureBrowser = async () => {
        if (browser && browser.isConnected && browser.isConnected()) return browser;
        if (browser) { try { await browser.close(); } catch {} }
        try {
          browser = await launchBrowser({ headless: process.env.SHOW_BROWSER === 'true' || process.env.BROWSER_VISIBLE === 'true' || process.env.VISUAL === 'true' ? false : (process.env.HEADLESS === 'false' ? false : "new") });
          return browser;
        } catch (e) {
          log.warn(`[Platform worker ${workerId}] failed to launch browser for ${group.platformName}: ${e.message}`);
          browser = null;
          return null;
        }
      };

      try {
        log.info(`[Platform worker ${workerId}] ${group.platformName}: ${group.items.length} email(s) on reused tab`);
        let lastProcessed = rowEnd;
        for (let k = 0; k < group.items.length; k++) {
          if (paused) break;
          if (await isCampaignPaused(campaignId, 'validate')) { paused = true; break; }
          const item = group.items[k];
          lastProcessed = item.i + 1;

          // Re-check state (resumable)
          if (String(item.row[validationIdx] || '').trim() !== 'valid_mx' || hasPlatformInconclusiveMarker(item.row, providerMXIdx)) {
            continue;
          }

          // ensure browser available (relaunch if crashed)
          const b = await ensureBrowser();
          if (!b) {
            // can't verify now; leave as valid_mx (pending) for resume, don't mark terminal
            log.warn(`[Row verify] ${item.email} @${item.platformName}: browser unavailable, leaving pending`);
            continue;
          }

          const result = await verifyEmailWithRetriesOnSameBrowser(ensureBrowser, item.email, item.platformName, item.config, log, 2);

          if (result.status === 'not_exists') {
            item.row[validationIdx] = 'not_exists';
            if (!String(item.row[providerMXIdx] || '').trim()) item.row[providerMXIdx] = item.platformName;
            attachPlatformEvidence(item.row, providerMXIdx, result);
            notExists++;
          } else if (result.status === 'verified_exists') {
            item.row[validationIdx] = 'verified_exists';
            if (!String(item.row[providerMXIdx] || '').trim()) item.row[providerMXIdx] = item.platformName;
            attachPlatformEvidence(item.row, providerMXIdx, result);
            verified++;
          } else {
            // Inconclusive after retries: finalize as terminal valid_mx (MX-valid, resolved, send-eligible)
            item.row[validationIdx] = 'valid_mx';
            attachPlatformEvidence(item.row, providerMXIdx, result);
            markPlatformInconclusive(item.row, providerMXIdx, item.platformName);
            inconclusive++;
            log.warn(`[Row verify] ${item.email} @${item.platformName}: inconclusive after retries (${result.detail || 'unknown'}) - finalizing as valid_mx (terminal)`);
          }

          // periodic flush/checkpoint per item (keeps progress safe/resumable)
          if ((k + 1) % 5 === 0 || k === group.items.length - 1) {
            await flushCheckpoint(lastProcessed);
          }
        }
        // final flush for this platform group
        await flushCheckpoint(group.items.length ? (group.items[group.items.length - 1].i + 1) : rowEnd);
      } finally {
        if (browser) { try { await browser.close(); } catch {} }
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, (_, i) => runWorker(i + 1)));

  return { paused, processedUpTo: paused ? -1 : rowEnd, verified, notExists, inconclusive };
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

function isValidationFullyComplete(dataRows, emailColIdx, validationIdx, providerMXIdx = -1) {
  for (const row of dataRows) {
    const status = String(row[validationIdx] || '').trim();
    if (!status) return false;
    if (status === 'valid_mx') {
      const email = String(row[emailColIdx] || '').trim();
      const domain = email.includes('@') ? email.split('@')[1].toLowerCase().trim() : '';
      const platformEligible = domain ? !!detectPlatform(domain) : false;
      if (platformEligible && (providerMXIdx === -1 || !hasPlatformInconclusiveMarker(row, providerMXIdx))) {
        return false; // still needs platform verification (not yet checked/finalized)
      }
    }
    // any non-final transitional states
    if (status === 'unverifiable' || status === 'processing') return false;
  }
  return true;
}

export async function POST(request) {
  let browser = null;
  let stageLease = null;
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
    stageLease = startStageLease(campaignId, 'validate', log);

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
    if (stageLease) stageLease.stop();
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
}

async function handleCoordinatorMode(campaignId, fileId, fileUrl, log, stageUserId) {
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

  // IMPORTANT: batch limits are concurrency/parallelism over the FULL dataset (never truncation/total caps).
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.validateLimit > 0)) {
    log.info(` validateBatchLimit is 0 or unavailable, blocking validation`);
    return NextResponse.json({ success: true, limitReached: true, message: "Validation blocked: validateBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const validateConcurrency = Math.max(1, parseInt(campaignLimits.validateLimit, 10) || 1);
  const platformBatchSize = Math.max(0, parseInt(campaignLimits.platformVerificationLimit, 10) || 0);

  const dataRows = normalizedRows.slice(1);
  const originalCount = dataRows.length;
  const limitApplied = false; // no truncation

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

  // Multi-server dispatch over full dataset
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

  log.info(` MX concurrency=${validateConcurrency}, platform workers=${platformBatchSize}, platform verification=${PLATFORM_VERIFICATION_ENABLED}`);
  log.info(` Processing ${dataRows.length} rows (single-server, full dataset)`);

  // MX validation (resumable - skips finalized rows), concurrent waves over full dataset
  const mxResult = await runMxValidation({
    rows: normalizedRows,
    rowStart: 0,
    rowEnd: dataRows.length,
    emailColIdx, validationIdx, providerMXIdx,
    campaignId, log, fileId,
    mxBatchSize: validateConcurrency,
  });

  if (mxResult.paused || await isCampaignPaused(campaignId, 'validate')) {
    await flushValidationCsv(campaignId, normalizedRows, fileId, log);
    await updateCampaignSettings(campaignId, { validationStatus: "paused", status: "paused" });
    try {
      const { updateSheetRowApi } = await import("../../api/googlesheets.js");
      await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "paused", updatedOn: new Date().toISOString() });
    } catch {}
    return NextResponse.json({ success: true, processing: true, paused: true, message: "Validation paused during MX check", stats: computeValidationStats(dataRows, validationIdx) });
  }

  // Flush after MX
  await flushValidationCsv(campaignId, normalizedRows, fileId, log);

  // Platform verification (concurrent), terminal resolution for inconclusive as valid_mx
  let platformResult = { paused: false, verified: 0, notExists: 0, inconclusive: 0 };
  if (PLATFORM_VERIFICATION_ENABLED && platformBatchSize > 0) {
    platformResult = await runPlatformVerification({
      rows: normalizedRows,
      rowStart: 0,
      rowEnd: dataRows.length,
      emailColIdx, validationIdx, providerMXIdx,
      campaignId, log, fileId,
      platformBatchSize,
    });
  } else if (PLATFORM_VERIFICATION_ENABLED) {
    log.warn(` platformVerificationBatchLimit is 0 - skipping platform verification (set it in the SETTINGS sheet to enable)`);
  }

  if (platformResult.paused || await isCampaignPaused(campaignId, 'validate')) {
    await flushValidationCsv(campaignId, normalizedRows, fileId, log);
    await updateCampaignSettings(campaignId, { validationStatus: "paused", status: "paused" });
    try {
      const { updateSheetRowApi } = await import("../../api/googlesheets.js");
      await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "paused", updatedOn: new Date().toISOString() });
    } catch {}
    return NextResponse.json({ success: true, processing: true, paused: true, message: "Validation paused during platform verification", stats: computeValidationStats(dataRows, validationIdx) });
  }

  // Final flush
  await flushValidationCsv(campaignId, normalizedRows, fileId, log);

  const complete = isValidationFullyComplete(dataRows, emailColIdx, validationIdx, providerMXIdx);
  const stats = computeValidationStats(dataRows, validationIdx);
  log.info(` Validation stats: ${JSON.stringify(stats)} complete=${complete} rows=${dataRows.length}`);

  if (!complete) {
    // Do NOT mark completed or advance; leave for retry/resume
    await updateCampaignSettings(campaignId, { validationStatus: "processing" });
    return NextResponse.json({
      success: true,
      processing: true,
      completed: false,
      message: "Validation incomplete - remaining rows pending/resumable",
      stats,
    });
  }

  // Only now mark completed (all rows resolved)
  await updateCampaignSettings(campaignId, { validationStatus: "completed" });

  // Usage accounting (single-server run over full dataset)
  if (stageUserId && dataRows.length > 0) {
    try { await updateUserUsage(stageUserId, "validateUsage", dataRows.length); } catch (e) { log.warn(`[user-limit] validateUsage increment failed: ${e.message}`); }
  }

  // Notify orchestrator so it can advance (coordinator/single-server completion handoff)
  try {
    const selfUrl = getInternalSelfUrl();
    fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, fromStage: true })
    }).catch(() => {});
  } catch {}

  return NextResponse.json({ success: true, completed: true, message: "Campaign email validation completed successfully", stats, limitApplied, originalCount, processedCount: dataRows.length });
}

async function handleWorkerMode(campaignId, fileId, serverBatch, log) {
  const myAssignment = await findMyAssignment(campaignId, 'validate');
  if (!myAssignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  }

  await updateMyAssignment(campaignId, 'validate', { status: 'running' });

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
  const campaignLimits = await getCampaignLimits();
  const validateConcurrency = Math.max(1, parseInt(campaignLimits.validateLimit, 10) || 1);
  const platformBatchSize = Math.max(0, parseInt(campaignLimits.platformVerificationLimit, 10) || 0);
  log.info(`[Worker] Processing rows ${rowStart}-${rowEnd - 1} (concurrency=${validateConcurrency}, platform workers=${platformBatchSize})`);

  let wasPaused = false;
  let mxResult = { validCount: 0, invalidCount: 0 };
  let platformResult = { paused: false };

  try {
    mxResult = await runMxValidation({
      rows: normalizedRows,
      rowStart, rowEnd,
      emailColIdx, validationIdx, providerMXIdx,
      campaignId, log, fileId,
      mxBatchSize: validateConcurrency,
      onCheckpoint: async (processedUpTo) => {
        await updateMyAssignment(campaignId, 'validate', { processedUpTo });
        await flushValidationCsv(campaignId, normalizedRows, fileId, log);
      }
    });

    if (mxResult.paused || await isCampaignPaused(campaignId, 'validate')) {
      wasPaused = true;
    } else if (PLATFORM_VERIFICATION_ENABLED && platformBatchSize > 0) {
      platformResult = await runPlatformVerification({
        rows: normalizedRows,
        rowStart, rowEnd,
        emailColIdx, validationIdx, providerMXIdx,
        campaignId, log, fileId,
        platformBatchSize,
        onCheckpoint: async (processedUpTo) => {
          await updateMyAssignment(campaignId, 'validate', { processedUpTo });
          await flushValidationCsv(campaignId, normalizedRows, fileId, log);
        }
      });
      if (platformResult.paused || await isCampaignPaused(campaignId, 'validate')) wasPaused = true;
    }
  } catch (error) {
    log.error(`[Worker] Error: ${error.message}`, { stack: error.stack });
    await updateMyAssignment(campaignId, 'validate', { status: 'failed', error: error.message });
    throw error;
  }

  await flushValidationCsv(campaignId, normalizedRows, fileId, log);

  const assignmentUpdates = {
    status: wasPaused ? 'paused' : 'completed',
    processedUpTo: wasPaused ? Math.max(rowStart, typeof mxResult.processedUpTo === 'number' && mxResult.processedUpTo >= 0 ? mxResult.processedUpTo : rowStart) : rowEnd,
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
      const complete = isValidationFullyComplete(allDataRows, emailColIdx, validationIdx, providerMXIdx);
      if (complete) {
        await updateCampaignSettings(campaignId, { validationStatus: "completed" });
        log.info(` All workers complete — validation finished`);
        try {
          const selfUrl = getInternalSelfUrl();
          fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaignId, fromStage: true })
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
