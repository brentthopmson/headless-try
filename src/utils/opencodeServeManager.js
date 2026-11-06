import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import axios from "axios";
import net from "net";

const LOG_FILE = path.resolve(process.cwd(), "opencode-serve.log");

let synced = false;

function hasBinary(bin) {
  try {
    const check = process.platform === "win32" ? "where " + bin : "which " + bin;
    const { execSync } = require("child_process");
    execSync(check, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => { resolve(false); });
    socket.connect(port, "127.0.0.1");
  });
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

function getGasConfig() {
  const url = process.env.SCRIPT_URL || "";
  const key = process.env.SCRIPT_KEY || "";
  return { url: url.trim().replace(/\/+$/, ""), key: key.trim() };
}

async function syncPasswordToAiSettings(password) {
  if (!password || synced) return;
  const { url, key } = getGasConfig();
  if (!url || !key) {
    console.warn("[opencode-serve] Missing SCRIPT_URL or SCRIPT_KEY in env");
    return;
  }

  try {
    const params = new URLSearchParams({
      action: "setMultipleCellDataByColumnSearch",
      sheetName: "SETTINGS",
      searchColumn: "aiProvider",
      searchValue: "opencode",
      key: key,
      data: JSON.stringify({ aiKey: password }),
    });

    const res = await axios.post(url, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    if (res.data && res.data.success) {
      console.log("[opencode-serve] Password synced to SETTINGS.aiKey -> OK (row " + res.data.rowNumber + ")");
      synced = true;
    } else {
      console.warn("[opencode-serve] Password sync failed: " + (res.data && res.data.error || "unknown"));
    }
  } catch (e) {
    console.warn("[opencode-serve] password sync skipped:", e.message);
  }
}

function watchForPassword() {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (synced) {
        clearInterval(interval);
        resolve();
        return;
      }
      const pwd = getPasswordFromLog();
      if (pwd) {
        syncPasswordToAiSettings(pwd).then(() => {
          if (synced) {
            clearInterval(interval);
            resolve();
          }
        });
      }
    }, 2000);

    setTimeout(() => {
      if (!synced) {
        clearInterval(interval);
        resolve();
      }
    }, 60000);
  });
}

export async function startOpencodeServe() {
  try {
    const envPwd = (process.env.OPENCODE_SERVER_PASSWORD || "").trim();
    if (envPwd) {
      console.log("[opencode-serve] Using OPENCODE_SERVER_PASSWORD from env");
      await syncPasswordToAiSettings(envPwd);
    }

    const alreadyRunning = await isPortInUse(4096);
    if (alreadyRunning) {
      console.log("[opencode-serve] opencode serve already running on port 4096");
      if (!envPwd) await watchForPassword();
      return;
    }

    const bin = process.platform === "win32" ? "opencode.cmd" : "opencode";
    const hasBin = hasBinary(bin.replace(".cmd", ""));
    if (!hasBin) {
      console.warn("[opencode-serve] opencode not found in PATH. Skipping auto-start.");
      return;
    }

    if (fs.existsSync(LOG_FILE)) {
      try { fs.unlinkSync(LOG_FILE); } catch {}
    }

    console.log("[opencode-serve] Starting opencode serve on http://127.0.0.1:4096");

    const proc = spawn(bin, ["serve", "--hostname", "127.0.0.1", "--port", "4096"], {
      cwd: process.cwd(),
      shell: true,
      stdio: "pipe",
      env: Object.assign({}, process.env, { OPENCODE_SERVER_PASSWORD: envPwd || "" }),
    });

    const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);

    proc.on("error", (err) => {
      console.warn("[opencode-serve] Failed to spawn:", err.message);
    });

    proc.on("close", (code) => {
      if (code && code !== 0) {
        console.warn("[opencode-serve] Exited with code " + code);
      }
      synced = false;
    });

    if (!envPwd) await watchForPassword();
    console.log("[opencode-serve] Startup complete");
  } catch (e) {
    console.warn("[opencode-serve] Skipping due to error:", e.message);
  }
}
