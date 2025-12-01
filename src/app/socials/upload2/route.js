import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import readlineSync from 'readline-sync';
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

// Helper function for launching the browser
async function launchBrowser() {
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
    headless: false, // headless mode should be off for manual login
  });
  return browser;
}

// Helper function to open and wait for manual login
async function openPlatformPage(browser, url) {
  const page = await browser.newPage();
  await page.setUserAgent(userAgent);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
  console.log(`Page loaded: ${url}`);
  return page;
}

// Wait for manual input "Continue"
function waitForContinue() {
  readlineSync.question('Press "Enter" when you have logged in to all accounts and are ready to continue: ');
}

// Helper function for refreshing the page
async function refreshPage(page) {
  await page.reload({ waitUntil: "networkidle2" });
}

// Helper function to search a query on the platform
async function searchQuery(page, query, searchSelector, submitSelector) {
  await page.waitForSelector(searchSelector);
  await page.type(searchSelector, query);
  await page.click(submitSelector);
  await page.waitForNavigation({ waitUntil: "networkidle2" });
  console.log(`Search performed: ${query}`);
}

// Helper function to retrieve the first 100 posts/comments from the search
async function getSearchResults(page, resultSelector, maxResults = 100) {
  await page.waitForSelector(resultSelector);
  const results = await page.evaluate((selector, limit) => {
    return [...document.querySelectorAll(selector)].slice(0, limit).map(el => el.innerText);
  }, resultSelector, maxResults);
  return results;
}

// Helper function to send posts/comments to an AI API
async function sendToAIForReply(posts) {
  const aiEndpoint = "https://your-ai-api.com/composeReply";
  const promptSetupMessage = "Please compose a professional reply about bitcoin recovery.";

  const responses = [];
  for (const post of posts) {
    const response = await fetch(aiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: `${promptSetupMessage}\n\n${post}` }),
    });
    const data = await response.json();
    responses.push(data.reply);
  }
  return responses;
}

// Helper function to reply to a post/comment
async function replyToPost(page, replySelector, replyContent) {
  await page.waitForSelector(replySelector);
  await page.type(replySelector, replyContent);
  await page.keyboard.press('Enter'); // Simulate pressing Enter to submit
}

// Main function to handle each platform
async function handlePlatform(browser, platform) {
  const page = await openPlatformPage(browser, platform.url);
  await refreshPage(page);
  const query = "How to recover lost bitcoin";
  await searchQuery(page, query, platform.searchSelector, platform.submitSelector);
  const posts = await getSearchResults(page, platform.resultSelector);
  const aiReplies = await sendToAIForReply(posts);
  
  // Reply back to each post/comment with the AI-generated responses
  for (const replyContent of aiReplies) {
    await replyToPost(page, platform.replySelector, replyContent);
  }
  console.log(`Replied to posts on ${platform.name}`);
}

// Function to run the whole process
async function runAutomation(platformsToRun) {
  const browser = await launchBrowser();

  // URLs and selectors for each platform
  const platforms = [
    {
      name: "Facebook",
      url: "https://facebook.com",
      searchSelector: "input[aria-label='Search Facebook']",
      submitSelector: "button[aria-label='Search']",
      resultSelector: "div[data-ad-comet-preview='message']",
      replySelector: "textarea[aria-label='Write a comment']", // Adjust if different
    },
    {
      name: "Instagram",
      url: "https://instagram.com",
      searchSelector: "input[placeholder='Search']",
      submitSelector: "button[type='submit']",
      resultSelector: "article div",
      replySelector: "textarea[aria-label='Add a comment…']", // Adjust if different
    },
    {
      name: "Quora",
      url: "https://www.quora.com/answer",
      searchSelector: "input[type='text']",
      submitSelector: "button[type='submit']",
      resultSelector: "div.q-box",
      replySelector: "textarea[placeholder='Add a comment']", // Adjust if different
    },
    {
      name: "Twitter",
      url: "https://twitter.com",
      searchSelector: "input[aria-label='Search query']",
      submitSelector: "div[role='button'][data-testid='SearchBox_Search_Button']",
      resultSelector: "article div[data-testid='tweet']",
      replySelector: "div[aria-label='Reply']", // Adjust if different
    },
    {
      name: "TikTok",
      url: "https://tiktok.com",
      searchSelector: "input[type='search']",
      submitSelector: "button[type='submit']",
      resultSelector: "div[class*='content']",
      replySelector: "textarea[class*='reply-input']", // Adjust if different
    },
    {
      name: "Reddit",
      url: "https://reddit.com",
      searchSelector: "input[type='search']",
      submitSelector: "button[type='submit']",
      resultSelector: "div._1poyrkZ7g36PawDueRza-J",
      replySelector: "textarea[placeholder='Add a comment']", // Adjust if different
    },
  ];

  // Filter platforms based on user input
  const selectedPlatforms = platforms.filter(platform => platformsToRun.includes(platform.name));

  // Open each selected platform in new tabs
  for (const platform of selectedPlatforms) {
    console.log(`Opening ${platform.name}...`);
    await openPlatformPage(browser, platform.url);
  }

  // Wait for manual login
  waitForContinue();

  // After login, refresh and perform search on selected platforms
  for (const platform of selectedPlatforms) {
    console.log(`Handling ${platform.name}...`);
    await handlePlatform(browser, platform);
  }

  await browser.close();
}

// Call runAutomation with specific platforms you want to run, e.g. ["Quora"]
runAutomation(["Quora"]); // Change this array to include other platforms as needed
