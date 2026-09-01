import crypto from 'crypto';

// ============================================================
// Per-run browser identity (fingerprint) generation + application
// ============================================================

// Expanded real Windows Chrome/Edge UAs so each run does not trivially
// share the exact same UA string as previous runs.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36 Edg/132.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
];

const VIEWPORT_PRESETS = [
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1.25 },
  { width: 1536, height: 864, dpr: 1 },
  { width: 1536, height: 864, dpr: 1.25 },
  { width: 1440, height: 900, dpr: 1 },
  { width: 1440, height: 900, dpr: 1.25 },
  { width: 1366, height: 768, dpr: 1 },
  { width: 1366, height: 768, dpr: 1.25 },
  { width: 1280, height: 720, dpr: 1 },
  { width: 1280, height: 720, dpr: 1.25 },
  { width: 1600, height: 900, dpr: 1 },
  { width: 1856, height: 1043, dpr: 1 },
];

const GEO_PROFILES = [
  { timezone: "America/New_York", locale: "en-US" },
  { timezone: "America/Chicago", locale: "en-US" },
  { timezone: "America/Denver", locale: "en-US" },
  { timezone: "America/Los_Angeles", locale: "en-US" },
  { timezone: "America/Toronto", locale: "en-CA" },
  { timezone: "Europe/London", locale: "en-GB" },
  { timezone: "Europe/Paris", locale: "fr-FR" },
  { timezone: "Europe/Berlin", locale: "de-DE" },
  { timezone: "Europe/Madrid", locale: "es-ES" },
  { timezone: "Asia/Singapore", locale: "en-SG" },
  { timezone: "Australia/Sydney", locale: "en-AU" },
  { timezone: "Asia/Tokyo", locale: "ja-JP" },
  { timezone: "Asia/Kolkata", locale: "en-IN" },
  { timezone: "Asia/Dubai", locale: "en-AE" },
  { timezone: "America/Sao_Paulo", locale: "pt-BR" },
  { timezone: "Africa/Johannesburg", locale: "en-ZA" },
];

const HARDWARE_CONCURRENCY = [4, 6, 8, 12, 16];
const DEVICE_MEMORY = [4, 8, 16];

const WEBGL_PAIRS = [
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "NVIDIA Corporation", renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "NVIDIA Corporation", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "NVIDIA Corporation", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon(TM) RX 580 Series Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon(TM) Radeon Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" },
  { vendor: "Google Inc. (Microsoft)", renderer: "ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)" },
];

function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(arr, rnd) {
  return arr[Math.floor(rnd() * arr.length)];
}

export function generateIdentity(seed) {
  const effSeed = seed || (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : String(Math.random()));
  const rnd = mulberry32(hashString(String(effSeed)));
  const geo = pick(GEO_PROFILES, rnd);
  const vp = pick(VIEWPORT_PRESETS, rnd);
  const webgl = pick(WEBGL_PAIRS, rnd);
  return {
    seed: effSeed,
    userAgent: pick(USER_AGENTS, rnd),
    platform: "Win32",
    viewport: {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: vp.dpr,
      screenAvailWidth: vp.width,
      screenAvailHeight: vp.height - 40,
    },
    windowSize: `${vp.width},${vp.height}`,
    windowPosition: `${Math.round(rnd() * 160) - 80},${Math.round(rnd() * 40)}`,
    timezone: geo.timezone,
    locale: geo.locale,
    acceptLanguage: `${geo.locale},en;q=0.9`,
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY, rnd),
    deviceMemory: pick(DEVICE_MEMORY, rnd),
    webgl,
    canvasSeed: Math.floor(rnd() * 0x7fffffff),
    audioSeed: Math.floor(rnd() * 0x7fffffff),
  };
}

export function launchArgsForIdentity(id) {
  if (!id) return [];
  return [
    `--user-agent=${id.userAgent}`,
    `--window-size=${id.windowSize}`,
    `--force-device-scale-factor=${id.viewport.deviceScaleFactor}`,
    `--lang=${id.locale}`,
    `--window-position=${id.windowPosition}`,
  ];
}

function buildSpoilers(id) {
  return {
    ua: id.userAgent,
    platform: id.platform || "Win32",
    lang: id.locale,
    hw: id.hardwareConcurrency,
    mem: id.deviceMemory,
    sw: id.viewport.width,
    sh: id.viewport.height,
    availW: id.viewport.screenAvailWidth,
    availH: id.viewport.screenAvailHeight,
    dpr: id.viewport.deviceScaleFactor,
    webglVendor: id.webgl.vendor,
    webglRenderer: id.webgl.renderer,
    canvasSeed: id.canvasSeed,
    audioSeed: id.audioSeed,
  };
}

// Self-contained injection script (runs before any page script, so every frame
// including Microsoft's fingerprint iframes sees the spoofed environment).
function injectionSource(spo) {
  return `(function(spo) {
  const def = (obj, prop, val) => {
    try { Object.defineProperty(obj, prop, { value: val, configurable: false, writable: true }); } catch (e) {}
  };
  const rd = (obj, prop, val) => {
    try { Object.defineProperty(obj, prop, { get: () => val, configurable: true }); } catch (e) {}
  };
  try {
    rd(navigator, 'userAgent', spo.ua);
    rd(navigator, 'appVersion', spo.ua.replace(/^Mozilla\\//, ''));
    rd(navigator, 'platform', spo.platform);
    rd(navigator, 'hardwareConcurrency', spo.hw);
    rd(navigator, 'deviceMemory', spo.mem);
    rd(navigator, 'language', spo.lang);
    rd(navigator, 'languages', [spo.lang]);
    rd(navigator, 'maxTouchPoints', 0);
  } catch (e) {}
  try {
    rd(screen, 'width', spo.sw);
    rd(screen, 'height', spo.sh);
    rd(screen, 'availWidth', spo.availW);
    rd(screen, 'availHeight', spo.availH);
    rd(screen, 'colorDepth', 24);
    rd(screen, 'pixelDepth', 24);
    rd(window, 'devicePixelRatio', spo.dpr);
    if (window.visualViewport) rd(window.visualViewport, 'scale', 1);
  } catch (e) {}
  try {
    const overrideGL = (proto, isGL2) => {
      const orig = proto.getParameter;
      proto.getParameter = function(param) {
        if (typeof param === 'number') {
          if (param === 0x1F00) return spo.webglVendor;
          if (param === 0x1F01) return spo.webglRenderer;
          if (param === 0x1F02) return isGL2 ? 'WebGL 2.0 (OpenGL ES 3.0 Chromium)' : 'WebGL 1.0 (OpenGL ES 2.0 Chromium)';
          if (param === 0x8B8C) return isGL2 ? 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.00 Chromium)' : 'WebGL GLSL ES 1.00 (OpenGL ES GLSL ES 1.0 Chromium)';
          if (param === 0x9245) return spo.webglVendor;
          if (param === 0x9246) return spo.webglRenderer;
        }
        return orig.call(this, param);
      };
    };
    if (window.WebGLRenderingContext) overrideGL(WebGLRenderingContext.prototype, false);
    if (window.WebGL2RenderingContext) overrideGL(WebGL2RenderingContext.prototype, true);
  } catch (e) {}
  try {
    const mulberry32 = (a) => {
      return function() {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const rand = mulberry32(spo.canvasSeed);
    const origGI = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(x, y, w, h) {
      const img = origGI.call(this, x, y, w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        if (rand() < 0.15) {
          d[i] = (d[i] + (rand() < 0.5 ? 1 : 255)) & 255;
          if (rand() < 0.5) d[i + 1] = (d[i + 1] + (rand() < 0.5 ? 1 : 255)) & 255;
          if (rand() < 0.5) d[i + 2] = (d[i + 2] + (rand() < 0.5 ? 1 : 255)) & 255;
        }
      }
      return img;
    };
  } catch (e) {}
  try {
    if (window.AnalyserNode) {
      const aRand = mulberry32(spo.audioSeed);
      const origFFD = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
        origFFD.call(this, arr);
        for (let i = 0; i < arr.length; i += 3) {
          if (aRand() < 0.1) arr[i] += (aRand() - 0.5) * 0.05;
        }
      };
    }
  } catch (e) {}
})(arguments[0]);`;
}

export async function applyIdentityToPage(page, id) {
  if (!page || !id) return;
  try { await page.setViewport(id.viewport); } catch (e) {}
  try {
    const cdp = await page.createCDPSession();
    // Use CDP directly instead of page.setUserAgent() to avoid Puppeteer 22+
    // auto-generating incomplete userAgentMetadata (missing architecture field
    // causes ProtocolError crash on Network.setUserAgentOverride).
    const ua = id.userAgent;
    const chromeMatch = ua.match(/Chrome\/(\d+)\.\d+\.\d+\.\d+/);
    const majorVersion = chromeMatch ? chromeMatch[1] : '130';
    const fullVersion = chromeMatch ? chromeMatch[0].replace('Chrome/', '') : '130.0.0.0';
    try {
      await cdp.send("Network.setUserAgentOverride", {
        userAgent: ua,
        acceptLanguage: id.acceptLanguage || `${id.locale},en;q=0.9`,
        userAgentMetadata: {
          brands: [
            { brand: "Chromium", version: majorVersion },
            { brand: "Google Chrome", version: majorVersion },
            { brand: "Not/A)Brand", version: "99" },
          ],
          fullVersionList: [
            { brand: "Chromium", version: fullVersion },
            { brand: "Google Chrome", version: fullVersion },
            { brand: "Not/A)Brand", version: "99.0.0.0" },
          ],
          platform: "Windows",
          platformVersion: "10.0.0",
          architecture: "x86",
          model: "",
          mobile: false,
          bitness: "64",
          wow64: false,
        },
      });
    } catch (e) {}
    try { await cdp.send("Emulation.setTimezoneOverride", { timezoneId: id.timezone }); } catch (e) {}
    try { await cdp.send("Emulation.setLocaleOverride", { locale: id.locale }); } catch (e) {}
  } catch (e) {}
  try {
    await page.evaluateOnNewDocument(injectionSource, buildSpoilers(id));
  } catch (e) {}
}

export async function applyUserAgentViaCDP(page, userAgent) {
  if (!page || !userAgent) return;
  try {
    const cdp = await page.createCDPSession();
    const chromeMatch = userAgent.match(/Chrome\/(\d+)\.\d+\.\d+\.\d+/);
    const majorVersion = chromeMatch ? chromeMatch[1] : '130';
    const fullVersion = chromeMatch ? chromeMatch[0].replace('Chrome/', '') : '130.0.0.0';
    await cdp.send("Network.setUserAgentOverride", {
      userAgent,
      acceptLanguage: "en-US,en;q=0.9",
      userAgentMetadata: {
        brands: [
          { brand: "Chromium", version: majorVersion },
          { brand: "Google Chrome", version: majorVersion },
          { brand: "Not/A)Brand", version: "99" },
        ],
        fullVersionList: [
          { brand: "Chromium", version: fullVersion },
          { brand: "Google Chrome", version: fullVersion },
          { brand: "Not/A)Brand", version: "99.0.0.0" },
        ],
        platform: "Windows",
        platformVersion: "10.0.0",
        architecture: "x86",
        model: "",
        mobile: false,
        bitness: "64",
        wow64: false,
      },
    });
  } catch (e) {}
}

export function identitySummary(id) {
  if (!id) return null;
  return {
    ua: id.userAgent,
    viewport: `${id.viewport.width}x${id.viewport.height}@${id.viewport.deviceScaleFactor}`,
    timezone: id.timezone,
    locale: id.locale,
    hwConcurrency: id.hardwareConcurrency,
    deviceMemory: id.deviceMemory,
    webgl: `${id.webgl.vendor} / ${id.webgl.renderer}`,
  };
}