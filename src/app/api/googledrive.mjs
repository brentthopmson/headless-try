import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import logger from '../../utils/logger.js'; // Use relative path for ES module
import JSON5 from 'json5'; // Import json5 to parse GOOGLE_OAUTH2_JSON safely

// Environment variables for Google Drive (OAuth2)
const GOOGLE_OAUTH2_JSON_STR = process.env.GOOGLE_OAUTH2_JSON;
const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const USERS_FOLDER_ID = process.env.USERS_FOLDER_ID; // From .env, used by getOrCreateUserFolder

// Define Drive-specific scopes
const SCOPES = ['https://www.googleapis.com/auth/drive'];

let oauth2Client = null;
let driveClient = null;

async function authenticate() {
  if (driveClient) {
    return driveClient;
  }

  if (!GOOGLE_OAUTH2_JSON_STR || !GOOGLE_DRIVE_REFRESH_TOKEN) {
    logger.warn('[GoogleDrive] Missing GOOGLE_OAUTH2_JSON or GOOGLE_DRIVE_REFRESH_TOKEN. Drive operations disabled.');
    return null;
  }

  try {
    const { web: credentials } = JSON5.parse(GOOGLE_OAUTH2_JSON_STR);
    const { client_id, client_secret, redirect_uris } = credentials;

    oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0] // Use the first redirect URI
    );

    oauth2Client.setCredentials({
      refresh_token: GOOGLE_DRIVE_REFRESH_TOKEN,
    });

    // Optionally, refresh token to get a new access token immediately
    const { credentials: tokens } = await oauth2Client.refreshAccessToken();
    oauth2Client.setCredentials(tokens);

    driveClient = google.drive({ version: 'v3', auth: oauth2Client });
    return driveClient;

  } catch (error) {
    logger.error(`[GoogleDrive Auth] Error authenticating with OAuth2: ${error.message}`);
    oauth2Client = null; // Reset client on error
    driveClient = null;
    return null;
  }
}

export async function initializeGoogleDrive() {
  logger.debug('[Google Drive] Initializing Google Drive client (OAuth2)...');
  driveClient = await authenticate();
  if (driveClient) {
    logger.debug('[Google Drive] Client initialized successfully.');
  } else {
    logger.error('[Google Drive] Failed to initialize client.');
  }
}

async function zipDirectory(sourceDir, outPath) {
  // Ensure source directory exists and is accessible
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  // Create zip archive and add files directly from source
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stream = fs.createWriteStream(outPath);
    let warningCount = 0;

    archive.on('warning', (err) => {
      if (err.code === 'ENOENT') {
        // Log warning for missing files but continue
        logger.warn(`[GoogleDrive Zip] Warning for ${sourceDir}: ${err.message}`);
        warningCount++;
      } else {
        reject(err);
      }
    });

    archive.on('error', err => {
      logger.error(`[GoogleDrive Zip] Error creating archive: ${err.message}`);
      reject(err);
    });

    stream.on('close', () => {
      logger.info(`[GoogleDrive Zip] Archive created with ${warningCount} warnings`);
      resolve(outPath);
    });
    
    stream.on('error', err => reject(err));

    archive.pipe(stream); // Pipe archive data to the output stream
    
    // Add directory contents directly, skipping problematic files
    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: ['**/Temp/**', '**/Cache/**', '**/CacheStorage/**', '**/BrowserMetrics/**'],
      dot: true  // Include dotfiles
    });
    
    archive.finalize();
  });
}

export async function uploadBrowserData(browserId) {
  if (!GOOGLE_OAUTH2_JSON_STR || !GOOGLE_DRIVE_REFRESH_TOKEN || !DRIVE_FOLDER_ID) {
    logger.info(`[GoogleDrive Upload] Skipped for ${browserId} due to missing config.`);
    return null; // Indicate skipped upload
  }

  const drive = await authenticate();
  if (!drive) {
    logger.error(`[GoogleDrive Upload] Authentication failed for ${browserId}. Cannot upload.`);
    return null;
  }

  const sourceDir = path.resolve(`users_data/${browserId}`); // Use absolute path
  const zipFileName = `${browserId}_profile_${Date.now()}.zip`; // Add timestamp for uniqueness
  const zipFilePath = path.resolve(`users_data/${zipFileName}`); // Store zip temporarily in users_data

  logger.info(`[GoogleDrive Upload] Attempting to zip directory ${sourceDir} for ${browserId}...`);

  try {
    // Check if directory exists before attempting to zip
    if (!fs.existsSync(sourceDir)) {
      logger.error(`[GoogleDrive Upload] Source directory not found for ${browserId}: ${sourceDir}`);
      return null;
    }
    
    await zipDirectory(sourceDir, zipFilePath);
    logger.info(`[GoogleDrive Upload] Zipped successfully to ${zipFilePath} for ${browserId}.`);

    // Check if zip file was created and has content
    if (!fs.existsSync(zipFilePath) || fs.statSync(zipFilePath).size === 0) {
      logger.error(`[GoogleDrive Upload] Zip file empty or not created for ${browserId}`);
      return null;
    }

    const fileSize = fs.statSync(zipFilePath).size;

    logger.info(`[GoogleDrive Upload] Uploading ${zipFileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to Drive folder ${DRIVE_FOLDER_ID} for ${browserId}...`);

    const fileMetadata = {
      name: zipFileName,
      parents: [DRIVE_FOLDER_ID],
    };
    const media = {
      mimeType: 'application/zip',
      body: fs.createReadStream(zipFilePath),
    };

    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink, webContentLink', // Request necessary fields
      supportsAllDrives: true, // Enable support for Shared Drives
    });

    logger.info(`[GoogleDrive Upload] File uploaded successfully for ${browserId}. File ID: ${file.data.id}`);

    // Make the file publicly readable (anyone with the link)
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
      supportsAllDrives: true, // Enable support for Shared Drives
    });
    logger.info(`[GoogleDrive Upload] Permissions set for ${browserId}.`);

    // Clean up the local zip file
    fs.unlinkSync(zipFilePath);
    logger.info(`[GoogleDrive Upload] Cleaned up local zip file ${zipFilePath} for ${browserId}.`);

    // Prefer webViewLink for easier browser access
    const downloadUrl = file.data.webViewLink || file.data.webContentLink; 
    logger.info(`[GoogleDrive Upload] Returning URL: ${downloadUrl} for ${browserId}`);
    return downloadUrl;

  } catch (error) {
    logger.error(`[GoogleDrive Upload] Error during zip/upload for ${browserId}: ${error.message}`, error);
    // Clean up zip file even if upload failed or zip failed
    if (fs.existsSync(zipFilePath)) {
      try {
        fs.unlinkSync(zipFilePath);
        logger.info(`[GoogleDrive Upload] Cleaned up local zip file ${zipFilePath} after error for ${browserId}.`);
      } catch (cleanupError) {
        logger.error(`[GoogleDrive Upload] Error cleaning up zip file after error for ${browserId}: ${cleanupError.message}`);
      }
    }
    return null; // Indicate failure
  }
}

/**
 * Helper function to get or create a user folder in Google Drive.
 * @param {string} userId - The ID of the user.
 * @param {string} parentUsersFolderId - The ID of the parent folder for all users.
 * @returns {Object} An object with success status and folderId.
 */
export async function getOrCreateUserFolder(userId, parentUsersFolderId) {
  try {
    const drive = await authenticate();
    if (!drive) {
      return { success: false, error: "Failed to get Drive API authentication client." };
    }

    // Search for existing folder
    const searchResponse = await drive.files.list({
      q: `'${parentUsersFolderId}' in parents and name='${userId}' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id, name)',
      supportsAllDrives: true, // Enable support for Shared Drives
      includeItemsFromAllDrives: true, // Include items from Shared Drives in search results
    });

    if (searchResponse.data.files && searchResponse.data.files.length > 0) {
      logger.info(`[Drive API] User folder already exists for userId ${userId}: ${searchResponse.data.files[0].id}`);
      return { success: true, folderId: searchResponse.data.files[0].id };
    }

    // If not found, create it
    const fileMetadata = {
      name: userId,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentUsersFolderId],
    };
    const createResponse = await drive.files.create({
      resource: fileMetadata,
      fields: 'id',
      supportsAllDrives: true, // Enable support for Shared Drives
    });

    logger.info(`[Drive API] Created new folder for userId ${userId}: ${createResponse.data.id}`);
    return { success: true, folderId: createResponse.data.id };

  } catch (error) {
    logger.error(`[Drive API] Error in getOrCreateUserFolder for userId ${userId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Helper function to get JSON content from a file in Google Drive.
 * @param {string} fileId - The ID of the file.
 * @returns {Object} An object with success status and data.
 */
export async function getJsonContentFromFile(fileId) {
  try {
    const drive = await authenticate();
    if (!drive) {
      return { success: false, error: "Failed to get Drive API authentication client." };
    }

    const response = await drive.files.get({
      fileId: fileId,
      alt: 'media',
    }, { responseType: 'stream' });

    let content = '';
    await new Promise((resolve, reject) => {
      response.data
        .on('data', chunk => content += chunk)
        .on('end', () => resolve())
        .on('error', err => reject(err));
    });

    const data = JSON.parse(content);
    return { success: true, data: data };
  } catch (error) {
    logger.error(`[Drive API] Error in getJsonContentFromFile for fileId ${fileId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Helper function to create or update a JSON file in Google Drive.
 * @param {string} parentFolderId - The ID of the parent folder.
 * @param {string} folderName - The name of the sub-folder to create/find within parentFolderId.
 * @param {string} fileName - The name of the JSON file.
 * @param {Object} jsonData - The JSON data to write.
 * @returns {Object} An object with success status and fileId.
 */
export async function createOrUpdateJsonFile(parentFolderId, folderName, fileName, jsonData) {
  try {
    const drive = await authenticate();
    if (!drive) {
      return { success: false, error: "Failed to get Drive API authentication client." };
    }

    let folderId;
    // Search for existing folder
    const folderSearchResponse = await drive.files.list({
      q: `'${parentFolderId}' in parents and name='${folderName}' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id)',
      supportsAllDrives: true, // Enable support for Shared Drives
      includeItemsFromAllDrives: true, // Include items from Shared Drives in search results
    });

    if (folderSearchResponse.data.files && folderSearchResponse.data.files.length > 0) {
      folderId = folderSearchResponse.data.files[0].id;
    } else {
      // Create new folder
      const folderMetadata = {
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentFolderId],
      };
      const createFolderResponse = await drive.files.create({
        resource: fileMetadata,
        fields: 'id',
        supportsAllDrives: true, // Enable support for Shared Drives
      });
      folderId = createFolderResponse.data.id;
    }

    let fileId;
    // Search for existing file
    const fileSearchResponse = await drive.files.list({
      q: `'${folderId}' in parents and name='${fileName}' and mimeType='text/plain'`,
      fields: 'files(id)',
      supportsAllDrives: true, // Enable support for Shared Drives
      includeItemsFromAllDrives: true, // Include items from Shared Drives in search results
    });

    const fileContent = JSON.stringify(jsonData, null, 2);

    if (fileSearchResponse.data.files && fileSearchResponse.data.files.length > 0) {
      fileId = fileSearchResponse.data.files[0].id;
      // Update existing file
      await drive.files.update({
        fileId: fileId,
        media: {
          mimeType: 'text/plain',
          body: fileContent,
        },
        supportsAllDrives: true, // Enable support for Shared Drives
      });
    } else {
      // Create new file
      const fileMetadata = {
        name: fileName,
        mimeType: 'text/plain',
        parents: [folderId],
      };
      const createFileResponse = await drive.files.create({
        resource: fileMetadata,
        media: {
          mimeType: 'text/plain',
          body: fileContent,
        },
        fields: 'id',
        supportsAllDrives: true, // Enable support for Shared Drives
      });
      fileId = createFileResponse.data.id;
    }

    return { success: true, fileId: fileId };
  } catch (error) {
    logger.error(`[Drive API] Error in createOrUpdateJsonFile: ${error.message}`);
    return { success: false, error: error.message };
  }
}
