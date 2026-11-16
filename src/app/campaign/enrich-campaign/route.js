import { NextResponse } from "next/server";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";
import axios from "axios";
import * as cheerio from "cheerio";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
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
function getCell(row, headers, name) {
  const idx = headers.indexOf(normHeader(name));
  return idx >= 0 ? String(row[idx] || "").trim() : "";
}
function setCell(row, headers, name, value) {
  const idx = headers.indexOf(normHeader(name));
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
  const keys = ["EMAIL","FIRSTNAME","LASTNAME","BUSINESSNAME","URL","SOCIALUSERNAME","SOCIALPLATFORM","CONTEXT","WEBSITE","COMPANY","DOMAIN"];
  for (const k of keys) {
    const idx = headers.indexOf(k);
    if (idx >= 0 && String(row[idx] || "").trim()) return true;
  }
  // fallback: any non-empty non-system cell
  const ignore = new Set(["SN","CAMPAIGNTYPE","ENGINE","PROVIDER","SMTP","PORT","USERNAME","PASSWORD","APPPASSWORD","BACKUPCODE","OAUTH2CLIENTID","OAUTH2CLIENTSECRET","OAUTH2REFRESHTOKEN","SHOULDVALIDATE","SHOULDENHANCE","SHOULDSEARCHINTERACT","SHOULDPAGEINTERACT","SHOULDINBOXINTERACT","SHOULDACTIVITIESINTERACT","SHOULDSENDMESSAGE","VALIDATION","PROVIDERMXRESULT","ENRICHMENTSTATUS","SENDDATE","SENDTIME","SENDSTAMP","SEARCHKEYS","SEARCHCOUNT","SEARCHSTATUS","SEARCHSTAMP","PROFILETOINTERACT","INTERACTCOUNT","INTERACTSTATUS","INTERACTSTAMP","PERSONALIZATIONSTATUS","EXECUTIONSTATUS"]);
  for (let i = 0; i < headers.length; i++) {
    if (ignore.has(headers[i])) continue;
    if (String(row[i] || "").trim()) return true;
  }
  return false;
}

function buildHeuristicQueries(row, headers) {
  const email = getCell(row, headers, "EMAIL");
  const first = getCell(row, headers, "FIRSTNAME");
  const last = getCell(row, headers, "LASTNAME");
  const company = getCell(row, headers, "BUSINESSNAME") || getCell(row, headers, "COMPANY");
  const url = getCell(row, headers, "URL") || getCell(row, headers, "WEBSITE");
  const social = getCell(row, headers, "SOCIALUSERNAME");
  const platform = getCell(row, headers, "SOCIALPLATFORM");
  const fullName = [first, last].filter(Boolean).join(" ").trim();
  const queries = [];
  if (email && email.includes("@")) {
    const [user, domain] = email.split("@");
    const d = (domain || "").toLowerCase();
    if (d && !GENERIC_EMAIL_DOMAINS.has(d)) {
      queries.push(`${d} company about contact`);
      queries.push(`${d} team leadership services`);
    } else {
      if (fullName) queries.push(`"${fullName}" "${email}" profile contact`);
      else if (user) queries.push(`"${user}" ${d} profile`);
    }
  }
  if (fullName && company) queries.push(`"${fullName}" "${company}" profile email contact`);
  else if (fullName) queries.push(`"${fullName}" profile linkedin contact`);
  if (company) queries.push(`"${company}" official website contact email`);
  if (social) queries.push(`${platform || ""} ${social} profile contact`.trim());
  if (url) {
    try { const u = new URL(url.startsWith("http") ? url : `https://${url}`); queries.push(`${u.hostname} about contact team`); } catch { queries.push(`${url} contact about`); }
  }
  // dedupe
  return Array.from(new Set(queries.map(q => q.replace(/\s+/g, " ").trim()).filter(Boolean))).slice(0, 6);
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
    $("script, style, noscript, svg").remove();
    const title = $("title").first().text().trim() || $("meta[property='og:title']").attr("content") || "";
    const description = $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "";
    const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
    const links = [];
    $("a[href]").each((_, el) => {
      if (links.length >= 20) return false;
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
      return /about|contact|team|company|services|profile|people|leadership|impressum/i.test(u.pathname + u.search);
    } catch { return false; }
  }).slice(0, 3);
  const extras = await Promise.allSettled(interesting.map(l => scrapeUrl(l)));
  for (const r of extras) {
    if (r.status === "fulfilled" && r.value) {
      const v = r.value;
      internalTexts.push([v.title, v.description, v.bodyText].filter(Boolean).join(" ").slice(0, 1500));
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
async function searxngSearch(query) {
  const base = process.env.SEARXNG_URL; if (!base) return [];
  try {
    const resp = await axios.get(`${base.replace(/\/$/, "")}/search`, { params: { q: query, format: "json" }, timeout: 10000 });
    return (resp.data?.results || []).slice(0, 5).map(r => ({ url: r.url, title: r.title, snippet: r.content }));
  } catch { return []; }
}
async function multiSearch(query) {
  const settled = await Promise.allSettled([googleSearch(query), bingSearch(query), duckDuckGoSearch(query), searxngSearch(query)]);
  const out = []; const seen = new Set();
  for (const r of settled) {
    if (r.status !== "fulfilled") continue;
    for (const item of (r.value || [])) {
      const u = String(item?.url || ""); if (!u || seen.has(u)) continue; seen.add(u); out.push(item);
    }
  }
  return out.slice(0, 10);
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
  const s = String(v || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return "";
  return s;
}

async function aiSuggestQueries(ai, row, headers, enrichmentContext, missingTargets = []) {
  const known = rowKnownData(row, headers);
  const prompt = `You generate web search queries to enrich a lead/contact/company record.
Known row data (JSON): ${JSON.stringify(known).slice(0, 4000)}
Enrichment context/instructions: ${enrichmentContext || "(none)"}
Still missing or low-confidence targets: ${missingTargets.join(", ") || "(general enrichment)"}

Return ONLY a JSON array of 3 to 6 short, specific search query strings.
Prioritize finding verifiable identity/company/contact info (including email if missing and verifiable). Do not invent facts.`;
  try {
    const text = await ai.generate(prompt, { maxTokens: 600, jsonMode: true });
    const parsed = parseJsonLoose(ai, text);
    if (Array.isArray(parsed)) {
      const qs = parsed.map(x => String(x || "").trim()).filter(Boolean).slice(0, 6);
      if (qs.length) return qs;
    }
  } catch {}
  return buildHeuristicQueries(row, headers).slice(0, 6);
}

async function aiExtractRow(ai, row, headers, evidence, enrichmentContext, targetColumns) {
  const known = rowKnownData(row, headers);
  const ev = (evidence || []).slice(0, 8).map((e, i) => ({
    i: i + 1,
    url: e.url, title: e.title, snippet: e.snippet,
    description: e.description,
    text: (e.bodyText || "").slice(0, 1800),
    internal: (e.internalTexts || []).join(" ").slice(0, 1200)
  }));
  const prompt = `You are a precise data enrichment agent. Extract ONLY verifiable information from evidence for this row.

Target columns (fill only if supported): ${targetColumns.join(", ")}
Known row data: ${JSON.stringify(known).slice(0, 3500)}
Enrichment context/instructions: ${enrichmentContext || "General enrichment: extract all available verifiable business/personal information."}

Evidence (JSON): ${JSON.stringify(ev).slice(0, 12000)}

Rules:
- Only fill fields directly supported by known data or evidence. If not verifiable, leave empty.
- If FIRSTNAME contains "First Last", split into FIRSTNAME and LASTNAME when appropriate.
- If EMAIL is missing/empty in known data and a verifiable email is found in evidence, include EMAIL.
- CONTEXT should be a concise 1-3 sentence factual summary when supported.
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
Evidence snippets: ${JSON.stringify((evidence||[]).slice(0,5).map(e=>({url:e.url,title:e.title,text:(e.bodyText||"").slice(0,500)}))).slice(0,5000)}
Extraction: ${JSON.stringify(extracted).slice(0,4000)}

Return ONLY a JSON object with the same target column keys plus "confidence" and "missing". Remove any value not supported by evidence/known data. Keep empty string for unknown.`;
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
    if (col === "EMAIL") v = cleanEmail(v) || (String(v || "").trim() ? cleanEmail(String(v)) : "");
    out[col] = typeof v === "string" ? v.trim() : (v == null ? "" : String(v).trim());
  }
  if (!targetColumns.includes("EMAIL") && headers.includes("EMAIL")) {
    const ev = cleanEmail(extracted?.EMAIL || extracted?.email || "");
    if (ev) out.EMAIL = ev;
  }
  if (!["high","medium","low","none"].includes(out.confidence)) out.confidence = "low";
  if (out.confidence === "none") {
    for (const col of targetColumns) {
      if (col === "FIRSTNAME" || col === "LASTNAME") continue;
      out[col] = "";
    }
  }
  return out;
}

function getTargetColumns(headers) {
  const preferred = ["FIRSTNAME","LASTNAME","JOBTITLE","BUSINESSNAME","BUSINESSCITY","BUSINESSSTATE","BUSINESSCOUNTRY","BUSINESSZIPCODE","BUSINESSPHONE","BUSINESSEMAIL","EMAIL","CONTEXT","SOCIALUSERNAME","SOCIALPLATFORM","URL","WEBSITE","ADDRESS","CITY","STATE","COUNTRY","ZIPCODE","PHONE"];
  const targets = preferred.filter(c => headers.includes(c));
  // ensure some core targets exist if columns present; if not, still allow EMAIL/CONTEXT if present
  if (!targets.includes("EMAIL") && headers.includes("EMAIL")) targets.unshift("EMAIL");
  if (!targets.includes("CONTEXT") && headers.includes("CONTEXT")) targets.push("CONTEXT");
  return Array.from(new Set(targets));
}

function isRowEnrichedFinal(row, headers) {
  const s = String(getCell(row, headers, "enrichmentStatus") || "").toLowerCase();
  return s === "enriched" || s === "no_data" || s === "skipped";
}

async function enrichOneRow({ row, headers, ai, enrichmentContext, scrapeConcurrency }) {
  const targetColumns = getTargetColumns(headers);
  if (!hasSearchableData(row, headers)) {
    return { status: "no_data", reason: "no_searchable_data", updated: false };
  }

  const knownUrl = getCell(row, headers, "URL") || getCell(row, headers, "WEBSITE");
  let evidence = [];
  if (knownUrl) {
    try {
      const u = knownUrl.startsWith("http") ? knownUrl : `https://${knownUrl}`;
      const scraped = await deepScrape(u);
      if (scraped) evidence.push(scraped);
    } catch {}
  }

  let queries = await aiSuggestQueries(ai, row, headers, enrichmentContext, []);
  let extracted = null;
  let reviewed = null;

  for (let round = 0; round < 3; round++) { // initial + up to 2 refinements
    const qset = (queries || []).slice(0, 6);
    const searchSettled = await Promise.allSettled(qset.map(q => multiSearch(q)));
    const found = [];
    const seen = new Set(evidence.map(e => e.url));
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
    // cap evidence
    evidence = evidence.slice(0, 10);

    extracted = normalizeExtracted(await aiExtractRow(ai, row, headers, evidence, enrichmentContext, targetColumns), targetColumns, headers);
    reviewed = normalizeExtracted(await aiReviewRow(ai, extracted, row, headers, evidence, enrichmentContext, targetColumns), targetColumns, headers);

    const conf = reviewed.confidence || "none";
    const missing = Array.isArray(reviewed.missing) ? reviewed.missing.filter(Boolean) : [];
    const needsEmail = headers.includes("EMAIL") && !getCell(row, headers, "EMAIL") && !cleanEmail(reviewed.EMAIL || "");
    const low = conf === "low" || conf === "none";
    if (round >= 2 || (!low && !needsEmail)) break;
    // refine: ask AI for alternative queries
    const missingTargets = Array.from(new Set([...missing, ...(needsEmail ? ["EMAIL"] : [])]));
    queries = await aiSuggestQueries(ai, row, headers, enrichmentContext, missingTargets);
    if (!queries || queries.length === 0) break;
  }

  const finalRes = reviewed || extracted || { confidence: "none" };
  let updated = false;
  let anyValue = false;
  for (const col of targetColumns) {
    const val = String(finalRes[col] || "").trim();
    if (!val) continue;
    if (col === "EMAIL") {
      const existing = getCell(row, headers, "EMAIL");
      if (!existing && cleanEmail(val)) { setCell(row, headers, "EMAIL", cleanEmail(val)); updated = true; anyValue = true; }
      continue;
    }
    const existing = getCell(row, headers, col);
    if (!existing) { setCell(row, headers, col, val); updated = true; anyValue = true; }
    else if (col === "CONTEXT" && val.length > existing.length + 20) { setCell(row, headers, col, val); updated = true; anyValue = true; }
  }
  // allow writing discovered email even if not in targetColumns list but header exists
  if (headers.includes("EMAIL") && !getCell(row, headers, "EMAIL")) {
    const evEmail = cleanEmail(finalRes.EMAIL || finalRes.email || "");
    if (evEmail) { setCell(row, headers, "EMAIL", evEmail); updated = true; anyValue = true; }
  }

  const status = (finalRes.confidence === "none" && !anyValue) ? "no_data" : "enriched";
  return { status, updated, confidence: finalRes.confidence || "none" };
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
