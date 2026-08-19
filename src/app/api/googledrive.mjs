import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { v2 as cloudinary } from 'cloudinary';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import logger from '../../utils/logger.js'; // Use relative path for ES module
import JSON5 from 'json5'; // Import json5 to parse GOOGLE_OAUTH2_JSON safely

// Environment variables for Google Drive (OAuth2)
const GOOGLE_OAUTH2_JSON_STR = process.env.GOOGLE_OAUTH2_JSON;
const GOOGLE_DRIVE_REFRESH_TOKEN = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
const USERS_FOLDER_ID = process.env.USERS_FOLDER_ID; // From .env, used by getOrCreateUserFolder

// Fallback upload providers: when Google Drive is down, unconfigured, or exhausted, the
// profile zip goes to Cloudflare R2, then Backblaze B2, then Cloudinary (last) as a public
// object/raw asset. The returned public URL is stored as driveUrl — the frontend's
// getDirectDownloadUrl passes non-Drive URLs through unchanged and the Electron launcher
// downloads any URL and validates the ZIP magic bytes, so no downstream change is required.
// Providers 2 and 3 (R2/B2) are inert until their env vars are set; the waterfall simply
// falls through to Cloudinary (or Drive-only) as it did before.
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'profile-uploads';
// Cloudinary raw-upload cap is 10 MB. Profiles are zipped below this by excluding
// regenerable Chromium caches (see ZIP_EXCLUDE_PATTERNS), and this guard is a hard
// ceiling so an unexpectedly large zip is skipped fast with a clear reason instead of
// a 5-second round-trip to Cloudinary's API that returns the same error anyway.
const CLOUDINARY_MAX_BYTES = parseInt(process.env.CLOUDINARY_MAX_BYTES || '10485760', 10);
let cloudinaryConfigured = false;
function configureCloudinary() {
  if (cloudinaryConfigured) return true;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) return false;
  cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET });
  cloudinaryConfigured = true;
  return true;
}

// Cloudflare R2 fallback provider (waterfall position 2, after Drive, before B2). R2 is
// S3-compatible, so uploads go through the shared uploadZipToS3 helper with the R2 endpoint
// (https://<ACCOUNT_ID>.r2.cloudflarestorage.com) and region "auto". Public downloads come
// from R2_PUBLIC_BASE_URL (a bound custom domain or the r2.dev dev URL when "Allow Access"
// is enabled on the bucket). All vars unset = provider skipped, never a permanent failure.
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;
const R2_MAX_BYTES = parseInt(process.env.R2_MAX_BYTES || String(1024 * 1024 * 1024), 10); // 1 GB default cap
function r2ConfigOk() {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_BASE_URL);
}

// Backblaze B2 fallback provider (waterfall position 3, after R2, before Cloudinary). Also
// S3-compatible; B2_ENDPOINT/B2_REGION are copied from the bucket's "Endpoint" field in the
// dashboard (e.g. https://s3.us-west-004.backblazeb2.com / us-west-004), and the App Key's
// keyID/applicationKey map to accessKeyId/secretAccessKey. Public downloads come from
// B2_PUBLIC_BASE_URL (https://<bucket>.s3.<region>.backblazeb2.com when the bucket is public).
// All vars unset = provider skipped, never a permanent failure.
const B2_ACCOUNT_ID = process.env.B2_ACCOUNT_ID;
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY;
const B2_BUCKET = process.env.B2_BUCKET;
const B2_ENDPOINT = process.env.B2_ENDPOINT;
const B2_REGION = process.env.B2_REGION;
const B2_PUBLIC_BASE_URL = process.env.B2_PUBLIC_BASE_URL;
const B2_MAX_BYTES = parseInt(process.env.B2_MAX_BYTES || String(1024 * 1024 * 1024), 10); // 1 GB default cap
function b2ConfigOk() {
  return !!(B2_ACCOUNT_ID && B2_APPLICATION_KEY && B2_BUCKET && B2_ENDPOINT && B2_REGION && B2_PUBLIC_BASE_URL);
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

// Regenerable Chromium/Chrome profile caches. They can be tens of MB and are rebuilt
// automatically on next launch, so excluding them slims the profile zip well under
// Cloudinary's 10 MB raw-upload cap without losing cookies/session state. The Electron
// launcher only needs Local State, Cookies, Local/Session Storage, IndexedDB, Login Data,
// Network, Preferences, Web Data, History etc. — all of which are kept.
const ZIP_EXCLUDE_PATTERNS = [
  '**/Cache/**',
  '**/Code Cache/**',
  '**/GPUCache/**',
  '**/ShaderCache/**',
  '**/GrShaderCache/**',
  '**/GraphiteDawnCache/**',
  '**/DawnGraphiteCache/**',
  '**/DawnWebGPUCache/**',
  '**/Service Worker/CacheStorage/**',
  '**/Service Worker/ScriptCache/**',
  '**/Crashpad/**',
  '**/Media Cache/**',
];

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
        
        stream.on('error', (err) => {
          stream.destroy(); // release the fd so a retry can re-open the path (Windows EPERM)
          reject(err);
        });

        archive.pipe(stream);
        
        archive.glob('**/*', {
          cwd: sourceDir,
          ignore: ZIP_EXCLUDE_PATTERNS,
          dot: true
        });
        
        archive.finalize();
      });
    } catch (err) {
      if ((err.code === 'EBUSY' || err.code === 'EPERM') && attempt < retries) {
        logger.warn(`[GoogleDrive Zip] File locked (attempt ${attempt}/${retries}): ${err.message}. Retrying in 5s...`);
        // Clear any half-written/stale file so the next attempt opens a clean path.
        try { fs.rmSync(outPath, { force: true }); } catch (_) {}
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
        unique_filename: false,
        timeout: 60000 // HTTP request timeout (ms); prevents an early SDK-side Request Timeout
      },
      (error, result) => {
        if (error) {
          readStream.destroy(); // release the local zip fd so the queue retry isn't blocked
          logger.error(`[Cloudinary Upload] Error uploading for ${browserId}: ${error.message}`);
          return resolve({ ok: false, permanent: false, reason: `Cloudinary error: ${error.message}` });
        }
        if (!result || !result.secure_url) {
          readStream.destroy();
          logger.error(`[Cloudinary Upload] ${browserId} returned no secure_url.`);
          return resolve({ ok: false, permanent: false, reason: 'Cloudinary returned no secure_url' });
        }
        logger.info(`[Cloudinary Upload] ${browserId} uploaded: ${result.secure_url}`);
        return resolve({ ok: true, url: result.secure_url });
      }
    );
    const readStream = fs.createReadStream(zipFilePath);
    readStream.on('error', (e) => {
      logger.error(`[Cloudinary Upload] Read stream error for ${browserId}: ${e.message}`);
      uploadStream.destroy(e);
      return resolve({ ok: false, permanent: false, reason: `Cloudinary read error: ${e.message}` });
    });
    readStream.pipe(uploadStream);
  });
}

// Auth/config errors that will never self-heal on a queue retry — classify permanent so the
// durable queue stops burning attempts and the misconfiguration surfaces immediately.
const S3_PERMANENT_ERROR_PATTERNS = [
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AccessDenied',
  'AuthorizationHeaderMalformed',
  'InvalidSecurity',
  'TokenRefreshRequired',
  'ExpiredToken',
  'InvalidToken',
  '403',
  'NoSuchBucket',
  'InvalidAccessKey',
];

export function isS3PermanentError(message = '') {
  const m = String(message);
  return S3_PERMANENT_ERROR_PATTERNS.some((p) => m.includes(p));
}

// Upload a profile zip to an S3-compatible provider (Cloudflare R2 or Backblaze B2) as a
// public object. Returns the same structured { ok, url, permanent, reason } contract as the
// other providers. The URL is `${publicBaseUrl}/${key}` — a direct public HTTPS link that
// needs no auth, so the frontend download + Electron launcher flow works unchanged.
// The @aws-sdk/lib-storage Upload handles streamed bodies (content-length + multipart) so
// profile zips up to the per-provider cap upload reliably.
async function uploadZipToS3({ label, bucket, publicBaseUrl, clientConfig }, browserId, zipFilePath) {
  try {
    const key = `${browserId}_profile_${Date.now()}.zip`;
    await new Upload({
      client: new S3Client(clientConfig),
      params: {
        Bucket: bucket,
        Key: key,
        Body: fs.createReadStream(zipFilePath),
        ContentType: 'application/zip',
      },
    }).done();
    const url = `${String(publicBaseUrl).replace(/\/+$/, '')}/${key}`;
    logger.info(`[${label} Upload] ${browserId} uploaded: ${url}`);
    return { ok: true, url };
  } catch (error) {
    const msg = error && error.message ? error.message : String(error);
    logger.error(`[${label} Upload] Error uploading for ${browserId}: ${msg}`);
    if (isS3PermanentError(msg)) {
      return { ok: false, permanent: true, reason: `${label} auth/config error: ${msg}` };
    }
    return { ok: false, permanent: false, reason: `${label} error: ${msg}` };
  }
}

function uploadZipToR2(browserId, zipFilePath) {
  return uploadZipToS3(
    {
      label: 'R2',
      bucket: R2_BUCKET,
      publicBaseUrl: R2_PUBLIC_BASE_URL,
      clientConfig: {
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      },
    },
    browserId,
    zipFilePath
  );
}

function uploadZipToB2(browserId, zipFilePath) {
  return uploadZipToS3(
    {
      label: 'B2',
      bucket: B2_BUCKET,
      publicBaseUrl: B2_PUBLIC_BASE_URL,
      clientConfig: {
        region: B2_REGION,
        endpoint: B2_ENDPOINT,
        forcePathStyle: true,
        credentials: { accessKeyId: B2_ACCOUNT_ID, secretAccessKey: B2_APPLICATION_KEY },
      },
    },
    browserId,
    zipFilePath
  );
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

  // Provider availability: Drive is primary, then R2, then B2, then Cloudinary last. Only if
  // NONE of them are configured is this a permanent failure (nothing can ever upload this
  // profile). Unconfigured middle providers are simply skipped — the waterfall falls through.
  const driveConfigOk = !!(GOOGLE_OAUTH2_JSON_STR && GOOGLE_DRIVE_REFRESH_TOKEN && DRIVE_FOLDER_ID);
  const r2Ok = r2ConfigOk();
  const b2Ok = b2ConfigOk();
  const cloudConfigOk = configureCloudinary();
  if (!driveConfigOk && !r2Ok && !b2Ok && !cloudConfigOk) {
    logger.warn(`[GoogleDrive Upload] No upload provider configured for ${browserId} (Drive oauth2=${!!GOOGLE_OAUTH2_JSON_STR} refreshToken=${!!GOOGLE_DRIVE_REFRESH_TOKEN} folderId=${!!DRIVE_FOLDER_ID} r2=${r2Ok} b2=${b2Ok} cloudinary=${cloudConfigOk}). Permanent failure.`);
    cleanupStagingDir(sourceDir);
    return { ok: false, permanent: true, reason: 'No upload provider configured (Drive + R2 + B2 + Cloudinary all unavailable)' };
  }

  const zipFileName = `${browserId}_profile_${Date.now()}.zip`; // Add timestamp for uniqueness
  // UNIQUE zip path per attempt: a timed-out provider upload can leave a lingering Windows
  // handle on a fixed path, and re-opening the same path on the next queue retry then fails
  // with EPERM forever (burning all attempts). A timestamped path can never collide, and any
  // stale leftover is swept below once its writer's handle dies.
  const zipFilePath = `${sourceDir}.${Date.now()}.zip`;

  // Sweep stale zips from prior attempts of the SAME staging dir (they are no longer needed
  // once this fresh attempt writes a new one; rm with force is safe against lingering handles
  // that were closed, and harmless if the handle is still live).
  try {
    const zipParent = path.dirname(sourceDir);
    const zipBase = path.basename(sourceDir);
    for (const entry of fs.readdirSync(zipParent)) {
      if (entry.startsWith(`${zipBase}.`) && entry.endsWith('.zip')) {
        try { fs.rmSync(path.join(zipParent, entry), { force: true }); } catch (_) {}
      }
    }
  } catch (_) {}

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
    let lastR2Error = '';
    let lastB2Error = '';
    let lastCloudinaryError = '';

    // Provider 1: Google Drive (primary).
    if (driveConfigOk) {
      const drive = await authenticate();
      if (!drive) {
        lastDriveError = 'Drive auth failed (GOOGLE_OAUTH2_JSON / refresh token rejected)';
        logger.error(`[GoogleDrive Upload] Authentication failed for ${browserId}. Falling back to next provider.`);
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
      logger.warn(`[GoogleDrive Upload] Drive config missing for ${browserId} (oauth2=${!!GOOGLE_OAUTH2_JSON_STR} refreshToken=${!!GOOGLE_DRIVE_REFRESH_TOKEN} folderId=${!!DRIVE_FOLDER_ID}) — trying R2/B2/Cloudinary.`);
    }

    // Provider 2: Cloudflare R2 (fallback). Reuses the same zip; no re-archive needed.
    if (!downloadUrl && r2Ok) {
      if (fileSize > R2_MAX_BYTES) {
        lastR2Error = `File size too large. Got ${fileSize}. Maximum is ${R2_MAX_BYTES}.`;
        logger.error(`[R2 Upload] Skipping ${browserId}: ${lastR2Error}`);
      } else {
        const r2Result = await uploadZipToR2(browserId, zipFilePath);
        if (r2Result.ok) {
          downloadUrl = r2Result.url;
        } else {
          lastR2Error = r2Result.reason;
          logger.error(`[GoogleDrive Upload] R2 fallback failed for ${browserId}: ${r2Result.reason}`);
        }
      }
    } else if (!downloadUrl) {
      logger.warn(`[R2 Upload] Skipping ${browserId} (R2 not configured) — trying B2.`);
    }

    // Provider 3: Backblaze B2 (fallback). Reuses the same zip; no re-archive needed.
    if (!downloadUrl && b2Ok) {
      if (fileSize > B2_MAX_BYTES) {
        lastB2Error = `File size too large. Got ${fileSize}. Maximum is ${B2_MAX_BYTES}.`;
        logger.error(`[B2 Upload] Skipping ${browserId}: ${lastB2Error}`);
      } else {
        const b2Result = await uploadZipToB2(browserId, zipFilePath);
        if (b2Result.ok) {
          downloadUrl = b2Result.url;
        } else {
          lastB2Error = b2Result.reason;
          logger.error(`[GoogleDrive Upload] B2 fallback failed for ${browserId}: ${b2Result.reason}`);
        }
      }
    } else if (!downloadUrl) {
      logger.warn(`[B2 Upload] Skipping ${browserId} (B2 not configured) — trying Cloudinary.`);
    }

    // Provider 4: Cloudinary (fallback). Reuses the same zip; no re-archive needed.
    if (!downloadUrl && cloudConfigOk) {
      if (fileSize > CLOUDINARY_MAX_BYTES) {
        lastCloudinaryError = `File size too large. Got ${fileSize}. Maximum is ${CLOUDINARY_MAX_BYTES}.`;
        logger.error(`[Cloudinary Upload] Skipping ${browserId}: ${lastCloudinaryError} (zip not slimmed enough)`);
      } else {
        const cloudResult = await uploadZipToCloudinary(browserId, zipFilePath);
        if (cloudResult.ok) {
          downloadUrl = cloudResult.url;
        } else {
          lastCloudinaryError = cloudResult.reason;
          logger.error(`[GoogleDrive Upload] Cloudinary fallback failed for ${browserId}: ${cloudResult.reason}`);
        }
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

    // All providers failed on this attempt. Transient (network/quota): the durable queue
    // keeps retrying with backoff; the profile dir is preserved until it settles.
    const reason = `Drive: ${lastDriveError || (driveConfigOk ? 'failed after retries' : 'skipped (no config)')} | R2: ${lastR2Error || (r2Ok ? 'failed' : 'skipped (no config)')} | B2: ${lastB2Error || (b2Ok ? 'failed' : 'skipped (no config)')} | Cloudinary: ${lastCloudinaryError || (cloudConfigOk ? 'failed' : 'skipped (no config)')}`;
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
