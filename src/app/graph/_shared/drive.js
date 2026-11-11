import { createOrUpdateJsonFile, getJsonContentFromFile, getOrCreateUserFolder } from "../../api/googledrive.mjs";
import logger from "../../../utils/logger.js";
import axios from 'axios';

// Drive helpers for graph index files (one-time dump).

export async function uploadGraphIndex(userId, deviceId, indexJson) {
  // Primary: OAuth Drive
  try {
    const folder = await getOrCreateUserFolder(userId, process.env.GRAPH_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID);
    const folderId = folder?.folderId || folder?.id;
    const fileName = `graphIndex_${deviceId}.json`;
    const res = await createOrUpdateJsonFile(folderId, fileName, indexJson);
    return { success: true, fileId: res?.fileId || res?.id, url: res?.webViewLink || res?.url };
  } catch (e) {
    logger.warn(`[graph/drive] OAuth upload failed: ${e.message}. Trying App Script fallback.`);
  }
  // Fallback: Apps Script Drive (runs under script owner identity)
  try {
    const appScriptUrl = process.env.SCRIPT_URL;
    const appScriptKey = process.env.SCRIPT_KEY;
    if (appScriptUrl && appScriptKey) {
      const url = new URL(appScriptUrl);
      url.searchParams.set('action', 'saveResponseToDrive');
      url.searchParams.set('key', appScriptKey);
      const resp = await axios.post(url.toString(), { projectId: deviceId, userId, data: JSON.parse(indexJson) }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000 });
      if (resp.data?.success) {
        return { success: true, fileId: resp.data.fileId, url: resp.data.fileUrl };
      }
    }
  } catch (e) {
    logger.error(`[graph/drive] App Script fallback failed: ${e.message}`);
  }
  return { success: false, error: 'upload failed' };
}

export async function downloadGraphIndex(fileId) {
  try {
    const content = await getJsonContentFromFile(fileId);
    return { success: true, content };
  } catch (e) {
    logger.error(`[graph/drive] download failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}