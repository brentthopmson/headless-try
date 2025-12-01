import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import readlineSync from 'readline-sync';
import axios from 'axios';
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";
import fs from 'fs';
import qs from 'qs';


// Add a global variable to track if the process is running
let isRunning = false;
let browser; // Declare a global browser variable
let hasLoggedIn = false; // Flag to track if the user has logged in

// Helper function for launching the browser with session persistence
async function launchBrowser(cookieJson) {
  const browser = await puppeteer.launch({
    ignoreDefaultArgs: ["--enable-automation"],
    args: isDev
      ? [
          "--disable-blink-features=AutomationControlled",
          "--disable-features=site-per-process",
          "-disable-site-isolation-trials",
        ]
      : [...chromium.args, "--disable-blink-features=AutomationControlled"],
    executablePath: isDev
      ? localExecutablePath
      : await chromium.executablePath(remoteExecutablePath),
    headless: false,
  });

  const page = await browser.newPage();
  await page.setUserAgent(userAgent); // Set the user agent

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

// Helper function to save cookies back to Google Sheets
async function saveCookiesToSheet(cookieJson, rowId) {
  try {
    const formattedCookie = JSON.stringify(JSON.parse(cookieJson), null, 2); // Format the cookie JSON
    const endpoint = "https://script.google.com/macros/s/AKfycbzQZxwzDMuGgu5PdkyYTMkaoLXHM4MR1SNBNqR17zXQA6QE_oPxogTW8Gi_OgUBuUu9/exec";
    const updateData = {
      action: 'updateData',
      dbname: 'Accounts',
      accountId: rowId, // Row ID to identify the row
      cookie: cookieJson, // Updated cookies as a JSON string
      formattedCookie: formattedCookie, // Updated cookies as a JSON string
      follower: "cookieJson", // Updated cookies as a JSON string
      following: "cookieJson", // Updated cookies as a JSON string
      friends: "cookieJson", // Updated cookies as a JSON string
    };

    const response = await axios.post(endpoint, qs.stringify(updateData), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    console.log(`Cookies updated successfully for row ID ${rowId}`);
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
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
  );

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


// Helper function to fetch data from App Script endpoint with retry logic
async function fetchDataFromAppScript(retries = 3, timeout = 120000) {
  const endpoint = "https://script.google.com/macros/s/AKfycbzQZxwzDMuGgu5PdkyYTMkaoLXHM4MR1SNBNqR17zXQA6QE_oPxogTW8Gi_OgUBuUu9/exec?action=getData&sheetname=Accounts&range=A1:BD";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Attempt to fetch the data with an extended timeout
      const response = await axios.get(endpoint, { timeout });
      console.log(`Data fetched successfully on attempt ${attempt}`);
      console.log(`Data: ${response}`);

      return response.data;
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) {
        throw new Error(`Failed to fetch data after ${retries} attempts.`);
      }
      console.log(`Retrying... (${attempt}/${retries})`);
    }
  }
}

// Helper function to fetch data from App Script endpoint with retry logic
async function fetchLimitsDataFromAppScript(limitCategory, limitValue, retries = 3, timeout = 120000) {
  const endpoint = "https://script.google.com/macros/s/AKfycbzQZxwzDMuGgu5PdkyYTMkaoLXHM4MR1SNBNqR17zXQA6QE_oPxogTW8Gi_OgUBuUu9/exec?action=getData&sheetname=Limits&range=A1:Z";
  
  // Fetch the data with retry logic
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(endpoint, { timeout });
      console.log(`Data fetched successfully on attempt ${attempt}`);
      
      const data = response.data;
      const headers = data[0]; // The header row
      const categoryColumnIndex = headers.indexOf("category"); // Assuming the category column is named "category"
      const limitColumnIndex = headers.indexOf("headername"); // The column where limitValue should be found (replace "headername" with the actual column name)
      
      if (categoryColumnIndex === -1 || limitColumnIndex === -1) {
        throw new Error("Category or limit column not found.");
      }

      // Find the row where the limitCategory matches the value in the "category" column
      const categoryRow = data.find(row => row[categoryColumnIndex] === limitCategory);
      
      if (!categoryRow) {
        console.error(`Category '${limitCategory}' not found.`);
        return null;
      }
      
      // Get the value from the corresponding row and column (based on limitValue)
      const result = categoryRow[limitColumnIndex];

      // Return the result
      console.log(`Found value: ${result}`);
      return result;
      
    } catch (error) {
      console.error(`Attempt ${attempt} failed: ${error.message}`);
      if (attempt === retries) {
        throw new Error(`Failed to fetch data after ${retries} attempts.`);
      }
      console.log(`Retrying... (${attempt}/${retries})`);
    }
  }
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
async function handlePlatformLogic(platformData, platformName, content, browser) {
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

      // Fetch limit values from the App Script (limitCategory and limitValue)
      const limitCategory = "tiktokLimit";
      const limitValue = "hourlyFollowLimitValue"; 

      const result = await fetchLimitsDataFromAppScript(limitCategory, limitValue);

      // Check if limit value exists and proceed to follow or follow back accordingly
      if (result && parseInt(result) > 0) {
        const followLimit = parseInt(result);
        let followCount = 0;

        // Follow Back or Follow (based on the result value)
        const usersToFollow = await page.$$('.user-to-follow'); // Modify the selector accordingly
        for (const user of usersToFollow) {
          if (followCount >= followLimit) break;

          // Follow action (either follow or follow back based on the condition)
          const followButton = await user.$('.follow-button-selector');
          if (followButton) {
            await followButton.click();
            followCount++;
          }
        }

        console.log(`Followed ${followCount} users, Limit: ${followLimit}`);
      } else {
        console.log("No valid limit data found or limit exceeded.");
      }

      // Update the timestamp and data in Google Sheets
      const currentTimestamp = new Date().toISOString();
      const updateData = {
        action: 'updateData',
        dbname: 'Accounts',
        accountId: rowId,
        follower: followerCount,
        following: followingCount,
        totalLike: totalLikeCount,
        followedToday: followCount,
        followStamp: currentTimestamp,
      };

      // Send the updated data to Google Sheets
      await updateTimestamp(
        'https://script.google.com/macros/s/AKfycbzQZxwzDMuGgu5PdkyYTMkaoLXHM4MR1SNBNqR17zXQA6QE_oPxogTW8Gi_OgUBuUu9/exec',
        updateData,
        3,
        10000
      );

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
    const data = await fetchDataFromAppScript();
    const headers = data[0];
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

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const platformName = row[columnIndexes['platform']];
      const cookieJson = row[columnIndexes['cookie']];
      const followLimitReached = row[columnIndexes['followLimtReached']];
      const rowId = row[columnIndexes['accountId']];

      // Check if followLimitReached is "TRUE", and skip the current row if true
      if (followLimitReached === true) {
        console.log(`Skipping account: followLimitReached is TRUE for row ${i + 1}`);
        continue;
      }

      // Check if rowId is defined (you can add additional checks here if needed)
      if (!rowId) {
        console.log(`Skipping account: rowId is missing for row ${i + 1}`);
        continue;
      }

      // Match platform with URL
      const platformData = platforms.find(p => p.name === platformName);
      if (!platformData) {
        console.log(`No matching platform found for: ${platformName}`);
        continue;
      }

      console.log(`Processing platform: ${platformName}, URL: ${platformData.url}`);
      browser = await launchBrowser(cookieJson); // Launch browser with cookies

      // If the cookie is blank, pause the automation and wait for user to log in manually
      if (!cookieJson || cookieJson === "null" || cookieJson.trim() === "") {
        console.log(`No valid cookies found for row ID ${rowId}. Pausing automation...`);
        waitForContinue(); // Wait for manual login
        console.log("Resuming automation after login...");
      }

      // Log cookies before processing platforms
      const tempPage = await browser.newPage();
      await tempPage.setViewport({ width: 1366, height: 768 });
      await tempPage.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      );
      // Make tempPage navigate to the platform URL as well
      console.log(`Navigating tempPage to URL: ${platformData.url}`);
      await tempPage.goto(platformData.url, { waitUntil: "networkidle2", timeout: 60000 });
      console.log(`tempPage loaded successfully: ${platformData.url}`);

      await logCookies(tempPage, rowId, cookieJson); // Log cookies after loading the page
      await tempPage.close();

      const content = { /* Your content object setup here */ };

      console.log(`Posting content for ${platformName}`);
      await handlePlatformLogic(platformData, platformName, content, browser);

      await browser.close(); // Close browser after each account
    }
  } catch (error) {
    console.error("Error running automation:", error);
  } finally {
    isRunning = false;
  }
}



// Wrapper to run automation repeatedly every 2 minutes
function runAutomationLoop() {
  const platforms = ["Quora", "TikTok"]; // Platforms you want to post on
  const postContent = "This is the content I'm posting!"; // Your post content

  // Run the automation every 2 minutes (120000 ms)
  setInterval(async () => {
    try {
      console.log("Running automation...");
      await runAutomation(platforms, postContent);
      console.log("Automation cycle complete.");
    } catch (error) {
      console.error("Error running automation:", error);
    }
  }, 15000); // 2 minutes interval
}

// Start the automation loop
runAutomationLoop();
