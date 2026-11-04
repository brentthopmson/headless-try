import { getSheetDataApi } from "../../googlesheets.js";

function getAuthHeader(password) {
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return `Basic ${token}`;
}

async function getAiSettingsRows() {
  try {
    const res = await getSheetDataApi("AI_SETTINGS");
    if (!res?.success || !res?.headers || !Array.isArray(res?.data)) return [];
    const headers = res.headers.map((h) => String(h).toLowerCase().trim());
    const rows = [];
    for (const r of res.data) {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h.replace(/[^a-z0-9]/g, "")] = r[idx];
        obj[h] = r[idx];
      });
      rows.push(obj);
    }
    return rows;
  } catch (e) {
    console.warn("[opencode] failed to read AI_SETTINGS:", e.message);
    return [];
  }
}

async function checkOpencodeUp(baseUrl, password, timeoutMs = 2500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/model`, {
      method: "GET",
      headers: { Authorization: getAuthHeader(password), Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    clearTimeout(t);
    return false;
  }
}

export async function getOpencodeConfig() {
  const aiList = await getAiSettingsRows();
  if (!Array.isArray(aiList)) return null;

  const opRow = aiList.find((r) => {
    const p = r.aiprovider || r.provider || r["ai_provider"];
    return String(p || "").toLowerCase() === "opencode";
  });
  if (!opRow) return null;

  const password = opRow.aikey || opRow.key || opRow.apikey || opRow.password;
  if (!password) return null;
  const pwd = String(password).trim();
  if (!pwd) return null;

  const tunnelUrl = opRow.aibaseurl || opRow.baseurl || opRow.url || opRow.endpoint;
  const tunnel = tunnelUrl ? String(tunnelUrl).replace(/\/$/, "") : null;

  if (tunnel && tunnel.startsWith("http")) {
    const tunnelOk = await checkOpencodeUp(tunnel, pwd);
    if (tunnelOk) {
      return { baseUrl: tunnel, password: pwd, source: "tunnel" };
    }
    console.warn("[opencode] Tunnel unreachable, trying local fallback...");
  }

  const localUrl = "http://127.0.0.1:4096";
  const localOk = await checkOpencodeUp(localUrl, pwd);
  if (localOk) {
    return { baseUrl: localUrl, password: pwd, source: "local" };
  }

  if (tunnel) {
    return { baseUrl: tunnel, password: pwd, source: "tunnel" };
  }

  return null;
}

export async function discoverOpencodeModels(baseUrl, password) {
  const res = await fetch(`${baseUrl}/api/model`, {
    method: "GET",
    headers: { Authorization: getAuthHeader(password), Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    const err = new Error(`opencode_discover_${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

export async function generateWithOpencode({ baseUrl, password, prompt, model, timeoutMs = 35000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/api/experimental/generate/text`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(password),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ prompt, model }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!res.ok) {
      const err = new Error(`opencode_gen_${res.status}`);
      err.status = res.status;
      throw err;
    }

    const json = await res.json();
    const text =
      json.text ||
      json.content ||
      json.response ||
      json.output ||
      json.message ||
      json?.choices?.[0]?.message?.content ||
      json?.choices?.[0]?.text ||
      "";

    return typeof text === "string" ? text.trim() : String(text).trim();
  } catch (e) {
    if (e.name === "AbortError") {
      const err = new Error("opencode_timeout");
      err.status = 408;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}
