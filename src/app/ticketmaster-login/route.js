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
};

async function validateTicketmasterLogin(email, password) {
  let browser = null;
  let loginStatus = { accountAccess: false };

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
      headless: false, // Keep the browser visible for debugging
    });

    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgent);

    console.log("Navigating to the login page...");
    await page.goto(ticketmasterUrl, { waitUntil: "load", timeout: 60000 });

    console.log("Typing email...");
    await page.waitForSelector(selectors.emailInput, { timeout: 30000 });
    await page.type(selectors.emailInput, email, { delay: 100 });

    console.log("Typing password...");
    await page.waitForSelector(selectors.passwordInput, { timeout: 10000 });
    await page.type(selectors.passwordInput, password, { delay: 100 });

    console.log("Clicking the sign-in button...");
    await page.waitForSelector(selectors.signInButton, { timeout: 10000 });
    await page.click(selectors.signInButton);

    // Poll the current URL for changes
    console.log("Waiting for the page to redirect...");
    const maxWaitTime = 15000; // Maximum time to wait for redirect (15 seconds)
    const pollingInterval = 500; // Check the URL every 500ms
    const startTime = Date.now();

    let currentUrl = page.url();
    while (!currentUrl.includes("https://www.ticketmaster.com")) {
      if (Date.now() - startTime > maxWaitTime) {
        console.error("Timeout reached while waiting for redirect.");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollingInterval)); // Sleep for polling interval
      currentUrl = page.url(); // Update the current URL
      console.log(`Current URL during polling: ${currentUrl}`);
    }

    console.log(`Final URL after polling: ${currentUrl}`);
    loginStatus.accountAccess = currentUrl.includes("https://www.ticketmaster.com");

  } catch (error) {
    console.error(`Error during Ticketmaster login validation: ${error.message}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error(`Error closing browser: ${closeError.message}`);
      }
    }
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

  const response = NextResponse.json(loginStatus, { status: 200 });
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");

  return response;
}

export async function OPTIONS() {
  const response = NextResponse.json({}, { status: 200 });
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");

  return response;
}
