import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers, setCorsHeaders, executeWorkflow } from '../_shared/routeHelper.js';
import { getPlatformConfig, getExtractor } from './platforms.js';

export const maxDuration = 120;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

async function extractProfile(platform, cookies, username) {
  const platformKey = platform.toLowerCase();
  const config = getPlatformConfig(platformKey);

  const cookieJSON = typeof cookies === "string" ? cookies : JSON.stringify(cookies);
  const { browser, page } = await launchBrowserWithSession(cookieJSON);

  try {
    const profileUrl = config.profileUrl.replace("{username}", username.replace("@", ""));
    await page.goto(profileUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await DOMHelpers.randomDelay(2000, 3000);

    const extractor = getExtractor(platformKey, "profile");
    if (extractor && extractor.parseFunction) {
      const parseFunc = new Function("items", extractor.parseFunction);
      const elements = await page.$$(extractor.selector);
      return parseFunc(elements);
    }

    return await page.evaluate(() => document.body.textContent?.trim().slice(0, 1000) || "");
  } finally {
    await page.close();
    await browser.close();
  }
}

async function extractFollowers(platform, cookies, username, limit = 50) {
  const platformKey = platform.toLowerCase();
  const config = getPlatformConfig(platformKey);

  if (platformKey !== "twitter") {
    throw new Error(`Follower extraction not yet supported for ${platform}`);
  }

  const cookieJSON = typeof cookies === "string" ? cookies : JSON.stringify(cookies);
  const { browser, page } = await launchBrowserWithSession(cookieJSON);

  try {
    const followersUrl = config.followersUrl.replace("{username}", username.replace("@", ""));
    await page.goto(followersUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await DOMHelpers.randomDelay(2000, 3000);

    const extractor = getExtractor(platformKey, "followers");
    if (!extractor || !extractor.parseFunction) {
      throw new Error("No followers extractor configured");
    }

    const followers = [];
    let prevCount = 0;

    for (let i = 0; i < 5; i++) {
      const parseFunc = new Function("items", extractor.parseFunction);
      const elements = await page.$$(extractor.selector);
      const batch = parseFunc(elements);

      for (const u of batch) {
        if (!followers.find(f => f.username === u.username)) {
          followers.push(u);
        }
      }

      if (followers.length >= limit || followers.length === prevCount) break;
      prevCount = followers.length;

      await page.evaluate(() => window.scrollBy(0, 800));
      await DOMHelpers.randomDelay(1500, 2500);
    }

    return followers.slice(0, limit);
  } finally {
    await page.close();
    await browser.close();
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, platform, cookies, username, limit } = body;

    logger.info(`[social-extract] action=${action} platform=${platform} username=${username}`);

    if (!platform || !cookies || !username) {
      return setCorsHeaders(NextResponse.json({ error: "Missing required fields: platform, cookies, username" }, { status: 400 }));
    }

    let result;
    switch (action) {
      case "profile":
        result = await extractProfile(platform, cookies, username);
        break;
      case "followers":
        result = await extractFollowers(platform, cookies, username, limit || 50);
        break;
      default:
        return setCorsHeaders(NextResponse.json({ error: "Invalid action. Use: profile, followers" }, { status: 400 }));
    }

    return setCorsHeaders(NextResponse.json({
      success: true,
      platform,
      username,
      action,
      data: result,
    }));

  } catch (e) {
    logger.error(`[social-extract] Error: ${e.message}`);
    return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
