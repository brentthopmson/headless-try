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
  const _bad = (t) => { const p = String(t || "").trimStart().slice(0, 60).toLowerCase(); return p.startsWith("<!doctype") || p.startsWith("<html"); };
  // session message shape: { info, parts: [{type:"text", text:"..."}] }
  if (Array.isArray(json.parts)) {
    const t2 = json.parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
    if (t2.trim() && !_bad(t2)) return t2.trim();
  }
  if (Array.isArray(json.content)) {
    const t = json.content.filter((c) => c && (c.type === "text" || c.type == null) && typeof c.text === "string").map((c) => c.text).join("");
    if (t.trim() && !_bad(t)) return t.trim();
  }
  const direct = json.text || (typeof json.content === "string" ? json.content : "") || json.response || json.output || json.message || json?.choices?.[0]?.message?.content || json?.choices?.[0]?.text || "";
  if (typeof direct === "string" && direct.trim() && !_bad(direct)) return direct.trim();
  const lists = [];
  if (Array.isArray(json)) lists.push(json);
  if (Array.isArray(json.messages)) lists.push(json.messages);
  if (Array.isArray(json.data)) lists.push(json.data);
  for (const list of lists) {
    for (const m of list) {
      if (!m) continue;
      const role = m?.info?.role || m?.role || m?.type;
      if (role && role !== "assistant") continue;
      if (Array.isArray(m.parts)) {
        const t = m.parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
        if (t.trim() && !_bad(t)) return t.trim();
      }
      if (Array.isArray(m.content)) {
        const t = m.content.filter((c) => c && (c.type === "text" || c.type == null) && typeof c.text === "string").map((c) => c.text).join("");
        if (t.trim() && !_bad(t)) return t.trim();
      }
    }
  }
  return typeof direct === "string" ? "" : (direct ? String(direct).trim() : "");
}

function sanitizeOpencodeText(text) {
  if (text == null) return "";
  let s = String(text);
  if (!s.trim()) return "";
  const probe = s.trimStart().slice(0, 300).toLowerCase();
  if (probe.startsWith("<!doctype") || probe.startsWith("<html")) return "";
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, "");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  s = s.replace(/\r\n?/g, "\n");
  const f = s.trim().match(/^```(?:json|text|markdown)?\s*\n([\s\S]*?)\n\s*```\s*$/i);
  if (f) s = f[1];
  s = s.replace(/<(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<\/?\s*[A-Za-z][^>]*?>/g, " ");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeOpencodeModel(model) {
  if (!model) return undefined;
  if (typeof model === "object") {
    const providerID = model.providerID || model.provider || "";
    const modelID = model.modelID || model.id || "";
    if (providerID && modelID) return { providerID: String(providerID), modelID: String(modelID) };
    return model;
  }
  const s = String(model);
  if (s.includes("/")) {
    const [providerID, ...rest] = s.split("/");
    const id = rest.join("/");
    if (providerID && id) return { providerID, modelID: id };
  }
  return String(model);
}

function stripDataUrlPrefix(v) {
  const s = String(v || "").trim();
  const i = s.indexOf("base64,");
  return i !== -1 && s.startsWith("data:") ? s.slice(i + "base64,".length) : s;
}
function mediaDataUrl(mimeType, b64) { return `data:${mimeType || "image/png"};base64,${b64 || ""}`; }
function isMediaUnsupportedMsg(msg) {
  return /image|video|vision|multimodal|file.*part|attachment|media.*support|support.*media|does not support|not supported|unsupported|invalid.*file/.test(String(msg || "").toLowerCase());
}
function isMediaUnsupportedResponse(text) {
  const s = String(text || "").trim();
  if (!s || s.length > 2000) return false;
  return /\b(i )?(can't|cannot|can not|unable to|don't have (?:image|vision)|no (?:image|vision)|not able to) (view|see|analyse|analyze|process|access)[^.]{0,60}(image|picture|photo|frame|video|file|attachment|media)/i.test(s)
    || /(image|picture|photo|frame|video|media) (input )?(isn't|is not|not) supported/i.test(s)
    || /i don't (support|have) (image|vision)/i.test(s);
}

// Collect every accepted media shape into opencode FilePartInput parts.
// Remote http(s) items are downloaded to base64 (size-capped) so the serve
// never has to fetch them itself. Capability is probed at call time — callers
// pass media and the waterfall decides; nothing here hardcodes a model list.
async function buildOpencodeParts(prompt, media = {}, timeoutMs = 15000) {
  const parts = [{ type: "text", text: String(prompt || "") }];
  const urls = [];
  const addB64 = (b64, mimeType, filename) => {
    if (!b64) return;
    parts.push({ type: "file", mime: mimeType || "image/png", filename: filename || "frame.png", url: mediaDataUrl(mimeType || "image/png", stripDataUrlPrefix(String(b64))) });
  };
  const push = (v) => {
    if (!v) return;
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return;
      if (s.startsWith("data:")) { const m = s.match(/^data:([^;,]+)?;base64,/i); addB64(stripDataUrlPrefix(s), (m && m[1]) || "image/png", "frame.png"); }
      else if (/^https?:\/\//i.test(s)) urls.push(s);
      else addB64(s, "image/png", "frame.png");
      return;
    }
    if (v && typeof v === "object") {
      if (v.base64 || v.data) addB64(v.base64 || v.data, v.mimeType || v.mime || "image/png", v.filename);
      else if (v.url && /^https?:\/\//i.test(String(v.url))) urls.push(String(v.url));
      else if (v.url && String(v.url).startsWith("data:")) { const m = String(v.url).match(/^data:([^;,]+)?;base64,/i); addB64(stripDataUrlPrefix(v.url), (m && m[1]) || "image/png", v.filename); }
    }
  };
  push(media.imageBase64);
  for (const v of (media.imageBase64s || media.frameBase64s || [])) push(v);
  for (const v of (media.images || [])) push(v);
  if (media.imageUrls) for (const v of media.imageUrls) push(v);
  if (media.imageUrl) push(media.imageUrl);
  // remote image download
  for (const u of urls.slice(0, 6)) {
    try {
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 20000));
      const res = await fetch(u, { signal: ctrl.signal, redirect: "follow" });
      clearTimeout(tt);
      if (!res.ok) continue;
      const ct = String(res.headers.get("content-type") || "").split(";")[0].trim() || "image/png";
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 12 * 1024 * 1024) continue;
      if (parts.length > 7) continue;
      addB64(buf.toString("base64"), ct.includes("/") ? ct : "image/png", "frame.png");
    } catch { /* keep the text marker path: caller already has URL in prompt */ }
  }
  const vb = media.videoBase64;
  if (vb) addB64(Buffer.isBuffer(vb) ? vb.toString("base64") : stripDataUrlPrefix(String(vb)), media.videoMimeType || "video/mp4", media.videoFilename || "video.mp4");
  if (media.videoUrl) {
    const s = String(media.videoUrl).trim();
    if (s.startsWith("data:")) { const m = s.match(/^data:([^;,]+)?;base64,/i); addB64(stripDataUrlPrefix(s), (m && m[1]) || "video/mp4", media.videoFilename || "video.mp4"); }
    else if (/^https?:\/\//i.test(s)) {
      try {
        const ctrl = new AbortController();
        const tt = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, 20000));
        const res = await fetch(s, { signal: ctrl.signal, redirect: "follow" });
        clearTimeout(tt);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length && buf.length <= 12 * 1024 * 1024) addB64(buf.toString("base64"), String(res.headers.get("content-type") || "video/mp4").split(";")[0].trim() || "video/mp4", media.videoFilename || "video.mp4");
        }
      } catch {}
    }
  }
  // cap file parts (1 text + up to 6 files)
  while (parts.length > 7) parts.pop();
  return { parts, hasMedia: parts.length > 1 };
}

export async function generateWithOpencode({ baseUrl, password, prompt, model, timeoutMs = 120000, imageBase64 = null, imageBase64s = null, frameBase64s = null, images = null, imageUrl = null, imageUrls = null, videoUrl = null, videoBase64 = null, videoMimeType = null, videoFilename = null }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: getAuthHeader(password),
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const throwIfApiError = (json) => {
    let apiErr = json?.info?.error || json?.error || null;
    if (!apiErr && json && typeof json === "object") {
      const lists = [];
      if (Array.isArray(json)) lists.push(json);
      if (Array.isArray(json.messages)) lists.push(json.messages);
      if (Array.isArray(json.data)) lists.push(json.data);
      for (const list of lists) {
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i]?.info?.error || list[i]?.error || null;
          if (e && typeof e === "object") { apiErr = e; break; }
        }
        if (apiErr) break;
      }
    }
    if (apiErr && typeof apiErr === "object") {
      const msg = apiErr?.data?.message || apiErr?.message || apiErr?.name || "opencode_api_error";
      const err = new Error(String(msg));
      err.status = Number(apiErr?.data?.statusCode || apiErr?.status || apiErr?.statusCode) || 502;
      err.apiError = apiErr;
      if (isMediaUnsupportedMsg(String(msg))) { err.retryableModel = true; err.mediaUnsupported = true; }
      throw err;
    }
  };

  try {
    // 1) session + async message API (v1.19.5): POST prompt_async (204) + poll /session/status + /session/:id/message.
    //    Sync POST would hang on free-tier retry (server retries server-side); async lets us fail FAST.
    try {
      const cs = await fetch(`${baseUrl}/api/session`, {
        method: "POST", headers, body: JSON.stringify({}), signal: controller.signal, cache: "no-store",
      });
      const ct = (cs.headers.get("content-type") || "").toLowerCase();
      if (cs.ok && ct.includes("application/json")) {
        const cj = await cs.json();
        const sid = cj?.data?.id || cj?.id;
        if (sid) {
          // v1.19.5 requires model as {providerID, modelID} object (additionalProperties:false).
          const modelObj = normalizeOpencodeModel(model);
          const { parts, hasMedia } = await buildOpencodeParts(prompt, { imageBase64, imageBase64s, frameBase64s, images, imageUrl, imageUrls, videoUrl, videoBase64, videoMimeType, videoFilename }, Math.min(timeoutMs || 15000, 20000));
          const msgBody = { parts, ...(modelObj ? { model: modelObj } : {}) };
          const abortSession = async () => { try { await fetch(`${baseUrl}/session/${sid}/abort`, { method: "POST", headers, body: JSON.stringify({}), cache: "no-store" }); } catch {} };
          // --- async path ---
          const ar = await fetch(`${baseUrl}/session/${sid}/prompt_async`, {
            method: "POST", headers, body: JSON.stringify(msgBody), signal: controller.signal, cache: "no-store",
          });
          if (ar.ok || ar.status === 204) {
            const deadline = Date.now() + Math.max(15000, timeoutMs || 90000);
            while (Date.now() < deadline) {
              if (controller.signal.aborted) throw new Error("aborted");
              await new Promise((r) => setTimeout(r, 1500));
              // status check for free-limit retry
              try {
                const sr = await fetch(`${baseUrl}/session/status`, { headers: { Authorization: getAuthHeader(password), Accept: "application/json" }, cache: "no-store" });
                const sct = (sr.headers.get("content-type") || "").toLowerCase();
                if (sr.ok && sct.includes("application/json")) {
                  const sj = await sr.json();
                  const st = sj?.[sid];
                  const _sm = String(st?.message || st?.action?.message || "");
                  const _sr = String(st?.action?.reason || "").toLowerCase();
                  if (st && st.type === "retry" && (/free.*limit|subscribe|weekly.*limit|usage.*limit|quota|balance/i.test(_sm) || /limit|quota|usage|balance/.test(_sr))) {
                    const err = new Error(String(st.message || "Free usage exceeded, subscribe to Go"));
                    err.status = 429; err.retryableModel = true; await abortSession(); throw err;
                  }
                  if (st && st.type === "idle") {
                    // fall through to message check before giving up
                  }
                }
              } catch (e) { if (e?.status === 429) throw e; }
              for (const gp of [`/session/${sid}/message`, `/api/session/${sid}/message`]) {
                const gr = await fetch(`${baseUrl}${gp}`, { headers: { Authorization: getAuthHeader(password), Accept: "application/json" }, cache: "no-store" });
                const gct = (gr.headers.get("content-type") || "").toLowerCase();
                if (!gr.ok || !gct.includes("application/json")) continue;
                const gj = await gr.json();
                const ae = gj?.info?.error || gj?.error || gj?.data?.error;
                if (ae && typeof ae === "object") throwIfApiError(gj);
                const text = extractTextFromMessage(gj);
                if (text) {
                  if (hasMedia && isMediaUnsupportedResponse(text)) {
                    const err = new Error(`opencode_media_unsupported: ${String(text).slice(0, 160)}`);
                    err.status = 422; err.retryableModel = true; err.mediaUnsupported = true; err.cantSee = true;
                    await abortSession(); throw err;
                  }
                  const clean = sanitizeOpencodeText(text);
                  if (clean) { await abortSession(); return clean; }
                  // empty after sanitize (bad data) — keep polling, never return HTML/controls
                }
              }
            }
            await abortSession();
            const et = new Error("opencode_timeout"); et.status = 408; throw et;
          }
          if (ar.status !== 404) {
            // validation / server error on this model shape: don't waste time on sync in same session
            const act = (ar.headers.get("content-type") || "").toLowerCase();
            if (act.includes("application/json")) {
              const aj = await ar.json().catch(() => null);
              try { throwIfApiError(aj || {}); } catch (e) { if (e?.apiError) throw e; }
              const err = new Error(aj?.message || `opencode_async_${ar.status}`); err.status = ar.status;
              if (isMediaUnsupportedMsg(String(aj?.message || ""))) { err.retryableModel = true; err.mediaUnsupported = true; }
              throw err;
            }
            const err = new Error(`opencode_async_${ar.status}`); err.status = ar.status; throw err;
          }
          // async route missing (404) → fall through to sync below (text-only for legacy)
          if (hasMedia) console.warn("[opencode] async route missing — file parts will be dropped on legacy fallback");
          // async route missing (404) → fall through to sync below
        }
      }
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (e?.status === 429 || e?.apiError) throw e;
      if (e?.status === 408) throw e;
      // fall through to legacy endpoint (sync attempts below are skipped; async 404 is the only sync trigger)
      if (e?.status && e.status !== 404) console.warn("[opencode] session API path failed, trying legacy:", e.message);
    }

    // 2) Legacy/experimental endpoint fallback
    const res = await fetch(`${baseUrl}/api/experimental/generate/text`, {
      method: "POST", headers, body: JSON.stringify({ prompt, model: normalizeOpencodeModel(model) }), signal: controller.signal, cache: "no-store",
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
    const text = sanitizeOpencodeText(extractTextFromMessage(json));
    if (text) return text;
    throw ((() => { const e = new Error("opencode_empty_response"); e.status = 502; e.retryableModel = true; return e; })());
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
