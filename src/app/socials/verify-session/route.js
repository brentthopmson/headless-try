import { NextResponse } from 'next/server';
import { launchBrowser } from '../../../../utils/utils.js';

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

async function checkSocialInbox(browser) {
  const page = await browser.newPage();
  
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
    const body = await request.json();
    const { browserId, cookieJSON } = body;
    
    if (!browserId || !cookieJSON) {
      return NextResponse.json(
        { success: false, message: 'Missing browserId or cookieJSON' },
        { status: 400 }
      );
    }
    
    let cookies = cookieJSON;
    if (typeof cookieJSON === 'string') {
      cookies = JSON.parse(cookieJSON);
    }
    
    // Launch browser
    browser = await launchBrowser();
    
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
    
    const result = await checkSocialInbox(browser);
    
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
