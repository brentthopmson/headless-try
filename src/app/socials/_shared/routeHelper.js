import axios from 'axios';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import https from 'https';
import http from 'http';
import extractZip from 'extract-zip';
import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, appendSheetRowApi, stripFormulaColumns } from '../../api/googlesheets.js';
import { localExecutablePath, isDev, fullChromiumExecutablePath, launchBrowser } from "../../../utils/utils.js";
import { applyIdentityToPage } from "../../../utils/identity.js";
import { detectEmailPlatform } from "../../emails/_shared/platforms.js";
import limitsCore from './limitsCore.js';
import { checkActionAllowed } from './limits.js';
import { getAccountUsage, updateAccountUsage } from './hubUpdater.js';
import { createTally, stepQuotaAction, accountStep } from './quotaActions.js';

const { toLimitActions } = limitsCore;

// ==================== Profile Download ====================

function getDirectDownloadUrl(driveUrl) {
    if (!driveUrl) return null;
    // Convert Google Drive分享链接 to direct download URL
    const match = driveUrl.match(/\/file\/d\/([^/]+)/);
    if (match) return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    // Cloudinary URLs work directly
    if (driveUrl.includes('cloudinary.com')) return driveUrl;
    // R2/B2 URLs work directly
    return driveUrl;
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const makeRequest = (targetUrl) => {
            const req = mod.get(targetUrl, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    makeRequest(res.headers.location);
                    return;
                }
                if (res.statusCode !== 200) {
                    let body = '';
                    res.on('data', (c) => (body += c.toString()));
                    res.on('end', () => reject(new Error(`Download failed with status ${res.statusCode}: ${body.slice(0, 200)}`)));
                    return;
                }
                const fileStream = fs.createWriteStream(destPath);
                res.pipe(fileStream);
                fileStream.on('finish', () => { fileStream.close(); resolve(); });
                fileStream.on('error', (err) => { fs.removeSync(destPath); reject(err); });
            });
            req.on('error', reject);
            req.setTimeout(60000, () => { req.destroy(); reject(new Error('Download timeout')); });
        };
        makeRequest(url);
    });
}

/**
 * Downloads a browser profile ZIP from Drive and extracts it to a local directory.
 * Returns the local directory path, or null if download/extraction fails.
 */
// Extracted Chrome profiles are cached for 60 minutes so a re-triggered
// campaign run (or hourly-limit resume) reuses the already-downloaded
// profile instead of re-fetching from Drive. Sits in os.tmpdir().
const PROFILE_CACHE_TTL_MS = 60 * 60 * 1000;

function profileCacheMarkerPath(destDir) {
    return path.join(destDir, '.extracted_at');
}

async function readProfileCacheAge(destDir) {
    try {
        const marker = profileCacheMarkerPath(destDir);
        if (!(await fs.pathExists(marker))) return Infinity;
        const raw = (await fs.readFile(marker, 'utf8')).trim();
        const extractedAt = Date.parse(raw);
        if (Number.isNaN(extractedAt)) return Infinity;
        return Date.now() - extractedAt;
    } catch (_) {
        return Infinity;
    }
}

export async function downloadAndExtractProfile(driveUrl, browserId) {
    if (!driveUrl) return null;
    const directUrl = getDirectDownloadUrl(driveUrl);
    if (!directUrl) return null;

    const destDir = path.join(os.tmpdir(), 'webfixx_profiles', browserId);
    const zipPath = `${destDir}.zip`;

    // Serve from cache when a fresh extracted profile already exists.
    try {
        const hasDefault = await fs.pathExists(path.join(destDir, 'Default'));
        if (hasDefault) {
            const ageMs = await readProfileCacheAge(destDir);
            if (ageMs < PROFILE_CACHE_TTL_MS) {
                logger.info(`[profileCache] Reusing fresh profile for ${browserId} (age ${Math.round(ageMs / 1000)}s < ${PROFILE_CACHE_TTL_MS / 1000}s TTL)`);
                return destDir;
            }
            logger.info(`[profileCache] Cached profile for ${browserId} is stale (age ${Math.round(ageMs / 1000)}s) — re-downloading`);
        }
        // Stale or invalid cache: clear it before re-download.
        await fs.remove(destDir).catch(() => {});
    } catch (_) { /* fall through to download */ }

    try {
        await fs.ensureDir(destDir);

        logger.info(`[profileDownload] Downloading profile from ${directUrl.substring(0, 80)}...`);
        await downloadFile(directUrl, zipPath);

        logger.info(`[profileDownload] Extracting ZIP to ${destDir}`);
        await extractZip(zipPath, { dir: destDir });

        // Clean up ZIP
        await fs.remove(zipPath).catch(() => {});

        // Verify the profile exists
        const hasDefault = await fs.pathExists(path.join(destDir, 'Default'));
        if (!hasDefault) {
            logger.warn(`[profileDownload] No Default/ directory in extracted profile`);
            await fs.remove(destDir);
            return null;
        }

        // Stamp the cache marker so future calls can reuse this profile.
        await fs.writeFile(profileCacheMarkerPath(destDir), new Date().toISOString()).catch(() => {});

        logger.info(`[profileDownload] Profile extracted successfully to ${destDir}`);
        // DETAILED PROFILE INVENTORY: log every file in downloaded profile to compare
        // with what was uploaded. Diagnoses why Dokploy (Linux) profiles are 0.11 MB.
        const dlFiles = [];
        const walkRel = (p, rel = '') => {
            for (const e of fs.readdirSync(p, { withFileTypes: true })) {
                const fp = path.join(p, e.name);
                const relPath = rel ? `${rel}/${e.name}` : e.name;
                if (e.isDirectory()) { walkRel(fp, relPath); }
                else { try { dlFiles.push({ path: relPath, size: fs.statSync(fp).size }); } catch (_) {} }
            }
        };
        try { walkRel(destDir); } catch (_) {}
        logger.warn(`[profileDownload] ${browserId} DOWNLOADED_PROFILE_FILES: ${JSON.stringify(dlFiles)}`);
        // Check BOTH cookie paths (pre-v80 uses Default/Cookies, v80+ uses Default/Network/Cookies)
        const dlOldCookies = fs.existsSync(path.join(destDir, 'Default', 'Cookies'));
        const dlNewCookies = fs.existsSync(path.join(destDir, 'Default', 'Network', 'Cookies'));
        const dlOldCookieSize = dlOldCookies ? fs.statSync(path.join(destDir, 'Default', 'Cookies')).size : 0;
        const dlNewCookieSize = dlNewCookies ? fs.statSync(path.join(destDir, 'Default', 'Network', 'Cookies')).size : 0;
        logger.warn(`[profileDownload] ${browserId} COOKIE_CHECK: Default/Cookies=${dlOldCookies}(${dlOldCookieSize}B) Default/Network/Cookies=${dlNewCookies}(${dlNewCookieSize}B)`);

        const localStatePath = path.join(destDir, 'Local State');
        if (!fs.existsSync(localStatePath)) {
            logger.warn(`[profileDownload] ${browserId} LOCAL_STATE: file missing — cookie decryption may fail`);
        } else {
            try {
                const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
                const encryptedKey = localState?.os_crypt?.encrypted_key;
                logger.info(`[profileDownload] ${browserId} LOCAL_STATE: encrypted_key=${encryptedKey ? `present(${encryptedKey.length} chars)` : 'MISSING'}`);
            } catch (localStateError) {
                logger.warn(`[profileDownload] ${browserId} LOCAL_STATE: invalid JSON — ${localStateError.message}`);
            }
        }

        const cookieArtifacts = [
            path.join(destDir, 'Default', 'Cookies'),
            path.join(destDir, 'Default', 'Cookies-wal'),
            path.join(destDir, 'Default', 'Cookies-shm'),
            path.join(destDir, 'Default', 'Cookies-journal'),
            path.join(destDir, 'Default', 'Network', 'Cookies'),
            path.join(destDir, 'Default', 'Network', 'Cookies-wal'),
            path.join(destDir, 'Default', 'Network', 'Cookies-shm'),
            path.join(destDir, 'Default', 'Network', 'Cookies-journal'),
        ];
        const cookieArtifactSummary = cookieArtifacts
            .filter((artifactPath) => fs.existsSync(artifactPath))
            .map((artifactPath) => ({
                path: path.relative(destDir, artifactPath).replaceAll(path.sep, '/'),
                size: fs.statSync(artifactPath).size,
            }));
        logger.info(`[profileDownload] ${browserId} COOKIE_ARTIFACTS: ${JSON.stringify(cookieArtifactSummary)}`);
        return destDir;
    } catch (e) {
        logger.warn(`[profileDownload] Failed to download/extract profile: ${e.message}`);
        await fs.remove(destDir).catch(() => {});
        await fs.remove(zipPath).catch(() => {});
        return null;
    }
}

// ==================== Browser Session Management ====================

export async function loadBrowserSession(cookieJSON) {
    if (!cookieJSON) throw new Error("No cookies provided");
    try {
        return typeof cookieJSON === 'string' ? JSON.parse(cookieJSON) : cookieJSON;
    } catch (e) {
        logger.error(`[loadBrowserSession] Error parsing cookies: ${e.message}`);
        throw e;
    }
}

function cookieMetadataKey(cookie) {
    return [cookie.name, cookie.domain, cookie.path || '/'].join('|');
}

function summarizeCookieMetadata(cookies) {
    return cookies.map(cookie => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path || '/',
        secure: !!cookie.secure,
        session: !!cookie.session,
        expires: cookie.expires,
    }));
}

/**
 * Launches a browser with session cookies.
 * @param {string} cookieJSON - Cookie JSON string or array
 * @param {string} headless - Headless mode ("new", false, etc.)
 * @param {object} options - Optional: { userDataDir: string, identity: object } to use a persistent profile + matching fingerprint
 */
export async function launchBrowserWithSession(cookieJSON, headless = isDev ? false : "new", options = {}) {
    try {
        const launchOptions = {
            headless,
            executablePath: isDev ? localExecutablePath : fullChromiumExecutablePath,
        };

        // fullPage: launch maximized (headed runs only — inert in headless).
        // Used by search-interact so TikTok's comment panel/reply boxes are
        // fully visible instead of clipped by a small fixed window.
        if (options.fullPage) {
            launchOptions.fullPage = true;
        }

        // If a userDataDir is provided (from Drive profile), use it instead of random temp dir
        if (options.userDataDir) {
            launchOptions.userDataDir = options.userDataDir;
            logger.info(`[launchBrowserWithSession] Using persistent profile: ${options.userDataDir}`);
        }

        // If a saved identity is provided (from cookie-api-login), reuse it so the
        // extraction browser has the exact same fingerprint and Google won't reject the session.
        if (options.identity) {
            launchOptions.identity = options.identity;
            logger.info(`[launchBrowserWithSession] Reusing saved identity (fingerprint match)`);
        }

        // Gmail: never randomize timezone/locale — a GEO far from the real IP is a
        // Google session-revocation risk signal. (Only matters when no saved
        // identity exists; login always saves one going forward.)
        if (options.realGeo || (options.platform || '').toLowerCase() === 'gmail') {
            launchOptions.realGeo = true;
        }

        const browser = await launchBrowser(launchOptions);

        const page = await browser.newPage();
        if (browser.identity) {
            await applyIdentityToPage(page, browser.identity);
        }

        if (options.userDataDir) {
            try {
                const gmailCookies = await page.cookies('https://mail.google.com');
                const accountCookies = await page.cookies('https://accounts.google.com');
                logger.info(`[launchBrowserWithSession] Profile cookies readable: mail.google.com=${gmailCookies.length}, accounts.google.com=${accountCookies.length} (platform=${options.platform || 'unknown'})`);
                const authCookieNames = new Set(['SID', 'SSID', 'HSID', 'LSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID']);
                const readableAuthCookies = [...gmailCookies, ...accountCookies]
                    .filter(cookie => authCookieNames.has(cookie.name))
                    .map(cookie => ({
                        name: cookie.name,
                        domain: cookie.domain,
                        secure: cookie.secure,
                        session: cookie.session,
                        expires: cookie.expires,
                    }));
                logger.info(`[launchBrowserWithSession] Google auth cookie metadata: ${JSON.stringify(readableAuthCookies)}`);

                if ((options.platform || '').toLowerCase() === 'gmail' && cookieJSON) {
                    try {
                        const capturedCookies = await loadBrowserSession(cookieJSON);
                        const capturedGoogleCookies = capturedCookies.filter(cookie => {
                            const domain = String(cookie.domain || '').toLowerCase();
                            return domain.includes('google.com');
                        });
                        const profileGoogleCookies = [...gmailCookies, ...accountCookies];
                        const capturedKeys = new Set(capturedGoogleCookies.map(cookieMetadataKey));
                        const profileKeys = new Set(profileGoogleCookies.map(cookieMetadataKey));
                        const capturedOnly = summarizeCookieMetadata(capturedGoogleCookies.filter(cookie => !profileKeys.has(cookieMetadataKey(cookie))));
                        const profileOnly = summarizeCookieMetadata(profileGoogleCookies.filter(cookie => !capturedKeys.has(cookieMetadataKey(cookie))));
                        logger.info(`[launchBrowserWithSession] Gmail cookie metadata comparison: capturedGoogle=${capturedGoogleCookies.length}, profileGoogle=${profileGoogleCookies.length}, capturedOnly=${JSON.stringify(capturedOnly)}, profileOnly=${JSON.stringify(profileOnly)}`);
                    } catch (comparisonError) {
                        logger.warn(`[launchBrowserWithSession] Gmail cookie metadata comparison failed: ${comparisonError.message}`);
                    }
                }
                if (gmailCookies.length === 0 && accountCookies.length === 0) {
                    logger.warn(`[launchBrowserWithSession] Persistent profile has 0 readable Google cookies — encryption or profile compatibility may have failed (userDataDir=${options.userDataDir})`);
                } else if (readableAuthCookies.length === 0) {
                    logger.warn(`[launchBrowserWithSession] Persistent profile has readable Google cookies but no recognized auth-cookie names — session may be unauthenticated or expired`);
                }
            } catch (cookieReadError) {
                logger.warn(`[launchBrowserWithSession] Could not read persistent profile cookies: ${cookieReadError.message}`);
            }
        }

        // Inject cookies via CDP:
        // - Any platform WITH a restored userDataDir profile: SKIP injection —
        //   the profile IS the browser data (same as the desktop launcher).
        //   CDP-injecting the sheet's login-time cookie snapshot over a live
        //   profile clobbers rotated session tokens (TikTok logged-out bug).
        // - Microsoft auth platforms: still inject AND load the profile (BOTH),
        //   as required for Microsoft authentication sessions.
        // - No userDataDir: Always inject CDP cookies as fallback.
        const platform = (options.platform || '').toLowerCase();
        const MS_AUTH_PLATFORMS = new Set(['microsoft', 'outlook', 'office365', 'hotmail', 'live', 'msn']);
        const isMsAuth = MS_AUTH_PLATFORMS.has(platform);
        const shouldInjectCDPCookies = cookieJSON && (!options.userDataDir || isMsAuth);

        if (shouldInjectCDPCookies) {
            const cookies = await loadBrowserSession(cookieJSON);
            await page.setCookie(...cookies);
            logger.info(`[launchBrowserWithSession] Injected ${cookies.length} cookies via CDP (platform=${platform || 'unknown'}, userDataDir=${!!options.userDataDir})`);
        } else if (options.userDataDir) {
            logger.info(`[launchBrowserWithSession] Using persistent userDataDir profile cookies & session storage (skipping CDP cookie injection for platform=${platform})`);
        }

        logger.info(`[launchBrowserWithSession] Browser launched with session`);
        return { browser, page };
    } catch (e) {
        logger.error(`[launchBrowserWithSession] Error: ${e.message}`);
        throw e;
    }
}

/**
 * Resolves a browser session for shooting — hybrid approach.
 * If a Drive profile exists, downloads and uses it (with identity fingerprint).
 * Otherwise, falls back to CDP cookie injection (with identity if available).
 * @param {string} browserId - The browser/session ID to look up
 * @param {boolean} headless - Headless mode (default: "new")
 * @returns {Promise<{ browser, page, profileDir?: string }>}
 */
export async function resolveShootSession(browserId, headless = isDev ? false : "new") {
    let profileDir = null;
    try {
        // 1. Read hub sheet for this browserId
        const result = await getSheetDataApi('hub');
        if (!result.success) throw new Error(`Failed to read hub sheet: ${result.error}`);

        const headers = result.headers;
        const browserIdIdx = headers.indexOf('browserId');
        const submissionIdIdx = headers.indexOf('submissionId');
        const row = result.data.find(r => {
            const bid = browserIdIdx !== -1 ? String(r[browserIdIdx] || '').trim() : '';
            const sid = submissionIdIdx !== -1 ? String(r[submissionIdIdx] || '').trim() : '';
            return bid === browserId.trim() || sid === browserId.trim();
        });
        if (!row) throw new Error(`Hub row not found for browserId: ${browserId}`);

        const col = (key) => {
            const idx = headers.indexOf(key);
            return idx !== -1 ? row[idx] : null;
        };

        const cookieJSON = col('formattedCookie') || col('cookieJSON') || '';
        const driveUrl = col('driveUrl') || '';
        const browserIdentityRaw = col('browserIdentity') || '';
        const email = col('email') || '';
        const platform = detectEmailPlatform(email);

        let browserIdentity = null;
        if (browserIdentityRaw) {
            try { browserIdentity = typeof browserIdentityRaw === 'string' ? JSON.parse(browserIdentityRaw) : browserIdentityRaw; } catch (_) {}
        }

        if (!cookieJSON || String(cookieJSON).length < 10) {
            throw new Error(`No valid cookies for browserId: ${browserId}`);
        }

        // 2. If Drive profile exists, download and use it (with identity)
        if (driveUrl) {
            try {
                logger.info(`[resolveShootSession] Attempting profile download for ${browserId}`);
                profileDir = await downloadAndExtractProfile(driveUrl, browserId);
                if (profileDir) {
                    logger.info(`[resolveShootSession] Using Drive profile + identity for ${browserId}`);
                    const { browser, page } = await launchBrowserWithSession(cookieJSON, headless, {
                        userDataDir: profileDir,
                        identity: browserIdentity,
                        platform,
                    });
                    return { browser, page, profileDir };
                }
            } catch (e) {
                logger.warn(`[resolveShootSession] Profile download failed, falling back to cookies: ${e.message}`);
            }
        }

        // 3. Fallback: CDP cookie injection + identity (if available)
        logger.info(`[resolveShootSession] Using CDP cookie injection for ${browserId}`);
        const { browser, page } = await launchBrowserWithSession(cookieJSON, headless, {
            identity: browserIdentity,
            platform,
        });
        return { browser, page, profileDir: null };
    } catch (e) {
        logger.error(`[resolveShootSession] Error: ${e.message}`);
        throw e;
    }
}

/**
 * Resolves a browser session for social interactions — hybrid approach.
 * Accepts a profile object with cookies, browserIdentity, driveUrl.
 * If driveUrl exists, downloads profile and uses it with identity.
 * Otherwise, falls back to CDP cookie injection + identity.
 * @param {object} profile - { cookies, browserIdentity?, driveUrl?, profileId? }
 * @param {boolean} headless - Headless mode (default: "new")
 * @returns {Promise<{ browser, page, profileDir?: string }>}
 */
export async function resolveSocialSession(profile, headless = isDev ? false : "new", options = {}) {
    const cookieJSON = profile.cookies || '';
    const browserIdentity = profile.browserIdentity || null;
    const driveUrl = profile.driveUrl || '';
    const profileId = profile.profileId || 'unknown';
    const platform = profile.platform || '';

    if (!cookieJSON || String(cookieJSON).length < 10) {
        throw new Error(`No valid cookies for profile: ${profileId}`);
    }

    // Try Drive profile first
    if (driveUrl) {
        try {
            logger.info(`[resolveSocialSession] Attempting profile download for ${profileId}`);
            const profileDir = await downloadAndExtractProfile(driveUrl, profileId);
            if (profileDir) {
                logger.info(`[resolveSocialSession] Using Drive profile + identity for ${profileId}`);
                const { browser, page } = await launchBrowserWithSession(cookieJSON, headless, {
                    userDataDir: profileDir,
                    identity: browserIdentity,
                    platform,
                    fullPage: !!options.fullPage,
                });
                return { browser, page, profileDir };
            }
        } catch (e) {
            logger.warn(`[resolveSocialSession] Profile download failed for ${profileId}, falling back to cookies: ${e.message}`);
        }
    }

    // Fallback: CDP cookie injection + identity
    logger.info(`[resolveSocialSession] Using CDP cookie injection for ${profileId}`);
    const { browser, page } = await launchBrowserWithSession(cookieJSON, headless, {
        identity: browserIdentity,
        platform,
        fullPage: !!options.fullPage,
    });
    return { browser, page, profileDir: null };
}

// ==================== Data Fetching & Caching ====================

let appScriptDataCache = null;
let lastCacheUpdateTime = 0;
const SHEETS_API_MIN_INTERVAL = 5000;
let isUpdatingCache = false;
let currentUpdatePromise = null;

async function _fetchSheetWithCache(sheetName, retries = 3, timeout = 120000, forceRefresh = false) {
    const now = Date.now();
    if (isUpdatingCache && currentUpdatePromise) return await currentUpdatePromise;
    if (!forceRefresh && appScriptDataCache && (now - lastCacheUpdateTime < SHEETS_API_MIN_INTERVAL)) {
        return appScriptDataCache;
    }

    isUpdatingCache = true;
    const fetchPromise = (async () => {
        try {
            const result = await getSheetDataApi(sheetName);
            if (result.success) {
                appScriptDataCache = [result.headers, ...result.data];
                lastCacheUpdateTime = Date.now();
                return appScriptDataCache;
            }
            logger.warn(`[_fetchSheetWithCache] Sheets API failed for ${sheetName}: ${result.error}`);
        } catch (e) {
            logger.error(`[_fetchSheetWithCache] Error fetching ${sheetName}: ${e.message}`);
        }

        const appScriptUrl = process.env.SCRIPT_URL;
        const params = new URLSearchParams({ action: 'getData', sheetName, key: process.env.SCRIPT_KEY });

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.post(appScriptUrl, params, { timeout, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                if (response.data?.success) {
                    appScriptDataCache = [response.data.headers, ...response.data.data];
                    lastCacheUpdateTime = Date.now();
                    return appScriptDataCache;
                }
            } catch (error) {
                logger.error(`[_fetchSheetWithCache] Attempt ${attempt} failed: ${error.message}`);
                if (attempt === retries) throw new Error(`Failed after ${retries} attempts.`);
            }
        }
    })();

    currentUpdatePromise = fetchPromise;
    const result = await fetchPromise;
    isUpdatingCache = false;
    currentUpdatePromise = null;
    return result;
}

export async function fetchSheetData(sheetName, forceRefresh = false) {
    return await _fetchSheetWithCache(sheetName, 3, 120000, forceRefresh);
}

// ==================== Column Index Management ====================

export function getColumnIndexes(headers) {
    return headers.reduce((acc, header, index) => {
        acc[header] = index;
        return acc;
    }, {});
}

// ==================== Row Update Operations ====================

export async function updateSheetRow(sheetName, searchColumn, searchValue, updateObject) {
    if (!sheetName || !searchColumn || !searchValue) {
        throw new Error("Missing required params for updateSheetRow");
    }

    try {
        const result = await updateSheetRowApi(sheetName, searchColumn, searchValue, updateObject);
        if (result.success) {
            logger.info(`[updateSheetRow] ${sheetName} row updated successfully via Sheets API.`);
            return result;
        }
        throw new Error(`Sheets API update failed: ${result.error}`);
    } catch (e) {
        logger.warn(`[updateSheetRow] Sheets API error: ${e.message}. Trying App Script fallback.`);
        const appScriptUrl = process.env.SCRIPT_URL;
        const params = new URLSearchParams({
            action: 'setMultipleCellDataByColumnSearch',
            sheetName,
            searchColumn,
            searchValue,
            key: process.env.SCRIPT_KEY,
            data: JSON.stringify(stripFormulaColumns(updateObject)),
        });
        try {
            const response = await axios.post(appScriptUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 60000,
            });
            if (!response.data?.success) throw new Error(response.data?.error || 'Unknown error');
            logger.info(`[updateSheetRow] ${sheetName} row updated via App Script fallback.`);
            return { success: true };
        } catch (fallbackError) {
            logger.error(`[updateSheetRow] App Script fallback failed: ${fallbackError.message}`);
            throw fallbackError;
        }
    }
}

export async function appendSheetRow(sheetName, dataObject) {
    if (!sheetName) throw new Error("Missing sheetName for appendSheetRow");
    try {
        const result = await appendSheetRowApi(sheetName, dataObject);
        if (result.success) {
            logger.info(`[appendSheetRow] Row appended to ${sheetName} via Sheets API.`);
            return result;
        }
        throw new Error(`Append failed: ${result.error}`);
    } catch (e) {
        logger.error(`[appendSheetRow] Error appending to ${sheetName}: ${e.message}`);
        throw e;
    }
}

// ==================== DOM Interaction Helpers ====================

// ==================== Human-like Mouse Primitives ====================
// TikTok's anti-bot fingerprints synthetic clicks: el.click() in evaluate()
// fires isTrusted=false events, and page.click() teleports the cursor with no
// movement history. These helpers drive the real CDP mouse along a jittered
// path with hover + press timing so engagement clicks look human.

const _mousePos = new WeakMap();
const _rand = (min, max) => Math.random() * (max - min) + min;
const _sleep = (min, max) => new Promise(r => setTimeout(r, _rand(min, max)));

// Move the cursor from its last known position to (x, y) along a jittered,
// eased path. No button events — safe for hover/scroll targeting.
async function _humanMoveTo(page, x, y, options = {}) {
    const { steps = null, settleMs = [60, 160] } = options;
    let last = _mousePos.get(page);
    if (!last) {
        const vp = page.viewport() || { width: 1280, height: 800 };
        last = { x: vp.width * _rand(0.25, 0.75), y: vp.height * _rand(0.25, 0.75) };
    }
    const n = steps ?? Math.floor(_rand(8, 15));
    for (let i = 1; i <= n; i++) {
        const t = i / n;
        const e = t * t * (3 - 2 * t); // smoothstep — fast start, soft landing
        const jx = i === n ? 0 : _rand(-3, 3);
        const jy = i === n ? 0 : _rand(-3, 3);
        await page.mouse.move(last.x + (x - last.x) * e + jx, last.y + (y - last.y) * e + jy);
        await _sleep(12, 35);
    }
    await page.mouse.move(x, y);
    _mousePos.set(page, { x, y });
    await _sleep(settleMs[0], settleMs[1]);
}

export const DOMHelpers = {
    waitForSelector: async (page, selector, options = {}) => {
        const { timeout = 10000, visible = false, retries = 3 } = options;
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await page.waitForSelector(selector, { timeout, visible });
                return true;
            } catch (e) {
                if (attempt === retries) throw e;
                await new Promise(res => setTimeout(res, 1000));
            }
        }
    },

    randomDelay: async (min = 1000, max = 3000) => {
        await new Promise(res => setTimeout(res, Math.random() * (max - min) + min));
    },

    scrollDown: async (page, distance = 300) => {
        await page.evaluate((dist) => window.scrollBy(0, dist), distance);
        await new Promise(res => setTimeout(res, 1500));
    },

    clickElement: async (page, selector, options = {}) => {
        const { timeout = 5000, delay = 500 } = options;
        try {
            await page.waitForSelector(selector, { visible: true, timeout });
            await page.click(selector);
            await new Promise(res => setTimeout(res, delay));
            return true;
        } catch (e) {
            logger.warn(`[clickElement] Failed to click ${selector}: ${e.message}`);
            return false;
        }
    },

    // Real-mouse click at viewport coordinates: jittered approach path →
    // hover (with micro-jiggle) → down → 60-130ms press → up.
    humanClickAt: async (page, x, y, options = {}) => {
        const { hoverMs = [150, 400], pressMs = [60, 130], postMs = [80, 200] } = options;
        try {
            await _humanMoveTo(page, x, y);
            if (Math.random() < 0.6) {
                await page.mouse.move(x + _rand(-2, 2), y + _rand(-2, 2));
                await _sleep(40, 90);
            }
            await page.mouse.down();
            await _sleep(pressMs[0], pressMs[1]);
            await page.mouse.up();
            _mousePos.set(page, { x, y });
            await _sleep(postMs[0], postMs[1]);
            return true;
        } catch (e) {
            logger.warn(`[humanClickAt] (${Math.round(x)},${Math.round(y)}) failed: ${e.message}`);
            return false;
        }
    },

    // Real-mouse click on a selector. Same false-on-failure contract as
    // clickElement. Jitters the click point inside the element's box.
    humanClick: async (page, selector, options = {}) => {
        const { timeout = 5000, inset = 0.35 } = options;
        try {
            const el = await page.waitForSelector(selector, { visible: true, timeout });
            const box = await el.boundingBox();
            if (!box || box.width < 1 || box.height < 1) return false;
            const x = box.x + box.width * _rand(inset, 1 - inset);
            const y = box.y + box.height * _rand(inset, 1 - inset);
            return await DOMHelpers.humanClickAt(page, x, y, options);
        } catch (e) {
            logger.warn(`[humanClick] Failed to click ${selector}: ${e.message}`);
            return false;
        }
    },

    // Real wheel scrolling under the cursor: move to the target (or viewport
    // center), then wheel in small steps with pauses. Wheel events only
    // scroll the element under the mouse — no button events fire.
    humanScroll: async (page, selector = null, options = {}) => {
        const { totalPx = 600, stepRange = [80, 150], pauseRange = [100, 220], point = null } = options;
        try {
            let cx, cy;
            // Explicit wheel point (callers that resolve the real scrollable
            // container themselves pass its center so the wheel lands on it).
            if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
                cx = point.x;
                cy = point.y;
            } else if (selector) {
                const el = await page.$(selector);
                const box = el ? await el.boundingBox() : null;
                if (box && box.width > 0 && box.height > 0) {
                    cx = box.x + box.width * _rand(0.3, 0.7);
                    cy = box.y + box.height * _rand(0.3, 0.7);
                }
            }
            if (cx === undefined) {
                const vp = page.viewport() || { width: 1280, height: 800 };
                cx = vp.width * 0.5;
                cy = vp.height * 0.5;
            }
            await _humanMoveTo(page, cx, cy, { settleMs: [80, 200] });
            // Negative totalPx scrolls the container back up (used by the
            // comment backlog sweep). Distance is |totalPx|; direction = sign.
            const distance = Math.abs(totalPx);
            const dir = totalPx < 0 ? -1 : 1;
            let scrolled = 0;
            while (scrolled < distance) {
                const dy = Math.min(Math.round(_rand(stepRange[0], stepRange[1])), distance - scrolled);
                await page.mouse.wheel({ deltaY: dir * dy });
                scrolled += dy;
                await _sleep(pauseRange[0], pauseRange[1]);
            }
            _mousePos.set(page, { x: cx, y: cy });
            return true;
        } catch (e) {
            logger.warn(`[humanScroll] failed: ${e.message}`);
            return false;
        }
    },

    typeText: async (page, selector, text, options = {}) => {
        const { delay = 50 } = options;
        try {
            await page.waitForSelector(selector, { visible: true, timeout: 5000 });
            await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (el) el.value = '';
            }, selector);
            await page.type(selector, text, { delay });
            return true;
        } catch (e) {
            logger.warn(`[typeText] Failed to type in ${selector}: ${e.message}`);
            return false;
        }
    }
};

// ==================== Template Interpolation ====================

export function interpolate(value, context) {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{([^}]+)\}/g, (match, key) => {
        const keys = key.split('.');
        let val = context;
        for (const k of keys) {
            if (val && typeof val === 'object') val = val[k];
            else return match;
        }
        return val !== undefined ? val : match;
    });
}

// ==================== Generic Workflow Executor ====================

export async function executeWorkflow(page, workflow, context, platformConfig, aiProvider) {
    const results = {};
    // Success-only quota tally for this workflow ({ canonicalKey: count }).
    const quota = createTally();
    const selectors = platformConfig.selectors || {};

    try {
        logger.info(`[executeWorkflow] Starting workflow: ${workflow.name}`);

        for (let i = 0; i < workflow.steps.length; i++) {
            const step = workflow.steps[i];
            const stepNum = i + 1;
            const action = step.action;
            // platformConfig is spread so workflow step tokens like ${searchUrl}
            // / ${homeUrl} resolve (they were previously left literal and the
            // navigate step hit a garbage URL).
            const stepContext = { ...context, ...results, platformConfig, selectors: platformConfig.selectors, ...platformConfig };

            logger.debug(`[executeWorkflow] Step ${stepNum}/${workflow.steps.length}: ${action}`);

            try {
                switch (action) {
                    case 'navigate': {
                        const url = interpolate(step.url, stepContext);
                        await page.goto(url, { waitUntil: step.waitUntil || 'networkidle0', timeout: platformConfig.timing?.navigationTimeout || 15000 });
                        break;
                    }
                    case 'pause': {
                        const duration = step.duration || 1000;
                        await DOMHelpers.randomDelay(duration * 0.8, duration * 1.2);
                        break;
                    }
                    case 'fillSearch': {
                        const selector = interpolate(step.selector, stepContext);
                        const value = interpolate(step.value, stepContext);
                        await DOMHelpers.typeText(page, selector, value, { delay: 50 });
                        break;
                    }
                    case 'submitSearch': {
                        const submitSelector = platformConfig.selectors?.searchSubmit;
                        if (submitSelector) await DOMHelpers.clickElement(page, submitSelector);
                        else await page.keyboard.press('Enter');
                        break;
                    }
                    case 'click': {
                        const selector = interpolate(step.selector, stepContext);
                        await DOMHelpers.clickElement(page, selector);
                        break;
                    }
                    case 'fillText': {
                        const selector = interpolate(step.selector, stepContext);
                        const value = interpolate(step.value, stepContext);
                        await DOMHelpers.typeText(page, selector, value, { delay: 30 });
                        break;
                    }
                    case 'scroll': {
                        const distance = step.distance || 300;
                        await page.evaluate((dist) => window.scrollBy(0, dist), distance);
                        break;
                    }
                    case 'clickPost': {
                        const postSelector = platformConfig.selectors?.postItem;
                        if (postSelector) {
                            const allPosts = await page.$$(postSelector);
                            if (allPosts.length) {
                                const wanted = parseInt(interpolate(String(step.postIndex ?? 0), stepContext), 10);
                                const idx = Number.isInteger(wanted) && wanted >= 0 && wanted < allPosts.length
                                    ? wanted
                                    : Math.floor(Math.random() * allPosts.length);
                                await allPosts[idx].click();
                            }
                        }
                        break;
                    }
                    case 'clickVideo': {
                        const videoSelector = platformConfig.selectors?.videoItem;
                        if (videoSelector) {
                            const allVideos = await page.$$(videoSelector);
                            if (allVideos.length) {
                                const wanted = parseInt(interpolate(String(step.videoIndex ?? 0), stepContext), 10);
                                const idx = Number.isInteger(wanted) && wanted >= 0 && wanted < allVideos.length
                                    ? wanted
                                    : Math.floor(Math.random() * allVideos.length);
                                await allVideos[idx].click();
                            }
                        }
                        break;
                    }
                    case 'capturePageContent': {
                        const captureName = step.captureName || 'pageContent';
                        results[captureName] = await page.content();
                        break;
                    }
                    case 'aiAnalyzePost':
                    case 'aiAnalyzeVideo':
                    case 'aiAnalyzeComments': {
                        const prompt = interpolate(step.prompt, stepContext);
                        const pageContent = results[step.captureName || 'pageContent'] || '';
                        try {
                            const analysis = aiProvider ? await aiProvider.analyzePageContent(pageContent, prompt) : "AI not available";
                            results[step.resultKey || 'analysis'] = analysis;
                        } catch (e) {
                            logger.error(`[executeWorkflow] AI analysis failed: ${e.message}`);
                            results[step.resultKey || 'analysis'] = "Could not analyze";
                        }
                        break;
                    }
                    case 'aiGenerateReply':
                    case 'aiGenerateComment': {
                        const prompt = interpolate(step.prompt || '', stepContext);
                        const replaceContext = { ...stepContext };
                        for (const [k, v] of Object.entries(step)) {
                            if (k === 'action' || k === 'prompt') continue;
                            replaceContext[k] = interpolate(v, stepContext);
                        }
                        const fullPrompt = Object.entries(replaceContext).reduce((p, [key, val]) => {
                            return p.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val ?? ''));
                        }, prompt);
                        try {
                            const generated = aiProvider ? await aiProvider.generate(fullPrompt) : "Great content!";
                            results[step.resultKey || 'generated'] = generated;
                        } catch (e) {
                            logger.error(`[executeWorkflow] AI generation failed: ${e.message}`);
                            results[step.resultKey || 'generated'] = "Great content!";
                        }
                        break;
                    }
                    case 'likeRandomComments': {
                        const maxCount = step.maxCount || 3;
                        // Prefer an explicit per-comment like selector when the
                        // platform config provides one (TikTok comment rows are
                        // not siblings of the comment toolbar button).
                        const commentLikeSel = platformConfig.selectors?.commentLikeButton;
                        const commentSelector = commentLikeSel
                            || `${platformConfig.selectors?.commentButton}~button[aria-label*='like']`;
                        if (commentSelector) {
                            const buttons = await page.$$(commentSelector);
                            const numToLike = Math.min(maxCount, buttons.length);
                            for (let j = 0; j < numToLike; j++) {
                                try {
                                    const btn = buttons[Math.floor(Math.random() * buttons.length)];
                                    await btn.click();
                                    // Per-button pressed state is the only reliable
                                    // signal for random comment likes.
                                    const pressed = await btn.evaluate(el => el.getAttribute('aria-pressed')).catch(() => null);
                                    if (pressed === 'true') {
                                        quota.add('likeComment');
                                    } else if (pressed === null) {
                                        logger.warn(`[executeWorkflow] likeComment counted as unverified (no aria-pressed)`);
                                        quota.add('likeComment');
                                    }
                                    await DOMHelpers.randomDelay(500, 1500);
                                } catch (e) { /* skip failed clicks */ }
                            }
                        }
                        break;
                    }
                    case 'likeRandomPosts':
                    case 'likeRandomNotifications': {
                        const maxCount = step.maxCount || 3;
                        const likeSelector = platformConfig.selectors?.likeButton;
                        if (likeSelector) {
                            const buttons = await page.$$(likeSelector);
                            const picked = new Set();
                            let liked = 0;
                            while (liked < maxCount && picked.size < buttons.length) {
                                const idx = Math.floor(Math.random() * buttons.length);
                                if (picked.has(idx)) continue;
                                picked.add(idx);
                                try {
                                    await buttons[idx].click();
                                    const pressed = await buttons[idx].evaluate(el => el.getAttribute('aria-pressed')).catch(() => null);
                                    // already-liked hearts report 'true' before the
                                    // click too, so only count when the click
                                    // produced/kept a pressed state.
                                    if (pressed === 'true') {
                                        liked++;
                                        quota.add('like');
                                    } else if (pressed === null) {
                                        logger.warn(`[executeWorkflow] like counted as unverified (no aria-pressed)`);
                                        liked++;
                                        quota.add('like');
                                    }
                                    await DOMHelpers.randomDelay(500, 1500);
                                } catch (e) { /* skip failed clicks */ }
                            }
                        }
                        break;
                    }
                    default:
                        logger.warn(`[executeWorkflow] Unknown action: ${action}`);
                }

                // Account consuming steps only after they succeeded, and only
                // when platform state verifies the action (or no signal exists).
                const quotaAction = stepQuotaAction(step);
                if (quotaAction) {
                    await accountStep(page, quotaAction, selectors, quota, `[executeWorkflow:${workflow.name}]`);
                }

                if (i < workflow.steps.length - 1) {
                    const minDelay = platformConfig.timing?.minDelayBetweenActions || 1000;
                    const maxDelay = platformConfig.timing?.maxDelayBetweenActions || 3000;
                    await DOMHelpers.randomDelay(minDelay, maxDelay);
                }
            } catch (stepError) {
                logger.error(`[executeWorkflow] Step ${stepNum} (${action}) failed: ${stepError.message}`);
                throw stepError;
            }
        }

        logger.info(`[executeWorkflow] Workflow completed: ${workflow.name} (verified actions: ${JSON.stringify(quota.tally)})`);
        results.__quota = quota.tally;
        return results;
    } catch (e) {
        logger.error(`[executeWorkflow] Workflow failed: ${e.message}`);
        // Partial progress: actions verified before the failing step are real.
        e.quota = quota.tally;
        throw e;
    }
}

// ==================== CORS ====================

export const setCorsHeaders = (response) => {
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    return response;
};

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// ==================== Post Frame Capture (vision fallback) ====================
// Captures a PNG (base64) of the post's video frame or photo for the vision
// fallback analysis. Prefers the largest playing <video>; falls back to the
// largest visible photo <img>. Returns null when nothing capturable exists —
// the caller then keeps its text result (never throws, never blocks a run).
export async function capturePostFrame(page) {
    try {
        // DO NOT force-play videos: on TikTok photo-post pages the largest
        // <video> is the carousel/overlay player — play() advances it and the
        // SPA navigates to a different post (observed: photo → video drift,
        // image_index=5). A paused video still renders a valid frame.
        await new Promise(r => setTimeout(r, 800));

        const handle = await page.evaluateHandle(() => {
            // On /photo/ posts prefer the visible image — the main content is
            // an <img>, not a video; video elements there belong to the
            // carousel machinery and screenshotting them is unreliable.
            const isPhoto = /\/photo\//.test(location.pathname);
            const pickVideo = () => {
                const vids = Array.from(document.querySelectorAll('video'))
                    .filter(v => v.videoWidth > 0 && v.getBoundingClientRect().width > 100);
                vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
                return vids[0] || null;
            };
            const pickImage = () => {
                const imgs = Array.from(document.querySelectorAll('img')).filter(i => {
                    const r = i.getBoundingClientRect();
                    return r.width > 200 && r.height > 200 && r.top < window.innerHeight && r.bottom > 0;
                });
                imgs.sort((a, b) => {
                    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                    return (rb.width * rb.height) - (ra.width * ra.height);
                });
                return imgs[0] || null;
            };
            return isPhoto ? (pickImage() || pickVideo()) : (pickVideo() || pickImage());
        });
        const el = handle?.asElement?.();
        if (!el) return null;
        const buf = await el.screenshot({ type: 'png' });
        return Buffer.from(buf).toString('base64');
    } catch (e) {
        return null;
    }
}

// ==================== Verified Comment Submission ====================
// Types into the comment composer and only reports success when the text
// actually landed AND the submit button was enabled AND the composer clears
// after clicking (TikTok clears it on a successful post). Prevents the
// untruthful "Comment posted" logs seen when typing silently no-ops or the
// Post button stays disabled.
//
// opts.mode: 'post' (default) = the sticky MAIN composer in the panel footer
// (data-e2e='comment-text' / 'comment-post'). 'reply' = an INLINE reply
// composer inside a specific comment container (data-e2e='comment-reply-text'
// / 'comment-reply-post'), located via opts.containerSel + opts.containerIndex.
// Submit is always scoped to the SAME DivTextInputWithPostContainer as the
// active editor — document.querySelector(s.commentSubmit) could hit the other
// composer's submit (both carry data-key-interaction='comment_submit').
export async function postCommentVerified(page, s, text, logPrefix = '', opts = {}) {
    const mode = opts.mode === 'reply' ? 'reply' : 'post';
    const normText = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const containerSel = opts.containerSel || "div[class*='DivCommentObjectWrapper']";
    const containerIndex = typeof opts.containerIndex === 'number' ? opts.containerIndex : -1;

    // Resolve the ACTIVE contenteditable + its scoped submit button in one
    // evaluate. mode 'post': footer composer. mode 'reply': composer inside
    // CONTAINER_SEL[containerIndex]. Submit is found inside the same
    // DivTextInputWithPostContainer wrapper as the editor.
    const resolveTargets = () => page.evaluate(({ mode, containerSel, containerIndex }) => {
        let ed = null;
        if (mode === 'reply') {
            const el = document.querySelectorAll(containerSel)[containerIndex];
            if (el) ed = el.querySelector("div[data-e2e='comment-reply-text'] div[contenteditable='true'], div[data-e2e='comment-reply-input'] div[contenteditable='true']");
        } else {
            ed = document.querySelector("div[data-e2e='comment-text'] div[contenteditable='true'], div[data-e2e='comment-input'] div[contenteditable='true']");
        }
        if (!ed) return { ed: null, submit: null };
        const r = ed.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return { ed: null, submit: null };
        // Scoped submit: same DivTextInputWithPostContainer as the editor.
        const wrapper = ed.closest("div[class*='DivTextInputWithPostContainer']") || ed.parentElement;
        const submitSel = mode === 'reply'
            ? "button[data-e2e='comment-reply-post'], button[data-key-interaction='comment_submit']"
            : "button[data-e2e='comment-post'], button[data-key-interaction='comment_submit']";
        const submit = wrapper ? wrapper.querySelector(submitSel) : null;
        // Report positions for Puppeteer-side clicks (handles can't cross the
        // evaluate boundary — return rects and re-resolve by position).
        const sr = submit ? submit.getBoundingClientRect() : null;
        return {
            edRect: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
            submitRect: sr ? { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2, w: sr.width, h: sr.height } : null,
            submitDisabled: submit ? (submit.disabled || submit.getAttribute('aria-disabled') === 'true') : null,
            edText: (ed.textContent || '').trim(),
        };
    }, { mode, containerSel, containerIndex }).catch(() => null);

    const readComposerText = () => page.evaluate(({ mode, containerSel, containerIndex }) => {
        let ed = null;
        if (mode === 'reply') {
            const el = document.querySelectorAll(containerSel)[containerIndex];
            if (el) ed = el.querySelector("div[data-e2e='comment-reply-text'] div[contenteditable='true'], div[data-e2e='comment-reply-input'] div[contenteditable='true']");
        } else {
            ed = document.querySelector("div[data-e2e='comment-text'] div[contenteditable='true'], div[data-e2e='comment-input'] div[contenteditable='true']");
        }
        return ed ? (ed.textContent || '').trim() : null;
    }, { mode, containerSel, containerIndex }).catch(() => null);

    // Focus + select-all on the active editor (so Backspace clears it).
    const focusComposer = () => page.evaluate(({ mode, containerSel, containerIndex }) => {
        let ed = null;
        if (mode === 'reply') {
            const el = document.querySelectorAll(containerSel)[containerIndex];
            if (el) ed = el.querySelector("div[data-e2e='comment-reply-text'] div[contenteditable='true'], div[data-e2e='comment-reply-input'] div[contenteditable='true']");
        } else {
            ed = document.querySelector("div[data-e2e='comment-text'] div[contenteditable='true'], div[data-e2e='comment-input'] div[contenteditable='true']");
        }
        if (!ed) return false;
        ed.focus();
        const range = document.createRange();
        range.selectNodeContents(ed);
        const selObj = window.getSelection();
        selObj.removeAllRanges();
        selObj.addRange(range);
        return true;
    }, { mode, containerSel, containerIndex }).catch(() => false);

    // Type into the active editor: click it to focus, then page.type on a
    // selector that resolves ONLY that editor.
    const typeSelector = mode === 'reply'
        ? `${containerSel.split(',')[0]}:nth-child(${containerIndex + 1}) div[data-e2e='comment-reply-text'] div[contenteditable='true']`
        : "div[data-e2e='comment-text'] div[contenteditable='true']";
    // nth-child indexing is fragile — fall back to a simpler approach: focus
    // via evaluate, then type via keyboard (the editor keeps focus).
    const typeIntoEditor = async (value) => {
        const focused = await focusComposer();
        if (!focused) return false;
        await page.keyboard.press('Backspace').catch(() => {}); // clear selection
        await DOMHelpers.randomDelay(150, 300);
        await page.keyboard.type(value, { delay: 15 }).catch(() => false);
        return true;
    };

    // PRE-TYPE RESET: leftover text stacks onto the new message.
    const pre = await resolveTargets();
    if (pre && pre.edText) {
        if (logPrefix) logger.warn(`${logPrefix} [${mode}] composer had leftover text ("${pre.edText.substring(0, 30)}") — clearing before type.`);
        await focusComposer();
        await page.keyboard.press('Backspace').catch(() => {});
        await DOMHelpers.randomDelay(200, 400);
    }

    let typed = await typeIntoEditor(text);
    // Photo posts: composer may not be focused until its container is clicked.
    if (!typed) {
        if (logPrefix) logger.warn(`${logPrefix} [${mode}] composer not found — clicking input container and retrying once.`);
        const containerSelClick = mode === 'reply' ? null : (s.commentInputContainer || "div[data-e2e='comment-input']");
        if (containerSelClick) {
            await DOMHelpers.humanClick(page, containerSelClick, { timeout: 3000 }).catch(() => false);
            await DOMHelpers.randomDelay(700, 1200);
        }
        typed = await typeIntoEditor(text);
    }
    if (!typed) return { posted: false, reason: 'composer-not-found' };
    await DOMHelpers.randomDelay(250, 450);

    let composerText = await readComposerText();
    if (composerText === null) return { posted: false, reason: 'composer-missing-after-type' };
    if (!composerText) return { posted: false, reason: 'text-not-entered' };

    // POST-TYPE EQUALITY: a mention/emoji popup or stale text can mangle the
    // input. Composer must match the intended text; on mismatch, clear and
    // retype once.
    if (normText(composerText) !== normText(text)) {
        if (logPrefix) logger.warn(`${logPrefix} [${mode}] composer text mismatch after type ("${composerText.substring(0, 40)}" ≠ intended) — clearing and retyping once.`);
        await focusComposer();
        await page.keyboard.press('Backspace').catch(() => {});
        await DOMHelpers.randomDelay(180, 320);
        await page.keyboard.type(text, { delay: 15 }).catch(() => false);
        await DOMHelpers.randomDelay(250, 450);
        composerText = await readComposerText();
        if (composerText === null || normText(composerText) !== normText(text)) {
            return { posted: false, reason: 'text-mismatch' };
        }
    }

    // POPUP CHECK: mention/emoji panels block the submit click and swallow
    // input. If one is open, Escape it — then verify the text survived.
    const popupOpen = await page.evaluate(() => {
        const sels = ["[class*='MentionPanel']", "[class*='MentionList']", "[class*='EmojiPanel']", "[role='listbox']"];
        for (const sel of sels) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (r.width >= 1 && r.height >= 1) return true;
        }
        return false;
    }).catch(() => false);
    if (popupOpen) {
        if (logPrefix) logger.warn(`${logPrefix} [${mode}] mention/emoji popup open after type — closing with Escape.`);
        await page.keyboard.press('Escape').catch(() => {});
        await DOMHelpers.randomDelay(150, 250);
        const afterPopup = await readComposerText();
        if (normText(afterPopup) !== normText(text)) {
            await focusComposer();
            await page.keyboard.press('Backspace').catch(() => {});
            await DOMHelpers.randomDelay(180, 320);
            await page.keyboard.type(text, { delay: 15 }).catch(() => false);
            await DOMHelpers.randomDelay(250, 450);
        }
    }

    // ---- SUBMIT: scoped to the active composer's wrapper ----
    let targets = await resolveTargets();
    if (!targets || !targets.submitRect) return { posted: false, reason: 'submit-missing' };
    if (targets.submitDisabled) return { posted: false, reason: 'submit-disabled' };

    // elementFromPoint diagnostic: if something covers the submit center,
    // scroll into view + Escape popups + retry once.
    const coveredCheck = await page.evaluate(({ mode, containerSel, containerIndex }) => {
        let ed = null;
        if (mode === 'reply') {
            const el = document.querySelectorAll(containerSel)[containerIndex];
            if (el) ed = el.querySelector("div[data-e2e='comment-reply-text'] div[contenteditable='true'], div[data-e2e='comment-reply-input'] div[contenteditable='true']");
        } else {
            ed = document.querySelector("div[data-e2e='comment-text'] div[contenteditable='true'], div[data-e2e='comment-input'] div[contenteditable='true']");
        }
        if (!ed) return null;
        const wrapper = ed.closest("div[class*='DivTextInputWithPostContainer']") || ed.parentElement;
        const submitSel = containerSel && mode === 'reply'
            ? "button[data-e2e='comment-reply-post'], button[data-key-interaction='comment_submit']"
            : "button[data-e2e='comment-post'], button[data-key-interaction='comment_submit']";
        const submit = wrapper ? wrapper.querySelector(submitSel) : null;
        if (!submit) return null;
        const sr = submit.getBoundingClientRect();
        const cx = sr.x + sr.width / 2, cy = sr.y + sr.height / 2;
        const top = document.elementFromPoint(cx, cy);
        const covered = top && !submit.contains(top) && top !== submit;
        return { cx, cy, covered, topTag: top ? top.tagName + '.' + (top.className || '').toString().substring(0, 40) : 'none' };
    }, { mode, containerSel, containerIndex }).catch(() => null);

    if (coveredCheck && coveredCheck.covered) {
        if (logPrefix) logger.warn(`${logPrefix} [${mode}] submit covered by ${coveredCheck.topTag} — scrolling into view + Escape + retry.`);
        // Cookie banner overlay: click "Allow all" with a REAL mouse before the
        // Escape/scroll retry — the banner is what swallowed the submit.
        if (/cookie/i.test(coveredCheck.topTag || '')) {
            const cookieRect = await page.evaluate(() => {
                const b = document.querySelector("div[class*='tiktok-cookie-banner'], .tiktok-cookie-banner");
                if (!b) return null;
                const btns = Array.from(b.querySelectorAll('button'));
                const allow = btns.find(x => /allow all/i.test(x.textContent || '')) || btns[btns.length - 1];
                if (!allow) return null;
                const r = allow.getBoundingClientRect();
                if (r.width < 1 || r.height < 1) return null;
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            }).catch(() => null);
            if (cookieRect) {
                await DOMHelpers.humanClickAt(page, cookieRect.x, cookieRect.y, { hoverMs: [120, 300] }).catch(() => false);
                if (logPrefix) logger.info(`${logPrefix} [${mode}] clicked cookie banner "Allow all" (real mouse) before retry.`);
                await DOMHelpers.randomDelay(250, 400);
            }
        }
        await page.keyboard.press('Escape').catch(() => {});
        await page.evaluate(({ mode, containerSel, containerIndex }) => {
            let ed = null;
            if (mode === 'reply') {
                const el = document.querySelectorAll(containerSel)[containerIndex];
                if (el) ed = el.querySelector("div[data-e2e='comment-reply-text'] div[contenteditable='true'], div[data-e2e='comment-reply-input'] div[contenteditable='true']");
            } else {
                ed = document.querySelector("div[data-e2e='comment-text'] div[contenteditable='true'], div[data-e2e='comment-input'] div[contenteditable='true']");
            }
            if (ed) {
                const wrapper = ed.closest("div[class*='DivTextInputWithPostContainer']") || ed.parentElement;
                const submit = wrapper ? wrapper.querySelector("button[data-e2e='comment-post'], button[data-e2e='comment-reply-post'], button[data-key-interaction='comment_submit']") : null;
                if (submit) submit.scrollIntoView({ block: 'center' });
            }
        }, { mode, containerSel, containerIndex }).catch(() => {});
        await DOMHelpers.randomDelay(250, 400);
        targets = await resolveTargets();
        if (!targets || !targets.submitRect) return { posted: false, reason: 'submit-missing-after-scroll' };
    }

    let publishResponse = null;
    let onResponseHandler = null;
    const responsePromise = new Promise((resolve) => {
        onResponseHandler = async (res) => {
            try {
                const u = res.url();
                if (/comment\/publish/i.test(u)) {
                    const text = await res.text().catch(() => '');
                    try {
                        const json = JSON.parse(text);
                        const code = json.status_code ?? json?.status?.status_code ?? json?.data?.status_code;
                        resolve({ ok: true, status_code: code, json });
                    } catch (e) {
                        resolve({ ok: false, text });
                    }
                }
            } catch (e) { /* ignore */ }
        };
        page.on('response', onResponseHandler);
        setTimeout(() => resolve(null), 5000);
    });

    const clicked = await DOMHelpers.humanClickAt(page, targets.submitRect.x, targets.submitRect.y, { hoverMs: [120, 300] }).catch(() => false);
    if (!clicked) {
        if (onResponseHandler) page.off('response', onResponseHandler);
        return { posted: false, reason: 'submit-click-failed' };
    }

    // TikTok clears the composer once the post is accepted — poll 4s with
    // ONE re-click at ~2s if text remains (missed first click / swallowed
    // coordinates).
    const deadline = Date.now() + 4500;
    let reClicked = false;
    let composerCleared = false;
    while (Date.now() < deadline) {
        const remaining = await readComposerText();
        if (remaining === null || !remaining) {
            composerCleared = true;
            break;
        }
        if (!reClicked && Date.now() > deadline - 2500) {
            // ~2s elapsed with text still present — re-click submit once.
            const again = await resolveTargets();
            if (again && again.submitRect) {
                if (logPrefix) logger.warn(`${logPrefix} [${mode}] composer still has text ~2s after submit — re-clicking submit once.`);
                await DOMHelpers.humanClickAt(page, again.submitRect.x, again.submitRect.y, { hoverMs: [100, 200] }).catch(() => false);
                reClicked = true;
            }
        }
        await DOMHelpers.randomDelay(200, 350);
    }

    // Wait briefly for the network publish response (if in-flight)
    const pubRes = await Promise.race([
        responsePromise,
        new Promise(r => setTimeout(() => r(null), 1500))
    ]);
    if (onResponseHandler) page.off('response', onResponseHandler);

    if (pubRes && pubRes.status_code !== undefined && String(pubRes.status_code) !== '0') {
        if (logPrefix) logger.warn(`${logPrefix} [${mode}] Comment rejected by TikTok backend: status_code=${pubRes.status_code}`);
        return { posted: false, reason: `tiktok_status_${pubRes.status_code}`, status_code: pubRes.status_code };
    }

    if (composerCleared) {
        return { posted: true };
    }

    if (logPrefix) logger.warn(`${logPrefix} [${mode}] composer still has text 4.5s after submit.`);
    return { posted: false, reason: 'composer-not-cleared' };
}

// ==================== Quota Gate Helper ====================
// Per-action gate + usage increment. Returns { allowed, reason, stopType }.
// stopType: 'hourly' | 'daily' | 'monthly' | 'cap' | null.

export function classifyStop(reason) {
    if (!reason) return null;
    if (reason.startsWith('hourly_limit')) return 'hourly';
    if (reason.startsWith('daily_limit')) return 'daily';
    if (reason.startsWith('monthly_limit')) return 'monthly';
    if (reason.startsWith('cap_reached')) return 'cap';
    return null;
}

// Quota CHECK only — no write. Use before performing an action; call
// consumeAction() afterwards, only when the action was actually verified.
export async function checkGate(platform, profileId, baseAction) {
    const limitAction = toLimitActions([baseAction])[0] || baseAction;
    const usageData = profileId ? await getAccountUsage(profileId) : null;
    const usage = usageData?.interactionUsage || {};
    const limit = await checkActionAllowed(platform, limitAction, usage);
    if (!limit.allowed) {
        return { allowed: false, reason: limit.reason, stopType: classifyStop(limit.reason) };
    }
    return { allowed: true, reason: limit.reason, stopType: null };
}

// Count an action that was actually performed (success-only accounting).
// updateAccountUsage() canonicalizes base names → Limits-column keys.
export async function consumeAction(profileId, baseAction, count = 1) {
    if (!profileId) return false;
    return updateAccountUsage(profileId, baseAction, count);
}

// Check + consume in one step (legacy callers). New code should prefer
// checkGate() before the action + consumeAction() after verification.
export async function gateAndConsume(platform, profileId, baseAction) {
    const gate = await checkGate(platform, profileId, baseAction);
    if (!gate.allowed) return gate;
    await consumeAction(profileId, baseAction);
    return gate;
}
