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
export async function resolveSocialSession(profile, headless = isDev ? false : "new") {
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
        const { totalPx = 600, stepRange = [80, 150], pauseRange = [150, 350] } = options;
        try {
            let cx, cy;
            if (selector) {
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
            let scrolled = 0;
            while (scrolled < totalPx) {
                const dy = Math.min(Math.round(_rand(stepRange[0], stepRange[1])), totalPx - scrolled);
                await page.mouse.wheel({ deltaY: dy });
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
                                    await buttons[Math.floor(Math.random() * buttons.length)].click();
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
                                    liked++;
                                    await DOMHelpers.randomDelay(500, 1500);
                                } catch (e) { /* skip failed clicks */ }
                            }
                        }
                        break;
                    }
                    default:
                        logger.warn(`[executeWorkflow] Unknown action: ${action}`);
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

        logger.info(`[executeWorkflow] Workflow completed: ${workflow.name}`);
        return results;
    } catch (e) {
        logger.error(`[executeWorkflow] Workflow failed: ${e.message}`);
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
        // Make sure the main video is playing so a frame is actually rendered.
        await page.evaluate(() => {
            const vids = Array.from(document.querySelectorAll('video'));
            vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
            const v = vids[0];
            if (v) { v.muted = true; if (v.paused) v.play().catch(() => {}); }
        }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));

        const handle = await page.evaluateHandle(() => {
            // Largest video that has real dimensions.
            const vids = Array.from(document.querySelectorAll('video'))
                .filter(v => v.videoWidth > 0 && v.getBoundingClientRect().width > 100);
            vids.sort((a, b) => (b.videoWidth * b.videoHeight) - (a.videoWidth * a.videoHeight));
            if (vids[0]) return vids[0];
            // Else largest visible photo image (photo posts / image-text).
            const imgs = Array.from(document.querySelectorAll('img')).filter(i => {
                const r = i.getBoundingClientRect();
                return r.width > 200 && r.height > 200 && r.top < window.innerHeight && r.bottom > 0;
            });
            imgs.sort((a, b) => {
                const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
                return (rb.width * rb.height) - (ra.width * ra.height);
            });
            return imgs[0] || null;
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
export async function postCommentVerified(page, s, text, logPrefix = '') {
    let typed = await DOMHelpers.typeText(page, s.commentBox, text, { delay: 40 }).catch(() => false);
    // Photo posts: comments list renders but the DraftEditor isn't focused /
    // mounted until the input container is clicked. One focus+retry before
    // giving up (fixes composer-not-found on photo posts).
    if (!typed) {
        if (logPrefix) logger.warn(`${logPrefix} composer not found — clicking comment input and retrying once.`);
        await DOMHelpers.humanClick(page, s.commentInputContainer || "div[data-e2e='comment-input']", { timeout: 3000 }).catch(() => false);
        await DOMHelpers.randomDelay(700, 1200);
        typed = await DOMHelpers.typeText(page, s.commentBox, text, { delay: 40 }).catch(() => false);
    }
    if (!typed) return { posted: false, reason: 'composer-not-found' };
    await DOMHelpers.randomDelay(600, 1200);

    const composerText = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        return el ? (el.textContent || '').trim() : null;
    }, s.commentBox).catch(() => null);
    if (composerText === null) return { posted: false, reason: 'composer-missing-after-type' };
    if (!composerText) return { posted: false, reason: 'text-not-entered' };

    const btnState = await page.evaluate((sel) => {
        const b = document.querySelector(sel);
        if (!b) return 'missing';
        return (b.disabled || b.getAttribute('aria-disabled') === 'true') ? 'disabled' : 'enabled';
    }, s.commentSubmit).catch(() => 'missing');
    if (btnState !== 'enabled') return { posted: false, reason: `submit-${btnState}` };

    const clicked = await DOMHelpers.humanClick(page, s.commentSubmit, { timeout: 5000 }).catch(() => false);
    if (!clicked) return { posted: false, reason: 'submit-click-failed' };

    // TikTok clears the composer once the post is accepted — poll briefly.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
        const remaining = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            return el ? (el.textContent || '').trim() : '';
        }, s.commentBox).catch(() => '');
        if (!remaining) return { posted: true };
        await DOMHelpers.randomDelay(400, 700);
    }
    if (logPrefix) logger.warn(`${logPrefix} composer still has text 4s after submit.`);
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

export async function gateAndConsume(platform, profileId, baseAction) {
    const limitAction = toLimitActions([baseAction])[0] || baseAction;
    const usageData = profileId ? await getAccountUsage(profileId) : null;
    const usage = usageData?.interactionUsage || {};
    const limit = await checkActionAllowed(platform, limitAction, usage);
    if (!limit.allowed) {
        return { allowed: false, reason: limit.reason, stopType: classifyStop(limit.reason) };
    }
    if (profileId) {
        await updateAccountUsage(profileId, baseAction);
    }
    return { allowed: true, reason: limit.reason, stopType: null };
}
