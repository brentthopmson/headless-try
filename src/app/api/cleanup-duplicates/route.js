import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { authenticate, getJsonContentFromFile } from "../googledrive.mjs";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * POST /api/cleanup-duplicates
 * Scans all user folders under USERS_FOLDER_ID for duplicate response files,
 * merges them by submissionId (keeping latest timestamp), deletes extras,
 * and optionally updates the projects sheet with correct fileIds.
 *
 * Body: { dryRun?: boolean } — if true, reports findings without modifying anything.
 */
export async function POST(request) {
  const USERS_FOLDER_ID = process.env.USERS_FOLDER_ID;
  if (!USERS_FOLDER_ID) {
    return NextResponse.json({ success: false, error: "USERS_FOLDER_ID not configured" }, { status: 500 });
  }

  let body = {};
  try { body = await request.json(); } catch (_) {}
  const dryRun = body.dryRun === true;

  try {
    const drive = await authenticate();
    if (!drive) {
      return NextResponse.json({ success: false, error: "Drive authentication failed" }, { status: 500 });
    }

    // 1. List all user folders under USERS_FOLDER_ID
    const userFolders = await listAllFiles(drive, USERS_FOLDER_ID, "application/vnd.google-apps.folder");
    logger.info(`[cleanup-duplicates] Found ${userFolders.length} user folders`);

    const report = {
      scanned: 0,
      duplicatesFound: 0,
      merged: 0,
      deletedFiles: 0,
      errors: [],
      details: [],
    };

    for (const userFolder of userFolders) {
      // 2. List all project subfolders within each user folder
      const projectFolders = await listAllFiles(drive, userFolder.id, "application/vnd.google-apps.folder");

      for (const projectFolder of projectFolders) {
        report.scanned++;

        // 3. List all files in the project folder
        const files = await listAllFiles(drive, projectFolder.id, "text/plain");

        // Group files by name
        const filesByName = new Map();
        for (const file of files) {
          const existing = filesByName.get(file.name) || [];
          existing.push(file);
          filesByName.set(file.name, existing);
        }

        // 4. Check for duplicates
        for (const [name, fileGroup] of filesByName) {
          if (fileGroup.length <= 1) continue;

          report.duplicatesFound++;
          logger.warn(`[cleanup-duplicates] Found ${fileGroup.length} duplicate files named "${name}" in folder ${projectFolder.name}`);

          if (dryRun) {
            report.details.push({
              userFolder: userFolder.name,
              projectFolder: projectFolder.name,
              fileName: name,
              duplicateCount: fileGroup.length,
              fileIds: fileGroup.map(f => f.id),
            });
            continue;
          }

          // 5. Fetch all file contents
          const allResponses = [];
          for (const file of fileGroup) {
            try {
              const result = await getJsonContentFromFile(file.id);
              if (result.success && Array.isArray(result.data)) {
                allResponses.push(...result.data);
              } else if (result.success && result.data && typeof result.data === "object") {
                allResponses.push(result.data);
              }
            } catch (e) {
              logger.warn(`[cleanup-duplicates] Failed to read file ${file.id}: ${e.message}`);
              report.errors.push(`Read failed for ${file.id}: ${e.message}`);
            }
          }

          // 6. Merge: deduplicate by submissionId, keep latest timestamp
          const mergedMap = new Map();
          for (const entry of allResponses) {
            const key = entry.submissionId || entry.id || JSON.stringify(entry);
            const existing = mergedMap.get(key);
            if (!existing || new Date(entry.timestamp || 0) > new Date(existing.timestamp || 0)) {
              mergedMap.set(key, entry);
            }
          }
          const mergedResponses = Array.from(mergedMap.values());

          // 7. Write merged content to the oldest file, delete the rest
          const sorted = [...fileGroup].sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
          const keepFile = sorted[0];

          try {
            await drive.files.update({
              fileId: keepFile.id,
              media: { mimeType: "text/plain", body: JSON.stringify(mergedResponses, null, 2) },
              supportsAllDrives: true,
            });
            report.merged++;
            logger.info(`[cleanup-duplicates] Merged ${allResponses.length} responses into ${mergedResponses.length} unique entries in ${keepFile.id}`);
          } catch (e) {
            report.errors.push(`Update failed for ${keepFile.id}: ${e.message}`);
            continue;
          }

          // 8. Delete duplicate files
          for (let i = 1; i < sorted.length; i++) {
            try {
              await drive.files.delete({ fileId: sorted[i].id, supportsAllDrives: true });
              report.deletedFiles++;
              logger.info(`[cleanup-duplicates] Deleted duplicate file ${sorted[i].id}`);
            } catch (e) {
              report.errors.push(`Delete failed for ${sorted[i].id}: ${e.message}`);
            }
          }

          report.details.push({
            userFolder: userFolder.name,
            projectFolder: projectFolder.name,
            fileName: name,
            duplicatesFound: fileGroup.length,
            keptFileId: keepFile.id,
            mergedEntries: mergedResponses.length,
            deletedCount: sorted.length - 1,
          });
        }
      }
    }

    logger.info(`[cleanup-duplicates] Complete: ${JSON.stringify({ scanned: report.scanned, duplicatesFound: report.duplicatesFound, merged: report.merged, deletedFiles: report.deletedFiles })}`);
    return NextResponse.json({ success: true, ...report });

  } catch (error) {
    logger.error(`[cleanup-duplicates] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

/**
 * Helper: list all files/folders in a parent folder with optional mimeType filter.
 */
async function listAllFiles(drive, parentId, mimeType) {
  const files = [];
  let pageToken = null;
  do {
    const q = `'${parentId}' in parents` + (mimeType ? ` and mimeType='${mimeType}'` : "");
    const response = await drive.files.list({
      q,
      fields: "nextPageToken, files(id, name, mimeType, createdTime)",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken: pageToken || undefined,
    });
    if (response.data.files) files.push(...response.data.files);
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return files;
}
