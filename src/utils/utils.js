export const localExecutablePath =
  process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "linux"
    ? "/usr/bin/google-chrome"
    : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const remoteExecutablePath =
  "https://github.com/Sparticuz/chromium/releases/download/v123.0.1/chromium-v123.0.1-pack.tar";

export const isDev = process.env.NODE_ENV === "development";

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
import chromium from "@sparticuz/chromium-min";
import { existsSync, rmSync } from 'node:fs';

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

    // Also wrap child evasion plugins created by the _plugins getter.
    // Each child evasion's onPageCreated is called inside _onTargetCreated
    // and if one throws it rejects the parent. This catches at child level.
    const _origPluginsDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(stealth), '_plugins'
    ) || { get: undefined };
    const origPluginsGetter = _origPluginsDescriptor.get;
    if (origPluginsGetter) {
      Object.defineProperty(stealth, '_plugins', {
        get() {
          const plugins = origPluginsGetter.call(this);
          return plugins.map(p => {
            if (p.onPageCreated) {
              const origOnPageCreated = p.onPageCreated.bind(p);
              p.onPageCreated = async (page) => {
                try {
                  await origOnPageCreated(page);
                } catch (e) {
                  if (e?.name === 'TargetCloseError' || e?.name === 'ProtocolError' ||
                      e?.message?.includes('Session closed') || e?.message?.includes('Target closed')) {
                    return;
                  }
                  throw e;
                }
              };
            }
            return p;
          });
        },
        configurable: true
      });
    }

    pptrExtra.use(stealth);
    _puppeteerExtra = pptrExtra;
    return _puppeteerExtra;
}

/**
 * Centrally launches an optimized Puppeteer browser instance.
 * Automatically randomizes User-Agent while keeping the physical layout
 * locked to standard widescreen dimensions (1920x1080) for automation safety.
 */
let _chromiumCacheCleaned = false;

export async function launchBrowser(customOptions = {}) {
  // Clean stale chromium binary from Docker layer cache (once per process)
  if (!isDev && !_chromiumCacheCleaned) {
    _chromiumCacheCleaned = true;
    if (existsSync('/tmp/chromium')) {
      try { rmSync('/tmp/chromium', { recursive: true }); } catch (_) {}
    }
  }

  // 1. Resolve User-Agent (dynamic random selection by default)
  const selectedUA = customOptions.userAgent || getRandomUserAgent();

  // 2. Lock physical viewport to standard widescreen
  const defaultViewport = { width: 1920, height: 1080, deviceScaleFactor: 1 };

  const baseArgs = [
    ...(isDev
      ? [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=site-per-process",
          "--disable-site-isolation-trials"
        ]
      : [...chromium.args.filter(a => !a.startsWith('--headless')), "--disable-blink-features=AutomationControlled"]),
    `--user-agent=${selectedUA}`,
    '--window-size=1920,1080',
    '--force-device-scale-factor=1',
    '--disable-dev-shm-usage', 
    '--no-sandbox',
    
    // Anti-detection flags
    '--disable-blink-features=AutomationControlled',
    '--disable-features=AutomationControlled',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--no-first-run',
    '--mute-audio',
    '--no-zygote',
    '--disable-gpu',
    '--js-flags="--max-old-space-size=512"'
  ];

  // Proxy support via environment variable (opt-in)
  const proxyUrl = process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  if (proxyUrl) {
    baseArgs.push(`--proxy-server=${proxyUrl}`);
  }

  const defaultOptions = {
    ignoreDefaultArgs: ["--enable-automation"],
    args: baseArgs,
    dumpio: false,
    defaultViewport,
    executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
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
  
  // Attach selected UA to the browser instance for logging / downstream set-up
  browser.selectedUserAgent = selectedUA;

  // Small delay after launch to let stealth plugin evasions settle on initial pages.
  // Without this, the caller may immediately close pages (e.g. initial tab cleanup)
  // while stealth is still applying evasions via CDP, causing TargetCloseError
  // (Protocol error (Network.setUserAgentOverride): Session closed) in constrained
  // Docker/production environments.
  if (!isDev) {
    await new Promise(r => setTimeout(r, 1500));
  }

  return browser;
}

