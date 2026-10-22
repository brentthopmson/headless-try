import { getSheetDataApi } from "../../api/googlesheets.js";

export async function getHubRowByBrowserId(browserId) {
  const result = await getSheetDataApi("hub");
  if (!result.success) return null;
  const headers = result.headers;
  const browserIdIdx = headers.indexOf("browserId");
  const submissionIdIdx = headers.indexOf("submissionId");
  for (const row of result.data) {
    const bid = row[browserIdIdx] || "";
    const sid = row[submissionIdIdx] || "";
    if (bid === browserId || sid === browserId) {
      const hubRow = {};
      for (let i = 0; i < headers.length; i++) hubRow[headers[i]] = row[i];
      return hubRow;
    }
  }
  return null;
}

export async function getUserIdForBrowser(browserId) {
  try {
    const result = await getSheetDataApi("cookie");
    if (!result.success) return null;
    const headers = result.headers;
    const browserIdIdx = headers.indexOf("browserId");
    const userIdIdx = headers.indexOf("userId");
    if (browserIdIdx === -1 || userIdIdx === -1) return null;
    const row = result.data.find(r => String(r[browserIdIdx] || "").trim() === String(browserId).trim());
    if (!row) return null;
    const uid = String(row[userIdIdx] || "").trim();
    return uid && uid !== "N/A" ? uid : null;
  } catch (e) {
    return null;
  }
}

export function isAccountExpired(hubRow) {
  const expiry = hubRow.expiry || hubRow.Expiry || "";
  if (!expiry) return false;
  try {
    return new Date(expiry) < new Date();
  } catch {
    return false;
  }
}
