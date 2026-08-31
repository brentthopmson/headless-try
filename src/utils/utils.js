export const localExecutablePath =
  process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "linux"
    ? "/usr/bin/google-chrome"
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// Production uses FULL Chromium (installed via apt in the Dockerfile) rather than
// the @sparticuz/chromium-min "chrome-headless-shell". The stripped headless shell
// never fires domcontentloaded on modern heavy JS pages (login.live.com/login.srf),
// leaving rows stuck in WAITINGEMAIL/PROCESSING. Full Chromium renders them like a
// real browser (this is what the Nixpacks deployment used, which worked).
export const fullChromiumExecutablePath = process.env.CHROME_PATH || "/usr/bin/chromium";
// NOTE: remoteExecutablePath stays as the sparticuz pack URL — other routes still
// call chromium.executablePath(remoteExecutablePath), which expects the brotli pack
// location, not a bare binary path.
export const remoteExecutablePath =
  "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar";

export const isDev = process.env.NODE_ENV === "development";

// ==================== Global Browser Semaphore ====================
// Limits total concurrent Chromium instances across all routes/campaigns to prevent OOM.
const MAX_GLOBAL_BROWSERS = parseInt(process.env.MAX_GLOBAL_BROWSERS || '4', 10);
const BROWSER_LAUNCH_TIMEOUT_MS = 30000; // 30s wait for a slot

if (!globalThis.__browserSemaphore) {
  globalThis.__browserSemaphore = {
    active: new Set(),
    waitQueue: [],
  };
}
const sem = globalThis.__browserSemaphore;

/**
 * Acquire a slot from the global browser semaphore.
 * Returns a release function that MUST be called when the browser is closed.
 */
async function acquireBrowserSlot() {
  // Fast path: slot available
  if (sem.active.size < MAX_GLOBAL_BROWSERS) {
    const slotId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sem.active.add(slotId);
    return slotId;
  }

  // Wait for a slot to free up
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const idx = sem.waitQueue.findIndex(w => w.resolve === resolve);
      if (idx !== -1) sem.waitQueue.splice(idx, 1);
      reject(new Error(`Browser semaphore timeout: ${sem.active.size}/${MAX_GLOBAL_BROWSERS} slots in use after ${BROWSER_LAUNCH_TIMEOUT_MS}ms`));
    }, BROWSER_LAUNCH_TIMEOUT_MS);

    sem.waitQueue.push({ resolve, timeout });
  });
}

/**
 * Release a slot from the global browser semaphore.
 */
function releaseBrowserSlot(slotId) {
  sem.active.delete(slotId);
  // Wake up next waiter if any
  if (sem.waitQueue.length > 0 && sem.active.size < MAX_GLOBAL_BROWSERS) {
    const next = sem.waitQueue.shift();
    clearTimeout(next.timeout);
    const newSlotId = `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    sem.active.add(newSlotId);
    next.resolve(newSlotId);
  }
}

/**
 * Get current browser semaphore stats.
 */
export function getBrowserSemaphoreStats() {
  return {
    active: sem.active.size,
    max: MAX_GLOBAL_BROWSERS,
    waiting: sem.waitQueue.length,
  };
}

import logger from "./logger.js";
import { generateIdentity, launchArgsForIdentity } from "./identity.js";
import { resolveProxyForRun, maskProxy } from "./proxy.js";

export const USER_AGENTS = [
  // Windows Chrome (matches actual browser environment)
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
];

export function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export const userAgent = getRandomUserAgent(); // Maintain legacy export just in case downstream modules reference it

import puppeteer from "puppeteer-core";

let _puppeteerExtra = null;

// Catch TargetCloseError / ProtocolError from stealth plugin's targetcreated
// handler at the process level. These are harmless race conditions where
// a page/target is closed before stealth finishes applying evasions. The
// _onTargetCreated wrapper below also catches them, but Node.js may still
// print unhandled rejection details to stderr unless caught at process level.
process.on('unhandledRejection', (reason) => {
  if (reason?.name === 'TargetCloseError' || reason?.name === 'ProtocolError' ||
      reason?.message?.includes('Session closed') || reason?.message?.includes('Target closed')) {
    return;
  }
});

async function getPuppeteerExtra() {
    if (_puppeteerExtra) return _puppeteerExtra;
    const { default: pptrExtra } = await import('puppeteer-extra');
    const { default: StealthPlugin } = await import('puppeteer-extra-plugin-stealth');

    // Patch PuppeteerExtraPlugin.prototype._onTargetCreated BEFORE any evasions
    // are registered. Each evasion plugin inherits from PuppeteerExtraPlugin and
    // its onPageCreated is called from the base _onTargetCreated, which catches
    // all errors and prints them via console.error(err) at line 500 of the base
    // class. This is the direct source of the stderr noise when a page is closed
    // mid-evasion — the incoming catcher in the base class prevents propagation
    // so our stealth-level wrapper never sees the TargetCloseError.
    const { PuppeteerExtraPlugin } = await import('puppeteer-extra-plugin');
    PuppeteerExtraPlugin.prototype._onTargetCreated = async function(target) {
        if (this.onTargetCreated)
            await this.onTargetCreated(target);
        if (target.type() === 'page') {
            try {
                const page = await target.page();
                if (!page) return;
                const validPage = 'isClosed' in page && !page.isClosed();
                if (this.onPageCreated && validPage) {
                    await this.onPageCreated(page);
                }
            } catch (err) {
                const msg = err?.message || '';
                if (err?.name === 'TargetCloseError' || err?.name === 'ProtocolError' ||
                    msg.includes('Session closed') || msg.includes('Target closed')) {
                    return;
                }
                console.error(err);
            }
        }
    };

    const stealth = StealthPlugin();

    // Wrap _onTargetCreated to suppress TargetCloseError / ProtocolError from
    // short-lived pages (e.g. redirect targets, popups that open and close before
    // stealth evasions finish applying). The base plugin's handler is async and
    // called fire-and-forget from the targetcreated event, so rejections become
    // unhandled and can crash the process in constrained environments.
    const _origOnTargetCreated = stealth._onTargetCreated.bind(stealth);
    stealth._onTargetCreated = async (target) => {
        try {
            await _origOnTargetCreated(target);
        } catch (e) {
            if (e?.name === 'TargetCloseError' ||
                e?.name === 'ProtocolError' ||
                e?.message?.includes('Session closed') ||
                e?.message?.includes('Target closed')) {
                return;
            }
            throw e;
        }
    };

    pptrExtra.use(stealth);
    _puppeteerExtra = pptrExtra;
    return _puppeteerExtra;
}

/**
 * Centrally launches an optimized Puppeteer browser instance.
 * Automatically randomizes User-Agent while keeping the physical layout
 * locked to standard widescreen dimensions (1920x1080) for automation safety.
 */
export async function launchBrowser(customOptions = {}) {
  // Acquire global browser slot (limits total Chromium instances)
  const slotId = await acquireBrowserSlot();

  try {
    // 1. Per-run browser identity (fingerprint): random UA, screen/viewport+DPR,
    //    timezone, locale/lang, WebGL vendor/renderer, canvas/audio noise, and
    //    hardware signals. Consistent within a single run, unique across runs.
    const identity = customOptions.identity || generateIdentity();
    if (customOptions.userAgent) identity.userAgent = customOptions.userAgent;

    // 2. Per-run proxy (IP rotation). Optional — if none is configured we still
    //    rotate the browser fingerprint, but IP correlation remains.
    const proxy = await resolveProxyForRun();

  // 3. Build launch args: identity + proxy args override the fixed defaults.
  const identityArgs = launchArgsForIdentity(identity);
  const proxyArgs = proxy ? [`--proxy-server=${proxy.url}`] : [];

  const defaultViewport = identity.viewport;

  const baseArgs = [
    ...identityArgs,
    ...proxyArgs,
    // Anti-detection flags
    "--disable-blink-features=AutomationControlled",
    "--disable-features=site-per-process",
    "--disable-site-isolation-trials",
    "--disable-dev-shm-usage", 
    "--no-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-features=AutomationControlled",
    "--enable-features=NetworkService,NetworkServiceInProcess",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-ipc-flooding-protection",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-prompt-on-repost",
    "--disable-sync",
    "--disable-translate",
    "--metrics-recording-only",
    "--no-first-run",
    "--mute-audio",
    "--no-zygote",
    "--disable-gpu",
    '--js-flags="--max-old-space-size=512"'
  ];

  // Legacy proxy fallback via generic HTTP(S)_PROXY env vars (kept working)
  if (!proxy && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY)) {
    baseArgs.push(`--proxy-server=${process.env.HTTP_PROXY || process.env.HTTPS_PROXY}`);
  }

  const defaultOptions = {
    ignoreDefaultArgs: ["--enable-automation"],
    args: baseArgs,
    dumpio: false,
    defaultViewport,
    executablePath: isDev ? localExecutablePath : fullChromiumExecutablePath,
    headless: "new",
    timeout: 60000,
  };

  // Merge default options with overrides
  const mergedOptions = {
    ...defaultOptions,
    ...customOptions,
    args: [
      ...defaultOptions.args,
      ...(customOptions.args || [])
    ],
    defaultViewport: {
      ...defaultOptions.defaultViewport,
      ...(customOptions.defaultViewport || {})
    }
  };

  const pptrExtra = await getPuppeteerExtra();
  const browser = await pptrExtra.launch(mergedOptions);
  
  // Attach the selected identity + proxy for downstream set-up / logging.
  browser.identity = identity;
  browser.proxy = proxy;
  browser.selectedUserAgent = identity.userAgent;
  browser._semaphoreSlotId = slotId;

  // Release semaphore slot when browser is closed
  const originalClose = browser.close.bind(browser);
  browser.close = async () => {
    try {
      await originalClose();
    } finally {
      releaseBrowserSlot(slotId);
    }
  };

  if (!proxy) {
    logger.warn(`[launchBrowser] No IP rotation configured — browser fingerprint rotates per run, but outbound IP stays constant. Set PROXY_HOSTS / PROXY_LIST_URL / PROXY_PROVIDER_URL to enable IP rotation.`);
  } else {
    logger.info(`[launchBrowser] IP rotation enabled via ${proxy.mode} proxy ${maskProxy(proxy.url)}`);
  }

  // Small delay after launch to let stealth plugin evasions settle on initial pages.
  // Without this, the caller may immediately close pages (e.g. initial tab cleanup)
  // while stealth is still applying evasions via CDP, causing TargetCloseError
  // (Protocol error (Network.setUserAgentOverride): Session closed) in constrained
  // Docker/production environments.
  if (!isDev) {
    await new Promise(r => setTimeout(r, 1500));
  }

    return browser;
  } finally {
    releaseBrowserSlot(slotId);
  }
}

