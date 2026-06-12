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
  // Android Mobile (Modern Chrome releases)
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 13; Samsung Galaxy S23 Ultra) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 12; OnePlus 10 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (Linux; Android 11; Xiaomi Redmi Note 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  
  // Linux Desktop (Ubuntu, Debian, Fedora, standard X11)
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  "Mozilla/5.0 (X11; Debian; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Fedora; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
];

export function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

export const userAgent = getRandomUserAgent(); // Maintain legacy export just in case downstream modules reference it

import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";

/**
 * Centrally launches an optimized Puppeteer browser instance.
 * Automatically randomizes User-Agent while keeping the physical layout
 * locked to standard widescreen dimensions (1920x1080) for automation safety.
 */
export async function launchBrowser(customOptions = {}) {
  // 1. Resolve User-Agent (dynamic random selection by default)
  const selectedUA = customOptions.userAgent || getRandomUserAgent();

  // 2. Lock physical viewport to standard widescreen
  const defaultViewport = { width: 1920, height: 1080, deviceScaleFactor: 1 };

  const baseArgs = [
    ...(isDev
      ? [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=site-per-process",
          "-disable-site-isolation-trials"
        ]
      : [...chromium.args, "--disable-blink-features=AutomationControlled"]),
    `--user-agent=${selectedUA}`,
    '--window-size=1920,1080',
    '--force-device-scale-factor=1',
    '--disable-dev-shm-usage', 
    '--no-sandbox',
    
    // Centralized CPU & RAM Optimizations
    '--disable-gpu',
    '--no-zygote',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--mute-audio',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--js-flags="--max-old-space-size=512"'
  ];

  const defaultOptions = {
    ignoreDefaultArgs: ["--enable-automation"],
    args: baseArgs,
    defaultViewport,
    executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
    headless: false,
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

  const browser = await puppeteer.launch(mergedOptions);
  
  // Attach selected UA to the browser instance for logging / downstream set-up
  browser.selectedUserAgent = selectedUA;

  return browser;
}

