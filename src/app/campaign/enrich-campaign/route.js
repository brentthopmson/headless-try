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
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings, getCampaignSettings, startStageLease } from "../_shared/pipelineUtils.js";
import { DEFAULT_ENRICHMENT_CONTEXT } from "../_shared/campaignDefaults.js";
import { applyRowStatuses } from "../_shared/campaignFields.js";
import {
  SCHEMA_ROLES, WRITE_POLICIES, normHeader, normKey, cleanText,
  normalizeEmailValue, getEmailDomain, clampStr, headerHint, isSystemHeader,
  ensureColumn, getCell, setCell, hygieneRow, buildColumnStats,
  validateAndApplyPatches, planEnrichmentWaves,
} from "../_shared/enrichmentCore.mjs";
import { getSelfUrlWithFallback, getInternalSelfUrl, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
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

function rowKnownData(row, headers, schema) {
  const ignoreHeaders = new Set((schema || []).filter(c => c.role === "ignore_system" || c.role === "ignore_template" || c.write_policy === "never_touch").map(c => c.header));
  const data = {};
  headers.forEach((h, i) => {
    if (ignoreHeaders.has(h)) return;
    if (/^(EMAILSUBJECT|EMAILBODY|SOCIALMESSAGE|REPLYTO|ENHANCEDSUBJECT|ENHANCEDBODY|ENHANCEDSOCIALMESSAGE)$/i.test(h)) return;
    const v = cleanText(row[i]);
    if (v) data[h] = v.slice(0, 300);
  });
  return data;
}

function hasSearchableData(row, headers, schema) {
  const safe = schema ? schema.filter(c => c.write_policy !== "never_touch" && c.role !== "ignore_system" && c.role !== "ignore_template") : headers.map(h => ({ header: h }));
  for (const c of safe) {
    const v = cleanText(getCell(row, headers, c.header));
    if (v) return true;
  }
  return false;
}

function isRowEnrichedFinal(row, headers) {
  const s = String(getCell(row, headers, "enrichmentStatus") || "").toLowerCase().trim();
  return s === "enriched" || s === "no_data" || s === "skipped";
}

function parseJsonLoose(ai, text) {
  const parsed = ai.parseAiJson ? ai.parseAiJson(text) : null;
  if (parsed) return parsed;
  try {
    const m = String(text || "").match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  return null;
}

async function aiGenerateJson(ai, prompt, maxTokens = 2500) {
  const text = await ai.generate(prompt, { maxTokens, jsonMode: true });
  return parseJsonLoose(ai, text);
}

// ---------------- Search (ddgs + scrapers, no SearXNG/CXNG) ----------------
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
  } catch { return null; }
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
    const $ = cheerio.load(resp.data || ""); const results = [];
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
let _ddgsWarned = false;
async function ddgsSearch(query) {
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
    } catch (e) { if (e && e.code === "ENOENT") continue; continue; }
  }
  if (!_ddgsWarned) { _ddgsWarned = true; try { logger.warn(`[enrich] ddgs local search unavailable (install with: pip install -r requirements-enrichment.txt)`); } catch {} }
  return [];
}
async function multiSearch(query) {
  const settled = await Promise.allSettled([ddgsSearch(query), googleSearch(query), bingSearch(query), duckDuckGoSearch(query)]);
  const out = []; const seen = new Set();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of (r.value || [])) {
      const u = String(item?.url || ""); if (!u || seen.has(u)) continue; seen.add(u); out.push(item);
    }
  }
  return out.slice(0, 12);
}

// ---------------- Evidence helpers (Gravatar + domain intel) ----------------
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
    return { email: e, displayName, location, about, profileUrl, accounts, urls };
  } catch { return null; }
}

async function gatherEmailSignals(row, headers, schema) {
  const evidence = [];
  const emailCol = (schema || []).find(c => c.role === "email")?.header || headers.find(h => normKey(h) === "email") || "EMAIL";
  const email = normalizeEmailValue(getCell(row, headers, emailCol));
  if (!email) return { evidence, notes: [] };
  const notes = [];
  const g = await gravatarLookup(email);
  if (g) {
    const gText = [g.displayName && `Name: ${g.displayName}`, g.location && `Location: ${g.location}`, g.about && `About: ${g.about}`,
      (g.accounts || []).slice(0, 5).map(a => `${a.domain || "account"}: ${a.url || a.username}`).join("; "),
      (g.urls || []).slice(0, 5).map(u => u.value).join("; ")
    ].filter(Boolean).join("\n");
    evidence.push({ url: g.profileUrl, title: `Gravatar: ${g.displayName || email}`, description: g.about || "", bodyText: gText.slice(0, 4000), internalTexts: [], snippet: "Gravatar public profile (verified)" });
    notes.push("gravatar");
  }
  const domain = getEmailDomain(email);
  if (domain && !GENERIC_EMAIL_DOMAINS.has(domain)) {
    const scraped = await deepScrape(`https://${domain}`);
    if (scraped) evidence.push({ ...scraped, snippet: "Company domain site (verified)" });
    notes.push("domain");
  }
  return { evidence, notes };
}

// ---------------- Pass A: Schema comprehension ----------------
async function aiSchemaPass(ai, headers, rows, enrichmentContext, log) {
  const stats = buildColumnStats(rows, headers);
  const prompt = `You are a CSV schema analyst for a B2B outreach enrichment engine.

You receive: (1) the campaign enrichment context, (2) every column header in a CSV,
(3) per-column statistics: fill rate, distinct-value count, detected data type, and a
few raw sample values.

Your job is NOT to enrich rows. Your job is to determine what each column MEANS and how
the engine must treat it. Schemas vary wildly: headers may be abbreviations, localized,
pluralized, mislabeled, or contain data that does not match the label. Judge by BOTH the
header and the actual values.

SEMANTIC ROLES (choose exactly one per column):
email, first_name, last_name, full_name, company, job_title, phone, mobile_phone,
url, address, city, state, region, country, postal_code, context_notes,
social_handle, social_platform, location_text, industry, employee_count,
ignore_system, ignore_template, unknown.

Also assign:
- confidence: 0..1
- write_policy: overwrite_if_clearly_misfilled | fill_if_empty | verify_only | never_touch
- data_type: text | email | phone | url | number | date | enum | mixed
- notes: max 20 words

HARD RULES
- Judge values over labels. If "NAME" contains full names, role = full_name.
- Never assume a first/last split exists. Mononyms, compound surnames, honorifics,
  suffixes, and non-Latin scripts are valid.
- Credentials/tokens/engine state/tracking/template columns = ignore_system/never_touch.
- If unsure, use "unknown" with low confidence; never guess.
- Never invent columns.
- write_policy guidance: identity/format-normalizable columns (names, company, phone,
  URL) = overwrite_if_clearly_misfilled; descriptive columns (title, location, context,
  industry) = fill_if_empty; source-of-truth identifier columns (email) = fill_if_empty
  unless values are visibly malformed; system/template = never_touch.

enrichmentContext: ${String(enrichmentContext || "(none)").slice(0, 2000)}
columns: ${JSON.stringify(stats).slice(0, 18000)}

Return ONLY valid JSON:
{"columns":[{"header":"<exact header>","role":"<role>","confidence":0.0,
"write_policy":"<policy>","data_type":"<type>","notes":"<short>"}]}`;
  let parsed = null;
  try { parsed = await aiGenerateJson(ai, prompt, 3000); } catch (e) { log && log.warn(`[enrich] schema AI failed: ${e.message}`); }
  const byHeader = new Map();
  if (parsed && Array.isArray(parsed.columns)) {
    for (const c of parsed.columns) {
      const header = headers.find(h => h === c?.header) || headers.find(h => normKey(h) === normKey(c?.header));
      if (!header) continue;
      const role = SCHEMA_ROLES.has(c.role) ? c.role : (headerHint(header) || "unknown");
      const write_policy = WRITE_POLICIES.has(c.write_policy) ? c.write_policy : (role.startsWith("ignore") ? "never_touch" : "fill_if_empty");
      byHeader.set(header, { header, role, write_policy, confidence: Math.max(0, Math.min(1, Number(c.confidence) || 0.5)), data_type: String(c.data_type || "text"), notes: clampStr(c.notes, 120) });
    }
  }
  // fallback defaults
  const schema = headers.map(h => {
    if (byHeader.has(h)) return byHeader.get(h);
    const hint = headerHint(h);
    const role = hint === "unknown" ? "unknown" : hint;
    const write_policy = role === "unknown" ? "fill_if_empty" : "fill_if_empty";
    return { header: h, role, write_policy, confidence: hint === "unknown" ? 0.3 : 0.6, data_type: "text", notes: "fallback" };
  });
  // Engine/system columns are never writable by AI (deterministic guardrail).
  for (const c of schema) {
    if (isSystemHeader(c.header)) { c.role = "ignore_system"; c.write_policy = "never_touch"; }
  }
  return schema;
}

// ---------------- Pass B + C ----------------
function schemaForPrompt(schema) {
  return schema.filter(c => c.write_policy !== "never_touch").map(c => ({ header: c.header, role: c.role, write_policy: c.write_policy, data_type: c.data_type || "text" }));
}

async function aiNormalizeBatch(ai, batchRows, schema, enrichmentContext) {
  const prompt = `You are a data normalization engine for a B2B outreach system. You NEVER invent facts.
You restructure and clean data that is already present; you add new values only under the
evidence rules below.

INPUTS: enrichmentContext; schema [{header,role,write_policy,data_type}];
rows [{rowId, values:{header:value}}]; optional evidenceByRow.

TASKS
1) Fill missing values and correct clearly misfilled values within each write_policy.
2) Derive identity fields when information already exists in the row, even if stored
   under the wrong column (full name in a first-name column, duplicated first/last,
   name in a generic column, company/person swapped). Derivation must be a pure
   restructuring of existing text: never add tokens not present.
3) Normalize formats: whitespace, casing, email lowercase/trim, phone formatting,
   URLs (scheme, strip tracking), locations, job titles, company names.
4) Descriptive fields (company, job title, location, context) may be filled by inference
   from the row and campaign context (basis "inferred") when empty or clearly wrong.
5) Identifiers (email, phone, URL/domain) must exist in the row or evidence; NEVER invent.
6) CONTEXT: short factual summary from row/evidence only.

DATA QUALITY RULES (hard, never override)
- The literal words Personal, self, private, individual, N/A, unknown, none or "-" are
  NOT company/business names and NOT websites. If no employer/organization is present
  in the row or evidence, leave BUSINESSNAME (company role) EMPTY. Do not infer a
  company from a note such as "Personal contact: Jane Doe (jane@example.com)".
- URL must be a real http(s) web address that appears in the row or evidence.
  If none is available, leave URL EMPTY. Never write a label, name, keyword or
  "Personal" into a URL column.
- CONTEXT is a short factual sentence about the person or business based only on
  row/evidence. Never turn "Personal contact: ..." into an employer claim.
- Company and URL may only use basis restructure | derived | verified. Never use
  "inferred" for them. Other descriptive fields may use "inferred" when empty.

THREE EXAMPLES OF THE EXPECTED OUTPUT SHAPE
Example 1 - no employer or site in the row:
  input:  {FIRSTNAME:"Jane", LASTNAME:"Doe", EMAIL:"jane@gmail.com",
           CONTEXT:"Personal contact: Jane Doe (jane@gmail.com)."}
  output: {"rowId":"1","status":"enriched","patches":[],
           "notes":"No verifiable company or URL; left empty."}
Example 2 - verified company and site in the row:
  input:  {FIRSTNAME:"Sam", LASTNAME:"Lee", EMAIL:"sam@acme.com",
           BUSINESSNAME:"acme inc", URL:"www.acme.com/about"}
  output: {"rowId":"2","status":"enriched","patches":[
    {"header":"BUSINESSNAME","value":"Acme Inc","basis":"restructure","confidence":0.9,"reason":"Normalize company casing"},
    {"header":"URL","value":"https://www.acme.com/about","basis":"restructure","confidence":0.9,"reason":"Add https scheme"}]}
Example 3 - misfilled full name in FIRSTNAME:
  input:  {FIRSTNAME:"Maria Garcia", LASTNAME:"", EMAIL:"maria@example.org"}
  output: {"rowId":"3","status":"enriched","patches":[
    {"header":"FIRSTNAME","value":"Maria","basis":"derived","confidence":0.9,"reason":"Split existing full name"},
    {"header":"LASTNAME","value":"Garcia","basis":"derived","confidence":0.9,"reason":"Split existing full name"}]}

NAMING / IDENTITY RULES (general)
- Do not assume two-part names. Single token is a valid name.
- Honorifics/titles are not names; suffixes attach only when clearly part of the family name.
- Preserve diacritics and original script.
- If first/last cannot be separated without adding text, keep the full value in the most
  appropriate role and leave the other blank.
- Never fabricate email, phone, URL, company, title, or location.

EVIDENCE RULES
- restructure = rearrangement/cleanup of the row's own text.
- derived     = identity split implied by the row's own values.
- inferred    = reasonable deduction from row + context (descriptive fields only).
- verified    = supported by evidenceByRow (cite the snippet reference).
- Conflicts: keep original, confidence < 0.5, reason "conflict".

enrichmentContext: ${String(enrichmentContext || "(none)").slice(0, 2500)}
schema: ${JSON.stringify(schemaForPrompt(schema)).slice(0, 12000)}
rows: ${JSON.stringify(batchRows.map(r => ({ rowId: r.rowId, values: r.values }))).slice(0, 18000)}
evidenceByRow: ${JSON.stringify(Object.fromEntries(batchRows.map(r => [r.rowId, (r.evidence || []).slice(0, 4).map(e => ({ url: e.url, title: e.title, snippet: e.snippet, text: (e.bodyText || '').slice(0, 500) }))]))).slice(0, 12000)}

OUTPUT valid JSON only:
{"rows":[{"rowId":"<id>","patches":[{"header":"<header>","value":"<new>",
"basis":"restructure|derived|inferred|verified","confidence":0.0,
"reason":"<max 15 words>"}],"status":"enriched|no_data","notes":"<optional>"}]}
One entry per input rowId in order. Empty patches = unchanged. Never modify never_touch.
No markdown.`;
  return aiGenerateJson(ai, prompt, 3500);
}

async function aiVerifyBatch(ai, batchRows, proposedById, schema) {
  const prompt = `You are a verification reviewer for normalized CSV rows. Inputs: original row, proposed
patches, schema, evidence.

For each patch: ACCEPT or REJECT.
ACCEPT if it is a faithful restructuring of the row's own text (restructure/derived), OR
a reasonable non-identifier inference consistent with row+context (inferred), OR directly
supported by evidence (verified), AND it does not conflict with other row values.
REJECT invented identifiers/facts, unsupported tokens, contradictions, never_touch
writes, or confidence < 0.5 without evidence.
ALWAYS REJECT a company/URL patch with basis "inferred", a company value of
Personal/self/private/individual/N/A/unknown, or a URL that is not a real http(s)
address present in the row or evidence. A "Personal contact: ..." note is NOT an
employer; leave BUSINESSNAME and URL empty in that case.
If a first/last split would require adding text, REJECT it and keep the original.

schema: ${JSON.stringify(schemaForPrompt(schema)).slice(0, 10000)}
rows: ${JSON.stringify(batchRows.map(r => ({ rowId: r.rowId, original: r.values, proposed: proposedById.get(r.rowId) || { patches: [], status: 'no_data' }, evidence: (r.evidence || []).slice(0, 3).map(e => ({ url: e.url, title: e.title, text: (e.bodyText || '').slice(0, 400) })) }))).slice(0, 20000)}

Return ONLY JSON:
{"rows":[{"rowId":"<id>","decisions":[{"header":"<header>",
"decision":"accept|reject","reason":"<max 15 words>"}]}]}`;
  return aiGenerateJson(ai, prompt, 2500);
}

async function enrichBatch({ batch, schema, schemaByHeader, headers, ai, enrichmentContext, log }) {
  // batch: [{i,row,rowId,values,evidence}]
  let proposed = null;
  let verified = null;
  try { proposed = await aiNormalizeBatch(ai, batch, schema, enrichmentContext); } catch (e) { log.warn(`[enrich] normalize batch failed: ${e.message}`); }
  if (!proposed || !Array.isArray(proposed.rows)) {
    // AI/parse failure: leave rows unresolved (resumable, never false completion)
    log.warn(`[enrich] normalize batch produced no usable rows - deferring ${batch.length} row(s)`);
    return batch.map(r => ({ i: r.i, failed: true }));
  }
  const proposedRows = proposed.rows;
  const proposedById = new Map(proposedRows.map(r => [String(r.rowId), r]));
  // ensure every row present
  for (const r of batch) { if (!proposedById.has(r.rowId)) proposedById.set(r.rowId, { rowId: r.rowId, patches: [], status: "no_data" }); }
  try { verified = await aiVerifyBatch(ai, batch, proposedById, schema); } catch (e) { log.warn(`[enrich] verify batch failed: ${e.message}`); }
  if (!verified || !Array.isArray(verified.rows)) {
    log.warn(`[enrich] verifier produced no usable decisions - deferring ${batch.length} row(s)`);
    return batch.map(r => ({ i: r.i, failed: true }));
  }
  const decisionsById = new Map();
  for (const vr of verified.rows) decisionsById.set(String(vr.rowId), vr);
  const results = [];
  for (const r of batch) {
    const prop = proposedById.get(r.rowId) || { patches: [], status: "no_data" };
    const dec = decisionsById.get(r.rowId) || null;
    const { changed, status, failed } = validateAndApplyPatches(r.row, headers, schemaByHeader, prop, dec, true);
    // final hygiene on touched row (non-semantic)
    hygieneRow(r.row);
    results.push({ i: r.i, status, changed, failed });
  }
  return results;
}

async function flushRows(campaignId, rows, fileId, log) {
  applyRowStatuses(rows);
  try {
    await mergeAndFlush(campaignId, 'enrich', rows, fileId);
  } catch (e) {
    log.warn(`[enrich] batch flush (merge) failed: ${e.message} - trying direct upload`);
    try { await uploadCsvText(fileId, stringifyCSV(rows)); }
    catch (e2) { log.error(`[enrich] batch flush failed after retry: ${e2.message}`); throw e2; }
  }
}

function isRangeFullyEnriched(rows, headers, start, end) {
  for (let i = start; i < end; i++) {
    const idx = i + 1;
    if (idx >= rows.length) break;
    if (!isRowEnrichedFinal(rows[idx], headers)) return false;
  }
  return true;
}

async function runEnrichmentRange({ rows, headers, start, end, campaignId, enrichmentContext, log, fileId, onCheckpoint, concurrency = 1, schema }) {
  ensureColumn(headers, rows, "enrichmentStatus");
  const N = Math.max(1, parseInt(concurrency, 10) || 1);
  const schemaByHeader = new Map(schema.map(c => [c.header, c]));
  let processed = 0, enriched = 0, noData = 0, skipped = 0;

  // hygiene pass (non-semantic) on range
  for (let i = start; i < end; i++) { const idx = i + 1; if (idx < rows.length) hygieneRow(rows[idx]); }

  const pending = [];
  for (let i = start; i < end; i++) {
    const idx = i + 1; if (idx >= rows.length) break;
    const row = rows[idx];
    if (isRowEnrichedFinal(row, headers)) { skipped++; continue; }
    pending.push(i);
  }

  let paused = false;
  const waves = planEnrichmentWaves(pending, N);
  for (const wave of waves) {
    // Bounded concurrency: N rows per AI call, up to N AI calls (groups) in flight.
    const settled = await Promise.allSettled(wave.map(async (idxs) => {
      const batch = [];
      for (const i of idxs) {
        const idx = i + 1; if (idx >= rows.length) continue;
        const row = rows[idx];
        if (isRowEnrichedFinal(row, headers)) continue;
        // gather light evidence (Gravatar/domain) per row (best-effort)
        let evidence = [];
        try { evidence = (await gatherEmailSignals(row, headers, schema)).evidence || []; } catch {}
        batch.push({ i, row, rowId: String(i), values: rowKnownData(row, headers, schema), evidence });
      }
      if (batch.length === 0) return [];
      const ai = new MultiProviderAI();
      return enrichBatch({ batch, schema, schemaByHeader, headers, ai, enrichmentContext, log });
    }));

    for (const s of settled) {
      if (s.status !== "fulfilled") {
        log.warn(`[enrich] batch failed: ${s.reason?.message || s.reason}`);
        continue;
      }
      for (const r of (s.value || [])) {
        if (r.failed) {
          log.warn(`[Row ${r.i}] enrichment deferred (AI/verifier unavailable) - row left unresolved`);
          continue;
        }
        const idx = r.i + 1; if (idx >= rows.length) continue;
        const row = rows[idx];
        if (isRowEnrichedFinal(row, headers)) { skipped++; continue; }
        setCell(row, headers, "enrichmentStatus", r.status === "enriched" ? "enriched" : "no_data");
        if (r.status === "enriched") enriched++; else noData++;
        processed++;
        log.info(`[Row ${r.i}] enrichment ${r.status}${r.changed ? "" : " (no-change)"}`);
      }
    }

    // Incremental per-wave commit: persist before next wave
    const covered = wave.flat();
    const checkpointUpTo = covered.length ? Math.min(Math.max(...covered) + 1, end) : end;
    if (onCheckpoint) {
      await onCheckpoint(checkpointUpTo, { processed, enriched, noData, skipped });
    } else if (fileId) {
      await flushRows(campaignId, rows, fileId, log);
    }

    // Pause only at safe checkpoints (after persistence)
    if (await isCampaignPaused(campaignId, 'enrich')) { paused = true; break; }
  }

  // final flush (only when not paused: a paused run already flushed the last wave)
  if (!paused) {
    if (onCheckpoint) await onCheckpoint(end, { processed, enriched, noData, skipped });
    else if (fileId) await flushRows(campaignId, rows, fileId, log);
  }

  return { processed, enriched, noData, skipped, paused };
}

async function handleCoordinatorMode(campaignId, fileUrl, log, stageUserId) {
  let enrichmentContext = "";
  try { const cs = await getCampaignSettings(campaignId); enrichmentContext = cs?.settings?.enrichmentContext || cs?.enrichmentContext || DEFAULT_ENRICHMENT_CONTEXT; } catch {}

  const fileId = extractFileId(fileUrl);
  if (!fileId) return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });

  log.info(` Downloading CSV file: ${fileId}`);
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

  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.enrichLimit > 0)) {
    return NextResponse.json({ success: true, limitReached: true, message: "Enrichment blocked: enrichBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  const N = Math.max(1, parseInt(campaignLimits.enrichLimit, 10) || 1);
  const totalRows = dataRows.length;

  // Pass A: schema comprehension (once per file)
  log.info(`[enrich] Running schema comprehension (AI Pass A) on ${headers.length} columns, ${totalRows} rows`);
  const schemaAi = new MultiProviderAI();
  const schema = await aiSchemaPass(schemaAi, headers, rows, enrichmentContext, log);
  log.info(`[enrich] Schema mapped: ${schema.filter(c=>c.write_policy!=='never_touch').length} writable columns`);

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

  await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });
  const stats = await runEnrichmentRange({ rows, headers, start: 0, end: totalRows, campaignId, enrichmentContext, log, fileId, concurrency: N, schema });

  if (stats.paused) {
    await updateCampaignSettings(campaignId, { enrichmentStatus: "paused", status: "paused" });
    return NextResponse.json({ success: true, paused: true, completed: false, message: "Enrichment paused at checkpoint", stats });
  }

  const complete = isRangeFullyEnriched(rows, headers, 0, totalRows);
  if (!complete) {
    await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });
    return NextResponse.json({ success: true, processing: true, completed: false, message: "Enrichment incomplete - remaining rows pending", stats });
  }

  await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
  if (stageUserId && totalRows > 0) {
    try { await updateUserUsage(stageUserId, "enrichUsage", totalRows); } catch (e) { log.warn(`[user-limit] enrichUsage increment failed: ${e.message}`); }
  }
  try {
    const selfUrl = getInternalSelfUrl();
    fetch(`${selfUrl}/campaign/pipeline-orchestrator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, fromStage: true }) }).catch(() => {});
  } catch {}
  return NextResponse.json({ success: true, completed: true, message: "Campaign enrichment completed", total: totalRows, stats });
}

async function handleWorkerMode(campaignId, fileUrl, serverBatch, log) {
  let enrichmentContext = "";
  try { const cs = await getCampaignSettings(campaignId); enrichmentContext = cs?.settings?.enrichmentContext || cs?.enrichmentContext || DEFAULT_ENRICHMENT_CONTEXT; } catch {}

  const myAssignment = await findMyAssignment(campaignId, 'enrich');
  if (!myAssignment) return NextResponse.json({ success: false, error: "No assignment found for this server" }, { status: 400 });
  await updateMyAssignment(campaignId, 'enrich', { status: 'running' });

  const fileId = extractFileId(fileUrl);
  if (!fileId) return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  let csvContent = dl.content; if (csvContent.charCodeAt(0) === 0xFEFF) csvContent = csvContent.slice(1);
  const rows = parseCSV(csvContent);
  if (rows.length <= 1) throw new Error("CSV empty or no data rows");
  const headers = rows[0].map(normHeader); rows[0] = headers; ensureColumn(headers, rows, "enrichmentStatus");

  const rowStart = Math.max(0, parseInt(serverBatch?.rowStart || 0));
  const rowEnd = Math.min(rows.length - 1, parseInt(serverBatch?.rowEnd || (rows.length - 1)));
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.enrichLimit > 0)) {
    await updateMyAssignment(campaignId, 'enrich', { status: 'failed', error: 'enrichBatchLimit is 0' });
    return NextResponse.json({ success: false, error: "Enrichment blocked: enrichBatchLimit is 0 - set it in the SETTINGS sheet", limitReached: true });
  }
  const N = Math.max(1, parseInt(campaignLimits.enrichLimit, 10) || 1);

  const schemaAi = new MultiProviderAI();
  const schema = await aiSchemaPass(schemaAi, headers, rows, enrichmentContext, log);
  await updateCampaignSettings(campaignId, { enrichmentStatus: "processing" });

  try {
    const stats = await runEnrichmentRange({
      rows, headers, start: rowStart, end: rowEnd, campaignId, enrichmentContext, log, fileId, concurrency: N, schema,
      onCheckpoint: async (processedUpTo, s) => {
        await updateMyAssignment(campaignId, 'enrich', { processedUpTo, ...s });
        await mergeAndFlush(campaignId, 'enrich', rows, fileId);
      }
    });
    const completeRange = isRangeFullyEnriched(rows, headers, rowStart, rowEnd);
    if (stats.paused) {
      await updateMyAssignment(campaignId, 'enrich', { status: 'paused', processedUpTo: rowEnd });
      await updateCampaignSettings(campaignId, { enrichmentStatus: "paused", status: "paused" });
      return NextResponse.json({ success: true, paused: true, completed: false, message: `Worker enrichment paused for rows ${rowStart}-${rowEnd - 1}`, stats });
    }
    await updateMyAssignment(campaignId, 'enrich', { status: completeRange ? 'completed' : 'running', processedUpTo: rowEnd });
    if (completeRange) {
      const allDone = await checkAllComplete(campaignId, 'enrich');
      if (allDone) {
        const wholeComplete = isRangeFullyEnriched(rows, headers, 0, rows.length - 1);
        if (wholeComplete) {
          await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
          try { const selfUrl = getInternalSelfUrl(); fetch(`${selfUrl}/campaign/pipeline-orchestrator`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, fromStage: true }) }).catch(()=>{}); } catch {}
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
  let stageLease = null;
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
    stageLease = startStageLease(campaignId, 'enrich', log);

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
  } finally {
    if (stageLease) stageLease.stop();
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
}