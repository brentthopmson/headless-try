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
    const endpoint = "https://script.google.com/macros/s/AKfycbzQZxwzDMuGgu5PdkyYTMkaoLXHM4MR1SNBNqR17zXQA6QE_oPxogTW8Gi_OgUBuUu9/exec";
    const updateData = {
      action: 'updateData',
      dbname: 'Accounts',
      accountId: rowId, // Row ID to identify the row
      cookie: cookieJson, // Updated cookies as a JSON string
      follower: "cookieJson", // Updated cookies as a JSON string
      following: "cookieJson", // Updated cookies as a JSON string
      friends: "cookieJson", // Updated cookies as a JSON string
      posts: "cookieJson", // Updated cookies as a JSON string
      totalLike: "cookieJson", // Updated cookies as a JSON string
      followedToday: "cookieJson", // Updated cookies as a JSON string
      followStamp: "cookieJson", // Updated cookies as a JSON string
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

// Helper function to dynamically extract column indexes from headers
function getColumnIndexes(headers) {
  const indexMap = {};
  headers.forEach((header, index) => {
    indexMap[header] = index;
  });
  return indexMap;
}