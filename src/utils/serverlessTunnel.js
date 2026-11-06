import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";
import { execSync } from "child_process";

const LOG_FILE = path.resolve(process.cwd(), "serverless-cloudflared.log");

function hasBinary(bin) {
  try {
    const check = process.platform === "win32" ? "where " + bin : "which " + bin;
    execSync(check, { stdio: "ignore" });
    return true;
  } catch { return false; }
}

function getTryCfUrl() {
  try {
    if (!fs.existsSync(LOG_FILE)) return null;
    const log = fs.readFileSync(LOG_FILE, "utf8");
    const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
    const valid = [];
    for (const line of log.split(/\r?\n/)) {
      if (/OPENCODE_TUNNEL_URL|Environmental variables/i.test(line)) continue;
      let m;
      while ((m = re.exec(line)) !== null) valid.push(m[0].replace(/\/$/, ""));
      re.lastIndex = 0;
    }
    return valid.length ? valid[valid.length - 1] : null;
  } catch { return null; }
}

function getGasConfig() {
  return { url: (process.env.SCRIPT_URL || "").trim().replace(/\/+$/, ""), key: (process.env.SCRIPT_KEY || "").trim() };
}

async function syncServerlessUrl() {
  try {
    const { url, key } = getGasConfig();
    if (!url || !key) { console.warn("[serverless-tunnel] Missing SCRIPT_URL or SCRIPT_KEY"); return; }
    const baseUrl = getTryCfUrl();
    if (!baseUrl) { console.warn("[serverless-tunnel] No trycloudflare URL found yet"); return; }
    const serverlessId = (process.env.SERVERLESS_ID || "serverless4").trim();
    const params = new URLSearchParams({
      action: "setMultipleCellDataByColumnSearch",
      sheetName: "links",
      searchColumn: "severlessId",
      searchValue: serverlessId,
      key,
      data: JSON.stringify({ severlessURL: baseUrl + "/", severlessStatus: "ACTIVE" }),
    });
    const res = await axios.post(url, params, { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 30000 });
    if (res.data && res.data.success) {
      console.log(`[serverless-tunnel] Synced ${baseUrl} -> links.${serverlessId} (severlessId) row ${res.data.rowNumber} OK`);
    } else {
      console.warn(`[serverless-tunnel] Sync failed: ${JSON.stringify(res.data)}`);
    }
  } catch (e) { console.warn("[serverless-tunnel] sync skipped:", e.message); }
}

function waitForTunnelUrl(ms = 90000) {
  return new Promise((resolve) => {
    const end = Date.now() + ms;
    const interval = setInterval(() => {
      const url = getTryCfUrl();
      if (url || Date.now() > end) { clearInterval(interval); resolve(url || getTryCfUrl()); }
    }, 2000);
  });
}

export async function startServerlessTunnel() {
  try {
    if (!hasBinary("cloudflared")) { console.warn("[serverless-tunnel] cloudflared not found. Skipping."); return; }
    // Use existing URL if already present (e.g. launcher started tunnel)
    let url = getTryCfUrl();
    if (!url) {
      console.log(`[serverless-tunnel] Starting cloudflared tunnel -> http://127.0.0.1:3001 (SERVERLESS_ID=${process.env.SERVERLESS_ID || "serverless4"})`);
      const proc = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:3001", "--logfile", LOG_FILE, "--loglevel", "info"], {
        cwd: process.cwd(), shell: true, stdio: "ignore",
      });
      proc.on("error", (err) => console.warn("[serverless-tunnel] spawn error:", err.message));
      console.log("[serverless-tunnel] Waiting for tunnel URL...");
      url = await waitForTunnelUrl();
    }
    if (url) {
      console.log("[serverless-tunnel] Found tunnel URL: " + url);
      await syncServerlessUrl();
    } else {
      console.warn("[serverless-tunnel] No tunnel URL found after timeout");
    }
    setInterval(() => syncServerlessUrl(), 5 * 60 * 1000);
  } catch (e) { console.warn("[serverless-tunnel] Skipping:", e.message); }
}
