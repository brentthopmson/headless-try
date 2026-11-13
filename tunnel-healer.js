const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');

// Load .env
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#][^=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const SERVERLESS_ID = (process.env.SERVERLESS_ID || 'serverless4').trim();
const OP_PORT = 4096;
const SL_PORT = 3001;
const CHECK_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';

function log(...args) { console.log('[tunnel-healer]', ...args); }

async function callGas(action, extraParams = {}) {
  const url = (process.env.SCRIPT_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SCRIPT_KEY || '').trim();
  if (!url || !key) { log('Missing SCRIPT_URL/SCRIPT_KEY'); return { success: false, error: 'missing_config' }; }
  const params = new URLSearchParams({ action, key });
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  try {
    const res = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 });
    return res.data || { success: false, error: 'empty_response' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function pingUrl(url, timeoutMs = 8000) {
  if (!url) return { ok: false, reason: 'no url' };
  const clean = url.replace(/\/+$/, '');
  try {
    const res = await axios.get(clean + '/api/serverless-self?ping=1', {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const code = res.status;
    const body = res.data || {};
    if (code >= 200 && code < 300 && (body.alive === true || body.checks !== undefined)) {
      return { ok: true, reason: 'reachable' };
    }
    if (code === 409 && (body.alive === true || body.checks !== undefined)) {
      return { ok: true, reason: 'reachable (409 host-mismatch but alive)' };
    }
    return { ok: false, reason: `HTTP ${code}` };
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

async function pingLocalhost(port) {
  return pingUrl(`http://localhost:${port}`, 5000);
}

async function getCurrentLinksUrl(serverlessId) {
  try {
    const res = await callGas('getData', { sheetname: 'links' });
    if (!res || !res.success || !res.data) return null;
    const headers = res.data.headers || [];
    const rows = res.data.rows || [];
    const idIdx = headers.indexOf('severlessId');
    const urlIdx = headers.indexOf('severlessURL');
    if (idIdx === -1 || urlIdx === -1) return null;
    const row = rows.find(r => String(r[idIdx] || '').trim() === String(serverlessId || '').trim());
    return row ? String(row[urlIdx] || '').trim() : null;
  } catch (e) {
    log('failed to read current links URL:', e.message);
    return null;
  }
}

function restartCloudflared(logFile, port) {
  return new Promise((resolve) => {
    log(`Restarting cloudflared for port ${port}...`);
    // Kill existing cloudflared processes for this port (best-effort)
    try {
      const { execSync } = require('child_process');
      if (process.platform === 'win32') {
        execSync(`taskkill /F /IM cloudflared.exe 2>nul`, { stdio: 'ignore' });
      } else {
        execSync(`pkill -f "cloudflared.*${port}" 2>/dev/null || true`, { stdio: 'ignore' });
      }
    } catch {}

    setTimeout(() => {
      const out = fs.openSync(logFile, 'a');
      const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${port}`], {
        detached: true,
        stdio: ['ignore', out, out],
      });
      proc.unref();
      log(`cloudflared spawned (PID ${proc.pid}) for port ${port}, logging to ${logFile}`);
      // Wait for URL to appear in log
      const end = Date.now() + 60000;
      const check = setInterval(() => {
        try {
          const log = fs.readFileSync(logFile, 'utf8');
          const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
          const matches = log.match(re);
          if (matches && matches.length > 0) {
            clearInterval(check);
            resolve(matches[matches.length - 1].replace(/\/$/, ''));
            return;
          }
        } catch {}
        if (Date.now() > end) {
          clearInterval(check);
          resolve(null);
        }
      }, 2000);
    }, 2000);
  });
}

async function syncUrlToSheet(serverlessId, newUrl) {
  const res = await callGas('setMultipleCellDataByColumnSearch', {
    sheetName: 'links',
    searchColumn: 'severlessId',
    searchValue: serverlessId,
    data: { severlessURL: newUrl + '/', severlessStatus: 'ACTIVE', severlessHealth: 'OK' },
  });
  if (res && res.success) {
    log(`Synced ${serverlessId} -> ${newUrl} (ACTIVE)`);
    return true;
  }
  log(`Failed to sync ${serverlessId}: ${JSON.stringify(res)}`);
  return false;
}

async function markServerFailed(serverlessId) {
  const res = await callGas('deactivateStaleLink', { url: null, status: 'FAILED', health: 'DOWN' });
  // deactivateStaleLink needs a URL, so instead update by serverlessId
  // We'll use setMultipleCellDataByColumnSearch via a GAS call
  // But GAS search is by column value; use severlessId as search
  const res2 = await callGas('setMultipleCellDataByColumnSearch', {
    sheetName: 'links',
    searchColumn: 'severlessId',
    searchValue: serverlessId,
    data: { severlessStatus: 'FAILED', severlessHealth: 'DOWN' },
  });
  if (res2 && res2.success) {
    log(`Marked ${serverlessId} as FAILED (localhost unreachable)`);
  } else {
    log(`Failed to mark ${serverlessId} as FAILED: ${JSON.stringify(res2)}`);
  }
}

async function healTunnel(serverlessId, port, logFile) {
  const currentUrl = await getCurrentLinksUrl(serverlessId);
  if (!currentUrl) {
    log(`No current URL for ${serverlessId} in links sheet`);
    return;
  }

  const cfPing = await pingUrl(currentUrl);
  if (cfPing.ok) {
    // Cloudflare tunnel is alive, nothing to do
    return;
  }

  log(`${serverlessId} Cloudflare tunnel dead (${cfPing.reason}): ${currentUrl}`);

  // Check if localhost is still alive
  const localPing = await pingLocalhost(port);
  if (!localPing.ok) {
    log(`${serverlessId} localhost:${port} also dead (${localPing.reason}) -> marking FAILED`);
    await markServerFailed(serverlessId);
    return;
  }

  log(`${serverlessId} localhost:${port} is alive -> healing Cloudflare tunnel`);

  // Restart cloudflared to get a new URL
  const newUrl = await restartCloudflared(logFile, port);
  if (!newUrl) {
    log(`${serverlessId} failed to get new cloudflared URL`);
    return;
  }

  // Verify the new URL works
  const verifyPing = await pingUrl(newUrl);
  if (!verifyPing.ok) {
    log(`${serverlessId} new URL not reachable yet: ${newUrl} (${verifyPing.reason}) — will retry next cycle`);
    // Still sync it — might need DNS propagation
  }

  // Sync new URL to links sheet
  await syncUrlToSheet(serverlessId, newUrl);

  // Migrate cookie stamps from old URL to new URL
  try {
    const mig = await callGas('migrateCookieServerUrls', { oldUrl: currentUrl.replace(/\/+$/, ''), newUrl: newUrl.replace(/\/+$/, '') });
    log(`migrateCookieServerUrls: ${JSON.stringify(mig)}`);
  } catch (e) {
    log('cookie migration failed (non-fatal):', e.message);
  }
}

async function runCycle() {
  log(`--- Health check cycle start (${new Date().toISOString()}) ---`);

  // Check this server's tunnel
  await healTunnel(SERVERLESS_ID, SL_PORT, path.join(__dirname, 'serverless-cloudflared.log'));

  // Check opencode tunnel (4096) - just log, don't restart (opencode is less critical)
  const opUrl = await getCurrentLinksUrl(SERVERLESS_ID); // opencode URL is in SETTINGS, not links
  // We don't have a direct way to check opencode URL from here, but we can check localhost
  const opLocalPing = await pingLocalhost(OP_PORT);
  if (!opLocalPing.ok) {
    log(`WARNING: opencode localhost:${OP_PORT} is unreachable: ${opLocalPing.reason}`);
  }

  log(`--- Health check cycle end ---`);
}

// Run immediately, then on interval
runCycle().catch(e => log('Cycle error:', e.message));
setInterval(() => {
  runCycle().catch(e => log('Cycle error:', e.message));
}, CHECK_INTERVAL_MS);

log(`Started. Checking ${SERVERLESS_ID} every ${CHECK_INTERVAL_MS / 1000}s.`);