import chromium from "@sparticuz/chromium-min";
import readlineSync from 'readline-sync';
import axios from 'axios';
import { NextResponse } from "next/server";
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
  launchBrowser,
} from "@/utils/utils";
import { applyIdentityToPage } from "@/utils/identity";
import fs from 'fs';
import qs from 'qs';
import { getSheetDataApi, updateSheetRowApi } from "../../api/googlesheets.js";
import { checkActionAllowed } from "../_shared/limits.js";
import { getAccountUsage, consumeAccountActions, updateAccountInteractionData } from "../_shared/hubUpdater.js";
import { resolveAccountGate } from "../_shared/accountGate.js";


// Add a global variable to track if the process is running
let isRunning = false;
let browser; // Declare a global browser variable
let hasLoggedIn = false; // Flag to track if the user has logged in

// Helper function for launching the browser with session persistence
async function launchLocalBrowser(cookieJson) {
  const browser = await launchBrowser({
    executablePath: isDev
      ? localExecutablePath
      : await chromium.executablePath(remoteExecutablePath),
    headless: false,
  });

  const page = await browser.newPage();
  if (browser.identity) { await applyIdentityToPage(page, browser.identity); } else { await page.setUserAgent(userAgent); }

  if (cookieJson) {
    try {
      const cookies = JSON.parse(cookieJson);
      await page.setCookie(...cookies);
      console.log("Cookies set successfully.");
    } catch (error) {
      console.error("Error setting cookies:", error);
    }
  }
  await page.close(); // Close the temporary page

  return browser;
}

// Helper function to save cookies back to the hub sheet. MERGE (upsert by
// name+domain) so visiting one platform never drops the account's other
// domains' cookies. The legacy Accounts GAS endpoint is gone (403).
async function saveCookiesToSheet(cookieJson, rowId) {
  try {
    const incoming = JSON.parse(cookieJson);
    if (!Array.isArray(incoming) || incoming.length === 0) return;

    const sheet = await getSheetDataApi("hub");
    if (!sheet.success) throw new Error(sheet.error || "hub read failed");
    const idIdx = sheet.headers.indexOf("submissionId");
    const cookieIdx = sheet.headers.indexOf("cookieJSON");
    if (idIdx === -1 || cookieIdx === -1) throw new Error("hub sheet missing submissionId/cookieJSON columns");
    const row = sheet.data.find(r => String(r[idIdx]).trim() === String(rowId).trim());
    if (!row) throw new Error(`row ${rowId} not found in hub`);

    let existing = [];
    try { existing = JSON.parse(row[cookieIdx] || "[]"); } catch { existing = []; }
    if (!Array.isArray(existing)) existing = [];

    const keyOf = (c) => `${c.name}::${c.domain || ""}`;
    const byKey = new Map(existing.map(c => [keyOf(c), c]));
    for (const c of incoming) byKey.set(keyOf(c), c);
    const merged = [...byKey.values()];

    const res = await updateSheetRowApi("hub", "submissionId", rowId, {
      cookieJSON: JSON.stringify(merged),
    });
    if (!res.success) throw new Error(res.error || "cookie write failed");
    console.log(`Cookies merged and saved for ${rowId} (${merged.length} cookies)`);
  } catch (error) {
    console.error(`Failed to update cookies for row ID ${rowId}:`, error.message);
  }
}

// Helper function to log cookies
async function logCookies(page, rowId, sheetCookieJson) {
  try {
    // Log cookies from the sheet
    console.log(`Sheet cookies for row ID ${rowId}:`, sheetCookieJson);

    // Fetch cookies stored via Puppeteer's API
    const browserCookies = await page.cookies();
    const browserCookieJson = JSON.stringify(browserCookies);
    console.log(`Puppeteer cookies for row ID ${rowId}:`, browserCookieJson);

    // Save Puppeteer's cookies back to Google Sheets
    await saveCookiesToSheet(browserCookieJson, rowId);
  } catch (error) {
    console.error(`Failed to log and save cookies for row ID ${rowId}:`, error.message);
  }
}


// Helper function to open and wait for manual login
async function openPlatformPage(url) {
  const page = await browser.newPage();
  if (browser.identity) { await applyIdentityToPage(page, browser.identity); } else { await page.setViewport({ width: 1366, height: 768 }); await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
  ); }

  console.log(`Navigating to URL: ${url}`); // Debugging line
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  console.log(`Page loaded: ${url}`);
  return page;
}


// Helper function to close a page
async function closePage(page) {
  await page.close();
  console.log("Tab closed.");
}


// Wait for manual input "Continue"
function waitForContinue() {
  readlineSync.question('Press "Enter" when you have logged in to all accounts and are ready to continue: ');
}


// Read the live hub sheet. The legacy Accounts GAS endpoint is dead (403 on
// every call), so accounts (platform / cookieJSON / submissionId) now come
// straight from the hub via the Sheets API.
async function fetchAccountsFromHub() {
  const result = await getSheetDataApi("hub");
  if (!result.success || !result.headers) {
    throw new Error(`Failed to fetch hub accounts: ${result.error || "unknown error"}`);
  }
  console.log(`Hub accounts fetched: ${result.data.length} rows`);
  return { headers: result.headers, data: result.data };
}


// Helper function to dynamically extract column indexes from headers
function getColumnIndexes(headers) {
  const indexMap = {};
  headers.forEach((header, index) => {
    indexMap[header] = index;
  });
  return indexMap;
}


// Function to handle platform-specific posting logic based on conditions
async function handlePlatformLogic(platformData, platformName, content, browser, rowId) {
  const { contentId, jobType, contentType, shouldSend, title, longTitle, description, longDescription, imageUrls, videos, location, ticktokStamp, quoraStamp } = content;

  let page;

  const axios = require('axios');
  const fs = require('fs');
  const path = require('path'); // Require path for file resolution
  const qs = require('qs'); // Import the querystring library

  // TikTok Logic
  if (platformName === "TikTok") {
    console.log("Running TikTok Following...");

    page = await openPlatformPage(platformData.url);

    try {
      // Click the "Profile" button using the correct selector
      const profileButton = await page.$('a[data-e2e="nav-profile"]'); // Updated selector based on the provided HTML
      if (profileButton) {
        await profileButton.click();
        console.log("Navigating to Profile page...");
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }); // Wait for profile page to load
      } else {
        console.error("Profile button not found.");
        return;
      }

      // Wait for the h3 element to be visible
      await page.waitForSelector('h3.css-lexcv0-H3CountInfos', { visible: true });

      // Get the values of follower, following, totalLike from elements within the h3 element
      const followerCount = await page.$eval('strong[data-e2e="followers-count"]', el => el.textContent);
      const followingCount = await page.$eval('strong[data-e2e="following-count"]', el => el.textContent);
      const totalLikeCount = await page.$eval('strong[data-e2e="likes-count"]', el => el.textContent);

      console.log(`Followers: ${followerCount}, Following: ${followingCount}, Total Likes: ${totalLikeCount}`);

      // Log which elements are being found
      console.log(`Follower element found: ${!!followerCount}`);
      console.log(`Following element found: ${!!followingCount}`);
      console.log(`Total Like element found: ${!!totalLikeCount}`);

      // Click the follower element and wait for modal to show (3 sec)
      const followerElement = await page.$('div[data-e2e="followers-count"]');
      if (followerElement) {
        await followerElement.click();
        await page.waitForTimeout(3000); // Wait for modal to show
      } else {
        console.error("Follower element not found.");
        return;
      }

      // Click "Suggested" tab
      const suggestedTab = await page.$('.suggested-tab-selector');
      if (suggestedTab) {
        await suggestedTab.click();
      } else {
        console.error("Suggested tab not found.");
        return;
      }

      // PLATFORM-tier follow gate (Limits sheet via _shared/limits) — replaces
      // the removed legacy `category` lookup, whose GAS endpoint is dead (403).
      let followCount = 0;
      let usage = (await getAccountUsage(rowId)).interactionUsage || {};

      const usersToFollow = await page.$$('.user-to-follow'); // Modify the selector accordingly
      for (const user of usersToFollow) {
        const gate = await checkActionAllowed("TikTok", "follow", usage);
        if (!gate.allowed) {
          console.log(`Follow limit reached for ${rowId}: ${gate.reason}`);
          break;
        }

        const followButton = await user.$('.follow-button-selector');
        if (followButton) {
          await followButton.click();
          // Success-only: count the follow only when the button flipped to the
          // following state (or when the platform exposes no state at all).
          const state = await followButton.evaluate(el => {
            const label = `${el.textContent || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
            if (/following|unfollow/.test(label)) return 'followed';
            if (/follow/.test(label)) return 'not-followed';
            return null;
          }).catch(() => null);
          if (state !== 'not-followed') {
            followCount++;
            if (state === null) console.log(`Follow state unverified for ${rowId} — counted as verified-by-click.`);
            await consumeAccountActions(rowId, { follow: 1 });
            usage = (await getAccountUsage(rowId)).interactionUsage || usage;
          } else {
            console.log(`Follow not confirmed for ${rowId} — not counted.`);
          }
        }
      }

      console.log(`Followed ${followCount} users for ${rowId}`);

      // Persist run stats to the hub (the legacy Accounts sheet endpoint is gone).
      await updateAccountInteractionData(rowId, {
        lastOperation: "bulkFollow",
        lastRun: new Date().toISOString(),
        follower: followerCount,
        following: followingCount,
        totalLike: totalLikeCount,
        followedInRun: followCount,
        status: "ACTIVE",
      });

      console.log("Updated data successfully for TikTok.");

    } catch (error) {
      console.error("Failed to process TikTok actions:", error.message);
    }

    // Close the tab after processing
    await closePage(page);
  }

  // Quora Logic
  if (platformName === "Quora" && shouldSend === "ACTIVE" && !quoraStamp && longDescription && imageUrls) {
    console.log("Uploading to Quora...");

    page = await openPlatformPage(platformData.url); // Ensure page is defined here too

    try {
      // Step 1: Click on the element "What do you want to ask or share?"
      await page.waitForSelector('div.q-text.qu-color--gray_light', { visible: true });
      await page.click('div.q-text.qu-color--gray_light');
      console.log("Clicked on 'What do you want to ask or share?'");


      // Step 7: Update timestamp in Google Sheets via App Script

      const qs = require('qs'); // Import the querystring library
      
      // Function to update timestamp with retries and timeout
      const updateTimestamp = async (url, data, retries = 3, timeout = 10000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            console.log(`Attempt ${attempt}: Updating timestamp in Google Sheets...`);

            // Send the request as form data
            const response = await axios.post(url, qs.stringify(data), {
              timeout,
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded', // Set the content type to URL encoded
              },
            });

            // If the request is successful, log the result and exit the loop
            console.log("Timestamp updated successfully in Google Sheets.");
            console.log(response.data);
            return response;

          } catch (error) {
            console.error(`Failed to update timestamp on attempt ${attempt}. Error: ${error.message}`);
            
            // If the number of retries is not exceeded, retry after a delay
            if (attempt < retries) {
              console.log(`Retrying timestamp update in 2 seconds...`);
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds before retrying
            } else {
              // If all attempts fail, throw an error
              console.error("Failed to update timestamp after multiple attempts.");
              throw error;
            }
          }
        }
      };

      const currentTimestamp = new Date().toISOString();
      const updateData = {
        action: 'updateData',
        'dbname': 'SM-Content-F',
        'contentId': contentId,
        platform: 'Quora',
        quoraStamp: currentTimestamp
      };

      // Call the function to update the timestamp with retries and timeout
      await updateTimestamp(
        'https://script.google.com/macros/s/AKfycbxrsER0ks-9yFbibZ8MEILfv1_dEPDLYwZBXEu7g5vEX2c0_Ic-Al_U-W3QbAkl73Zs/exec',
        updateData,
        3,
        10000
      );

      // Step 8: Clean up local image files after upload
      imagePaths.forEach(imagePath => require('fs').unlinkSync(imagePath)); // Deletes the temporary images
      console.log("Deleted local images after uploading.");

    } catch (error) {
      console.error("An error occurred during the Quora upload process: ", error.message);
      // Log the failure and continue with the next row
    }
    
    // Close the tab after processing
    await closePage(page);
  }

  // Twitter Logic

  // Facebook Logic

  // Instagram Logic

}


// Function to run the whole process for posting content
async function runAutomation(platformsToRun, postContent) {
  if (isRunning) {
    console.log("Automation is already running, skipping this cycle...");
    return; // Skip the current cycle if one is already running
  }

  isRunning = true; // Set the flag to prevent other instances from starting

  try {
    const { headers, data } = await fetchAccountsFromHub();
    const columnIndexes = getColumnIndexes(headers);
    const platforms = [
      { name: "Facebook", url: "https://facebook.com" },
      { name: "Instagram", url: "https://instagram.com" },
      { name: "Quora", url: "https://quora.com" },
      { name: "Twitter", url: "https://twitter.com" },
      { name: "TikTok", url: "https://www.tiktok.com/" },
      { name: "Reddit", url: "https://reddit.com" },
      { name: "Office", url: "https://go.microsoft.com/fwlink/p/?LinkID=2125442&deeplink=owa%2F" },
    ];

    const selectedPlatforms = platforms.filter(platform =>
      platformsToRun.includes(platform.name)
    );

    let processed = 0;
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      const platformName = row[columnIndexes['platform']];
      const cookieJson = row[columnIndexes['cookieJSON']];
      const rowId = row[columnIndexes['submissionId']];

      // Non-social hub rows carry no platform — skip quietly.
      if (!platformName) continue;

      // Check if rowId is defined (you can add additional checks here if needed)
      if (!rowId) {
        console.log(`Skipping account: rowId is missing for row ${i + 1}`);
        continue;
      }

      // Match platform with URL (only the requested platforms run)
      const platformData = selectedPlatforms.find(p => p.name === platformName);
      if (!platformData) {
        console.log(`No matching platform found for: ${platformName}`);
        continue;
      }

      // ACCOUNT-tier status gate BEFORE any browser launch — CANCELLED blocks,
      // RATE_LIMITED blocks until windows roll. Replaces the legacy
      // followLimtReached flag (that column only existed in the dead sheet).
      const statusGate = await resolveAccountGate(rowId, platformName);
      if (statusGate.blocked) {
        console.log(`Skipping account ${rowId}: account limits (${statusGate.reason || statusGate.status})`);
        continue;
      }

      console.log(`Processing platform: ${platformName}, URL: ${platformData.url}`);
      browser = await launchLocalBrowser(cookieJson); // Launch browser with cookies

      // If the cookie is blank, pause the automation and wait for user to log in manually
      if (!cookieJson || cookieJson === "null" || cookieJson.trim() === "") {
        console.log(`No valid cookies found for row ID ${rowId}. Pausing automation...`);
        waitForContinue(); // Wait for manual login
        console.log("Resuming automation after login...");
      }

      // Log cookies before processing platforms
      const tempPage = await browser.newPage();
      if (browser.identity) { await applyIdentityToPage(tempPage, browser.identity); } else { await tempPage.setViewport({ width: 1366, height: 768 }); await tempPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      ); }
      // Make tempPage navigate to the platform URL as well
      console.log(`Navigating tempPage to URL: ${platformData.url}`);
      await tempPage.goto(platformData.url, { waitUntil: "networkidle2", timeout: 60000 });
      console.log(`tempPage loaded successfully: ${platformData.url}`);

      await logCookies(tempPage, rowId, cookieJson); // Log cookies after loading the page
      await tempPage.close();

      const content = { /* Your content object setup here */ };

      console.log(`Posting content for ${platformName}`);
      await handlePlatformLogic(platformData, platformName, content, browser, rowId);
      processed++;

      await browser.close(); // Close browser after each account
    }
    return { ok: true, rows: data.length, processed };
  } catch (error) {
    console.error("Error running automation:", error);
    return { ok: false, error: error.message };
  } finally {
    isRunning = false;
  }
}

// On-demand entry point: runs ONE automation pass per request. The old
// module-load auto-loop (runAutomationLoop) was removed — importing a route
// must never start a background 15s interval that fires headed browsers and
// blocks the event loop on readline-sync.
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const platforms = Array.isArray(body.platforms) && body.platforms.length > 0
      ? body.platforms
      : ["Quora", "TikTok"];
    const summary = await runAutomation(platforms, body.postContent || "");
    const ok = !!(summary && summary.ok);
    return NextResponse.json(
      { success: ok, platforms, ...(summary || {}) },
      { status: ok ? 200 : 500 }
    );
  } catch (e) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
