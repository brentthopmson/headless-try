import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import { getSetting } from "./settingsCache.js";

const LOG_FILE = path.resolve(process.cwd(), "cloudflared.log");

function hasBinary(bin) {
  try {
    const check = process.platform === "win32" ? `where ${bin}` : `which ${bin}`;
    const { execSync } = require("child_process");
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function getTryCfUrl() {
  try {
    if (!fs.existsSync(LOG_FILE)) return null;
    const log = fs.readFileSync(LOG_FILE, "utf8");
    const matches = [...log.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)];
    if (matches.length === 0) return null;
    return matches[matches.length - 1][0].replace(/\/$/, "");
  } catch {
    return null;
  }
}

function postToGas(url, payload) {
  return new Promise((resolve, reject) => {
    try {
      const data = JSON.stringify(payload);
      const u = new URL(url);
      const req = https.request(
        {
          hostname: u.hostname,
          path: u.pathname + u.search,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          },
          timeout: 15000,
        },
        (res) => {
          let body = "";
          res.on("data", (d) => (body += d));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.write(data);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function syncOpencodeFromSheet() {
  try {
    const [scriptUrl, pass, secret] = await Promise.all([
      getSetting("SCRIPT_EXEC_URL"),
      getSetting("OPENCODE_SERVER_PASSWORD"),
      getSetting("OPENCODE_SYNC_SECRET"),
    ]);

    const syncUrl = scriptUrl?.value1 || scriptUrl?.value2;
    const password = pass?.value1 || pass?.value2;
    const syncSecret = secret?.value1 || secret?.value2;

    if (!syncUrl || !syncSecret) {
      return;
    }

    const baseUrl = getTryCfUrl();
    if (!baseUrl) {
      return;
    }

    if (!password) {
      console.warn("[opencode-tunnel] Waiting for OPENCODE_SERVER_PASSWORD in SETTINGS or password in AI_SETTINGS");
    }

    const res = await postToGas(syncUrl, {
      action: "syncOpencodeTunnelToAi",
      secret: syncSecret,
      password: password || "",
      baseUrl,
      provider: "opencode",
    });

    console.log(`[opencode-tunnel] Synced ${baseUrl} -> ${res.status}`);
  } catch (e) {
    console.warn("[opencode-tunnel] sync skipped:", e.message);
  }
}

export function startOpencodeQuickTunnel() {
  try {
    if (!hasBinary("cloudflared")) {
      console.warn("[opencode-tunnel] 'cloudflared' not found in PATH. Skipping tunnel auto-start.");
      return;
    }

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

    setTimeout(() => syncOpencodeFromSheet(), 20000);
    setInterval(() => syncOpencodeFromSheet(), 5 * 60 * 1000);
  } catch (e) {
    console.warn("[opencode-tunnel] Skipping due to error:", e.message);
  }
}
