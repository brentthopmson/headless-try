const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn, execSync } = require('child_process');

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
const CF_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi;

let opencodeSettingsUtil = null;
try { opencodeSettingsUtil = require('./src/utils/opencodeSettings'); } catch (e) { console.warn('[tunnel-healer] opencodeSettings util unavailable:', e.message); }

function log(...args) { console.log('[tunnel-healer]', new Date().toISOString(), ...args); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function normUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }
function hasUrl(v) { return /^https?:\/\//i.test(String(v || '').trim()); }

async function callGas(action, extraParams = {}, opts = {}) {
  const url = normUrl(process.env.SCRIPT_URL || '');
  const key = String(process.env.SCRIPT_KEY || '').trim();
  if (!url || !key) { log('Missing SCRIPT_URL/SCRIPT_KEY'); return { success: false, error: 'missing_config' }; }
  const params = new URLSearchParams({ action, key });
  for (const [k, v] of Object.entries(extraParams || {})) {
    if (v === undefined || v === null) continue;
    params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  const retries = Number.isFinite(opts.retries) ? opts.retries : 1;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(url, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: opts.timeout || 30000 });
      return res.data || { success: false, error: 'empty_response' };
    } catch (e) {
      if (attempt >= retries) return { success: false, error: e.message, code: e.response?.status };
      await sleep(1000 * (attempt + 1));
    }
  }
  return { success: false, error: 'unreachable' };
}

async function pingServerlessUrl(url, timeoutMs = 8000) {
  if (!url) return { ok: false, reason: 'no_url' };
  const clean = normUrl(url);
  try {
    const res = await axios.get(clean + '/api/serverless-self?ping=1', {
      headers: { 'ngrok-skip-browser-warning': 'true' },
      timeout: timeoutMs,
      validateStatus: () => true,
    });
    const code = res.status;
    const body = res.data || {};
    // Treat as reachable/healthy only when endpoint responds successfully with alive signal.
    if (code >= 200 && code < 300 && (body.alive === true || body.success === true || body.checks !== undefined)) {
      return { ok: true, reason: body.alive === false ? 'reachable_but_not_alive' : 'reachable', code, body };
    }
    // 409 means server answered but self-assertion failed; reachable, but not a healthy reconciliation signal.
    if (code === 409) return { ok: false, reason: 'http_409_assertion_failed', code, body, reachable: true };
    return { ok: false, reason: `http_${code}`, code, body, reachable: code > 0 };
  } catch (e) {
    return { ok: false, reason: e.code || e.message };
  }
}

async function pingOpencodeUrl(url, timeoutMs = 8000) {
  if (!url) return { ok: false, reason: 'no_url' };
  const clean = normUrl(url);
  const headers = {};
  if (process.env.OPENCODE_SERVER_PASSWORD) {
    headers['Authorization'] = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  }
  // Try lightweight endpoints; opencode implementations vary, so accept any non-network-failure HTTP response < 500 as reachable.
  const paths = ['/global/health', '/health', '/'];
  for (const p of paths) {
    try {
      const res = await axios.get(clean + p, { headers, timeout: timeoutMs, validateStatus: () => true });
      const code = res.status;
      if (code === 401 || code === 403) return { ok: true, reason: `reachable_auth_${code}`, code };
      if (code >= 200 && code < 500) return { ok: true, reason: `reachable_http_${code}`, code };
      return { ok: false, reason: `http_${code}`, code };
    } catch (e) {
      // try next path on network error only? keep last error
      if (p === paths[paths.length - 1]) return { ok: false, reason: e.code || e.message };
    }
  }
  return { ok: false, reason: 'unreachable' };
}

async function pingLocalhostServerless() { return pingServerlessUrl(`http://localhost:${SL_PORT}`, 5000); }
async function pingLocalhostOpencode() { return pingOpencodeUrl(`http://localhost:${OP_PORT}`, 5000); }

function getTryCfUrlsFromLog(logFile) {
  try {
    if (!fs.existsSync(logFile)) return [];
    const logText = fs.readFileSync(logFile, 'utf8');
    const urls = [];
    for (const line of logText.split(/\r?\n/)) {
      if (/OPENCODE_TUNNEL_URL|TUNNEL_URL\s*[:=]/i.test(line) && /Environmental variables|map\[|env/i.test(line)) continue;
      if (/OPENCODE_TUNNEL_URL/i.test(line)) continue;
      let m; CF_URL_RE.lastIndex = 0;
      while ((m = CF_URL_RE.exec(line)) !== null) urls.push(normUrl(m[0]));
    }
    return urls;
  } catch { return []; }
}
function getLatestTryCfUrl(logFile) { const urls = getTryCfUrlsFromLog(logFile); return urls.length ? urls[urls.length - 1] : null; }

async function getLinksRow(serverlessId) {
  const res = await callGas('getData', { sheetname: 'links' }, { retries: 2 });
  if (!res || !res.success) return null;
  const headers = res.headers || (res.data && res.data.headers) || [];
  const rows = res.data || (res.data && res.data.rows) || [];
  const idIdx = headers.indexOf('severlessId');
  if (idIdx === -1) return null;
  const row = (Array.isArray(rows) ? rows : []).find(r => String((r && r[idIdx]) || '').trim() === String(serverlessId || '').trim());
  if (!row) return null;
  const obj = {};
  headers.forEach((h, i) => { obj[h] = row[i]; });
  return obj;
}

async function getOpencodeSettingsState() {
  if (!opencodeSettingsUtil || typeof opencodeSettingsUtil.resolveOpencodeTargetForServer !== 'function') {
    return { ok: false, error: 'opencode_settings_util_unavailable' };
  }
  try {
    const target = await opencodeSettingsUtil.resolveOpencodeTargetForServer({ serverlessId: SERVERLESS_ID, label: 'tunnel-healer' });
    if (!target.ok) return target;
    const headers = target.headers || [];
    const data = target.headers ? null : null; // resolve returns headers in current util; fetch again for row values
    // fetch full settings to read aiBaseUrl/aiStatus for this aiSn
    const got = await callGas('getData', { sheetname: 'SETTINGS' }, { retries: 2 });
    if (!got || !got.success) return { ok: false, error: got?.error || 'settings_read_failed', aiSn: target.aiSn, aiSnHeader: target.aiSnHeader };
    const hs = got.headers || [];
    const rs = got.data || [];
    const aiSnIdx = hs.findIndex(h => String(h || '').toLowerCase().replace(/[^a-z0-9]/g,'') === 'aisn');
    const row = (Array.isArray(rs) ? rs : []).find(r => aiSnIdx >= 0 && String(r[aiSnIdx] || '').trim() === String(target.aiSn).trim());
    const obj = {};
    if (row) hs.forEach((h,i)=>obj[h]=row[i]);
    const baseIdx = hs.findIndex(h => String(h||'').toLowerCase().replace(/[^a-z0-9]/g,'') === 'aibaseurl');
    const statusIdx = hs.findIndex(h => String(h||'').toLowerCase().replace(/[^a-z0-9]/g,'') === 'aistatus');
    return {
      ok: true,
      aiSn: target.aiSn,
      aiSnHeader: target.aiSnHeader || 'aiSn',
      aiBaseUrl: baseIdx >= 0 && row ? String(row[baseIdx] || '').trim() : String(obj.aiBaseUrl || obj.aibaseurl || '').trim(),
      aiStatus: statusIdx >= 0 && row ? String(row[statusIdx] || '').trim() : String(obj.aiStatus || obj.aistatus || '').trim(),
      headers: hs,
      row: obj,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function listManagedCloudflaredPids(port) {
  const pids = new Set();
  try {
    if (process.platform === 'win32') {
      // Use PowerShell CIM to find cloudflared processes targeting this localhost port
      const cmd = `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq 'cloudflared.exe' -and $_.CommandLine -match 'tunnel' -and $_.CommandLine -match 'http://(127\\.0\\.0\\.1|localhost):${port}(\\s|$|\")' } | Select-Object -ExpandProperty ProcessId"`;
      const out = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString();
      out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(x => pids.add(Number(x)));
    } else {
      const out = execSync(`pgrep -f "cloudflared.*http://(127\\.0\\.0\\.1|localhost):${port}" || true`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString();
      out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).forEach(x => pids.add(Number(x)));
    }
  } catch {}
  return [...pids].filter(n => Number.isFinite(n) && n > 0);
}

function stopManagedCloudflared(port) {
  const pids = listManagedCloudflaredPids(port);
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', timeout: 10000 });
      else process.kill(pid, 'SIGTERM');
      log(`Stopped managed cloudflared for port ${port} (PID ${pid})`);
    } catch (e) {
      log(`Failed to stop cloudflared PID ${pid} for port ${port}: ${e.message}`);
    }
  }
  return pids.length;
}

async function waitForNewDistinctUrl(logFile, beforeUrlsSet, avoidUrlsSet, timeoutMs = 90000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const urls = getTryCfUrlsFromLog(logFile);
    for (let i = urls.length - 1; i >= 0; i--) {
      const u = normUrl(urls[i]);
      if (!u) continue;
      if (avoidUrlsSet && avoidUrlsSet.has(u)) continue;
      if (!beforeUrlsSet || !beforeUrlsSet.has(u) || i === urls.length - 1) return u;
    }
    await sleep(2000);
  }
  const latest = getLatestTryCfUrl(logFile);
  if (latest && !(avoidUrlsSet && avoidUrlsSet.has(latest))) return latest;
  return null;
}

async function restartCloudflaredForPort(logFile, port, { avoidUrl } = {}) {
  log(`Restarting cloudflared for port ${port} (targeted)...`);
  const before = new Set(getTryCfUrlsFromLog(logFile).map(normUrl));
  stopManagedCloudflared(port);
  await sleep(2000);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--logfile', logFile, '--loglevel', 'info'], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  try { fs.closeSync(out); } catch {}
  try { proc.unref(); } catch {}
  log(`cloudflared spawned (PID ${proc.pid}) for port ${port}`);
  const avoid = new Set([normUrl(avoidUrl)].filter(Boolean));
  const newUrl = await waitForNewDistinctUrl(logFile, before, avoid, 90000);
  return newUrl ? normUrl(newUrl) : null;
}

async function syncServerlessLink(serverlessId, url, { status = 'ACTIVE', health = 'OK' } = {}) {
  const clean = normUrl(url);
  const data = { severlessStatus: status, severlessHealth: health };
  if (clean) data.severlessURL = clean + '/';
  const res = await callGas('setMultipleCellDataByColumnSearch', {
    sheetName: 'links',
    searchColumn: 'severlessId',
    searchValue: serverlessId,
    data,
  }, { retries: 2 });
  if (res && res.success) log(`links.${serverlessId} synced`, JSON.stringify(data));
  else log(`links.${serverlessId} sync failed:`, JSON.stringify(res));
  return !!(res && res.success);
}

async function markServerlessFailed(serverlessId, reason) {
  const res = await callGas('setMultipleCellDataByColumnSearch', {
    sheetName: 'links',
    searchColumn: 'severlessId',
    searchValue: serverlessId,
    data: { severlessStatus: 'FAILED', severlessHealth: 'DOWN', severlessHealthReason: String(reason || 'localhost_down') },
  }, { retries: 2 });
  if (res && res.success) log(`links.${serverlessId} marked FAILED/DOWN (${reason || 'localhost_down'})`);
  else log(`links.${serverlessId} mark FAILED failed:`, JSON.stringify(res));
  return !!(res && res.success);
}

async function syncOpencodeSettings(aiBaseUrl, { status = 'ACTIVE', reason } = {}) {
  if (!opencodeSettingsUtil) return { ok: false, error: 'opencode_settings_util_unavailable' };
  const data = { aiBaseUrl: normUrl(aiBaseUrl) ? normUrl(aiBaseUrl) + '/' : '', aiStatus: status };
  if (reason) data.aiHealthReason = String(reason);
  const pwd = String(process.env.OPENCODE_SERVER_PASSWORD || '').trim();
  if (pwd) data.aiKey = pwd;
  try {
    const res = await opencodeSettingsUtil.syncOpencodeRowForServer(data, { serverlessId: SERVERLESS_ID, label: 'tunnel-healer' });
    if (!res || res.ok === false) log('opencode SETTINGS sync failed:', JSON.stringify(res));
    return res || { ok: false, error: 'unknown' };
  } catch (e) {
    log('opencode SETTINGS sync exception:', e.message);
    return { ok: false, error: e.message };
  }
}

async function migrateCookieServerUrls(oldUrl, newUrl) {
  const oldN = normUrl(oldUrl), newN = normUrl(newUrl);
  if (!oldN || !newN || oldN === newN) return null;
  try {
    const mig = await callGas('migrateCookieServerUrls', { oldUrl: oldN, newUrl: newN }, { retries: 2, timeout: 45000 });
    log(`migrateCookieServerUrls ${oldN} -> ${newN}: ${JSON.stringify(mig)}`);
    return mig;
  } catch (e) {
    log('cookie migration failed (non-fatal):', e.message);
    return null;
  }
}

async function healServerlessTunnel(opCurrentUrl) {
  const row = await getLinksRow(SERVERLESS_ID);
  const currentUrl = normUrl(row && row.severlessURL);
  const currentStatus = String((row && row.severlessStatus) || '').trim().toUpperCase();
  const currentHealth = String((row && row.severlessHealth) || '').trim().toUpperCase();
  const logFile = path.join(__dirname, 'serverless-cloudflared.log');

  if (!currentUrl) {
    // No URL known: if localhost is alive, try to discover/restart tunnel and publish
    const local = await pingLocalhostServerless();
    if (local.ok) {
      const avoid = new Set([normUrl(opCurrentUrl)].filter(Boolean));
      const latest = getLatestTryCfUrl(logFile);
      let chosen = (latest && !avoid.has(latest)) ? latest : null;
      let ping = chosen ? await pingServerlessUrl(chosen) : { ok: false };
      if (!ping.ok) {
        chosen = await restartCloudflaredForPort(logFile, SL_PORT, { avoidUrl: opCurrentUrl });
        if (chosen) ping = await pingServerlessUrl(chosen);
      }
      if (chosen) await syncServerlessLink(SERVERLESS_ID, chosen, { status: ping.ok ? 'ACTIVE' : 'ACTIVE', health: ping.ok ? 'OK' : 'UNKNOWN' });
    }
    return;
  }

  const pub = await pingServerlessUrl(currentUrl);
  const local = await pingLocalhostServerless();

  if (pub.ok) {
    // Reachable: reconcile stale FAILED/DOWN to ACTIVE/OK
    if (currentStatus !== 'ACTIVE' || currentHealth !== 'OK') {
      log(`links.${SERVERLESS_ID} reachable but stale (${currentStatus}/${currentHealth}) -> reconciling ACTIVE/OK`);
      await syncServerlessLink(SERVERLESS_ID, currentUrl, { status: 'ACTIVE', health: 'OK' });
    }
    return;
  }

  log(`links.${SERVERLESS_ID} public URL unhealthy (${pub.reason}) url=${currentUrl} local=${local.ok ? 'up' : 'down:' + local.reason}`);
  if (!local.ok) {
    await markServerlessFailed(SERVERLESS_ID, `localhost_down:${local.reason}`);
    return;
  }

  // localhost alive but public tunnel dead/unhealthy -> heal cloudflared tunnel
  const newUrl = await restartCloudflaredForPort(logFile, SL_PORT, { avoidUrl: opCurrentUrl });
  if (!newUrl) {
    log(`links.${SERVERLESS_ID} failed to obtain new serverless cloudflared URL`);
    return;
  }
  const verify = await pingServerlessUrl(newUrl);
  if (!verify.ok) log(`links.${SERVERLESS_ID} new URL verify not healthy yet (${verify.reason}); syncing anyway for propagation/retry`);
  await syncServerlessLink(SERVERLESS_ID, newUrl, { status: 'ACTIVE', health: verify.ok ? 'OK' : 'UNKNOWN' });
  await migrateCookieServerUrls(currentUrl, newUrl);
}

async function healOpencodeTunnel(serverlessCurrentUrl) {
  const state = await getOpencodeSettingsState();
  if (!state.ok) {
    // Still do a localhost sanity log
    const local = await pingLocalhostOpencode();
    if (!local.ok) log(`WARNING: opencode localhost:${OP_PORT} unreachable (${local.reason}); SETTINGS sync skipped (${state.error || 'unresolved'})`);
    else log(`opencode localhost:${OP_PORT} up but SETTINGS row unresolved/skipped (${state.error || 'unresolved'})`);
    return state;
  }

  const currentUrl = normUrl(state.aiBaseUrl);
  const currentStatus = String(state.aiStatus || '').trim().toUpperCase();
  const logFile = path.join(__dirname, 'cloudflared.log');
  const pub = hasUrl(currentUrl) ? await pingOpencodeUrl(currentUrl) : { ok: false, reason: 'missing_or_invalid_url' };
  const local = await pingLocalhostOpencode();

  if (pub.ok) {
    if (currentStatus !== 'ACTIVE') {
      log(`opencode ${SERVERLESS_ID} reachable but status=${currentStatus || '(empty)'} -> reconciling ACTIVE`);
      await syncOpencodeSettings(currentUrl, { status: 'ACTIVE', reason: 'reconciled_reachable' });
    }
    return { ...state, aiBaseUrl: currentUrl };
  }

  log(`opencode ${SERVERLESS_ID} public URL unhealthy (${pub.reason}) url=${currentUrl || '(none)'} local=${local.ok ? 'up' : 'down:' + local.reason}`);
  if (!local.ok) {
    await syncOpencodeSettings(currentUrl, { status: 'FAILED', reason: `localhost_down:${local.reason}` });
    return { ...state, aiBaseUrl: currentUrl };
  }

  const newUrl = await restartCloudflaredForPort(logFile, OP_PORT, { avoidUrl: serverlessCurrentUrl });
  if (!newUrl) {
    log(`opencode ${SERVERLESS_ID} failed to obtain new cloudflared URL`);
    await syncOpencodeSettings(currentUrl, { status: 'FAILED', reason: 'tunnel_restart_no_url' });
    return { ...state, aiBaseUrl: currentUrl };
  }
  const verify = await pingOpencodeUrl(newUrl);
  if (!verify.ok) log(`opencode ${SERVERLESS_ID} new URL verify not healthy yet (${verify.reason}); syncing anyway`);
  await syncOpencodeSettings(newUrl, { status: verify.ok ? 'ACTIVE' : 'ACTIVE', reason: verify.ok ? 'healed' : 'healed_unverified' });
  return { ...state, aiBaseUrl: newUrl };
}

async function runCycle() {
  log(`--- Health check cycle start (serverless=${SERVERLESS_ID}) ---`);
  try {
    const linksRow = await getLinksRow(SERVERLESS_ID);
    const serverlessUrl = normUrl(linksRow && linksRow.severlessURL);

    // Heal/reconcile serverless (3001) first, using current opencode URL as collision-avoid hint if known
    const opStatePre = await getOpencodeSettingsState();
    const opUrlPre = opStatePre && opStatePre.ok ? normUrl(opStatePre.aiBaseUrl) : '';
    await healServerlessTunnel(opUrlPre);

    // Re-read serverless URL after possible heal, then heal opencode (4096)
    const linksRowAfter = await getLinksRow(SERVERLESS_ID);
    const serverlessUrlAfter = normUrl((linksRowAfter && linksRowAfter.severlessURL) || serverlessUrl);
    await healOpencodeTunnel(serverlessUrlAfter);
  } catch (e) {
    log('Cycle error:', e && e.message ? e.message : e);
  }
  log('--- Health check cycle end ---');
}

// Run immediately, then on interval
runCycle().catch(e => log('Cycle error:', e && e.message ? e.message : e));
setInterval(() => {
  runCycle().catch(e => log('Cycle error:', e && e.message ? e.message : e));
}, CHECK_INTERVAL_MS);

log(`Started. Checking ${SERVERLESS_ID} every ${CHECK_INTERVAL_MS / 1000}s (ports ${SL_PORT}/${OP_PORT}).`);