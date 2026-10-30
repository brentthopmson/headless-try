import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, ensureSheetColumns } from '../../googlesheets.js';

export const maxDuration = 30;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const COOKIE_SHEET = 'cookie';

export async function POST(request) {
    try {
        const body = await request.json();
        const { browserId, token, launcherKey, cookies } = body;

        if (!browserId) {
            return NextResponse.json({ error: "Missing required field: browserId" }, { status: 400 });
        }

        if (!token) {
            return NextResponse.json({ error: "Missing authentication token" }, { status: 401 });
        }

        logger.info(`[electron/sync-cookies] Sync request for browserId=${browserId} launcherKey=${launcherKey || 'none'} cookiesCount=${Array.isArray(cookies) ? cookies.length : 0}`);

        const result = await getSheetDataApi(COOKIE_SHEET);
        if (!result.success) {
            logger.error(`[electron/sync-cookies] Failed to read cookie sheet: ${result.error}`);
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

        if (parsedLaunchHistory && parsedLaunchHistory.launcherKey) {
            if (launcherKey && parsedLaunchHistory.launcherKey !== launcherKey) {
                logger.warn(`[electron/sync-cookies] Access Denied: browserId=${browserId} is locked to launcherKey=${parsedLaunchHistory.launcherKey}, sync attempted by launcherKey=${launcherKey}`);
                return NextResponse.json({
                    error: "Access Denied: This session is locked to a different launcher installation."
                }, { status: 403 });
            }
        }

        const now = new Date().toISOString();
        const updatedHistory = {
            ...(parsedLaunchHistory || {}),
            launcherKey: launcherKey || parsedLaunchHistory?.launcherKey || '',
            lastHeartbeat: now
        };

        // Check platform: STRICTLY GOOGLE-ONLY for cookie write-backs
        const email = col('email') || '';
        const domain = col('domain') || (email ? email.split('@')[1]?.toLowerCase() : '') || '';
        const platform = col('platform') || '';
        const d = (domain || '').toLowerCase().trim();
        const p = (platform || '').toLowerCase().trim();
        const em = (email || '').toLowerCase().trim();
        const isGoogle = p === 'google' || p === 'gmail' || p.includes('google') || p.includes('gmail') || p.includes('gsuite') || p.includes('workspace') || d.includes('google') || d.includes('gmail') || em.endsWith('@gmail.com') || em.endsWith('@googlemail.com');

        if (!isGoogle) {
            // Microsoft / Outlook / Other: Leave cookies untouched! Update heartbeat only.
            try {
                await ensureSheetColumns(COOKIE_SHEET, ['launchHistory']);
                await updateSheetRowApi(COOKIE_SHEET, 'browserId', browserId, {
                    launchHistory: JSON.stringify(updatedHistory)
                });
            } catch (err) {
                logger.warn(`[electron/sync-cookies] Failed to update heartbeat for non-Google session: ${err.message}`);
            }
            return NextResponse.json({
                success: true,
                message: "Heartbeat recorded (non-Google session; cookies untouched)"
            });
        }

        // For Google: Validate cookies array before persisting
        if (!Array.isArray(cookies) || cookies.length === 0) {
            // Just update heartbeat
            try {
                await ensureSheetColumns(COOKIE_SHEET, ['launchHistory']);
                await updateSheetRowApi(COOKIE_SHEET, 'browserId', browserId, {
                    launchHistory: JSON.stringify(updatedHistory)
                });
            } catch (err) {
                logger.warn(`[electron/sync-cookies] Failed to update heartbeat: ${err.message}`);
            }
            return NextResponse.json({
                success: true,
                message: "Heartbeat recorded (no cookies to sync)"
            });
        }

        // Safety check: Ensure incoming cookie jar contains core Google auth tokens
        const hasCoreAuth = cookies.some(c => c && (c.name === 'SID' || c.name === '__Secure-1PSID' || c.name === 'HSID' || c.name === 'SSID'));
        if (!hasCoreAuth) {
            logger.warn(`[electron/sync-cookies] Incoming cookies lack core Google auth tokens. Skipping cookie overwrite to protect session.`);
            return NextResponse.json({
                success: false,
                warning: "Sync rejected: core auth tokens missing"
            }, { status: 422 });
        }

        // Partition into 3 waterfall tiers:
        // Helper to check if domain belongs to Google ecosystem
        const isGoogleEcosystem = (dom) => {
            if (!dom) return false;
            const d = dom.toLowerCase();
            return d.includes('google') || d.includes('youtube') || d.includes('blogger') || d.includes('youtu.be') || d.includes('1e100.net');
        };

        // Tier 1: driveCookieJSON = Superset of all Google ecosystem cookies
        const driveCookieJSON = cookies.filter(c => c && isGoogleEcosystem(c.domain));

        // Tier 2: accountCookie = Exclude drive.google.com
        const accountCookie = cookies.filter(c => c && isGoogleEcosystem(c.domain) && !c.domain.includes('drive.google.com'));

        // Tier 3: cookieJSON = Core mail subset (exclude drive and myaccount)
        const cookieJSON = cookies.filter(c => c && isGoogleEcosystem(c.domain) && !c.domain.includes('drive.google.com') && !c.domain.includes('myaccount.google.com'));

        updatedHistory.lastSync = now;

        const updatePayload = {
            driveCookieJSON: JSON.stringify(driveCookieJSON),
            accountCookie: JSON.stringify(accountCookie),
            accountCookieJSON: JSON.stringify(accountCookie),
            cookieJSON: JSON.stringify(cookieJSON),
            cookie: JSON.stringify(cookieJSON),
            launchHistory: JSON.stringify(updatedHistory)
        };

        await ensureSheetColumns(COOKIE_SHEET, ['driveCookieJSON', 'accountCookie', 'accountCookieJSON', 'cookieJSON', 'cookie', 'launchHistory']);
        const updateResult = await updateSheetRowApi(COOKIE_SHEET, 'browserId', browserId, updatePayload);

        if (!updateResult.success) {
            logger.error(`[electron/sync-cookies] Failed to write synchronized cookies to sheet: ${updateResult.error}`);
            return NextResponse.json({ error: "Failed to persist synced cookies" }, { status: 500 });
        }

        logger.info(`[electron/sync-cookies] Successfully synchronized ${cookies.length} cookies for Google session browserId=${browserId} (drive=${driveCookieJSON.length}, account=${accountCookie.length}, mail=${cookieJSON.length})`);

        return NextResponse.json({
            success: true,
            message: `Successfully synchronized ${cookies.length} live cookies`,
            count: cookies.length,
            timestamp: now
        });

    } catch (e) {
        logger.error(`[electron/sync-cookies] Error: ${e.message}`);
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
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
