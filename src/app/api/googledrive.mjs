import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { v2 as cloudinary } from 'cloudinary';
import logger from '../../utils/logger.js'; // Use relative path for ES module
import JSON5 from 'json5'; // Import json5 to parse GOOGLE_OAUTH2_JSON safely

// Environment variables for Google Drive (OAuth2)
const GOOGLE_OAUTH2_JSON_STR = process.env.GOOGLE_OAUTH2_JSON;
const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const USERS_FOLDER_ID = process.env.USERS_FOLDER_ID; // From .env, used by getOrCreateUserFolder

// Cloudinary fallback provider: when Google Drive is down, unconfigured, or exhausted, the
// profile zip goes to Cloudinary as a public raw asset. The returned secure_url is stored
// as driveUrl — the frontend's getDirectDownloadUrl passes non-Drive URLs through unchanged
// and the Electron launcher downloads any URL and validates the ZIP magic bytes, so no
// downstream change is required.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'profile-uploads';
let cloudinaryConfigured = false;
function configureCloudinary() {
  if (cloudinaryConfigured) return true;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return false;
  cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET });
  cloudinaryConfigured = true;
  return true;
}

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

export async function uploadImageToDrive(base64Image, fileName, parentFolderId) {
  try {
    const drive = await authenticate();
    if (!drive) {
      return { success: false, error: "Failed to get Drive API authentication client." };
    }
    const buffer = Buffer.from(base64Image, 'base64');
    const media = { mimeType: 'image/png', body: buffer };
    const fileMetadata = {
      name: fileName,
      parents: [parentFolderId || DRIVE_FOLDER_ID],
    };
    const file = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
      supportsAllDrives: true,
    });
    await drive.permissions.create({
      fileId: file.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
      supportsAllDrives: true,
    });
    logger.info(`[Drive API] Image uploaded: ${file.data.webViewLink}`);
    return { success: true, webViewLink: file.data.webViewLink, id: file.data.id };
  } catch (error) {
    logger.error(`[Drive API] Error uploading image: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function zipDirectory(sourceDir, outPath, retries = 3) {
  // Ensure source directory exists and is accessible
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Create zip archive and add files directly from source
      return await new Promise((resolve, reject) => {
        const archive = archiver('zip', { zlib: { level: 9 } });
        const stream = fs.createWriteStream(outPath);
        let warningCount = 0;

        archive.on('warning', (err) => {
          if (err.code === 'ENOENT') {
            logger.warn(`[GoogleDrive Zip] Warning for ${sourceDir}: ${err.message}`);
            warningCount++;
          } else if (err.code === 'EBUSY' || err.code === 'EPERM') {
            reject(err);
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

        archive.pipe(stream);
        
        archive.glob('**/*', {
          cwd: sourceDir,
          ignore: [],
          dot: true
        });
        
        archive.finalize();
      });
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && attempt < retries) {
        logger.warn(`[GoogleDrive Zip] File locked (attempt ${attempt}/${retries}): ${err.message}. Retrying in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      throw err;
    }
  }
}

const MAX_UPLOAD_RETRIES = 3;
const UPLOAD_RETRY_DELAY_MS = 5000; // 5 seconds

// Locate a browser profile dir across ALL worker segments. route.js's WORKER_SEGMENT is
// module-scoped and re-randomizes on a Next dev hot-recompile, so the dir a prior module
// instance launched may live under a different segment than the one this job was built
// with. Scanning every segment is the durable fallback before we ever classify a profile
// as gone (which would fail the upload permanently and lose the cookies).
function resolveProfileDir(browserId) {
  const parent = '/tmp/users_data';
  try {
    if (fs.existsSync(parent)) {
      for (const seg of fs.readdirSync(parent)) {
        if (seg.startsWith('.')) continue;
        const candidate = `${parent}/${seg}/${browserId}`;
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch (_) {}
  return null;
}

// Clean the dedicated staging copy after an upload settles (success OR permanent). Transient
// failures intentionally keep the staging dir so the queue's next retry can still zip it.
// Staging lives OUTSIDE /tmp/users_data (route.js moves the profile there at close), so this
// never conflicts with live profile dirs, segment scans, or the external segment cleaner.
function cleanupStagingDir(sourceDir) {
  if (!String(sourceDir).includes('/webfixx_uploading/')) return;
  try {
    if (fs.existsSync(sourceDir)) {
      fs.rmSync(sourceDir, { recursive: true, force: true });
      logger.info(`[GoogleDrive Upload] Cleaned staging dir ${sourceDir} after settle.`);
    }
  } catch (e) {
    logger.error(`[GoogleDrive Upload] Staging cleanup failed for ${sourceDir}: ${e.message}`);
  }
}

// Upload a profile zip to Cloudinary as a raw public asset. Returns a structured
// { ok, url, permanent, reason }. secure_url is a public direct link (no auth needed),
// so the frontend download + Electron launcher flow works unchanged.
function uploadZipToCloudinary(browserId, zipFilePath) {
  return new Promise((resolve) => {
    if (!configureCloudinary()) {
      logger.warn(`[Cloudinary Upload] Missing CLOUDINARY_* config for ${browserId}. Cannot upload.`);
      return resolve({ ok: false, permanent: true, reason: 'Missing Cloudinary config' });
    }
    const publicId = `${browserId}_profile`;
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'raw',
        public_id: publicId,
        folder: CLOUDINARY_FOLDER,
        overwrite: true,
        unique_filename: false
      },
      (error, result) => {
        if (error) {
          logger.error(`[Cloudinary Upload] Error uploading for ${browserId}: ${error.message}`);
          return resolve({ ok: false, permanent: false, reason: `Cloudinary error: ${error.message}` });
        }
        if (!result || !result.secure_url) {
          logger.error(`[Cloudinary Upload] ${browserId} returned no secure_url.`);
          return resolve({ ok: false, permanent: false, reason: 'Cloudinary returned no secure_url' });
        }
        logger.info(`[Cloudinary Upload] ${browserId} uploaded: ${result.secure_url}`);
        return resolve({ ok: true, url: result.secure_url });
      }
    );
    fs.createReadStream(zipFilePath).pipe(uploadStream);
  });
}

// Public entry point: short-circuits on the re-upload guard, otherwise serializes
// through the durable write queue (1 upload at a time, quota-aware, journaled).
// The raw upload logic lives in uploadBrowserDataRaw below and is invoked by the
// queue worker. Dynamic import keeps the googlesheets→googledrive→writeQueue→
// cookieDataFetcher→googlesheets module cycle broken.
export function uploadBrowserData(browserId, updateData, userDataDir, opts = {}) {
  const uploadedMap = globalThis.__uploadedBrowserData;
  if (uploadedMap instanceof Map && uploadedMap.has(browserId)) {
    const cachedUrl = uploadedMap.get(browserId);
    logger.warn(`[GoogleDrive Upload][skip] ${browserId} already uploaded this process (${cachedUrl}). Returning cached URL without re-upload.`);
    return Promise.resolve(cachedUrl);
  }
  if (updateData && updateData.driveUrl) {
    logger.warn(`[GoogleDrive Upload][skip] ${browserId} row already has driveUrl (${updateData.driveUrl}). Returning it without re-upload.`);
    return Promise.resolve(updateData.driveUrl);
  }
  return import('../../utils/writeQueue.js').then(({ enqueueDriveUpload }) =>
    enqueueDriveUpload(browserId, updateData, userDataDir, opts)
  );
}

export async function uploadBrowserDataRaw(browserId, updateData, userDataDir) {
  // RE-UPLOAD GUARD: if this process already uploaded the profile, or the row already
  // carries a driveUrl (prior successful save persisted to the sheet), short-circuit so a
  // reprocessed terminal row can never re-upload after the dir was deleted.
  const uploadedMap = globalThis.__uploadedBrowserData;
  if (uploadedMap instanceof Map && uploadedMap.has(browserId)) {
    const cachedUrl = uploadedMap.get(browserId);
    logger.warn(`[GoogleDrive Upload][skip] ${browserId} already uploaded this process (${cachedUrl}). Returning cached URL without re-upload.`);
    return { ok: true, url: cachedUrl };
  }
  if (updateData && updateData.driveUrl) {
    logger.warn(`[GoogleDrive Upload][skip] ${browserId} row already has driveUrl (${updateData.driveUrl}). Returning it without re-upload.`);
    return { ok: true, url: updateData.driveUrl };
  }
  logger.warn(`[GoogleDrive Upload] No skip-guard hit for ${browserId} (map=${uploadedMap instanceof Map ? uploadedMap.has(browserId) : 'n/a'} driveUrl=${updateData?.driveUrl || 'none'}). Proceeding with fresh upload.`);

  // DIAGNOSTIC + RESOLUTION: the caller passes a worker-scoped dir, but after a Next dev
  // hot-recompile the module's WORKER_SEGMENT differs from the launch segment recorded in
  // globalThis.__profileWriter, so the requested dir may be the wrong one while the real
  // profile lives under another segment. Resolve across all segments before classifying
  // the profile as gone (which would lose the cookies and mark a good run FAILED).
  let sourceDir = userDataDir || `/tmp/users_data/${browserId}`;
  if (!fs.existsSync(sourceDir)) {
    const resolved = resolveProfileDir(browserId);
    if (resolved) {
      logger.warn(`[GoogleDrive Upload][diag] ${browserId} requested dir missing (${sourceDir}) — resolved to ${resolved}`);
      sourceDir = resolved;
    }
  }
  let dirSizeMB = 0;
  try {
    if (fs.existsSync(sourceDir)) {
      const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
      const counts = { files: 0, dirs: 0 };
      for (const e of entries) { if (e.isDirectory()) counts.dirs++; else counts.files++; }
      let sizeBytes = 0;
      const walk = (p) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const fp = `${p}/${e.name}`;
          if (e.isDirectory()) { walk(fp); } else { try { sizeBytes += fs.statSync(fp).size; } catch (_) {} }
        }
      };
      try { walk(sourceDir); } catch (_) {}
      dirSizeMB = Math.round((sizeBytes / 1024 / 1024) * 100) / 100;
      logger.warn(`[GoogleDrive Upload][diag] ${browserId} dirExists=true entries=${JSON.stringify(counts)} sizeMB=${dirSizeMB} now=${new Date().toISOString()}`);
      // DEGRADED-PROFILE MONITOR: an intact Chromium profile always has several top-level
      // entries (Default/, Local State, Preferences, ...). files=0 + dirs<=1 means the dir
      // was deleted mid-run and lazily recreated — the upload would capture a logged-out
      // empty profile while the sheet still marks the row COMPLETED (silent data loss).
      if (counts.files === 0 && counts.dirs <= 1) {
        logger.error(`[GoogleDrive Upload][diag] ${browserId} DEGRADED PROFILE: top-level files=0 dirs=${counts.dirs} sizeMB=${dirSizeMB} — profile dir looks freshly recreated (likely deleted mid-run). Uploading anyway; flag for repair. now=${new Date().toISOString()}`);
      }
    } else {
      logger.error(`[GoogleDrive Upload][diag] ${browserId} dirExists=false now=${new Date().toISOString()} stack=${new Error().stack?.split('\n').slice(2, 5).join(' | ')}`);
      // GRACE: the profile dir may have just been written by a concurrent profile save/upload.
      // Wait once (5s), then re-scan every segment before giving up — avoids a false 'Source
      // directory not found' turning a valid completion into a lost profile.
      await new Promise((r) => setTimeout(r, 5000));
      const reResolved = resolveProfileDir(browserId) || sourceDir;
      if (!fs.existsSync(reResolved)) {
        logger.error(`[GoogleDrive Upload][diag] ${browserId} dirExists=false after 5s grace + full segment scan. Aborting upload PERMANENT (profile gone). now=${new Date().toISOString()}`);
        cleanupStagingDir(sourceDir);
        return { ok: false, permanent: true, reason: `Source directory not found (profile gone): ${reResolved}` };
      }
      sourceDir = reResolved;
      logger.warn(`[GoogleDrive Upload][diag] ${browserId} dir appeared after 5s grace (${reResolved}). Proceeding with upload. now=${new Date().toISOString()}`);
    }
  } catch (statErr) {
    logger.warn(`[GoogleDrive Upload][diag] ${browserId} stat failed: ${statErr.message}`);
  }

  // Provider availability: Drive is primary, Cloudinary is the fallback. Only if BOTH are
  // unavailable is this a permanent failure (nothing can ever upload this profile).
  const driveConfigOk = !!(GOOGLE_OAUTH2_JSON_STR && GOOGLE_DRIVE_REFRESH_TOKEN && DRIVE_FOLDER_ID);
  const cloudConfigOk = configureCloudinary();
  if (!driveConfigOk && !cloudConfigOk) {
    logger.warn(`[GoogleDrive Upload] No upload provider configured for ${browserId} (Drive oauth2=${!!GOOGLE_OAUTH2_JSON_STR} refreshToken=${!!GOOGLE_DRIVE_REFRESH_TOKEN} folderId=${!!DRIVE_FOLDER_ID} cloudinary=${cloudConfigOk}). Permanent failure.`);
    cleanupStagingDir(sourceDir);
    return { ok: false, permanent: true, reason: 'No upload provider configured (Drive + Cloudinary both unavailable)' };
  }

  const zipFileName = `${browserId}_profile_${Date.now()}.zip`; // Add timestamp for uniqueness
  const zipFilePath = `${sourceDir}.zip`; // Keep the zip out of the profile dir, unique per worker/browserId

  logger.info(`[GoogleDrive Upload] Attempting to zip directory ${sourceDir} for ${browserId}...`);

  try {
    // Check if directory exists before attempting to zip
    if (!fs.existsSync(sourceDir)) {
      logger.error(`[GoogleDrive Upload] Source directory not found for ${browserId}: ${sourceDir} now=${new Date().toISOString()}`);
      cleanupStagingDir(sourceDir);
      return { ok: false, permanent: true, reason: `Source directory not found: ${sourceDir}` };
    }

    await zipDirectory(sourceDir, zipFilePath);
    logger.info(`[GoogleDrive Upload] Zipped successfully to ${zipFilePath} for ${browserId}.`);

    // Check if zip file was created and has content
    if (!fs.existsSync(zipFilePath) || fs.statSync(zipFilePath).size === 0) {
      logger.error(`[GoogleDrive Upload] Zip file empty or not created for ${browserId}`);
      // Clean up the empty/failed zip file before returning
      if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);
      return { ok: false, permanent: false, reason: 'Zip file empty or not created' };
    }

    const fileSize = fs.statSync(zipFilePath).size;
    let downloadUrl = null;
    let lastDriveError = '';
    let lastCloudinaryError = '';

    // Provider 1: Google Drive (primary).
    if (driveConfigOk) {
      const drive = await authenticate();
      if (!drive) {
        lastDriveError = 'Drive auth failed (GOOGLE_OAUTH2_JSON / refresh token rejected)';
        logger.error(`[GoogleDrive Upload] Authentication failed for ${browserId}. Falling back to Cloudinary.`);
      } else {
        let uploadAttempt = 0;
        while (uploadAttempt < MAX_UPLOAD_RETRIES && !downloadUrl) {
          uploadAttempt++;
          logger.info(`[GoogleDrive Upload] Uploading ${zipFileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB) to Drive folder ${DRIVE_FOLDER_ID} for ${browserId} (Attempt ${uploadAttempt} of ${MAX_UPLOAD_RETRIES})...`);

          try {
            // Re-create the read stream for each upload attempt
            const media = {
              mimeType: 'application/zip',
              body: fs.createReadStream(zipFilePath),
            };
            const fileMetadata = {
              name: zipFileName,
              parents: [DRIVE_FOLDER_ID],
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

            // Prefer webViewLink for easier browser access
            downloadUrl = file.data.webViewLink || file.data.webContentLink;
            logger.info(`[GoogleDrive Upload] Returning URL: ${downloadUrl} for ${browserId}`);

          } catch (uploadError) {
            lastDriveError = uploadError.message;
            logger.error(`[GoogleDrive Upload] Error during upload attempt ${uploadAttempt} for ${browserId}: ${uploadError.message}`);
            if (uploadAttempt < MAX_UPLOAD_RETRIES) {
              logger.warn(`[GoogleDrive Upload] Retrying upload in ${UPLOAD_RETRY_DELAY_MS / 1000} seconds for ${browserId}...`);
              await new Promise(resolve => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
            }
          }
        }
      }
    } else {
      logger.warn(`[GoogleDrive Upload] Drive config missing for ${browserId} (oauth2=${!!GOOGLE_OAUTH2_JSON_STR} refreshToken=${!!GOOGLE_DRIVE_REFRESH_TOKEN} folderId=${!!DRIVE_FOLDER_ID}) — trying Cloudinary.`);
    }

    // Provider 2: Cloudinary (fallback). Reuses the same zip; no re-archive needed.
    if (!downloadUrl && cloudConfigOk) {
      const cloudResult = await uploadZipToCloudinary(browserId, zipFilePath);
      if (cloudResult.ok) {
        downloadUrl = cloudResult.url;
      } else {
        lastCloudinaryError = cloudResult.reason;
        logger.error(`[GoogleDrive Upload] Cloudinary fallback failed for ${browserId}: ${cloudResult.reason}`);
      }
    }

    // Clean up the local zip file after all attempts (whether successful or failed)
    if (fs.existsSync(zipFilePath)) {
      try {
        fs.unlinkSync(zipFilePath);
        logger.info(`[GoogleDrive Upload] Cleaned up local zip file ${zipFilePath} for ${browserId}.`);
      } catch (cleanupError) {
        logger.error(`[GoogleDrive Upload] Error cleaning up zip file after upload for ${browserId}: ${cleanupError.message}`);
      }
    }

    if (downloadUrl) {
      if (globalThis.__uploadedBrowserData instanceof Map) {
        globalThis.__uploadedBrowserData.set(browserId, downloadUrl);
      }
      cleanupStagingDir(sourceDir);
      return { ok: true, url: downloadUrl };
    }

    // Both providers failed on this attempt. Transient (network/quota): the durable queue
    // keeps retrying with backoff; the profile dir is preserved until it settles.
    const reason = `Drive: ${lastDriveError || (driveConfigOk ? 'failed after retries' : 'skipped (no config)')} | Cloudinary: ${lastCloudinaryError || (cloudConfigOk ? 'failed' : 'skipped (no config)')}`;
    logger.error(`[GoogleDrive Upload] ${browserId} all providers failed. ${reason}`);
    return { ok: false, permanent: false, reason };

  } catch (error) {
    logger.error(`[GoogleDrive Upload] Error during zip or initial upload setup for ${browserId}: ${error.message}`, error);
    // Clean up zip file if it exists after any error in the main try block
    if (fs.existsSync(zipFilePath)) {
      try {
        fs.unlinkSync(zipFilePath);
        logger.info(`[GoogleDrive Upload] Cleaned up local zip file ${zipFilePath} after error for ${browserId}.`);
      } catch (cleanupError) {
        logger.error(`[GoogleDrive Upload] Error cleaning up zip file after error for ${browserId}: ${cleanupError.message}`);
      }
    }
    return { ok: false, permanent: false, reason: error.message }; // Indicate transient failure
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
