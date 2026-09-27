import { NextResponse } from 'next/server';
import { launchBrowser } from '../../../utils/utils.js';
import { requireFeature } from '../../../utils/featureGate.js';
import { getSheetDataApi } from '../../api/googlesheets.js';

const INBOX_URLS = [
  'https://mail.google.com',
  'https://mail.google.com/mail/u/0/#inbox',
  'https://inbox.google.com'
];

const INBOX_SELECTORS = [
  '[role="main"]',
  '[data-email]',
  '[aria-label*="Inbox"]',
  '[data-testid="primary-tab"]',
  'div[role="list"]',
  'tr.zA',
  '.aeJ',
  '[gh="tm"]'
];

async function checkEmailInbox(browser) {
  const page = await browser.newPage();
  
  try {
    for (const url of INBOX_URLS) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        const currentUrl = page.url();
        
        // Check if redirected to login
        if (currentUrl.includes('accounts.google.com/signin') || 
            currentUrl.includes('accounts.google.com/v3/signin')) {
          return { reachedInbox: false, message: 'Redirected to login - session expired' };
        }
        
        // Check for inbox selectors
        for (const selector of INBOX_SELECTORS) {
          try {
            const element = await page.$(selector);
            if (element) {
              return { reachedInbox: true, message: 'Inbox accessible', url: currentUrl };
            }
          } catch (e) {
            // Continue to next selector
          }
        }
        
        // Check page content for inbox indicators
        const pageContent = await page.content();
        if (pageContent.includes('Inbox') || 
            pageContent.includes('Compose') ||
            pageContent.includes('mailto:') ||
            pageContent.includes('Gmail')) {
          return { reachedInbox: true, message: 'Inbox content detected', url: currentUrl };
        }
      } catch (e) {
        // Try next URL
      }
    }
    
    return { reachedInbox: false, message: 'Could not detect inbox' };
  } finally {
    await page.close();
  }
}

export async function POST(request) {
  let browser = null;
  
  try {
    const gate = await requireFeature('allowRevalidation', 'session revalidation');
    if (gate) return gate;
    const body = await request.json();
    const { browserId, cookieJSON } = body;
    
    if (!browserId || !cookieJSON) {
      return NextResponse.json(
        { success: false, message: 'Missing browserId or cookieJSON' },
        { status: 400 }
      );
    }
    
    // Parse cookies if string
    let cookies = cookieJSON;
    if (typeof cookieJSON === 'string') {
      cookies = JSON.parse(cookieJSON);
    }

    // Re-validate with the SAVED identity + real geo. Launching with a fresh
    // random identity each call presented the same session cookie to Google
    // with a different timezone/UA/screen every time — a strong session
    // revocation signal. Sheet read failures are non-fatal (fall back to
    // random identity, same as before).
    let savedIdentity = null;
    let isGoogleDomain = false;
    try {
      const cookieResult = await getSheetDataApi('cookie');
      if (cookieResult.success) {
        const idx = cookieResult.headers.indexOf('browserId');
        const row = idx !== -1
          ? cookieResult.data.find((r) => String(r[idx]).trim() === String(browserId).trim())
          : null;
        if (row) {
          const col = (key) => {
            const i = cookieResult.headers.indexOf(key);
            return i !== -1 ? row[i] : null;
          };
          const identityRaw = col('browserIdentity') || '';
          if (identityRaw) {
            try { savedIdentity = typeof identityRaw === 'string' ? JSON.parse(identityRaw) : identityRaw; } catch (_) {}
          }
          const emailDomain = String(col('email') || '').split('@')[1]?.toLowerCase() || '';
          isGoogleDomain = emailDomain === 'gmail.com' || emailDomain === 'googlemail.com';
        }
      }
    } catch (e) {
      // Non-fatal — proceed without saved identity
    }

    // Launch browser
    browser = await launchBrowser({
      ...(savedIdentity ? { identity: savedIdentity } : {}),
      realGeo: isGoogleDomain,
    });
    
    // Set cookies
    const page = await browser.newPage();
    
    for (const cookie of cookies) {
      try {
        const cookieParam = {
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path || '/',
          secure: cookie.secure || false,
          httpOnly: cookie.httpOnly || false
        };
        
        if (cookie.expirationDate) {
          cookieParam.expires = cookie.expirationDate;
        }
        
        await page.setCookie(cookieParam);
      } catch (e) {
        // Skip invalid cookies
      }
    }
    
    // Check inbox
    const result = await checkEmailInbox(browser);
    
    return NextResponse.json({
      success: true,
      status: result.reachedInbox ? 'COMPLETED' : 'FAILED',
      message: result.message,
      browserId,
      category: 'WIRE'
    });
    
  } catch (error) {
    console.error('Email verify-session error:', error);
    return NextResponse.json(
      { success: false, message: error.message || 'Verification failed' },
      { status: 500 }
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
