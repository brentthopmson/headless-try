import axios from 'axios';
import net from 'net';

// ============================================================
// Per-run IP proxy resolution + rotation + health check
// ============================================================
// Supports three modes (checked in order):
//   1. PROXY_HOSTS         — static comma-separated list, e.g. host:port (optionally full http://user:pass@host:port)
//   2. PROXY_LIST_URL      — a URL returning a plain-text/JSON list of host:port entries (free public lists work here)
//   3. PROXY_PROVIDER_URL  — a paid/provider rotation endpoint returning one "user:pass@host:port" (or full URL)
// Optional shared credentials for mode 1/2: PROXY_USER + PROXY_PASS.

const HEALTH_CHECK_TIMEOUT = 3000;
const MAX_HEALTH_CHECKS = 6;

let validatedPool = null;
let lastPick = 0;

function pickProxyUrl(host, user, pass) {
  const trimmed = String(host || '').trim();
  if (!trimmed) return null;
  if (/^[a-z]+:\/\//i.test(trimmed)) {
    // Already a full URL (may or may not carry creds). If creds provided and none embedded, embed.
    if (user && pass && !/@/.test(trimmed)) {
      const m = trimmed.match(/^(https?):\/\/(.*)$/i);
      if (m) return `${m[1]}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${m[2]}`;
    }
    return trimmed;
  }
  if (user && pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${trimmed}`;
  }
  return `http://${trimmed}`;
}

function tcpCheck(host, port, timeoutMs = HEALTH_CHECK_TIMEOUT) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function parseHostPort(entry) {
  const clean = String(entry || '').trim().replace(/^https?:\/\//i, '');
  const m = clean.match(/^([0-9a-zA-Z.-]+):([0-9]+)$/);
  return m ? { host: m[1], port: parseInt(m[2], 10) } : null;
}

async function fetchListCandidates(url, user, pass) {
  try {
    const res = await axios.get(url, { timeout: 15000, responseType: 'text' });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const entries = [];
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
      try {
        const arr = JSON.parse(trimmed);
        for (const item of arr) {
          if (typeof item === 'string') entries.push(item);
        }
      } catch (e) { /* fall through to line parsing */ }
    } else {
      for (const line of trimmed.split(/\r?\n/)) {
        const s = line.trim();
        if (!s) continue;
        if (parseHostPort(s) || /^[a-z]+:\/\//i.test(s)) entries.push(s);
      }
    }
    return entries.slice(0, 200).map(h => pickProxyUrl(h, user, pass)).filter(Boolean);
  } catch (e) {
    return [];
  }
}

async function fetchProviderUrl(url) {
  try {
    const res = await axios.get(url, { timeout: 20000, responseType: 'text' });
    const text = typeof res.data === 'string' ? res.data.trim() : JSON.stringify(res.data).trim();
    if (!text) return null;
    if (/^[a-z]+:\/\//i.test(text)) return text;
    if (parseHostPort(text)) return `http://${text}`;
    return null;
  } catch (e) {
    return null;
  }
}

async function resolveCandidates() {
  if (validatedPool && validatedPool.length) return validatedPool;

  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS;
  const hosts = (process.env.PROXY_HOSTS || '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean)
    .map(h => pickProxyUrl(h, user, pass))
    .filter(Boolean);
  const listUrl = process.env.PROXY_LIST_URL;

  let candidates = hosts;
  if (!candidates.length && listUrl) {
    candidates = await fetchListCandidates(listUrl, user, pass);
  }

  if (!candidates.length) return [];

  const healthy = [];
  // Shuffle for fairness
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  for (const url of shuffled) {
    if (healthy.length >= MAX_HEALTH_CHECKS) break;
    const parsed = parseHostPort(url);
    if (parsed) {
      const ok = await tcpCheck(parsed.host, parsed.port);
      if (ok) healthy.push(url);
    } else {
      healthy.push(url);
    }
  }

  if (healthy.length) validatedPool = healthy;
  return healthy;
}

export async function resolveProxyForRun() {
  if (!(process.env.PROXY_HOSTS || process.env.PROXY_LIST_URL || process.env.PROXY_PROVIDER_URL)) {
    return null;
  }

  // Provider mode (single rotating endpoint) — always fetch a fresh one.
  if (!(process.env.PROXY_HOSTS || process.env.PROXY_LIST_URL) && process.env.PROXY_PROVIDER_URL) {
    const url = await fetchProviderUrl(process.env.PROXY_PROVIDER_URL);
    if (!url) return null;
    return { url, mode: 'provider' };
  }

  const pool = await resolveCandidates();
  if (!pool.length) return null;

  const idx = (lastPick + 1 + Math.floor(Math.random() * Math.max(1, pool.length - 1))) % pool.length;
  lastPick = idx;
  return { url: pool[idx], mode: 'pool' };
}

export function maskProxy(url) {
  if (!url) return 'none';
  const cleaned = String(url).replace(/(:\/\/)[^@/]+@/, '$1***@');
  return cleaned;
}

export function resetProxyPool() {
  validatedPool = null;
  lastPick = 0;
}