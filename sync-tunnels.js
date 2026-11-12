const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Load .env
try {
  const env = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^\s*([^#][^=]+)=(.*)$/);
    if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

function getTryCfUrl(logFile) {
  try {
    if (!fs.existsSync(logFile)) return null;
    const log = fs.readFileSync(logFile, 'utf8');
    const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;
    // Ignore env-dump lines (e.g. OPENCODE_TUNNEL_URL / "Environmental variables") which
    // can contain stale trycloudflare URLs and cause 4096/3001 collisions.
    const valid = [];
    for (const line of log.split(/\r?\n/)) {
      if (/Environmental variables|OPENCODE_TUNNEL_URL|TUNNEL_URL\s*[:=]/i.test(line) && /map\[|env/i.test(line)) continue;
      if (/OPENCODE_TUNNEL_URL/i.test(line)) continue;
      let m;
      while ((m = re.exec(line)) !== null) valid.push(m[0].replace(/\/$/, ''));
      re.lastIndex = 0;
    }
    return valid.length ? valid[valid.length - 1] : null;
  } catch { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGas(action, extraParams = {}, opts = {}) {
  const url = (process.env.SCRIPT_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SCRIPT_KEY || '').trim();
  if (!url || !key) { console.error('[sync] Missing SCRIPT_URL/SCRIPT_KEY'); return { success: false, error: 'missing_script_config' }; }
  const params = new URLSearchParams({ action, key });
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const retries = Number.isFinite(opts.retries) ? opts.retries : 2;
  const timeout = Number.isFinite(opts.timeout) ? opts.timeout : 30000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout });
      return res.data || { success: false, error: 'empty_response' };
    } catch (e) {
      if (attempt >= retries) return { success: false, error: e.message };
      await sleep(2000 * (attempt + 1));
    }
  }
  return { success: false, error: 'unreachable' };
}

async function sync(sheetName, searchColumn, searchValue, data, label) {
  let attempt = 0;
  let delayMs = 5000;
  const maxDelayMs = 60000;
  while (true) {
    attempt++;
    try {
      const res = await callGas('setMultipleCellDataByColumnSearch', { sheetName, searchColumn, searchValue, data }, { retries: 0, timeout: 30000 });
      if (res && res.success) {
        console.log(`[sync] ${label} -> OK (row ${res.rowNumber})${attempt > 1 ? ` [after ${attempt} attempts]` : ''}`);
        return true;
      }
      console.warn(`[sync] ${label} -> FAIL (attempt ${attempt}): ${JSON.stringify(res)} ; retrying in ${Math.round(delayMs/1000)}s...`);
    } catch (e) {
      console.warn(`[sync] ${label} -> ERROR (attempt ${attempt}): ${e.message} ; retrying in ${Math.round(delayMs/1000)}s...`);
    }
    await sleep(delayMs);
    delayMs = Math.min(maxDelayMs, Math.round(delayMs * 1.5));
  }
}

async function getCurrentLinksUrl(serverlessId) {
  try {
    const res = await callGas('getData', { sheetname: 'links' }, { retries: 1, timeout: 30000 });
    if (!res || !res.success || !res.data) return null;
    const headers = res.data.headers || [];
    const rows = res.data.rows || [];
    const idIdx = headers.indexOf('severlessId');
    const urlIdx = headers.indexOf('severlessURL');
    if (idIdx === -1 || urlIdx === -1) return null;
    const row = rows.find(r => String(r[idIdx] || '').trim() === String(serverlessId || '').trim());
    return row ? String(row[urlIdx] || '').trim() : null;
  } catch (e) {
    console.warn(`[sync-tunnels] failed to read current links URL for ${serverlessId}: ${e.message}`);
    return null;
  }
}

function waitForUrl(logFile, ms, opts = {}) {
  const end = Date.now() + ms;
  const rejectUrl = opts.notEqualTo || null;
  const label = opts.label || logFile;
  return new Promise(resolve => {
    const t = setInterval(() => {
      const u = getTryCfUrl(logFile);
      if (u) {
        if (rejectUrl && u === rejectUrl) {
          // collision: same URL as the other tunnel; keep waiting for a distinct one
          if (!waitForUrl._warned) waitForUrl._warned = {};
          if (!waitForUrl._warned[label]) {
            console.warn(`[sync-tunnels] WARNING: ${label} has same URL as other tunnel (${u}) - waiting for a distinct URL...`);
            waitForUrl._warned[label] = true;
          }
        } else {
          clearInterval(t); resolve(u); return;
        }
      }
      if (Date.now() > end) { clearInterval(t); resolve(getTryCfUrl(logFile)); }
    }, 2000);
  });
}

(async () => {
  const serverlessId = (process.env.SERVERLESS_ID || 'serverless4').trim();
  console.log(`[sync-tunnels] SERVERLESS_ID=${serverlessId}`);
  const opLog = path.join(__dirname, 'cloudflared.log');
  const slLog = path.join(__dirname, 'serverless-cloudflared.log');

  // Resolve opencode (4096) tunnel first, then resolve serverless (3001) tunnel
  // ensuring it is DISTINCT (prevents routing 4096/3001 to the same quick-tunnel URL).
  const opUrl = await waitForUrl(opLog, 90000, { label: 'cloudflared.log(4096)' });
  let slUrl = await waitForUrl(slLog, 90000, { label: 'serverless-cloudflared.log(3001)', notEqualTo: opUrl });

  if (opUrl && slUrl && opUrl === slUrl) {
    console.error(`[sync-tunnels] ERROR: tunnel URL collision (${opUrl}). Refusing to sync same URL to both targets.`);
    console.error('[sync-tunnels] HINT: ensure two separate cloudflared processes are running (4096->cloudflared.log, 3001->serverless-cloudflared.log).');
    slUrl = null;
  }

  // Resolve this server's opencode SETTINGS row (aiProvider=opencode AND aiSeverlessId/aiServerlessId==SERVERLESS_ID)
  // then update by unique aiSn — avoids cross-server contention (GAS search is single-column).
  let opTarget = null;
  try {
    const { resolveOpencodeTargetForServer } = require('./src/utils/opencodeSettings');
    opTarget = await resolveOpencodeTargetForServer({ serverlessId, label: 'sync-tunnels' });
  } catch (e) {
    console.warn(`[sync-tunnels] Failed to resolve opencode row for SERVERLESS_ID='${serverlessId}': ${e.message}`);
  }

  if (opUrl) {
    console.log(`[sync-tunnels] opencode tunnel (4096): ${opUrl}`);
    if (opTarget && opTarget.ok && opTarget.aiSn) {
      await sync('SETTINGS', opTarget.aiSnHeader || 'aiSn', String(opTarget.aiSn), { aiBaseUrl: opUrl, aiStatus: 'ACTIVE' }, `SETTINGS.aiSn=${opTarget.aiSn} (SERVERLESS_ID=${serverlessId}) aiBaseUrl`);
    } else {
      console.warn(`[sync-tunnels] No matching opencode SETTINGS row for SERVERLESS_ID='${serverlessId}' — NOT writing aiBaseUrl (avoids cross-server contention).`);
    }
  } else {
    console.warn('[sync-tunnels] No opencode tunnel URL found in cloudflared.log');
  }
  if (slUrl) {
    console.log(`[sync-tunnels] serverless tunnel (3001, ${serverlessId}): ${slUrl}`);
    const newSlUrl = slUrl.replace(/\/+$/, '');
    // On-demand cleanup: if this server's public URL rotated, migrate cookie stamps from old -> new
    try {
      const oldSlUrl = String(await getCurrentLinksUrl(serverlessId) || '').trim().replace(/\/+$/, '');
      if (oldSlUrl && oldSlUrl !== newSlUrl) {
        console.log(`[sync-tunnels] links.${serverlessId} URL changed: ${oldSlUrl} -> ${newSlUrl}; migrating cookie server stamps`);
        const mig = await callGas('migrateCookieServerUrls', { oldUrl: oldSlUrl, newUrl: newSlUrl }, { retries: 2, timeout: 45000 });
        console.log(`[sync-tunnels] migrateCookieServerUrls: ${JSON.stringify(mig)}`);
      }
    } catch (e) {
      console.warn(`[sync-tunnels] stale-cookie migration skipped (non-fatal): ${e.message}`);
    }
    await sync('links', 'severlessId', serverlessId, { severlessURL: newSlUrl + '/', severlessStatus: 'ACTIVE', severlessHealth: 'OK' }, `links.${serverlessId} severlessURL`);
  } else {
    console.warn(`[sync-tunnels] No DISTINCT serverless tunnel URL found in ${slLog} - NOT updating links.${serverlessId} (collision or missing).`);
  }
  const pwd = (process.env.OPENCODE_SERVER_PASSWORD || '').trim();
  if (pwd) {
    if (opTarget && opTarget.ok && opTarget.aiSn) {
      await sync('SETTINGS', opTarget.aiSnHeader || 'aiSn', String(opTarget.aiSn), { aiKey: pwd }, `SETTINGS.aiSn=${opTarget.aiSn} (SERVERLESS_ID=${serverlessId}) aiKey`);
    } else {
      console.warn(`[sync-tunnels] No matching opencode SETTINGS row for SERVERLESS_ID='${serverlessId}' — NOT writing aiKey (avoids cross-server contention).`);
    }
  }
  console.log('[sync-tunnels] done');
})();
