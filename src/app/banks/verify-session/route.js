import { NextResponse } from 'next/server';
import { launchBrowser } from '../../../utils/utils.js';

const BANK_URLS = [
  'https://www.chase.com/personal/dashboard',
  'https://secure.bankofamerica.com/login/sign-in/signOnV2',
  'https://www.wellsfargo.com/accounts/',
  'https://online banking portal'
];

const INBOX_SELECTORS = [
  '[data-testid="account-summary"]',
  '.account-list',
  '[class*="account"]',
  '[data-testid="balance"]',
  '.dashboard-content',
  '#mainContent'
];

async function checkBankInbox(browser) {
  const page = await browser.newPage();
  
  try {
    for (const url of BANK_URLS) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(3000);
        
        const currentUrl = page.url();
        
        // Check if redirected to login
        if (currentUrl.includes('login') || 
            currentUrl.includes('signin') ||
            currentUrl.includes('auth') ||
            currentUrl.includes('error')) {
          return { reachedInbox: false, message: 'Redirected to login - session expired' };
        }
        
        // Check for content selectors
        for (const selector of INBOX_SELECTORS) {
          try {
            const element = await page.$(selector);
            if (element) {
              return { reachedInbox: true, message: 'Bank dashboard accessible', url: currentUrl };
            }
          } catch (e) {
            // Continue
          }
        }
        
        // Check page content
        const pageContent = await page.content();
        if (pageContent.includes('Account') || 
            pageContent.includes('Balance') ||
            pageContent.includes('Transfer') ||
            pageContent.includes('Statement')) {
          return { reachedInbox: true, message: 'Bank content detected', url: currentUrl };
        }
      } catch (e) {
        // Try next URL
      }
    }
    
    return { reachedInbox: false, message: 'Could not detect bank dashboard' };
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
    
    const result = await checkBankInbox(browser);
    
    return NextResponse.json({
      success: true,
      status: result.reachedInbox ? 'COMPLETED' : 'FAILED',
      message: result.message,
      browserId,
      category: 'BANK'
    });
    
  } catch (error) {
    console.error('Bank verify-session error:', error);
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
