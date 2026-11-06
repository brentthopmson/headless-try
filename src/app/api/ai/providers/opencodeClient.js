import axios from "axios";
import { getServerlessId, findMatchingOpencodeNormalizedRow } from "../../../utils/opencodeSettings.js";

function getAuthHeader(password) {
  const token = Buffer.from(`opencode:${password}`).toString("base64");
  return `Basic ${token}`;
}

async function getAiSettingsRows() {
  try {
    const url = process.env.SCRIPT_URL;
    const key = process.env.SCRIPT_KEY;
    if (!url || !key) {
      console.warn("[opencode] Missing SCRIPT_URL or SCRIPT_KEY");
      return [];
    }

    const params = new URLSearchParams({
      action: "getData",
      key: key,
      sheetname: "SETTINGS",
    });

    const res = await axios.post(url, params, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 30000,
    });

    if (!res.data?.success || !Array.isArray(res.data?.headers)) return [];
    const headers = res.data.headers.map((h) => String(h).toLowerCase().trim());
    const rows = res.data.data || [];
    const result = [];
    for (const r of rows) {
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = r[idx];
        obj[h.replace(/[^a-z0-9]/g, "")] = r[idx];
      });
      result.push(obj);
    }
    return result;
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
  const serverlessId = getServerlessId();
  // Pick the opencode row scoped to this server (aiSeverlessId/aiServerlessId == SERVERLESS_ID)
  // so multi-server deployments never contend on one row. Never pick another server's row.
  const match = findMatchingOpencodeNormalizedRow(aiList, serverlessId);
  let opRow = match ? match.row : null;
  if (!opRow) {
    const opRows = Array.isArray(aiList) ? aiList.filter((r) => String(r.aiprovider || r.provider || "").toLowerCase() === "opencode") : [];
    if (opRows.length) console.warn(`[opencode] No SETTINGS opencode row matches SERVERLESS_ID='${serverlessId || "(unset)"}' (opencode rows=${opRows.length}) — set aiSeverlessId/aiServerlessId on the correct row; not using another server's row.`);
  } else {
    console.log(`[opencode] Using opencode row aiSn=${match.aiSn || "?"} (SERVERLESS_ID='${serverlessId || "(unset)"}', match=${match.matchedBy})`);
  }

  let password = opRow?.aikey || opRow?.key || opRow?.apikey || opRow?.password;
  let tunnelUrl = opRow?.aibaseurl || opRow?.baseurl || opRow?.url || opRow?.endpoint;

  // Fallback to env vars
  if (!password) {
    password = process.env.OPENCODE_SERVER_PASSWORD || process.env.OPENCODE_KEY || process.env.OPENCODE_AI_KEY;
  }
  if (!tunnelUrl) {
    tunnelUrl = process.env.OPENCODE_TUNNEL_URL || process.env.OPENCODE_BASE_URL;
  }

  if (!password) return null;
  const pwd = String(password).trim();
  if (!pwd) return null;

  const tunnel = tunnelUrl ? String(tunnelUrl).replace(/\/$/, "") : null;

  // 1) Try tunnel first (MAIN)
  if (tunnel && tunnel.startsWith("http")) {
    const tunnelOk = await checkOpencodeUp(tunnel, pwd);
    if (tunnelOk) {
      return { baseUrl: tunnel, password: pwd, source: "tunnel" };
    }
    console.warn("[opencode] Tunnel unreachable, trying local fallback...");
  }

  // 2) Try local as fallback (SECONDARY)
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

function extractTextFromMessage(json) {
  if (!json || typeof json !== "object") return "";
  // session message shape: { info, parts: [{type:"text", text:"..."}] }
  if (Array.isArray(json.parts)) {
    const t = json.parts
      .filter((p) => p && (p.type === "text" || p.type === "reasoning" ? false : p.type === "text") && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    const t2 = json.parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
    if (t2.trim()) return t2.trim();
    if (t.trim()) return t.trim();
  }
  const direct = json.text || json.content || json.response || json.output || json.message || json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "";
  return typeof direct === "string" ? direct.trim() : (direct ? String(direct).trim() : "");
}

export async function generateWithOpencode({ baseUrl, password, prompt, model, timeoutMs = 120000 }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: getAuthHeader(password),
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const throwIfApiError = (json) => {
    const apiErr = json?.info?.error || json?.error;
    if (apiErr && typeof apiErr === "object") {
      const msg = apiErr?.data?.message || apiErr?.message || apiErr?.name || "opencode_api_error";
      const err = new Error(String(msg));
      err.status = 502;
      err.apiError = apiErr;
      throw err;
    }
  };

  try {
    // 1) Preferred for opencode serve: session + message API
    try {
      const cs = await fetch(`${baseUrl}/api/session`, {
        method: "POST", headers, body: JSON.stringify({}), signal: controller.signal, cache: "no-store",
      });
      const ct = (cs.headers.get("content-type") || "").toLowerCase();
      if (cs.ok && ct.includes("application/json")) {
        const cj = await cs.json();
        const sid = cj?.data?.id || cj?.id;
        if (sid) {
          const msgBody = { parts: [{ type: "text", text: String(prompt || "") }], ...(model ? { model } : {}) };
          for (const path of [`/session/${sid}/message`, `/api/session/${sid}/message`]) {
            const mr = await fetch(`${baseUrl}${path}`, {
              method: "POST", headers, body: JSON.stringify(msgBody), signal: controller.signal, cache: "no-store",
            });
            const mct = (mr.headers.get("content-type") || "").toLowerCase();
            if (!mr.ok || !mct.includes("application/json")) continue;
            const mj = await mr.json();
            throwIfApiError(mj);
            const text = extractTextFromMessage(mj);
            if (text) return text;
            // if no text but no error, return empty string rather than falling through to wrong endpoint
            if (!mj?.info?.error) return text;
          }
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      // fall through to legacy endpoint
      if (!String(e?.message || "").includes("opencode_")) console.warn("[opencode] session API path failed, trying legacy:", e.message);
      if (e?.apiError) throw e;
    }

    // 2) Legacy/experimental endpoint fallback
    const res = await fetch(`${baseUrl}/api/experimental/generate/text`, {
      method: "POST", headers, body: JSON.stringify({ prompt, model }), signal: controller.signal, cache: "no-store",
    });
    const rct = (res.headers.get("content-type") || "").toLowerCase();
    if (!res.ok) {
      const err = new Error(`opencode_gen_${res.status}`);
      err.status = res.status;
      throw err;
    }
    if (!rct.includes("application/json")) {
      const err = new Error("opencode_gen_non_json_response");
      err.status = 502;
      throw err;
    }
    const json = await res.json();
    const text = extractTextFromMessage(json);
    return text;
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
