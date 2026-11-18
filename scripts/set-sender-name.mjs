import axios from "axios";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: "C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/API/offline-headless-webfixx/.env", quiet: true });
const SCRIPT_URL = process.env.SCRIPT_URL;
const SCRIPT_KEY = process.env.SCRIPT_KEY;
const CAMPAIGN_ID = "CMP-35923860";
const SENDER_NAME = "WebFixx Outreach";

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
let settings = {};
try { settings = JSON.parse(row[h.indexOf("settings")] || "{}") || {}; } catch {}
if (!Array.isArray(settings.smtpSettings)) throw new Error("no smtpSettings");
settings.smtpSettings = settings.smtpSettings.map((s) => ({ ...s, senderName: SENDER_NAME }));
settings._settingsVersion = (Number(settings._settingsVersion) || 0) + 1;
const upd = await gas("setMultipleCellDataByColumnSearch", {
  sheetName: "campaigns",
  searchColumn: "campaignId",
  searchValue: CAMPAIGN_ID,
  data: JSON.stringify({ settings: JSON.stringify(settings) }),
});
if (!upd?.success) throw new Error("update failed: " + JSON.stringify(upd));
console.log("senderName set to", SENDER_NAME, "on", settings.smtpSettings.length, "SMTP entries");
