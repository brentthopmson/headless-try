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

// Add a global variable to track if the process is running
let isRunning = false;
let browser; // Declare a global browser variable
let hasLoggedIn = false; // Flag to track if the user has logged in

// Helper function for launching the browser with session persistence
async function launchBrowser() {
  const userDataDir = './user_data'; // Directory to save session data (cookies, localStorage, etc.)
  const newBrowser = await puppeteer.launch({
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
    userDataDir, // Use this directory to persist session
  });
  return newBrowser;
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
  const endpoint = "https://script.google.com/macros/s/AKfycbxrsER0ks-9yFbibZ8MEILfv1_dEPDLYwZBXEu7g5vEX2c0_Ic-Al_U-W3QbAkl73Zs/exec?action=getData&sheetname=SM-Content-F&range=A1:Z";

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Attempt to fetch the data with an extended timeout
      const response = await axios.get(endpoint, { timeout });
      console.log(`Data fetched successfully on attempt ${attempt}`);
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


// Function to handle platform-specific posting logic based on conditions
async function handlePlatformLogic(platformData, platformName, content, browser) {
  const { contentId, jobType, contentType, shouldSend, title, longTitle, description, longDescription, imageUrls, videos, location, ticktokStamp, quoraStamp } = content;

  let page;

  const axios = require('axios');
  const fs = require('fs');
  const path = require('path'); // Require path for file resolution
  const qs = require('qs'); // Import the querystring library
  


  // TikTok Logic
  if (platformName === "TikTok" && shouldSend === "ACTIVE" && !title && !ticktokStamp && videos) {
    console.log("Uploading to TikTok...");

    page = await openPlatformPage(platformData.url);

    // Ensure you are on the correct page and logged in
    console.log("Waiting for video upload input element...");

    try {
      // TikTok video upload logic starts here
      await page.waitForSelector('input[type="file"][accept="video/*"]', { timeout: 120000 }); // Wait for the file input to load

      // Handle videos array (assuming 'videos' is an array of video URLs)
      const downloadVideoFile = async (url, retries = 3, timeout = 30000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            console.log(`Attempt ${attempt}: Downloading video from ${url}...`);

            const response = await axios({
              url,
              method: 'GET',
              responseType: 'arraybuffer',
              timeout: timeout, // Set timeout for the download request
            });

            console.log("Video downloaded successfully.");
            return response.data; // Return the video data if successful

          } catch (error) {
            console.error(`Failed to download video from ${url} on attempt ${attempt}. Error: ${error.message}`);
            if (attempt < retries) {
              console.log('Retrying video download in 2 seconds...');
              await new Promise(resolve => setTimeout(resolve, 2000)); // Retry after 2 seconds
            } else {
              console.error(`Failed to download video ${url} after multiple attempts. Skipping.`);
              return null; // Return null if all retries fail
            }
          }
        }
      };

      // Iterate over each video URL to download them
      const videoUrls = Array.isArray(videos) ? videos : [videos]; // Handle both string and array cases
      let videoFileData = null;

      for (const videoUrl of videoUrls) {
        videoFileData = await downloadVideoFile(videoUrl);
        if (videoFileData) break; // Exit loop if a valid video is downloaded
      }

      if (!videoFileData) {
        throw new Error("No valid video found to upload.");
      }

      // Use path.resolve to handle file path cross-platform
      const filePath = path.resolve(__dirname, `tiktok_video_${contentId}.mp4`); // Resolved file path

      // Save the video locally
      await new Promise((resolve, reject) => {
        fs.writeFile(filePath, videoFileData, (err) => {
          if (err) {
            reject(err);
          } else {
            console.log("Video file saved locally.");
            resolve();
          }
        });
      });

      // Wait for file input element to become available
      const fileInput = await page.$('input[type="file"][accept="video/*"]');

      console.log("Uploading video file to TikTok...");
      await fileInput.uploadFile(filePath); // Upload the video file
      console.log("Video file uploaded successfully.");

      // Wait for the video description input to appear
      console.log("Waiting for video description input element...");

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Target the correct element based on manual confirmation
      await page.waitForSelector('.DraftEditor-root', { timeout: 60000 });

      // Focus on the description input
      const editorContainer = await page.$('.DraftEditor-root');
      await editorContainer.click();  // Click to focus on the description area

      // Clear any existing content by doing CTRL + A and Backspace
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace');

      // Add video description
      await page.keyboard.type(description); // Type the description text
      console.log("Video description added.");

      // Wait for 2 seconds after typing the description
      await new Promise(resolve => setTimeout(resolve, 7000));



        // Enter the location
        if (location) {
          console.log("Entering location...");
          await page.waitForSelector('#poi', { timeout: 30000 }); // Wait for the location input
          const locationInput = await page.$('#poi');
          await locationInput.click(); // Focus on the location input
          await locationInput.type(location); // Type the location

          // Wait for 3 seconds before pressing DOWN and ENTER
          await new Promise(resolve => setTimeout(resolve, 5000));

          // Simulate pressing the DOWN arrow key and ENTER to confirm the location
          await page.keyboard.press('ArrowDown'); // Press the DOWN key to highlight the location
          await page.keyboard.press('Enter');     // Press ENTER to select it
          console.log("Location entered and confirmed: " + location);
          
          // Unfocus from the location input and wait for 2 seconds
          await page.keyboard.press('Tab'); // Tab out of the location input
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for 2 seconds
      }

      // Click the correct "Post" button to submit the content
      const postButtonSelector = 'button.TUXButton.TUXButton--default.TUXButton--large.TUXButton--primary';
      await page.waitForSelector(postButtonSelector, { timeout: 60000 }); // Wait for the post button
      const postButton = await page.$(postButtonSelector);

      if (postButton) {
          console.log("Submitting the video...");
          await postButton.click(); // Click the "Post" button
      } else {
          throw new Error("Post button not found.");
      }

      // Wait for 5 seconds to allow for the success modal or redirect
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check for the success modal's presence
      const successModalSelector = 'div.TUXModal'; // Selector for the success modal
      const isSuccessModalVisible = await page.$(successModalSelector) !== null;

      // Check if the page URL has changed (indicating a redirect)
      const currentUrl = page.url();
      const redirectedUrl = 'https://www.tiktok.com/tiktokstudio/content'; // Change to the expected redirect URL after successful upload

      if (isSuccessModalVisible) {
          console.log("Video posted successfully on TikTok.");
      } else if (currentUrl !== platformData.url) { // Check if URL is different from the original upload page
          console.log("Video posted successfully (redirect detected).");
      } else {
          console.error("Video posting failed; success modal not found and no redirect detected.");
      }

      // Clean up the local file after upload
      await new Promise((resolve, reject) => {
          fs.unlink(filePath, (err) => {
              if (err) {
                  reject(err);
              } else {
                  console.log("Local video file deleted after upload.");
                  resolve();
              }
          });
      });

      // Retry logic for updating the TikTok timestamp in Google Sheets
      const updateTimestamp = async (url, data, retries = 10, timeout = 30000) => {
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

            console.log("TikTok timestamp updated successfully.");
            return response;

          } catch (error) {
            console.error(`Failed to update TikTok timestamp on attempt ${attempt}. Error: ${error.message}`);

            if (attempt < retries) {
              console.log('Retrying timestamp update in 2 seconds...');
              await new Promise(resolve => setTimeout(resolve, 2000)); // Retry after 2 seconds
            } else {
              console.error("Failed to update timestamp after multiple attempts.");
              throw error;
            }
          }
        }
      };

      // Prepare the current timestamp and data for update
      const currentTimestamp = new Date().toISOString();
      const updateData = {
        action: 'updateData',
        'dbname': 'SM-Content-F',
        'contentId': contentId,
        platform: 'TikTok',
        ticktokStamp: currentTimestamp
      };

      // Call the function to update the TikTok timestamp with retries and timeout
      await updateTimestamp(
        'https://script.google.com/macros/s/AKfycbxrsER0ks-9yFbibZ8MEILfv1_dEPDLYwZBXEu7g5vEX2c0_Ic-Al_U-W3QbAkl73Zs/exec',
        updateData,
        3,
        10000
      );

    } catch (error) {
      console.error("Failed to upload video to TikTok:", error.message);
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

      // Step 2: Wait for the "Create Post" element and click it
      await page.waitForSelector('div.q-text.qu-dynamicFontSize--button.qu-medium', { visible: true });
      await page.evaluate(() => {
        const createPostButton = Array.from(document.querySelectorAll('div.q-text.qu-dynamicFontSize--button.qu-medium'))
          .find(element => element.textContent.includes('Create Post'));
        if (createPostButton) {
          createPostButton.click();
        }
      });
      console.log("Clicked 'Create Post'");

      // Step 3: Wait for the contenteditable field
      console.log("Waiting for the contenteditable field...");
      const contentEditableSelector = 'div.doc[data-placeholder][contenteditable]';
      await page.waitForSelector(contentEditableSelector, { visible: true, timeout: 60000 });
      console.log("Contenteditable field found!");

      // Step 4: Focus, clear, and type the longDescription
      await page.focus(contentEditableSelector);

      // Clear the field by selecting all text and pressing Backspace
      await page.keyboard.down('Control');
      await page.keyboard.press('A');
      await page.keyboard.up('Control');
      await page.keyboard.press('Backspace'); // Clear all selected text

      // Function to simulate typing text
      async function typeText(selector, text) {
        for (const char of text) {
          await page.keyboard.type(char, { delay: 100 }); // You can adjust the delay as needed
        }
      }

      await typeText(contentEditableSelector, longDescription);
      console.log("Cleared and entered the long description");

      // Step 5: Download and upload images to the post

      // Utility function to wait for a given time (used for retry delay)
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

      // Function to download an image with retry and timeout
      const downloadImage = async (url, imagePath, retries = 3, timeout = 30000) => {
        for (let attempt = 1; attempt <= retries; attempt++) {
          try {
            console.log(`Attempt ${attempt}: Downloading image from ${url}...`);

            const response = await axios({
              url,
              responseType: 'stream',
              timeout: timeout, // Set timeout for the download request
            });

            return new Promise((resolve, reject) => {
              const writer = require('fs').createWriteStream(imagePath);
              response.data.pipe(writer);
              writer.on('finish', resolve);
              writer.on('error', reject);
            });

          } catch (error) {
            console.error(`Failed to download image from ${url} on attempt ${attempt}. Error: ${error.message}`);
            if (attempt < retries) {
              console.log(`Retrying download in 2 seconds...`);
              await delay(2000); // Delay before retrying
            } else {
              console.log(`Failed to download image after ${retries} attempts.`);
              throw error; // Throw error if all retries fail
            }
          }
        }
      };

      // Split the imageUrls string into an array of URLs, assuming comma-separated values
      const imageUrlsArray = imageUrls.split(',').map(url => url.trim());

      const imagePaths = [];
      const path = require('path'); // Require path for file resolution
      for (let i = 0; i < imageUrlsArray.length; i++) {
        const imageUrl = imageUrlsArray[i];
        const imagePath = path.resolve(__dirname, `quora_image_${i}.jpg`); // Temporary local file path

        // Download the image with retry and timeout
        try {
          await downloadImage(imageUrl, imagePath, 3, 30000); // Retry 3 times with a 30-second timeout
          imagePaths.push(imagePath); // Store paths for uploading
          console.log(`Downloaded image ${i + 1}: ${imageUrl}`);
        } catch (error) {
          console.error(`Skipping image ${i + 1} due to download failure.`);
        }
      }

      // Upload downloaded images
      const imageUploadInput = await page.$('input[type="file"][accept="image/*"]');
      if (imageUploadInput && imagePaths.length > 0) {
        await imageUploadInput.uploadFile(...imagePaths);
        console.log("Uploaded images to Quora");

        // Wait a few seconds to ensure the images have fully uploaded before proceeding
        await new Promise(resolve => setTimeout(resolve, 5000)); // Replace page.waitForTimeout with setTimeout
      }

      // Step 6: Click the "Post" button to publish the post
      const postButtonSelector = 'button.q-click-wrapper.puppeteer_test_modal_submit';
      // Wait for the "Post" button to be visible and clickable
      await page.waitForSelector(postButtonSelector, { visible: true, timeout: 60000 });
      await page.click(postButtonSelector);
      console.log("Post button clicked!");

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
    // If the browser is not initialized, launch it
    if (!browser) {
      browser = await launchBrowser();
    }

    const data = await fetchDataFromAppScript();

    // First row is the header, extract indexes dynamically
    const headers = data[0];
    const columnIndexes = getColumnIndexes(headers);

    // URLs and selectors for each platform
    const platforms = [
      { name: "Facebook", url: "https://facebook.com" },
      { name: "Instagram", url: "https://instagram.com" },
      { name: "Quora", url: "https://quora.com" },
      { name: "Twitter", url: "https://twitter.com" },
      { name: "TikTok", url: "https://www.tiktok.com/tiktokstudio/upload?from=upload" },
      { name: "Reddit", url: "https://reddit.com" },
    ];

    // Filter platforms based on user input
    const selectedPlatforms = platforms.filter(platform => platformsToRun.includes(platform.name));

    // Wait for manual login only once
    if (!hasLoggedIn) {
      waitForContinue();
      hasLoggedIn = true; // Set the flag after the first login
    }

    // Process each row of data (except the header)
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const content = {
        contentId: row[columnIndexes['contentId']],
        jobType: row[columnIndexes['jobType']],
        contentType: row[columnIndexes['contentType']],
        shouldSend: row[columnIndexes['shouldSend']],
        title: row[columnIndexes['title']],
        longTitle: row[columnIndexes['longTitle']],
        description: row[columnIndexes['description']],
        longDescription: row[columnIndexes['longDescription']],
        hashtags: row[columnIndexes['hashtags']],
        imageUrls: row[columnIndexes['images']],
        videos: row[columnIndexes['videos']],
        location: row[columnIndexes['location']],
        ticktokStamp: row[columnIndexes['ticktokStamp']],
        quoraStamp: row[columnIndexes['quoraStamp']],
      };

      for (const platform of selectedPlatforms) {
        console.log(`Processing content for ${platform.name}...`);
        await handlePlatformLogic(platform, platform.name, content, browser);
      }
    }
  } catch (error) {
    console.error("Error running automation:", error);
  } finally {
    isRunning = false; // Reset the flag after the process is complete
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
