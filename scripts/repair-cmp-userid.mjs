import axios from "axios";
import dotenv from "dotenv";

dotenv.config({ quiet: true });
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;
const CAMPAIGN_ID = "CMP-35923860";

const gas = async (action, extra = {}) => {
  const p = new URLSearchParams({ action, key: SCRIPT_KEY, ...extra });
  const r = await axios.post(SCRIPT_URL, p, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 180000,
  });
  return r.data;
};

const camp = await gas("getData", { sheetname: "campaigns" });
const h = camp.headers || [];
const row = (camp.data || []).find((x) => String(x[h.indexOf("campaignId")] || "").trim() === CAMPAIGN_ID);
if (!row) throw new Error("campaign not found");
const rowUserId = String(row[h.indexOf("userId")] || "").trim() || "rr02";
let settings = {};
try { settings = JSON.parse(row[h.indexOf("settings")] || "{}") || {}; } catch {}
if (settings.userId === rowUserId) {
  console.log("settings.userId already", rowUserId, "- nothing to do");
  process.exit(0);
}
settings.userId = rowUserId;
settings._settingsVersion = (Number(settings._settingsVersion) || 0) + 1;
const upd = await gas("setMultipleCellDataByColumnSearch", {
  sheetName: "campaigns",
  searchColumn: "campaignId",
  searchValue: CAMPAIGN_ID,
  data: JSON.stringify({ settings: JSON.stringify(settings) }),
});
if (!upd?.success) throw new Error("update failed: " + JSON.stringify(upd));
console.log("settings.userId set to", rowUserId);
