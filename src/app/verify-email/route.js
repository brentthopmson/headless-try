import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

export const maxDuration = 60; // This function can run for a maximum of 60 seconds
export const dynamic = "force-dynamic";

const platformUrls = {
  gmail: "https://accounts.google.com/",
  outlook: "https://login.live.com/",
  roundcube: "https://your-roundcube-url.com/",
  aol: "https://login.aol.com/",
};

const platformSelectors = {
  gmail: {
    input: "#identifierId",
    nextButton: "#identifierNext",
    errorMessage: "//*[contains(text(), 'Couldn’t find your Google Account')]",
  },
  outlook: {
    input: "input[name='loginfmt']",
    nextButton: "#idSIButton9",
    errorMessage: "//*[contains(text(), 'That Microsoft account doesn’t exist')]",
  },
  roundcube: {
    input: "input[name='user']",
    nextButton: "input[name='submitbutton']",
    errorMessage: "//*[contains(text(), 'Login failed')]",
  },
  aol: {
    input: "#login-username",
    nextButton: "#login-signin",
    errorMessage: "//*[contains(text(), 'Sorry, we don’t recognize this email')]",
  },
};

async function checkEmailExists(email, platform) {
  let browser = null;
  let accountExists = false;

  try {
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
            "-disable-site-isolation-trials",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: isDev ? false : "new",
      debuggingPort: isDev ? 9222 : undefined,
    });

    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(platformUrls[platform], { waitUntil: "networkidle2", timeout: 60000 });

    const { input, nextButton, errorMessage } = platformSelectors[platform];

    await page.type(input, email);
    await page.click(nextButton);
    await new Promise((resolve) => setTimeout(resolve, 3000)); // Replace page.waitForTimeout(3000)

    const errorElements = await page.evaluate((xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
      const nodes = [];
      let node;
      while ((node = result.iterateNext())) {
        nodes.push(node);
      }
      return nodes.length;
    }, errorMessage);

    accountExists = errorElements === 0;
  } catch (err) {
    console.log(`Error checking ${platform} email: ${err.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return accountExists;
}

export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const platform = url.searchParams.get("platform");

  if (!email || !platform) {
    return NextResponse.json({ error: "Missing email or platform parameter" }, { status: 400 });
  }

  if (!platformUrls[platform]) {
    return NextResponse.json({ error: "Unsupported platform" }, { status: 400 });
  }

  const accountExists = await checkEmailExists(email, platform);

  return NextResponse.json({ account_exists: accountExists }, { status: 200 });
}
