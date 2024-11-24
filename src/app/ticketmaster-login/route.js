import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";

import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

export const maxDuration = 60; // Max duration: 60 seconds
export const dynamic = "force-dynamic";

const ticketmasterUrl =
  "https://auth.ticketmaster.com/as/authorization.oauth2?client_id=8bf7204a7e97.web.ticketmaster.us&response_type=code&scope=openid%20profile%20phone%20email%20tm&redirect_uri=https://identity.ticketmaster.com/exchange&visualPresets=tm&lang=en-us&placementId=mytmlogin&hideLeftPanel=false&integratorId=prd1741.iccp&intSiteToken=tm-us&TMUO=west_ZYM0IjVU6c1ayyL7bKkNdATyLfzKLkNoSHzKurAMPLk%3D&deviceId=2G%2Bc0ShtdcnHy8zGycbMycjMzMdiohX1ps2rRQ&doNotTrack=false";

const selectors = {
  emailInput: "input[name='email']",
  passwordInput: "input[name='password']",
  signInButton: "button[name='sign-in'][type='submit']",
  errorMessages: {
    updatePassword: "//*[contains(text(), 'Update Your Password')]",
    emailNotFound: "//*[contains(text(), 'We can’t find an account with this email address')]",
  },
};

async function validateTicketmasterLogin(email, password) {
  let browser = null;
  let loginStatus = { emailExists: false, accountAccess: false };

  try {
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: false, // Use headless mode
    });

    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgent);

    // Navigate to Ticketmaster login page
    await page.goto(ticketmasterUrl, { waitUntil: "networkidle2", timeout: 60000 });

    // Input email
    await page.waitForSelector(selectors.emailInput);
    await page.type(selectors.emailInput, email);

    // Input password
    await page.waitForSelector(selectors.passwordInput);
    await page.type(selectors.passwordInput, password);

    // Click the "Sign in" button
    await page.waitForSelector(selectors.signInButton);
    await page.click(selectors.signInButton);

    // Wait for a specific result or timeout after a reasonable duration
    const timeout = 15000; // Wait up to 15 seconds for error/success states
    const start = Date.now();

    while (Date.now() - start < timeout) {
    const updatePasswordError = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue !== null;
        }, selectors.errorMessages.updatePassword);
        
        const emailNotFoundError = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue !== null;
        }, selectors.errorMessages.emailNotFound);
        

      if (emailNotFoundError.length > 0) {
        // Email not found error
        loginStatus.emailExists = false;
        loginStatus.accountAccess = false;
        break;
      } else if (updatePasswordError.length > 0) {
        // Update password error (email exists but needs to reset password)
        loginStatus.emailExists = true;
        loginStatus.accountAccess = false;
        break;
      }

      // Check if any login success indicators are present (e.g., no error prompts)
      const success = await page.evaluate(() => {
        return document.querySelector("div.success-indicator") !== null; // Replace with the actual success element
      });

      if (success) {
        loginStatus.emailExists = true;
        loginStatus.accountAccess = true;
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error(`Error during Ticketmaster login validation: ${error.message}`);
  } finally {
    if (browser) await browser.close();
  }

  return loginStatus;
}

export async function GET(request) {
    const url = new URL(request.url);
    const email = url.searchParams.get("email");
    const password = url.searchParams.get("password");
  
    if (!email || !password) {
      return NextResponse.json({ error: "Missing email or password parameter" }, { status: 400 });
    }
  
    // Call the validateTicketmasterLogin function to check the login status
    const loginStatus = await validateTicketmasterLogin(email, password);
  
    // Create the response
    const response = NextResponse.json(loginStatus, { status: 200 });
  
    // Add CORS headers
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  
    return response;
  }
  
  export async function OPTIONS() {
    // Preflight response for OPTIONS requests
    const response = NextResponse.json({}, { status: 200 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    
    return response;
  }
  
