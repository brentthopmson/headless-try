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

    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check for specific error messages
    const updatePasswordError = await page.$x(selectors.errorMessages.updatePassword);
    const emailNotFoundError = await page.$x(selectors.errorMessages.emailNotFound);

    if (emailNotFoundError.length > 0) {
      loginStatus.emailExists = false;
    } else {
      loginStatus.emailExists = true;

      if (updatePasswordError.length === 0) {
        // If no password update prompt appears, assume login success
        loginStatus.accountAccess = true;
      }
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

  const loginStatus = await validateTicketmasterLogin(email, password);

  return NextResponse.json(loginStatus, { status: 200 });
}
