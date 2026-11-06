import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { syncOpencodeRowForServer, getServerlessId } from "./opencodeSettings.js";

const LOG_FILE = path.resolve(process.cwd(), "cloudflared.log");

function hasBinary(bin) {
  try {
    const check = process.platform === "win32" ? "where " + bin : "which " + bin;
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isCloudflaredRunning() {
  try {
    const check = process.platform === "win32"
      ? 'tasklist /FI "IMAGENAME eq cloudflared.exe" /NH'
      : "pgrep -x cloudflared";
    const out = execSync(check, { stdio: "pipe" }).toString();
    return process.platform === "win32"
      ? out.toLowerCase().includes("cloudflared.exe")
      : out.trim().length > 0;
  } catch {
    return false;
  }
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
  const url = process.env.SCRIPT_URL || "";
  const key = process.env.SCRIPT_KEY || "";
  return { url: url.trim().replace(/\/+$/, ""), key: key.trim() };
}

async function syncOpencodeFromSheet() {
  try {
    const { url, key } = getGasConfig();
    if (!url || !key) {
      console.warn("[opencode-tunnel] Missing SCRIPT_URL or SCRIPT_KEY in env");
      return;
    }

    const baseUrl = getTryCfUrl();
    if (!baseUrl) {
      console.warn("[opencode-tunnel] No trycloudflare URL found in cloudflared.log yet");
      return;
    }

    const serverlessId = getServerlessId();
    // Sync to the opencode row matching this server (aiSeverlessId/aiServerlessId==SERVERLESS_ID),
    // resolved to aiSn for GAS single-column update. Never touches another server's row.
    const r = await syncOpencodeRowForServer(
      { aiBaseUrl: baseUrl, aiStatus: "ACTIVE" },
      { scriptUrl: url, scriptKey: key, serverlessId, label: "opencode-tunnel" }
    );
    if (!r.ok) {
      console.warn(`[opencode-tunnel] Sync skipped for SERVERLESS_ID='${serverlessId || "(unset)"}': ${r.error || "unknown"} (set aiSeverlessId/aiServerlessId on this server's opencode row)`);
    }
  } catch (e) {
    console.warn("[opencode-tunnel] sync skipped:", e.message);
  }
}

function waitForTunnelUrl() {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      const url = getTryCfUrl();
      if (url) {
        clearInterval(interval);
        resolve(url);
      }
    }, 2000);

    setTimeout(() => {
      clearInterval(interval);
      resolve(getTryCfUrl());
    }, 60000);
  });
}

export async function startOpencodeQuickTunnel() {
  try {
    if (!hasBinary("cloudflared")) {
      console.warn("[opencode-tunnel] cloudflared not found in PATH. Skipping tunnel auto-start.");
      return;
    }

    const alreadyRunning = isCloudflaredRunning();
    if (!alreadyRunning) {
      if (fs.existsSync(LOG_FILE)) {
        try { fs.unlinkSync(LOG_FILE); } catch {}
      }

      console.log("[opencode-tunnel] Starting cloudflared quick tunnel -> http://127.0.0.1:4096");

      const proc = spawn("cloudflared", ["tunnel", "--url", "http://127.0.0.1:4096", "--logfile", LOG_FILE, "--loglevel", "info"], {
        cwd: process.cwd(),
        shell: true,
        stdio: "ignore",
      });

      proc.on("error", (err) => {
        console.warn("[opencode-tunnel] Failed to spawn cloudflared:", err.message);
      });
    } else {
      console.log("[opencode-tunnel] cloudflared already running");
    }

    // Wait for tunnel URL to appear in log, then sync
    console.log("[opencode-tunnel] Waiting for tunnel URL...");
    const url = await waitForTunnelUrl();
    if (url) {
      console.log("[opencode-tunnel] Found tunnel URL: " + url);
      await syncOpencodeFromSheet();
    } else {
      console.warn("[opencode-tunnel] No tunnel URL found after 60s");
    }

    // Re-sync every 5 minutes
    setInterval(() => syncOpencodeFromSheet(), 5 * 60 * 1000);
    console.log("[opencode-tunnel] Startup complete");
  } catch (e) {
    console.warn("[opencode-tunnel] Skipping due to error:", e.message);
  }
}
