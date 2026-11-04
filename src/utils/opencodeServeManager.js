import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import https from "https";
import { getSetting } from "./settingsCache.js";

const LOG_FILE = path.resolve(process.cwd(), "opencode-serve.log");

let synced = false;

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

function getPasswordFromLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return null;
    const log = fs.readFileSync(LOG_FILE, "utf8");
    const patterns = [
      /password[:\s]+([A-Za-z0-9\-\_]+)/i,
      /Basic auth[^\n]*password[:\s]+([A-Za-z0-9\-\_]+)/i,
      /opencode[^\n]*password[:\s]+([A-Za-z0-9\-\_]+)/i,
    ];
    for (const re of patterns) {
      const m = log.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return null;
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

async function syncPasswordToAiSettings(password) {
  if (!password || synced) return;
  try {
    const [scriptUrl, secret] = await Promise.all([
      getSetting("SCRIPT_EXEC_URL"),
      getSetting("OPENCODE_SYNC_SECRET"),
    ]);

    const syncUrl = scriptUrl?.value1 || scriptUrl?.value2;
    const syncSecret = secret?.value1 || secret?.value2;

    if (!syncUrl || !syncSecret) {
      console.warn("[opencode-serve] Missing SCRIPT_EXEC_URL or OPENCODE_SYNC_SECRET in SETTINGS");
      return;
    }

    const res = await postToGas(syncUrl, {
      action: "syncOpencodePasswordToAi",
      secret: syncSecret,
      password,
      provider: "opencode",
    });

    console.log(`[opencode-serve] Password synced to AI_SETTINGS.aiKey -> ${res.status}`);
    synced = true;
  } catch (e) {
    console.warn("[opencode-serve] password sync skipped:", e.message);
  }
}

function watchForPassword() {
  const interval = setInterval(() => {
    if (synced) {
      clearInterval(interval);
      return;
    }
    const pwd = getPasswordFromLog();
    if (pwd) {
      syncPasswordToAiSettings(pwd);
    }
  }, 2000);

  setTimeout(() => {
    if (!synced) clearInterval(interval);
  }, 120000);
}

export function startOpencodeServe() {
  try {
    if (!hasBinary("opencode")) {
      console.warn("[opencode-serve] 'opencode' not found in PATH. Skipping auto-start.");
      return;
    }

    if (fs.existsSync(LOG_FILE)) {
      try { fs.unlinkSync(LOG_FILE); } catch {}
    }

    console.log("[opencode-serve] Starting opencode serve on http://127.0.0.1:4096 (let it generate password)");

    const proc = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
      cwd: process.cwd(),
      shell: true,
      stdio: "ignore",
    });

    const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    proc.stdout?.pipe?.(logStream);
    proc.stderr?.pipe?.(logStream);

    proc.on("error", (err) => {
      console.warn("[opencode-serve] Failed to spawn:", err.message);
    });

    proc.on("close", (code) => {
      if (code && code !== 0) {
        console.warn(`[opencode-serve] Exited with code ${code}`);
      }
      synced = false;
    });

    watchForPassword();
  } catch (e) {
    console.warn("[opencode-serve] Skipping due to error:", e.message);
  }
}
