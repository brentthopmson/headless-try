import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import logger from '@/utils/logger.js'; // Assuming logger path alias

const KEY_FILE_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const SCOPES = ['https://www.googleapis.com/auth/drive.file'];

if (!KEY_FILE_PATH || !DRIVE_FOLDER_ID) {
  logger.warn('[GoogleDrive] Missing GOOGLE_SERVICE_ACCOUNT_KEY_PATH or GOOGLE_DRIVE_FOLDER_ID environment variables. Drive upload disabled.');
}

async function authenticate() {
  if (!KEY_FILE_PATH) return null;
  try {
    // Ensure the key file exists before attempting to authenticate
    if (!fs.existsSync(KEY_FILE_PATH)) {
        logger.error(`[GoogleDrive Auth] Service account key file not found at: ${KEY_FILE_PATH}`);
        return null;
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: KEY_FILE_PATH,
      scopes: SCOPES,
    });
    const authClient = await auth.getClient();
    return google.drive({ version: 'v3', auth: authClient });
  } catch (error) {
    logger.error(`[GoogleDrive Auth] Error authenticating: ${error.message}`);
    return null;
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
  if (!KEY_FILE_PATH || !DRIVE_FOLDER_ID) {
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
    });

    logger.info(`[GoogleDrive Upload] File uploaded successfully for ${browserId}. File ID: ${file.data.id}`);

    // Make the file publicly readable (anyone with the link)
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: {
        role: 'reader',
        type: 'anyone',
      },
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
