import { NextResponse } from "next/server";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";
import axios from "axios";
import * as cheerio from "cheerio";
import crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import MultiProviderAI from "../../../utils/multiProviderAI.js";

const execFileAsync = promisify(execFile);
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings, sanitizeForCsv, getPerformancePresets } from "../_shared/pipelineUtils.js";
import { getSelfUrl, getSelfUrlWithFallback, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits, checkUserQuota } from "../../socials/_shared/limits.js";
import { updateUserUsage } from "../../socials/_shared/hubUpdater.js";

// Validate/enrich/personalize must be able to run to completion for all rows.
export const maxDuration = 0;
export const dynamic = "force-dynamic";

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "mail.com", "zoho.com", "yandex.com", "protonmail.com", "proton.me", "gmx.com",
  "mail.ru", "live.com", "msn.com", "googlemail.com", "me.com"
]);

function normHeader(h) { return String(h || "").trim().toUpperCase(); }
function normKey(h) { return String(h || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
const HEADER_ALIASES = {
  EMAIL: ["email", "e-mail", "mail", "emailaddress", "workemail", "businessemail"],
  FIRSTNAME: ["firstname", "first_name", "first name", "givenname", "fname", "contactfirstname"],
  LASTNAME: ["lastname", "last_name", "last name", "surname", "familyname", "lname", "contactlastname"],
  FULLNAME: ["fullname", "full_name", "full name", "name", "contactname", "personname", "leadname"],
  BUSINESSNAME: ["businessname", "company", "companyname", "organization", "org", "business", "employer"],
  BUSINESSPHONE: ["businessphone", "companyphone", "workphone", "officephone"],
  PHONE: ["phone", "mobile", "cell", "telephone", "phonenumber"],
  URL: ["url", "website", "site", "domain", "web", "companyurl", "homepage"],
  CONTEXT: ["context", "notes", "note", "description", "about", "bio"],
  JOBTITLE: ["jobtitle", "title", "position", "role"],
  CITY: ["city", "town"],
  STATE: ["state", "region", "province"],
  COUNTRY: ["country"],
};
function resolveHeaderIndex(headers, nameOrAliases) {
  const want = Array.isArray(nameOrAliases) ? nameOrAliases : (HEADER_ALIASES[normHeader(nameOrAliases)] || [nameOrAliases]);
  const keys = new Set(want.map(normKey));
  for (let i = 0; i < headers.length; i++) {
    if (keys.has(normKey(headers[i]))) return i;
  }
  // fallback exact normalized header
  if (!Array.isArray(nameOrAliases)) {
    const n = normHeader(nameOrAliases);
    const idx = headers.indexOf(n);
    if (idx >= 0) return idx;
  }
  return -1;
}
function getCell(row, headers, nameOrAliases) {
  const idx = resolveHeaderIndex(headers, nameOrAliases);
  return idx >= 0 ? String(row[idx] || "").trim() : "";
}
function setCell(row, headers, nameOrAliases, value) {
  const idx = resolveHeaderIndex(headers, nameOrAliases);
  if (idx >= 0) row[idx] = sanitizeForCsv(String(value ?? ""));
}
function ensureColumn(headers, rows, name) {
  const n = normHeader(name);
  let idx = headers.indexOf(n);
  if (idx === -1) {
    headers.push(n);
    idx = headers.length - 1;
    for (const r of rows) r[idx] = "";
  }
  return idx;
}
function cleanText(v) { return String(v ?? "").replace(/\s+/g, " ").trim(); }
function isPlaceholder(v) {
  const s = cleanText(v).toLowerCase();
  return !s || ["n/a", "na", "none", "null", "undefined", "-", "--", "unknown", "not available", "n.a."].includes(s);
}
function normalizeEmailValue(v) {
  const s = cleanText(v).toLowerCase().replace(/^mailto:/, "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  return s;
}
function getEmailDomain(email) {
  const e = normalizeEmailValue(email);
  const at = e.lastIndexOf("@");
  return at > 0 ? e.slice(at + 1).toLowerCase() : "";
}
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
function splitFullName(full) {
  const s = cleanText(full).replace(/,+/g, " ");
  if (!s) return { first: "", last: "" };
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return { first: parts[0], last: "" };
  if (parts.length === 2) return { first: parts[0], last: parts[1] };
  let lastParts = [parts[parts.length - 1]];
  let rest = parts.slice(0, -1);
  const lastTok = lastParts[0].toLowerCase().replace(/\./g, "");
  if (NAME_SUFFIXES.has(lastTok) && rest.length >= 2) {
    lastParts = [rest[rest.length - 1], parts[parts.length - 1]];
    rest = rest.slice(0, -1);
  }
  // keep multi-part surnames common patterns (de/van/von/da/del/la/st) as part of last when present
  if (rest.length >= 2) {
    const prev = rest[rest.length - 1].toLowerCase().replace(/\./g, "");
    if (["de", "del", "da", "dos", "das", "van", "von", "der", "den", "la", "le", "st", "st."].includes(prev)) {
      lastParts = [rest[rest.length - 1], ...lastParts];
      rest = rest.slice(0, -1);
    }
  }
  return { first: rest.join(" "), last: lastParts.join(" ") };
}
function namesLooselyEqual(a, b) {
  const na = cleanText(a).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const nb = cleanText(b).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  return !!na && na === nb;
}
function containsWordPhrase(hay, needle) {
  const h = cleanText(hay).toLowerCase();
  const n = cleanText(needle).toLowerCase();
  if (!h || !n) return false;
  return h === n || h.endsWith(" " + n) || h.startsWith(n + " ") || h.includes(" " + n + " ");
}
function preNormalizeRow(row, headers) {
  const notes = [];
  const get = (n) => getCell(row, headers, n);
  const set = (n, v) => setCell(row, headers, n, v);

  // basic cleanup
  for (let i = 0; i < headers.length; i++) {
    const v = String(row[i] ?? "");
    if (!v) continue;
    const cleaned = cleanText(v);
    if (isPlaceholder(cleaned)) { row[i] = ""; continue; }
    if (cleaned !== v) row[i] = sanitizeForCsv(cleaned);
  }

  // normalize email
  const emailIdx = resolveHeaderIndex(headers, "EMAIL");
  if (emailIdx >= 0) {
    const raw = String(row[emailIdx] || "").trim();
    const ne = normalizeEmailValue(raw);
    if (ne && ne !== raw) { row[emailIdx] = sanitizeForCsv(ne); notes.push("normalized email"); }
  }

  let first = get("FIRSTNAME");
  let last = get("LASTNAME");
  const full = get("FULLNAME");

  // derive from FULLNAME if missing
  if ((!first || !last) && full) {
    const sp = splitFullName(full);
    if (!first && sp.first) { set("FIRSTNAME", sp.first); first = sp.first; notes.push("derived first from full name"); }
    if (!last && sp.last) { set("LASTNAME", sp.last); last = sp.last; notes.push("derived last from full name"); }
  }

  // repair FIRSTNAME containing full name / duplicated LASTNAME (reported case)
  if (first) {
    const fParts = cleanText(first).split(/\s+/).filter(Boolean);
    if (last) {
      const lClean = cleanText(last);
      const fClean = cleanText(first);
      if (fParts.length >= 2 && (namesLooselyEqual(fClean, lClean) ? false : (fClean.toLowerCase().endsWith(" " + lClean.toLowerCase()) || namesLooselyEqual(fParts[fParts.length - 1], lClean)))) {
        // if first ends with last (or last token equals last) and first has extra tokens -> split
        if (fClean.toLowerCase() !== lClean.toLowerCase()) {
          const newLast = lClean; // keep provided last (may be multi-part)
          let newFirst = fClean;
          if (fClean.toLowerCase().endsWith(" " + lClean.toLowerCase())) {
            newFirst = fClean.slice(0, fClean.length - lClean.length).trim();
          } else if (namesLooselyEqual(fParts[fParts.length - 1], lClean) && fParts.length >= 2) {
            newFirst = fParts.slice(0, -1).join(" ");
          }
          if (newFirst && newFirst.toLowerCase() !== fClean.toLowerCase()) {
            set("FIRSTNAME", newFirst); first = newFirst; notes.push("split first/last (removed duplicated last from first)");
          }
        }
      } else if (fParts.length >= 2 && fClean.toLowerCase() === lClean.toLowerCase()) {
        // identical first/last -> try split
        const sp = splitFullName(fClean);
        if (sp.first && sp.last) { set("FIRSTNAME", sp.first); set("LASTNAME", sp.last); first = sp.first; last = sp.last; notes.push("split identical first/last"); }
      } else if (fParts.length >= 2 && !lClean) {
        const sp = splitFullName(fClean); if (sp.last) { set("FIRSTNAME", sp.first); set("LASTNAME", sp.last); first = sp.first; last = sp.last; notes.push("split full name in first"); }
      }
    } else if (fParts.length >= 2) {
      const sp = splitFullName(first);
      if (sp.first && sp.last) { set("FIRSTNAME", sp.first); set("LASTNAME", sp.last); first = sp.first; last = sp.last; notes.push("split full name in first (no last)"); }
    }
  }

  // if FIRSTNAME still empty but LASTNAME contains full name
  first = get("FIRSTNAME"); last = get("LASTNAME");
  if (!first && last && cleanText(last).split(/\s+/).length >= 2) {
    const sp = splitFullName(last); if (sp.first && sp.last) { set("FIRSTNAME", sp.first); set("LASTNAME", sp.last); notes.push("split full name in last"); }
  }

  // trim company/context basic
  const biz = get("BUSINESSNAME"); if (biz) { const b = cleanText(biz); if (b !== biz) set("BUSINESSNAME", b); }
  const ctx = get("CONTEXT"); if (ctx) { const c = cleanText(ctx); if (c !== ctx) set("CONTEXT", c); }

  return { changed: notes.length > 0, notes };
}

function rowKnownData(row, headers) {
  const data = {};
  headers.forEach((h, i) => {
    const v = String(row[i] || "").trim();
    if (!v) return;
    // exclude large/template/system-ish fields
    if (["EMAILSUBJECT","EMAILBODY","SOCIALMESSAGE","REPLYTO","ENHANCEDSUBJECT","ENHANCEDBODY","ENHANCEDSOCIALMESSAGE"].includes(h)) return;
    if (h.startsWith("__")) return;
    data[h] = v.slice(0, 300);
  });
  return data;
}

function hasSearchableData(row, headers) {
  const email = normalizeEmailValue(getCell(row, headers, "EMAIL"));
  const first = getCell(row, headers, "FIRSTNAME");
  const last = getCell(row, headers, "LASTNAME");
  const company = getCell(row, headers, "BUSINESSNAME") || getCell(row, headers, "COMPANY");
  const url = getCell(row, headers, "URL") || getCell(row, headers, "WEBSITE");
  const social = getCell(row, headers, "SOCIALUSERNAME");
  if (email || first || last || company || url || social) return true;
  const ignore = new Set(["SN","CAMPAIGNTYPE","ENGINE","PROVIDER","SMTP","PORT","USERNAME","PASSWORD","APPPASSWORD","BACKUPCODE","OAUTH2CLIENTID","OAUTH2CLIENTSECRET","OAUTH2REFRESHTOKEN","SHOULDVALIDATE","SHOULDENHANCE","SHOULDSEARCHINTERACT","SHOULDPAGEINTERACT","SHOULDINBOXINTERACT","SHOULDACTIVITIESINTERACT","SHOULDSENDMESSAGE","VALIDATION","PROVIDERMXRESULT","ENRICHMENTSTATUS","SENDDATE","SENDTIME","SENDSTAMP","SEARCHKEYS","SEARCHCOUNT","SEARCHSTATUS","SEARCHSTAMP","PROFILETOINTERACT","INTERACTCOUNT","INTERACTSTATUS","INTERACTSTAMP","PERSONALIZATIONSTATUS","EXECUTIONSTATUS","ENHANCEDSUBJECT","ENHANCEDBODY","ENHANCEDSOCIALMESSAGE","EMAILSUBJECT","EMAILBODY","SOCIALMESSAGE","REPLYTO"]);
  for (let i = 0; i < headers.length; i++) {
    const h = normHeader(headers[i]);
    if (ignore.has(h) || h.startsWith("__")) continue;
    if (cleanText(row[i])) return true;
  }
  return false;
}

function getIdentity(row, headers) {
  const email = normalizeEmailValue(getCell(row, headers, "EMAIL"));
  const first = cleanText(getCell(row, headers, "FIRSTNAME"));
  const last = cleanText(getCell(row, headers, "LASTNAME"));
  const full = cleanText(getCell(row, headers, "FULLNAME")) || [first, last].filter(Boolean).join(" ").trim();
  const company = cleanText(getCell(row, headers, "BUSINESSNAME") || getCell(row, headers, "COMPANY"));
  const url = cleanText(getCell(row, headers, "URL") || getCell(row, headers, "WEBSITE"));
  const domain = getEmailDomain(email);
  return { email, first, last, full, company, url, domain };
}

function buildHeuristicQueries(row, headers) {
  const { email, first, last, full, company, url, domain } = getIdentity(row, headers);
  const social = getCell(row, headers, "SOCIALUSERNAME");
  const platform = getCell(row, headers, "SOCIALPLATFORM");
  const fullName = full || [first, last].filter(Boolean).join(" ").trim();
  const queries = [];
  if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
    queries.push(`site:${domain} about OR contact OR team`);
    queries.push(`"${domain}" company ${company || fullName || ""}`.trim());
    if (fullName) queries.push(`"${fullName}" "${domain}"`);
  }
  if (email) {
    queries.push(`"${email}"`);
    if (GENERIC_EMAIL_DOMAINS.has(domain) && fullName) queries.push(`"${fullName}" ${domain.split(".")[0] || ""} profile`.trim());
  }
  if (fullName && company) queries.push(`"${fullName}" "${company}" contact OR profile`);
  else if (fullName) queries.push(`"${fullName}" ${company || ""} profile OR linkedin`.trim());
  if (company) queries.push(`"${company}" official website contact email`);
  if (social) queries.push(`${platform || ""} "${social}" profile`.trim());
  if (url) {
    try { const u = new URL(url.startsWith("http") ? url : `https://${url}`); queries.push(`site:${u.hostname} about OR contact OR team`); } catch { queries.push(`"${url}" contact about`); }
  }
  if (domain && GENERIC_EMAIL_DOMAINS.has(domain) && !fullName) {
    const user = email.split("@")[0] || "";
    if (user) queries.push(`"${user}" ${domain} profile`);
  }
  return Array.from(new Set(queries.map(q => cleanText(q)).filter(Boolean))).slice(0, 8);
}

async function scrapeUrl(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 12000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
    });
    const $ = cheerio.load(resp.data || "");
    $("script, style, noscript, svg, nav, footer").remove();
    const title = $("title").first().text().trim() || $("meta[property='og:title']").attr("content") || "";
    const description = $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "";
    const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4500);
    const links = [];
    $("a[href]").each((_, el) => {
      if (links.length >= 25) return false;
      const href = $(el).attr("href");
      if (!href) return;
      try { const abs = new URL(href, url).toString(); if (abs.startsWith("http")) links.push(abs); } catch {}
    });
    return { url, title, description, bodyText, links };
  } catch (err) {
    return null;
  }
}

async function deepScrape(url) {
  const main = await scrapeUrl(url);
  if (!main) return null;
  const internalTexts = [];
  const baseHost = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  const interesting = (main.links || []).filter(l => {
    try {
      const u = new URL(l); if (baseHost && u.hostname !== baseHost) return false;
      return /about|contact|team|company|services|profile|people|leadership|impressum|staff|who-we-are|our-team/i.test(u.pathname + u.search);
    } catch { return false; }
  }).slice(0, 4);
  const extras = await Promise.allSettled(interesting.map(l => scrapeUrl(l)));
  for (const r of extras) {
    if (r.status === "fulfilled" && r.value) {
      const v = r.value;
      internalTexts.push([v.title, v.description, v.bodyText].filter(Boolean).join(" ").slice(0, 1800));
    }
  }
  return { ...main, internalTexts };
}

async function googleSearch(query) {
  try {
    const resp = await axios.get("https://www.google.com/search", {
      params: { q: query, num: 5, hl: "en" }, timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" },
    });
    const $ = cheerio.load(resp.data || "");
    const results = [];
    $("div.g, div[data-sokoban-container]").each((_, el) => {
      if (results.length >= 5) return false;
      const a = $(el).find("a[href^='http']").first();
      const href = a.attr("href"); const title = $(el).find("h3").first().text().trim(); const snippet = $(el).find(".VwiC3b, span.aCOpRe").first().text().trim();
      if (href && !href.includes("google.com/search")) results.push({ url: href, title, snippet });
    });
    return results;
  } catch { return []; }
}
async function bingSearch(query) {
  try {
    const resp = await axios.get("https://www.bing.com/search", { params: { q: query, count: 5 }, timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36" } });
    const $ = cheerio.load(resp.data || ""); const results = [];
    $("li.b_algo").each((_, el) => {
      if (results.length >= 5) return false;
      const link = $(el).find("h2 a").attr("href"); const title = $(el).find("h2").text().trim(); const snippet = $(el).find(".b_caption p").text().trim();
      if (link && link.startsWith("http")) results.push({ url: link, title, snippet });
    }); return results;
  } catch { return []; }
}
async function duckDuckGoSearch(query) {
  try {
    const resp = await axios.get("https://html.duckduckgo.com/html/", { params: { q: query }, timeout: 10000, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36" } });
    const $ = cheerio.load(resp.data || ""); const results = [];
    $(".result").each((_, el) => {
      if (results.length >= 5) return false;
      const a = $(el).find("a.result__a"); const href = a.attr("href"); const title = a.text().trim(); const snippet = $(el).find(".result__snippet").text().trim();
      if (href && href.startsWith("http")) results.push({ url: href, title, snippet });
    }); return results;
  } catch { return []; }
}
let _searxngWarned = false;
let _ddgsWarned = false;
async function searxngSearch(query) {
  const base = (process.env.SEARXNG_URL || process.env.SEARX_URL || process.env.CXNG_URL || "").trim();
  if (!base) return [];
  try {
    const resp = await axios.get(`${base.replace(/\/$/, "")}/search`, { params: { q: query, format: "json" }, timeout: 12000 });
    const results = (resp.data?.results || []).slice(0, 8).map(r => ({ url: r.url, title: r.title, snippet: r.content || r.snippet }));
    return results.filter(r => r.url);
  } catch (e) {
    if (!_searxngWarned) { _searxngWarned = true; try { logger.warn(`[enrich] SearXNG search failed (${base}): ${e.message}`); } catch {} }
    return [];
  }
}
async function ddgsSearch(query) {
  // Local metasearch fallback via Python `ddgs` package (no external instance/Docker required).
  // Portable: works wherever Python + `pip install -r requirements-enrichment.txt` is available.
  const q = String(query || "").trim();
  if (!q) return [];
  const configured = (process.env.PYTHON_BIN || "").trim();
  const candidates = configured ? [configured] : (process.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"]);
  const code = `import json,sys\ntry:\n  from ddgs import DDGS\nexcept Exception:\n  from duckduckgo_search import DDGS\nq=sys.argv[1]\ntry:\n  r=DDGS().text(q, max_results=6)\n  out=[]\n  for x in (r or []):\n    if isinstance(x,dict): out.append({'url':x.get('href') or x.get('url'),'title':x.get('title'),'snippet':x.get('body') or x.get('snippet')})\n  print(json.dumps(out, ensure_ascii=False))\nexcept Exception:\n  print('[]')`;
  for (const py of candidates) {
    const args = (py.toLowerCase() === "py" && process.platform === "win32") ? ["-3", "-c", code, q] : ["-c", code, q];
    try {
      const { stdout } = await execFileAsync(py, args, { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 });
      const raw = String(stdout || "[]").trim();
      const start = raw.indexOf("["); const end = raw.lastIndexOf("]");
      const jsonText = (start >= 0 && end >= start) ? raw.slice(start, end + 1) : "[]";
      const parsed = JSON.parse(jsonText);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(r => ({ url: r?.url, title: r?.title, snippet: r?.snippet })).filter(r => r.url).slice(0, 6);
    } catch (e) {
      // try next interpreter candidate
      if (e && e.code === "ENOENT") continue;
      // package missing/runtime error: try next candidate once, but don't spam
      continue;
    }
  }
  if (!_ddgsWarned) { _ddgsWarned = true; try { logger.warn(`[enrich] ddgs local search unavailable (install with: pip install -r requirements-enrichment.txt)`); } catch {} }
  return [];
}
async function multiSearch(query) {
  const settled = await Promise.allSettled([searxngSearch(query), ddgsSearch(query), googleSearch(query), bingSearch(query), duckDuckGoSearch(query)]);
  const out = []; const seen = new Set();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of (r.value || [])) {
      const u = String(item?.url || ""); if (!u || seen.has(u)) continue; seen.add(u); out.push(item);
    }
  }
  return out.slice(0, 12);
}

function parseJsonLoose(ai, text) {
  const parsed = ai.parseAiJson(text);
  if (parsed) return parsed;
  try {
    const m = String(text || "").match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return null;
}

function cleanEmail(v) {
  return normalizeEmailValue(v);
}

async function gravatarLookup(email) {
  const e = normalizeEmailValue(email);
  if (!e) return null;
  const hash = crypto.createHash("md5").update(e).digest("hex");
  try {
    const resp = await axios.get(`https://en.gravatar.com/${hash}.json`, { timeout: 8000, validateStatus: s => s === 200 || s === 404 });
    if (resp.status !== 200 || !resp.data) return null;
    const entry = (resp.data.entry && resp.data.entry[0]) || null;
    if (!entry) return null;
    const accounts = Array.isArray(entry.accounts) ? entry.accounts.map(a => ({ domain: a.domain, username: a.username, url: a.url, display: a.display })).filter(a => a.url || a.username) : [];
    const urls = Array.isArray(entry.urls) ? entry.urls.map(u => ({ title: u.title, value: u.value })).filter(u => u.value) : [];
    const nameObj = entry.name || {};
    const displayName = cleanText(entry.displayName || entry.preferredUsername || [nameObj.givenName, nameObj.familyName].filter(Boolean).join(" "));
    const location = cleanText(entry.currentLocation || "");
    const about = cleanText(entry.aboutMe || "");
    const profileUrl = entry.profileUrl || `https://gravatar.com/${hash}`;
    return { email: e, hash, displayName, givenName: cleanText(nameObj.givenName || ""), familyName: cleanText(nameObj.familyName || ""), location, about, profileUrl, accounts, urls, thumbnailUrl: entry.thumbnailUrl || "" };
  } catch {
    return null;
  }
}

async function gatherEmailSignals(row, headers) {
  const id = getIdentity(row, headers);
  const evidence = [];
  const fills = {};
  const notes = [];
  if (!id.email) return { evidence, fills, notes };

  // Gravatar (free, verifiable profile signal)
  const g = await gravatarLookup(id.email);
  if (g) {
    const gTextParts = [g.displayName && `Name: ${g.displayName}`, g.location && `Location: ${g.location}`, g.about && `About: ${g.about}`,
      (g.accounts || []).slice(0, 5).map(a => `${a.domain || "account"}: ${a.url || a.username}`).join("; "),
      (g.urls || []).slice(0, 5).map(u => u.value).join("; ")
    ].filter(Boolean);
    evidence.push({ url: g.profileUrl, title: `Gravatar: ${g.displayName || id.email}`, description: g.about || "", bodyText: gTextParts.join("\n").slice(0, 4000), internalTexts: [], snippet: "Gravatar public profile" });
    const sp = splitFullName(g.displayName || "");
    if (!id.first && sp.first) fills.FIRSTNAME = sp.first;
    if (!id.last && sp.last) fills.LASTNAME = sp.last;
    if (!getCell(row, headers, "CONTEXT")) {
      const bits = [g.displayName, g.about, g.location].filter(Boolean).join(" — ");
      if (bits) fills.CONTEXT = cleanText(bits).slice(0, 300);
    }
    // if gravatar exposes accounts, keep as evidence (not blindly writing platform fields)
    notes.push("gravatar");
  }

  // Domain/company intelligence for non-generic emails
  if (id.domain && !GENERIC_EMAIL_DOMAINS.has(id.domain)) {
    const baseUrl = `https://${id.domain}`;
    const scraped = await deepScrape(baseUrl);
    if (scraped) {
      evidence.push({ ...scraped, snippet: "Company domain site" });
      // try to infer business name from title if missing
      if (!id.company) {
        const t = cleanText(scraped.title || "").split(/[|\-–—:]/)[0].trim();
        if (t && t.length >= 2 && t.length <= 80) fills.BUSINESSNAME = t;
      }
    }
    notes.push("domain");
  }

  return { evidence, fills, notes };
}

async function aiSuggestQueries(ai, row, headers, enrichmentContext, missingTargets = []) {
  const known = rowKnownData(row, headers);
  const prompt = `You generate web search queries to enrich a lead/contact/company record.
Known row data (JSON): ${JSON.stringify(known).slice(0, 4000)}
Enrichment context/instructions: ${enrichmentContext || "(none)"}
Still missing or low-confidence targets: ${missingTargets.join(", ") || "(general enrichment)"}

Return ONLY a JSON array of 3 to 8 short, specific search query strings.
Prioritize: verifiable identity (name/company), public profiles, official company/about/contact/team pages, and verifiable email/contact details. Use quoted names/emails/domains where useful. Do not invent facts.`;
  try {
    const text = await ai.generate(prompt, { maxTokens: 700, jsonMode: true });
    const parsed = parseJsonLoose(ai, text);
    if (Array.isArray(parsed)) {
      const qs = parsed.map(x => String(x || "").trim()).filter(Boolean).slice(0, 8);
      if (qs.length) return qs;
    }
  } catch {}
  return buildHeuristicQueries(row, headers).slice(0, 8);
}

async function aiExtractRow(ai, row, headers, evidence, enrichmentContext, targetColumns) {
  const known = rowKnownData(row, headers);
  const ev = (evidence || []).slice(0, 10).map((e, i) => ({
    i: i + 1,
    url: e.url, title: e.title, snippet: e.snippet,
    description: e.description,
    text: (e.bodyText || "").slice(0, 1800),
    internal: (e.internalTexts || []).join(" ").slice(0, 1400)
  }));
  const prompt = `You are a precise data enrichment agent. Extract ONLY verifiable information from evidence for this row.

Target columns (fill only if supported): ${targetColumns.join(", ")}
Known row data: ${JSON.stringify(known).slice(0, 3500)}
Enrichment context/instructions: ${enrichmentContext || "General enrichment: extract all available verifiable business/personal information."}

Evidence (JSON): ${JSON.stringify(ev).slice(0, 14000)}

Rules:
- Only fill fields directly supported by known data or evidence. If not verifiable, leave empty.
- Correct/split identity when evident: if FIRSTNAME contains a full name and LASTNAME duplicates/should be split, return corrected FIRSTNAME and LASTNAME.
- If EMAIL is missing/empty and a verifiable email is found in evidence, include EMAIL.
- CONTEXT should be a concise 1-3 sentence factual summary grounded in evidence (who they are/company/role/location/contact hints) when supported.
- Follow enrichment context priorities when provided.
- Return ONLY a JSON object with keys from target columns plus "confidence" ("high"|"medium"|"low"|"none") and "missing" (array of target columns still unknown/unverified).
- When confidence is "none", return empty values for unverified fields.`;
  try {
    const text = await ai.generate(prompt, { maxTokens: 2500, jsonMode: true });
    const parsed = parseJsonLoose(ai, text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return { confidence: "none", missing: targetColumns };
}

async function aiReviewRow(ai, extracted, row, headers, evidence, enrichmentContext, targetColumns) {
  const known = rowKnownData(row, headers);
  const prompt = `Review this enrichment extraction for correctness and unsupported claims.
Target columns: ${targetColumns.join(", ")}
Known row data: ${JSON.stringify(known).slice(0, 2500)}
Enrichment context: ${enrichmentContext || "(none)"}
Evidence snippets: ${JSON.stringify((evidence||[]).slice(0,6).map(e=>({url:e.url,title:e.title,text:(e.bodyText||"").slice(0,500)}))).slice(0,6000)}
Extraction: ${JSON.stringify(extracted).slice(0,4000)}

Return ONLY a JSON object with the same target column keys plus "confidence" and "missing". Remove any value not supported by evidence/known data. Keep empty string for unknown. Correct obvious name-split errors if evidence supports.`;
  try {
    const text = await ai.generate(prompt, { maxTokens: 1800, jsonMode: true });
    const parsed = parseJsonLoose(ai, text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {}
  return extracted;
}

function normalizeExtracted(extracted, targetColumns, headers) {
  const out = { confidence: String(extracted?.confidence || "none").toLowerCase(), missing: Array.isArray(extracted?.missing) ? extracted.missing : [] };
  for (const col of targetColumns) {
    let v = extracted?.[col] ?? extracted?.[col.toLowerCase()] ?? extracted?.[col.toUpperCase()] ?? "";
    if (col === "EMAIL") v = cleanEmail(v);
    else if (typeof v === "string") v = cleanText(v);
    out[col] = typeof v === "string" ? v : (v == null ? "" : String(v).trim());
  }
  if (headers.includes("EMAIL")) {
    const ev = cleanEmail(extracted?.EMAIL || extracted?.email || out.EMAIL || "");
    if (ev) out.EMAIL = ev;
  }
  if (!["high","medium","low","none"].includes(out.confidence)) out.confidence = "low";
  // if model returns empty names under none, keep as-is (don't force blanks except truly empty)
  if (out.confidence === "none") {
    for (const col of targetColumns) {
      if (col === "FIRSTNAME" || col === "LASTNAME" || col === "BUSINESSNAME") continue;
      // keep CONTEXT only if meaningful
      if (col === "CONTEXT" && String(out[col] || "").length < 20) out[col] = "";
      else if (col !== "CONTEXT") out[col] = out[col] || "";
    }
  }
  return out;
}

function getTargetColumns(headers) {
  const preferred = ["FIRSTNAME","LASTNAME","JOBTITLE","BUSINESSNAME","BUSINESSCITY","BUSINESSSTATE","BUSINESSCOUNTRY","BUSINESSZIPCODE","BUSINESSPHONE","BUSINESSEMAIL","EMAIL","CONTEXT","SOCIALUSERNAME","SOCIALPLATFORM","URL","WEBSITE","ADDRESS","CITY","STATE","COUNTRY","ZIPCODE","PHONE"];
  const targets = preferred.filter(c => headers.includes(c));
  if (!targets.includes("EMAIL") && headers.includes("EMAIL")) targets.unshift("EMAIL");
  if (!targets.includes("CONTEXT") && headers.includes("CONTEXT")) targets.push("CONTEXT");
  // also allow alias-resolved logical targets to be written if present via aliases (handled in apply)
  return Array.from(new Set(targets));
}

function isMisfilledName(first, last) {
  const f = cleanText(first), l = cleanText(last);
  if (!f || !l) return false;
  const fParts = f.split(/\s+/);
  if (fParts.length < 2) return false;
  const fl = f.toLowerCase(), ll = l.toLowerCase();
  return fl.endsWith(" " + ll) || namesLooselyEqual(fParts[fParts.length - 1], l) || fl === ll;
}

function applyField(row, headers, col, value, { allowCorrect = false } = {}) {
  const v = cleanText(value);
  if (!v) return false;
  const existing = getCell(row, headers, col);
  if (!existing) { setCell(row, headers, col, v); return true; }
  if (col === "CONTEXT") {
    if (v.length > existing.length + 15 && v.toLowerCase() !== existing.toLowerCase()) { setCell(row, headers, col, v); return true; }
    return false;
  }
  if (!allowCorrect) return false;
  if (col === "FIRSTNAME" || col === "LASTNAME") {
    if (isMisfilledName(getCell(row, headers, "FIRSTNAME"), getCell(row, headers, "LASTNAME"))) {
      // apply corrected split
      if (v.toLowerCase() !== existing.toLowerCase()) { setCell(row, headers, col, v); return true; }
    }
    return false;
  }
  if ((col === "BUSINESSNAME" || col === "EMAIL") && isPlaceholder(existing)) { setCell(row, headers, col, v); return true; }
  return false;
}

function isRowEnrichedFinal(row, headers) {
  const s = String(getCell(row, headers, "enrichmentStatus") || "").toLowerCase();
  return s === "enriched" || s === "no_data" || s === "skipped";
}

async function enrichOneRow({ row, headers, ai, enrichmentContext, scrapeConcurrency }) {
  // 1) Deterministic normalization/repair (schema-agnostic, safe corrections) - persisted in-row
  const norm = preNormalizeRow(row, headers);
  let updated = norm.changed;
  let anyValue = norm.changed; // normalization is a meaningful improvement when it changes data

  const targetColumns = getTargetColumns(headers);
  if (!hasSearchableData(row, headers)) {
    return { status: "no_data", reason: "no_searchable_data", updated, confidence: "none" };
  }

  // 2) Free email-based signals (Gravatar + domain/company site) as verifiable evidence/fills
  let evidence = [];
  try {
    const sig = await gatherEmailSignals(row, headers);
    evidence = evidence.concat(sig.evidence || []);
    for (const [k, v] of Object.entries(sig.fills || {})) {
      if (!v) continue;
      const existing = getCell(row, headers, k);
      if (!existing) { setCell(row, headers, k, v); updated = true; anyValue = true; }
      else if (k === "CONTEXT" && String(v).length > existing.length + 15) { setCell(row, headers, k, v); updated = true; anyValue = true; }
    }
  } catch {}

  // 3) Known URL / domain evidence
  const knownUrl = getCell(row, headers, "URL") || getCell(row, headers, "WEBSITE");
  if (knownUrl) {
    try {
      const u = knownUrl.startsWith("http") ? knownUrl : `https://${knownUrl}`;
      if (!evidence.some(e => e && e.url && e.url.includes(u.replace(/^https?:\/\//, "").split("/")[0]))) {
        const scraped = await deepScrape(u);
        if (scraped) evidence.push(scraped);
      }
    } catch {}
  }

  let queries = await aiSuggestQueries(ai, row, headers, enrichmentContext, []);
  let extracted = null;
  let reviewed = null;

  for (let round = 0; round < 3; round++) { // initial + up to 2 refinements
    const qset = (queries || []).slice(0, 8);
    const searchSettled = await Promise.allSettled(qset.map(q => multiSearch(q)));
    const found = [];
    const seen = new Set(evidence.map(e => e && e.url).filter(Boolean));
    for (const s of searchSettled) {
      if (s.status !== "fulfilled") continue;
      for (const item of (s.value || [])) {
        if (!item?.url || seen.has(item.url)) continue;
        seen.add(item.url); found.push(item);
      }
    }
    const toScrape = found.slice(0, Math.max(4, Math.min(8, scrapeConcurrency || 6)));
    const scrapedSettled = await Promise.allSettled(toScrape.map(it => deepScrape(it.url)));
    for (let i = 0; i < scrapedSettled.length; i++) {
      const r = scrapedSettled[i];
      if (r.status === "fulfilled" && r.value) {
        evidence.push({ ...r.value, snippet: toScrape[i]?.snippet || "", title: r.value.title || toScrape[i]?.title || "" });
      }
    }
    evidence = evidence.filter(Boolean).slice(0, 12);

    extracted = normalizeExtracted(await aiExtractRow(ai, row, headers, evidence, enrichmentContext, targetColumns), targetColumns, headers);
    reviewed = normalizeExtracted(await aiReviewRow(ai, extracted, row, headers, evidence, enrichmentContext, targetColumns), targetColumns, headers);

    const conf = reviewed.confidence || "none";
    const missing = Array.isArray(reviewed.missing) ? reviewed.missing.filter(Boolean) : [];
    const needsEmail = resolveHeaderIndex(headers, "EMAIL") >= 0 && !getCell(row, headers, "EMAIL") && !cleanEmail(reviewed.EMAIL || "");
    const low = conf === "low" || conf === "none";
    if (round >= 2 || (!low && !needsEmail)) break;
    const missingTargets = Array.from(new Set([...missing, ...(needsEmail ? ["EMAIL"] : [])]));
    queries = await aiSuggestQueries(ai, row, headers, enrichmentContext, missingTargets);
    if (!queries || queries.length === 0) break;
  }

  const finalRes = reviewed || extracted || { confidence: "none" };
  for (const col of targetColumns) {
    const val = String(finalRes[col] || "").trim();
    if (!val) continue;
    if (col === "EMAIL") {
      const ev = cleanEmail(val);
      if (ev && applyField(row, headers, "EMAIL", ev, { allowCorrect: false })) { updated = true; anyValue = true; }
      continue;
    }
    // allow safe correction for misfilled names; fill empties for others; improve CONTEXT
    const allowCorrect = (col === "FIRSTNAME" || col === "LASTNAME");
    if (applyField(row, headers, col, val, { allowCorrect })) { updated = true; anyValue = true; }
  }
  // discovered email fallback
  if (resolveHeaderIndex(headers, "EMAIL") >= 0 && !getCell(row, headers, "EMAIL")) {
    const evEmail = cleanEmail(finalRes.EMAIL || finalRes.email || "");
    if (evEmail) { setCell(row, headers, "EMAIL", evEmail); updated = true; anyValue = true; }
  }

  // re-run name normalization if AI filled/changed names into a messy state
  const post = preNormalizeRow(row, headers);
  if (post.changed) { updated = true; anyValue = true; }

  // mark enriched if we made a verifiable/useful improvement (incl. normalization) or have meaningful context/evidence-backed result
  const ctx = getCell(row, headers, "CONTEXT");
  const hasMeaningfulContext = cleanText(ctx).length >= 25;
  const confident = (finalRes.confidence && finalRes.confidence !== "none");
  const status = (updated || anyValue || (confident && hasMeaningfulContext)) ? "enriched" : "no_data";
  return { status, updated, confidence: finalRes.confidence || (updated ? "low" : "none") };
}

async function runEnrichmentRange({ rows, headers, start, end, campaignId, enrichmentContext, log, fileId, onCheckpoint, concurrency = 1 }) {
  ensureColumn(headers, rows, "enrichmentStatus");
  const limit = Math.max(1, parseInt(concurrency, 10) || 1);
  let processed = 0, enriched = 0, noData = 0, skipped = 0;

  // Build pending row indexes in range (resumable)
  const pending = [];
  for (let i = start; i < end; i++) {
    const idx = i + 1; // header offset
    if (idx >= rows.length) break;
    const row = rows[idx];
    if (isRowEnrichedFinal(row, headers)) { skipped++; continue; }
    pending.push(i);
  }

  const runOne = async (i) => {
    const idx = i + 1;
    const row = rows[idx];
    const ai = new MultiProviderAI();
    try {
      const res = await enrichOneRow({ row, headers, ai, enrichmentContext, scrapeConcurrency: 6 });
      return { i, status: res.status || 'no_data', confidence: res.confidence || 'none' };
    } catch (e) {
      log.warn(`[Row ${i}] enrichment error: ${e.message}`);
      return { i, status: 'no_data', confidence: 'error', error: e.message };
    }
  };

  for (let cursor = 0; cursor < pending.length; cursor += limit) {
    const wave = pending.slice(cursor, cursor + limit);
    const settled = await Promise.allSettled(wave.map(i => runOne(i)));
    for (let w = 0; w < settled.length; w++) {
      const i = wave[w];
      const idx = i + 1;
      if (idx >= rows.length) continue;
      const row = rows[idx];
      if (isRowEnrichedFinal(row, headers)) { skipped++; continue; }
      const val = settled[w].status === 'fulfilled' ? settled[w].value : { i, status: 'no_data', confidence: 'error' };
      setCell(row, headers, "enrichmentStatus", val.status === 'enriched' ? 'enriched' : 'no_data');
      if (val.status === 'enriched') enriched++; else noData++;
      processed++;
      log.info(`[Row ${i}] enrichment ${val.status === 'enriched' ? 'enriched' : 'no_data'} conf=${val.confidence || "n/a"}`);
    }

    // Incremental per-batch commit: persist completed batch rows/status before next batch
    const checkpointUpTo = Math.min(wave[wave.length - 1] + 1, end);
    if (onCheckpoint) {
      await onCheckpoint(checkpointUpTo, { processed, enriched, noData, skipped });
    } else if (fileId) {
      try {
        await mergeAndFlush(campaignId, 'enrich', rows, fileId);
      } catch (e) {
        log.warn(`[enrich] batch flush (merge) failed: ${e.message} - trying direct upload`);
        try { await uploadCsvText(fileId, stringifyCSV(rows)); }
        catch (e2) { log.error(`[enrich] batch flush failed after retry: ${e2.message}`); }
      }
    }
  }

  // final checkpoint flush (ensure all processed rows persisted)
  if (onCheckpoint) {
    await onCheckpoint(end, { processed, enriched, noData, skipped });
  } else if (fileId) {
    try {
      await mergeAndFlush(campaignId, 'enrich', rows, fileId);
    } catch (e) {
      log.warn(`[enrich] final flush (merge) failed: ${e.message} - trying direct upload`);
      try { await uploadCsvText(fileId, stringifyCSV(rows)); }
      catch (e2) { log.error(`[enrich] final flush failed after retry: ${e2.message}`); }
    }
  }

  return { processed, enriched, noData, skipped };
}

function isRangeFullyEnriched(rows, headers, start, end) {
  for (let i = start; i < end; i++) {
    const idx = i + 1;
    if (idx >= rows.length) break;
    if (!isRowEnrichedFinal(rows[idx], headers)) return false;
  }
  return true;
}

async function handleCoordinatorMode(campaignId, fileUrl, log, stageUserId) {
  await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });
  let enrichmentContext = '';
  try {
    const cs = await getCampaignSettings(campaignId);
    enrichmentContext = cs?.settings?.enrichmentContext || cs?.enrichmentContext || '';
  } catch {}

  const fileId = extractFileId(fileUrl);
  if (!fileId) return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });

  log.info(` Downloading CSV file: ${fileId}`);
  const sx = (process.env.SEARXNG_URL || process.env.SEARX_URL || process.env.CXNG_URL || "").trim();
  log.info(sx ? `[enrich] SearXNG configured: ${sx}` : `[enrich] SearXNG not configured (SEARXNG_URL missing) - using web scraping fallbacks + email/domain signals`);
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  let csvContent = dl.content;
  if (csvContent.charCodeAt(0) === 0xFEFF) csvContent = csvContent.slice(1);
  const rows = parseCSV(csvContent);
  if (rows.length <= 1) throw new Error("CSV empty or no data rows");
  const headers = rows[0].map(normHeader);
  rows[0] = headers;
  ensureColumn(headers, rows, "enrichmentStatus");
  const dataRows = rows.slice(1);

  // batch limits = concurrency over FULL dataset (never total scope/truncation)
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.enrichLimit > 0)) {
    return NextResponse.json({ success: true, limitReached: true, message: "Enrichment blocked: enrichBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const enrichConcurrency = Math.max(1, parseInt(campaignLimits.enrichLimit, 10) || 1);
  const totalRows = dataRows.length;

  // multi-server dispatch over full dataset when nothing processed yet
  if (await isMultiServerEnabled()) {
    const noneProcessed = dataRows.every(r => !String(getCell(r, headers, "enrichmentStatus") || "").trim());
    if (noneProcessed) {
      const dispatchResult = await dispatchToServers(campaignId, 'enrich', fileUrl, totalRows);
      if (dispatchResult) {
        return NextResponse.json({ success: true, processing: true, dispatched: true, servers: dispatchResult.servers });
      }
    }
  }

  const stats = await runEnrichmentRange({
    rows, headers, start: 0, end: totalRows, campaignId, enrichmentContext, log, fileId, concurrency: enrichConcurrency,
  });

  const complete = isRangeFullyEnriched(rows, headers, 0, totalRows);
  if (!complete) {
    await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });
    return NextResponse.json({ success: true, processing: true, completed: false, message: "Enrichment incomplete - remaining rows pending", stats });
  }

  await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
  if (stageUserId && totalRows > 0) {
    try { await updateUserUsage(stageUserId, "enrichUsage", totalRows); } catch (e) { log.warn(`[user-limit] enrichUsage increment failed: ${e.message}`); }
  }
  // Notify orchestrator so it can advance (coordinator/single-server completion handoff)
  try {
    const selfUrl = getSelfUrlWithFallback();
    fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId })
    }).catch(() => {});
  } catch {}
  return NextResponse.json({ success: true, completed: true, message: "Campaign enrichment completed", total: totalRows, stats });
}

async function handleWorkerMode(campaignId, fileUrl, serverBatch, log) {
  await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });
  let enrichmentContext = '';
  try { const cs = await getCampaignSettings(campaignId); enrichmentContext = cs?.settings?.enrichmentContext || cs?.enrichmentContext || ''; } catch {}

  const myAssignment = await findMyAssignment(campaignId, 'enrich');
  if (!myAssignment) return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  await updateMyAssignment(campaignId, 'enrich', { status: 'running' });

  const fileId = extractFileId(fileUrl);
  if (!fileId) return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
  const sx = (process.env.SEARXNG_URL || process.env.SEARX_URL || process.env.CXNG_URL || "").trim();
  log.info(sx ? `[enrich][worker] SearXNG configured: ${sx}` : `[enrich][worker] SearXNG not configured - using web scraping fallbacks + email/domain signals`);
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  let csvContent = dl.content; if (csvContent.charCodeAt(0) === 0xFEFF) csvContent = csvContent.slice(1);
  const rows = parseCSV(csvContent);
  if (rows.length <= 1) throw new Error("CSV empty or no data rows");
  const headers = rows[0].map(normHeader); rows[0] = headers; ensureColumn(headers, rows, "enrichmentStatus");

  const rowStart = Math.max(0, parseInt(serverBatch?.rowStart || 0));
  const rowEnd = Math.min(rows.length - 1, parseInt(serverBatch?.rowEnd || (rows.length - 1)));
  const campaignLimits = await getCampaignLimits();
  const enrichConcurrency = Math.max(1, parseInt(campaignLimits.enrichLimit || 1, 10) || 1);

  try {
    const stats = await runEnrichmentRange({
      rows, headers, start: rowStart, end: rowEnd, campaignId, enrichmentContext, log, fileId,
      concurrency: enrichConcurrency,
      onCheckpoint: async (processedUpTo, s) => {
        await updateMyAssignment(campaignId, 'enrich', { processedUpTo, ...s });
        await mergeAndFlush(campaignId, 'enrich', rows, fileId);
      }
    });
    const completeRange = isRangeFullyEnriched(rows, headers, rowStart, rowEnd);
    await updateMyAssignment(campaignId, 'enrich', { status: completeRange ? 'completed' : 'running', processedUpTo: rowEnd });
    if (completeRange) {
      const allDone = await checkAllComplete(campaignId, 'enrich');
      if (allDone) {
        // verify whole file complete before marking
        const wholeComplete = isRangeFullyEnriched(rows, headers, 0, rows.length - 1);
        if (wholeComplete) {
          await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
          try { const selfUrl = getSelfUrlWithFallback(); fetch(`${selfUrl}/campaign/pipeline-orchestrator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId }) }).catch(()=>{}); } catch {}
        } else {
          await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });
        }
      }
    }
    return NextResponse.json({ success: true, completed: completeRange, message: `Worker enrichment ${completeRange ? 'completed' : 'in progress'} for rows ${rowStart}-${rowEnd - 1}`, stats });
  } catch (error) {
    await updateMyAssignment(campaignId, 'enrich', { status: 'failed', error: error.message });
    throw error;
  }
}

export async function POST(request) {
  let log = logger.child({ campaignId: null, stage: 'enrich' });
  let campaignId;
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const { fileUrl, serverBatch } = body;
    ({ campaignId } = body);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    log = logger.child({ campaignId, stage: 'enrich' });
    log.info(`Received enrichment request${serverBatch ? ` [worker]` : ''}`);

    // USER tier — monthly enrichUsage gate
    let stageUserId = body.settings?.userId || body.userId || null;
    if (!stageUserId) { try { stageUserId = (await getCampaignSettings(campaignId))?.userId || null; } catch {} }
    if (stageUserId) {
      const quota = await checkUserQuota(stageUserId, { keys: ["enrichUsage"] });
      if (!quota.allowed) {
        await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
        return NextResponse.json({ success: true, limitReached: true, userMonthlyLimit: true, message: `Enrichment blocked: ${quota.reason}` });
      }
    }

    if (serverBatch) return await handleWorkerMode(campaignId, fileUrl, serverBatch, log);
    return await handleCoordinatorMode(campaignId, fileUrl, log, stageUserId);
  } catch (error) {
    (log || logger).error(`Error: ${error.message}`, { stack: error.stack });
    try { if (campaignId) await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" }); } catch {}
    return NextResponse.json({ success: false, error: error.message, processing: true }, { status: 500 });
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}
