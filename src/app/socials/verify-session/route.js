import { NextResponse } from 'next/server';
import { launchBrowser } from '../../../utils/utils.js';
import { applyIdentityToPage } from '../../../utils/identity.js';
import { requireFeature } from '../../../utils/featureGate.js';
import { checkUserQuota } from '../../socials/_shared/limits.js';
import { updateUserUsage } from '../../socials/_shared/hubUpdater.js';
import logger from '../../../utils/logger.js';

const INBOX_URLS = [
  'https://www.linkedin.com/feed/',
  'https://www.linkedin.com/messaging/',
  'https://www.linkedin.com/home/'
];

const INBOX_SELECTORS = [
  '[data-test-id="main-feed-primary"]',
  '.feed-shared-update-v2',
  '[data-test-id="messaging-list"]',
  '.msg-conversations-container',
  '.scaffold-layout__main',
  '#voyager-feed'
];

// Normalize a free-form platform hint to a known token; non-platform values
// (WIRE/SOCIAL/BANK, gmail/outlook, …) normalize to "".
function normalizePlatformToken(value) {
  const p = String(value || '').toLowerCase().trim();
  if (!p) return '';
  if (p.includes('tiktok')) return 'tiktok';
  if (p.includes('twitter')) return 'twitter';
  if (p.includes('instagram')) return 'instagram';
  if (p.includes('facebook')) return 'facebook';
  if (p.includes('linkedin')) return 'linkedin';
  if (p.includes('whatsapp')) return 'whatsapp';
  if (p.includes('discord')) return 'discord';
  if (p === 'x') return 'twitter';
  return (p === 'social' || p === 'wire' || p === 'bank') ? '' : '';
}

// Infer the platform from the session cookie domains (works when neither the
// caller nor the sheet carries a platform value).
function inferPlatformFromCookies(cookies) {
  const domains = (Array.isArray(cookies) ? cookies : [])
    .map(c => String((c && c.domain) || '').toLowerCase())
    .join(' ');
  if (domains.includes('tiktok')) return 'tiktok';
  if (domains.includes('twitter') || domains.includes('x.com')) return 'twitter';
  if (domains.includes('instagram')) return 'instagram';
  if (domains.includes('facebook')) return 'facebook';
  if (domains.includes('linkedin')) return 'linkedin';
  return '';
}

// TikTok session check: login redirect = dead; otherwise logged-in UI
// indicator (real data-e2e attributes) or the presence of the sessionid
// cookie without a login redirect counts as valid.
async function checkTikTokSession(browser) {
  const page = await browser.newPage();
  if (browser.identity) { await applyIdentityToPage(page, browser.identity); }

  try {
    await page.goto('https://www.tiktok.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('signup') || currentUrl.includes('authwall') || currentUrl.includes('checkpoint')) {
      return { reachedInbox: false, message: 'Redirected to login - session expired' };
    }

    let hasSessionCookie = false;
    try {
      const cookies = await page.cookies('https://www.tiktok.com/');
      hasSessionCookie = cookies.some(c => c.name === 'sessionid' && String(c.domain || '').includes('tiktok'));
    } catch (e) { /* cookie probe is best-effort */ }

    let loggedInUi = false;
    try {
      loggedInUi = await page.evaluate(() => {
        const qs = (s) => !!document.querySelector(s);
        return qs('[data-e2e="user-avatar"]') ||
          qs('[data-e2e="profile-sidebar-avatar"]') ||
          qs('[data-e2e="upload-icon"]') ||
          qs('[data-e2e="nav-profile-link"]');
      });
    } catch (e) { /* DOM probe is best-effort */ }

    if (loggedInUi) {
      return { reachedInbox: true, message: 'TikTok feed accessible', url: currentUrl };
    }
    if (hasSessionCookie) {
      return { reachedInbox: true, message: 'TikTok session cookie present (no login redirect)', url: currentUrl };
    }
    return { reachedInbox: false, message: 'No TikTok session detected - session expired' };
  } finally {
    await page.close();
  }
}

async function checkSocialInbox(browser) {
  const page = await browser.newPage();
  if (browser.identity) { await applyIdentityToPage(page, browser.identity); }
  
  try {
    for (const url of INBOX_URLS) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        const currentUrl = page.url();
        
        // Check if redirected to login
        if (currentUrl.includes('linkedin.com/login') || 
            currentUrl.includes('authwall') ||
            currentUrl.includes('checkpoint')) {
          return { reachedInbox: false, message: 'Redirected to login - session expired' };
        }
        
        // Check for content selectors
        for (const selector of INBOX_SELECTORS) {
          try {
            const element = await page.$(selector);
            if (element) {
              return { reachedInbox: true, message: 'Social feed accessible', url: currentUrl };
            }
          } catch (e) {
            // Continue
          }
        }
        
        // Check page content
        const pageContent = await page.content();
        if (pageContent.includes('Feed') || 
            pageContent.includes('Messaging') ||
            pageContent.includes('My Network') ||
            pageContent.includes('linkedin')) {
          return { reachedInbox: true, message: 'Social content detected', url: currentUrl };
        }
      } catch (e) {
        // Try next URL
      }
    }
    
    return { reachedInbox: false, message: 'Could not detect social feed' };
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

    // Resolve which platform's session this is: explicit hint from the
    // caller → infer from the cookie domains.
    const resolvedCookies = typeof cookieJSON === 'string' ? JSON.parse(cookieJSON) : cookieJSON;
    const platform = normalizePlatformToken(body.platform) || inferPlatformFromCookies(resolvedCookies);

    // USER tier — monthly verifyLoginUsage: gate revalidation attempts
    // (dashboard Verify button + GAS auto-verify both send userId).
    // Missing/"N/A" userId → warn and allow (fail open).
    const quotaUserId = body.userId && String(body.userId).trim() && String(body.userId).trim() !== "N/A"
      ? String(body.userId).trim() : null;
    if (!quotaUserId) {
      logger.warn(`[verify-session][user-limit] attempt without usable userId — skipping quota gate for ${browserId}.`);
    } else {
      const quota = await checkUserQuota(quotaUserId, { keys: ["verifyLoginUsage"] });
      if (!quota.allowed) {
        logger.warn(`[verify-session][user-limit] ${quota.reason} — blocking verify-session for ${browserId}`);
        return NextResponse.json(
          { success: false, error: quota.reason, message: quota.reason, userMonthlyLimit: true, limitReached: true },
          { status: 429 }
        );
      }
      try {
        await updateUserUsage(quotaUserId, "verifyLoginUsage");
      } catch (e) {
        logger.warn(`[verify-session][user-limit] verifyLoginUsage increment failed: ${e.message}`);
      }
    }

    let cookies = cookieJSON;
    if (typeof cookieJSON === 'string') {
      cookies = JSON.parse(cookieJSON);
    }
    
    // Launch browser
    browser = await launchBrowser();
    
    const page = await browser.newPage();
    if (browser.identity) { await applyIdentityToPage(page, browser.identity); }
    
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
    
    const result = platform === 'tiktok'
      ? await checkTikTokSession(browser)
      : await checkSocialInbox(browser);
    
    return NextResponse.json({
      success: true,
      status: result.reachedInbox ? 'COMPLETED' : 'FAILED',
      message: result.message,
      browserId,
      category: 'SOCIAL'
    });
    
  } catch (error) {
    console.error('Social verify-session error:', error);
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
