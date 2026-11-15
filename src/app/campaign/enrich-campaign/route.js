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

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const GENERIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "mail.com", "zoho.com", "yandex.com", "protonmail.com", "proton.me", "gmx.com",
  "mail.ru", "live.com", "msn.com", "googlemail.com"
]);

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function inferFirstName(email) {
  if (!email) return "";
  const username = email.split("@")[0];
  const parts = username.split(/[\._\-0-9]+/);
  for (const part of parts) {
    if (part.length > 1) return capitalize(part);
  }
  return username ? capitalize(username) : "";
}

function inferCompany(email) {
  if (!email) return "";
  const parts = email.split("@");
  if (parts.length !== 2) return "";
  const domain = parts[1].toLowerCase().trim();
  if (GENERIC_DOMAINS.has(domain)) return "Personal";
  return capitalize(domain.split(".")[0]);
}

async function scrapeUrl(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      maxRedirects: 5,
    });

    const $ = cheerio.load(resp.data);
    $("script, style, noscript, nav, footer, header").remove();

    const title = $("title").text().trim()
      || $("meta[property='og:title']").attr("content")
      || "";

    const description = $("meta[name='description']").attr("content")
      || $("meta[property='og:description']").attr("content")
      || "";

    const main = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    const bodyText = main.text().replace(/\s+/g, " ").trim().slice(0, 3000);

    return { title, description, bodyText, status: resp.status, url };
  } catch (err) {
    logger.warn(`[Enrich] Scrape failed for ${url}: ${err.message}`);
    return null;
  }
}

async function googleSearch(query) {
  try {
    const resp = await axios.get("https://www.google.com/search", {
      params: { q: query, num: 5, hl: "en" },
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const $ = cheerio.load(resp.data);
    const results = [];

    $("div.g, div[data-sokoban-container]").each((i, el) => {
      if (results.length >= 5) return false;
      const link = $(el).find("a").first().attr("href");
      const title = $(el).find("h3").first().text().trim();
      const snippet = $(el).find(".VwiC3b, .s, span.aCOpRe").first().text().trim();
      if (link && link.startsWith("http")) {
        results.push({ url: link, title, snippet });
      }
    });

    return results;
  } catch (err) {
    logger.warn(`[Enrich] Google search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function bingSearch(query) {
  try {
    const resp = await axios.get("https://www.bing.com/search", {
      params: { q: query, count: 5 },
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    const $ = cheerio.load(resp.data);
    const results = [];
    $("li.b_algo").each((i, el) => {
      if (results.length >= 5) return false;
      const link = $(el).find("h2 a").attr("href");
      const title = $(el).find("h2").text().trim();
      const snippet = $(el).find(".b_caption p").text().trim();
      if (link && link.startsWith("http")) results.push({ url: link, title, snippet });
    });
    return results;
  } catch (err) {
    logger.warn(`[Enrich] Bing search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function duckDuckGoSearch(query) {
  try {
    const resp = await axios.get("https://html.duckduckgo.com/html/", {
      params: { q: query },
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    const $ = cheerio.load(resp.data);
    const results = [];
    $(".result").each((i, el) => {
      if (results.length >= 5) return false;
      const link = $(el).find("a.result__a").attr("href");
      const title = $(el).find("a.result__a").text().trim();
      const snippet = $(el).find("a.result__snippet").text().trim();
      if (link && link.startsWith("http")) results.push({ url: link, title, snippet });
    });
    return results;
  } catch (err) {
    logger.warn(`[Enrich] DDG search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function searxngSearch(query) {
  const base = process.env.SEARXNG_URL;
  if (!base) return [];
  try {
    const resp = await axios.get(`${base.replace(/\/$/, '')}/search`, {
      params: { q: query, format: 'json' },
      timeout: 10000,
    });
    const items = resp.data?.results || [];
    return items.slice(0, 5).map(r => ({ url: r.url, title: r.title, snippet: r.content }));
  } catch (err) {
    logger.warn(`[Enrich] SearXNG search failed for "${query}": ${err.message}`);
    return [];
  }
}

async function multiSearch(query) {
  const [g, b, d, s] = await Promise.allSettled([
    googleSearch(query), bingSearch(query), duckDuckGoSearch(query), searxngSearch(query),
  ]);
  const all = [];
  for (const r of [g, b, d, s]) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value);
  }
  // dedupe by url
  const seen = new Set();
  const out = [];
  for (const r of all) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
    if (out.length >= 10) break;
  }
  return out;
}

async function deepScrape(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 10000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      maxRedirects: 5,
    });
    const $ = cheerio.load(resp.data);
    $("script, style, noscript, nav, footer, header, aside").remove();
    const title = $("title").text().trim() || $("meta[property='og:title']").attr("content") || "";
    const description = $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "";
    const main = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    const bodyText = main.text().replace(/\s+/g, " ").trim().slice(0, 2000);

    // internal links
    const internalLinks = [];
    const baseHost = new URL(url).hostname;
    $("a[href]").each((i, el) => {
      if (internalLinks.length >= 5) return false;
      const href = $(el).attr("href");
      if (!href) return;
      try {
        const u = new URL(href, url);
        if (u.hostname === baseHost && /about|contact|team|company|services|who-we-are|people/i.test(u.pathname)) {
          if (!internalLinks.includes(u.href)) internalLinks.push(u.href);
        }
      } catch {}
    });

    // fetch up to 3 internal links in parallel
    const internalTexts = [];
    if (internalLinks.length > 0) {
      const fetches = internalLinks.slice(0, 3).map(async (il) => {
        try {
          const r = await axios.get(il, { timeout: 8000, headers: { "User-Agent": "Mozilla/5.0" } });
          const $2 = cheerio.load(r.data);
          $2("script, style, noscript, nav, footer, header").remove();
          return $2("body").text().replace(/\s+/g, " ").trim().slice(0, 1000);
        } catch { return ""; }
      });
      const results = await Promise.allSettled(fetches);
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) internalTexts.push(r.value);
      }
    }

    return { url, title, description, bodyText, internalTexts, status: resp.status };
  } catch (err) {
    logger.warn(`[Enrich] deepScrape failed for ${url}: ${err.message}`);
    return null;
  }
}

async function analyzeBatchWithGemini_OLD(scrapeResults) {
  if (scrapeResults.length === 0) return [];

  const batchContent = scrapeResults.map((r, i) => {
    const parts = [r.title, r.description, r.bodyText?.slice(0, 800)].filter(Boolean).join(". ");
    return `[${i + 1}] ${parts}`;
  }).join("\n\n");

  const prompt = `Analyze these ${scrapeResults.length} webpage contents and extract useful information for cold outreach.

${batchContent}

Return a JSON array with one object per webpage (same order):
[{"summary": "2-3 sentence summary", "industry": "detected industry", "services": "key services/products"}, ...]`;

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 4000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed)) {
      const clean = parsed.map(r => r && typeof r === 'object'
        ? { summary: ai.sanitizeAiPlainText(String(r.summary || ''), 2000), industry: ai.sanitizeAiPlainText(String(r.industry || ''), 200), services: ai.sanitizeAiPlainText(String(r.services || ''), 2000) }
        : null).filter(r => r && (r.summary || r.industry || r.services));
      if (clean.length) return clean;
    }
    if (typeof ai._salvageJsonArray === 'function') {
      const salvaged = ai._salvageJsonArray(text);
      if (Array.isArray(salvaged) && salvaged.length) {
        return salvaged.map(r => ({ summary: ai.sanitizeAiPlainText(String(r.summary || ''), 2000), industry: ai.sanitizeAiPlainText(String(r.industry || ''), 200), services: ai.sanitizeAiPlainText(String(r.services || ''), 2000) })).filter(r => r.summary || r.industry || r.services);
      }
    }
  } catch (err) {
    logger.warn(`[Enrich] Batch AI analysis failed: ${err.message}`);
  }
  return [];
}

export async function POST(request) {
  let log = logger.child({ campaignId: null, stage: 'enrich' });
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const { campaignId, fileUrl, serverBatch } = body;

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    log = logger.child({ campaignId, stage: 'enrich' });
    log.info(`Received enrichment request${serverBatch ? ` [worker rowStart=${serverBatch.rowStart} rowEnd=${serverBatch.rowEnd}]` : ''}`);

    // USER tier — monthly enrichUsage gate (GAS sends full settings; our own
    // orchestrator sends only campaignId → fall back to the campaign row).
    let stageUserId = body.settings?.userId || body.userId || null;
    if (!stageUserId) {
      try { stageUserId = (await getCampaignSettings(campaignId))?.userId || null; } catch (e) { /* fail open */ }
    }
    if (stageUserId) {
      const quota = await checkUserQuota(stageUserId, { keys: ["enrichUsage"] });
      if (!quota.allowed) {
        log.info(`[user-limit] ${quota.reason} — blocking enrichment for ${campaignId}`);
        await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
        return NextResponse.json({ success: true, limitReached: true, userMonthlyLimit: true, message: `Enrichment blocked: ${quota.reason}` });
      }
    }

    if (serverBatch) {
      return await handleWorkerMode(campaignId, fileUrl, serverBatch, log);
    }

    if (!fileUrl) {
      return NextResponse.json({ success: false, error: "Missing fileUrl" }, { status: 400 });
    }

    return await handleCoordinatorMode(campaignId, fileUrl, log, stageUserId);

  } catch (error) {
    (log || logger).error(`Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleCoordinatorMode(campaignId, fileUrl, log, stageUserId) {
  let wasPaused = false;
  log.info(`Received enrichment request for campaign: ${campaignId}`);

  const fileId = extractFileId(fileUrl);
  if (!fileId) {
    return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
  }

  // Read batch limits from SETTINGS, falling back to performance level presets
  const perfLevelSetting = await getSetting('performanceLevel');
  const perfPresets = getPerformancePresets(perfLevelSetting?.value1 || 'balanced');

  const enrichBatchSetting = await getSetting('enrichBatchLimit');
  const ENRICH_BATCH_SIZE = parseInt(enrichBatchSetting?.value1) || perfPresets.enrichBatchLimit;
  const searchBatchSetting = await getSetting('enrichSearchBatchLimit');
  const SEARCH_BATCH_SIZE = parseInt(searchBatchSetting?.value1) || perfPresets.enrichSearchBatchLimit;
  const aiBatchSetting = await getSetting('enrichAiBatchLimit');
  const AI_BATCH_SIZE = parseInt(aiBatchSetting?.value1) || perfPresets.enrichAiBatchLimit;
  const concurrencySetting = await getSetting('enrichScrapeConcurrency');
  const SCRAPE_CONCURRENCY = parseInt(concurrencySetting?.value1) || perfPresets.enrichScrapeConcurrency;

  log.info(`enrich=${ENRICH_BATCH_SIZE}, search=${SEARCH_BATCH_SIZE}, ai=${AI_BATCH_SIZE}, concurrency=${SCRAPE_CONCURRENCY}, level=${perfLevelSetting?.value1 || 'balanced'}`);

  // 1. Download CSV
  log.info(`Downloading CSV file: ${fileId}`);
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  const csvContent = dl.content;

  const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

  // 2. Parse and find columns
  const parsedRows = parseCSV(cleanContent);
  if (parsedRows.length === 0) throw new Error("CSV file is empty");

  const rawHeaders = parsedRows[0];
  const headers = rawHeaders.map(h => h.trim().toUpperCase());

  const emailIdx = headers.indexOf("EMAIL");
  if (emailIdx === -1) throw new Error("EMAIL column not found");

  const firstNameIdx = headers.indexOf("FIRSTNAME");
  const companyIdx = headers.indexOf("BUSINESSNAME");
  const urlIdx = headers.indexOf("URL");
  const contextIdx = headers.indexOf("CONTEXT");
  const validationIdx = headers.indexOf("validation");
  const enrichStatusIdx = headers.findIndex(h => h.toLowerCase().trim() === "enrichmentstatus");

  const dataRows = parsedRows.slice(1);

  // Per-run cap from SETTINGS (enrichBatchLimit) — strict: missing key = block
  const campaignLimits = await getCampaignLimits();
  if (!(campaignLimits.enrichLimit > 0)) {
    log.info(`enrichBatchLimit is 0 or unavailable, blocking enrichment - set enrichBatchLimit in the SETTINGS sheet`);
    return NextResponse.json({ success: true, limitReached: true, message: "Enrichment blocked: enrichBatchLimit is 0 - set it in the SETTINGS sheet" });
  }
  if (dataRows.length > campaignLimits.enrichLimit) {
    dataRows.length = campaignLimits.enrichLimit;
    log.info(`enrichLimit (${campaignLimits.enrichLimit}) applied: capped to ${dataRows.length} rows`);
  }
  log.info(`Processing ${dataRows.length} rows`);

  const multiEnabled = await isMultiServerEnabled();
  if (multiEnabled) {
    const dispatchResult = await dispatchToServers(campaignId, 'enrich', fileUrl, dataRows.length);
    if (dispatchResult) {
      return NextResponse.json({ success: true, dispatched: true, servers: dispatchResult.servers });
    }
  }

  // 3. Inference pass (firstName, company from email)
  for (const row of dataRows) {
    if (enrichStatusIdx !== -1 && row[enrichStatusIdx]?.trim() === "enriched") continue;
    const email = row[emailIdx]?.trim();
    if (!email) continue;
    let inferred = false;
    if (firstNameIdx !== -1 && !row[firstNameIdx]?.trim()) {
      row[firstNameIdx] = inferFirstName(email);
      inferred = true;
    }
    if (companyIdx !== -1 && !row[companyIdx]?.trim()) {
      row[companyIdx] = inferCompany(email);
      inferred = true;
    }
    if (inferred) log.info(`[Row enrich] ${email}: inferred firstName=${row[firstNameIdx] || '-'}, company=${row[companyIdx] || '-'}`);
  }

  // 4. URL Enrichment (batched)
  let urlScrapedCount = 0;
  const scrapeCache = new Map();
  const rowsWithUrl = dataRows.filter(r => {
    const url = r[urlIdx]?.trim();
    return url && url.startsWith("http");
  });

  const enrichBatchCount = Math.ceil(rowsWithUrl.length / ENRICH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < enrichBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      log.info(`Campaign paused at URL batch ${batchIdx + 1}/${enrichBatchCount}`);
      break;
    }

    const start = batchIdx * ENRICH_BATCH_SIZE;
    const end = Math.min(start + ENRICH_BATCH_SIZE, rowsWithUrl.length);
    const batch = rowsWithUrl.slice(start, end);

    // Scrape with concurrency limit to prevent rate limiting
    for (let ci = 0; ci < batch.length; ci += SCRAPE_CONCURRENCY) {
      const chunk = batch.slice(ci, ci + SCRAPE_CONCURRENCY);
      const scrapePromises = chunk.map(async (row) => {
        const url = row[urlIdx]?.trim();
        if (scrapeCache.has(url)) {
          const cached = scrapeCache.get(url);
          if (cached && contextIdx !== -1) row[contextIdx] = sanitizeForCsv(cached);
          return;
        }

        const result = await scrapeUrl(url);
        if (result) {
          let contextValue = null;
          const parts = [];
          if (result.title) parts.push(`Page: ${result.title}`);
          if (result.description) parts.push(result.description);
          contextValue = parts.join(". ") || "";

          if (contextIdx !== -1) row[contextIdx] = sanitizeForCsv(contextValue);
          scrapeCache.set(url, contextValue);
          urlScrapedCount++;
          log.info(`[Row scrape] ${url}: ${result.title || 'no title'} (${contextValue.length} chars)`);
        } else {
          log.info(`[Row scrape] ${url}: no result`);
        }
      });
      await Promise.allSettled(scrapePromises);
      if (ci + SCRAPE_CONCURRENCY < batch.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // Live flush
    try {
      await uploadCsvText(fileId, stringifyCSV(parsedRows));
    } catch (flushErr) {
      log.warn(` Live flush failed at batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    log.info(` URL batch ${batchIdx + 1}/${enrichBatchCount} complete (${urlScrapedCount} scraped)`);
  }

  // 5. Google Search Fallback (rows without URL, batched)
  let searchFoundCount = 0;
  const rowsWithoutUrl = dataRows.filter(r => {
    if (enrichStatusIdx !== -1 && r[enrichStatusIdx]?.trim() === "enriched") return false;
    const url = r[urlIdx]?.trim();
    const email = r[emailIdx]?.trim();
    const context = r[contextIdx]?.trim();
    return email && (!url || !url.startsWith("http")) && (!context || context.length < 10);
  });

  const searchBatchCount = Math.ceil(rowsWithoutUrl.length / SEARCH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < searchBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      log.info(` Campaign paused at search batch ${batchIdx + 1}/${searchBatchCount}`);
      break;
    }

    const start = batchIdx * SEARCH_BATCH_SIZE;
    const end = Math.min(start + SEARCH_BATCH_SIZE, rowsWithoutUrl.length);
    const batch = rowsWithoutUrl.slice(start, end);

    for (const row of batch) {
      const email = row[emailIdx]?.trim();
      const firstName = firstNameIdx !== -1 ? row[firstNameIdx]?.trim() : "";
      const company = companyIdx !== -1 ? row[companyIdx]?.trim() : "";

      if (!email) continue;

      const query = [
        firstName && company ? `"${firstName}" "${company}"` : "",
        company || "",
        "site:linkedin.com OR site:twitter.com OR site:github.com"
      ].filter(Boolean).join(" ");

      if (!query) continue;

      const results = await multiSearch(query);
      if (results.length > 0) {
        const bestResult = results.find(r =>
          r.url.includes("linkedin.com") || r.url.includes("twitter.com") || r.url.includes("github.com")
        ) || results[0];

        let contextValue = bestResult.snippet || bestResult.title || "";
        if (bestResult.url && contextIdx !== -1) {
          contextValue = `${contextValue} | Profile: ${bestResult.url}`.trim();
        }
        if (contextIdx !== -1) row[contextIdx] = sanitizeForCsv(contextValue);
        searchFoundCount++;
        log.info(`[Row search] ${email}: found "${bestResult.url}"`);
      } else {
        log.info(`[Row search] ${email}: no results`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Live flush
    try {
      await uploadCsvText(fileId, stringifyCSV(parsedRows));
    } catch (flushErr) {
      log.warn(` Live flush failed at search batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    log.info(` Search batch ${batchIdx + 1}/${searchBatchCount} complete (${searchFoundCount} found)`);
  }

  // 6. Batch AI Analysis (on scraped content)
  const rowsNeedingAnalysis = dataRows.filter(r => {
    if (enrichStatusIdx !== -1 && r[enrichStatusIdx]?.trim() === "enriched") return false;
    const context = r[contextIdx]?.trim();
    return context && context.length > 10 && !context.includes("Industry:");
  });

  const aiBatchCount = Math.ceil(rowsNeedingAnalysis.length / AI_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < aiBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) { wasPaused = true; break; }

    const start = batchIdx * AI_BATCH_SIZE;
    const end = Math.min(start + AI_BATCH_SIZE, rowsNeedingAnalysis.length);
    const batch = rowsNeedingAnalysis.slice(start, end);

    const scrapeResults = batch.map(row => ({
      title: "",
      description: row[contextIdx]?.trim() || "",
      bodyText: ""
    }));

    const targetCols = ['FIRSTNAME', 'LASTNAME', 'JOBTITLE', 'BUSINESSNAME', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'CONTEXT', 'SOCIALUSERNAME', 'SOCIALPLATFORM'];
let aiResults = await analyzeBatchWithAI(scrapeResults, targetCols);

    // Dynamic batch reduction: if AI fails, retry with half batch
    if (!aiResults || aiResults.length === 0) {
      const halfSize = Math.ceil(scrapeResults.length / 2);
      if (halfSize >= 2) {
        log.warn(` AI batch failed, retrying with half size (${halfSize})`);
        const halfResults = scrapeResults.slice(0, halfSize);
        const retryResults = await analyzeBatchWithAI(halfResults, targetCols);
        if (retryResults && retryResults.length > 0) {
          aiResults = retryResults;
          for (let i = 0; i < Math.min(halfSize, batch.length); i++) {
            const aiResult = retryResults[i];
            if (aiResult) {
              const enriched = [
                aiResult.summary,
                aiResult.industry ? `Industry: ${aiResult.industry}` : "",
                aiResult.services ? `Services: ${aiResult.services}` : ""
              ].filter(Boolean).join(". ");
              if (enriched) batch[i][contextIdx] = sanitizeForCsv(enriched);
            }
          }
          log.info(` AI retry succeeded for ${halfSize} items`);
          continue;
        }
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const aiResult = aiResults[i];
      if (aiResult) {
        const colMap = {
          FIRSTNAME: 'FIRSTNAME', LASTNAME: 'LASTNAME', JOBTITLE: 'JOBTITLE',
          BUSINESSNAME: 'BUSINESSNAME', BUSINESSCITY: 'BUSINESSCITY',
          BUSINESSSTATE: 'BUSINESSSTATE', BUSINESSCOUNTRY: 'BUSINESSCOUNTRY',
          CONTEXT: 'CONTEXT', SOCIALUSERNAME: 'SOCIALUSERNAME',
          SOCIALPLATFORM: 'SOCIALPLATFORM', PHONE: 'PHONE',
        };
        let anyFilled = false;
        for (const [aiKey, colName] of Object.entries(colMap)) {
          const ci = headers.indexOf(colName);
          if (ci === -1) continue;
          const val = aiResult[aiKey];
          if (val && String(val).trim() !== '') {
            batch[i][ci] = sanitizeForCsv(String(val));
            anyFilled = true;
          }
        }
        if (contextIdx !== -1 && !(batch[i][contextIdx] || '').trim()) {
          const parts = [aiResult.summary, aiResult.industry ? `Industry: ${aiResult.industry}` : '', aiResult.services ? `Services: ${aiResult.services}` : ''].filter(Boolean);
          if (parts.length) { batch[i][contextIdx] = sanitizeForCsv(parts.join('. ')); anyFilled = true; }
        }
        const reviewed = await reviewBatchWithAI([aiResult], [batch[i]]);
        if (reviewed && reviewed[0]) {
          for (const [aiKey, colName] of Object.entries(colMap)) {
            const ci = headers.indexOf(colName);
            if (ci === -1) continue;
            const val = reviewed[0][aiKey];
            if (val && String(val).trim() !== '') {
              batch[i][ci] = sanitizeForCsv(String(val));
            } else if (reviewed[0].confidence === 'none' && aiKey !== 'FIRSTNAME' && aiKey !== 'LASTNAME') {
              batch[i][ci] = '';
            }
          }
        }
        if (enrichStatusIdx !== -1) {
          batch[i][enrichStatusIdx] = (aiResult.confidence === 'none' || !anyFilled) ? 'no_data' : 'enriched';
        }
        log.info(`[Row AI] batch item ${i}: confidence=${aiResult.confidence || 'low'} filled=${anyFilled}`);
      }
    }

    log.info(` AI batch ${batchIdx + 1}/${aiBatchCount} complete`);
  }

  // 7. Mark all processed rows as enriched
  if (enrichStatusIdx !== -1) {
    for (const row of dataRows) {
      row[enrichStatusIdx] = "enriched";
    }
  }

  // 8. Final CSV flush
  log.info(` Final CSV flush to Drive: ${fileId}`);
  try {
    await uploadCsvText(fileId, stringifyCSV(parsedRows));
  } catch (flushErr) {
    log.warn(` Final CSV flush failed: ${flushErr.message}`);
  }

  // 8. Update campaign settings
  await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });

  // USER tier accounting: one monthly enrichUsage increment for the whole
  // single-server run (multi-server dispatch exits before this point and is
  // not metered — documented limitation).
  if (stageUserId && dataRows.length > 0) {
    try {
      await updateUserUsage(stageUserId, "enrichUsage", dataRows.length);
    } catch (e) {
      log.warn(`[user-limit] enrichUsage increment failed: ${e.message}`);
    }
  }

  return NextResponse.json({
    success: true,
    message: "Campaign enrichment completed",
    total: dataRows.length,
    urlsScraped: urlScrapedCount,
    searchFound: searchFoundCount,
    aiAnalyzed: rowsNeedingAnalysis.length
  });
}

async function handleWorkerMode(campaignId, fileUrl, serverBatch, log) {
  log.info(` Worker mode for campaign: ${campaignId}, rows ${serverBatch.rowStart}-${serverBatch.rowEnd}`);

  const assignment = await findMyAssignment(campaignId, 'enrich');
  if (!assignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this worker" }, { status: 404 });
  }

  await updateMyAssignment(campaignId, 'enrich', { status: 'running' });

  const fileId = extractFileId(fileUrl);
  if (!fileId) {
    return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
  }

  const enrichBatchSetting = await getSetting('enrichBatchLimit');
  const ENRICH_BATCH_SIZE = parseInt(enrichBatchSetting?.value1) || perfPresets.enrichBatchLimit;
  const searchBatchSetting = await getSetting('enrichSearchBatchLimit');
  const SEARCH_BATCH_SIZE = parseInt(searchBatchSetting?.value1) || perfPresets.enrichSearchBatchLimit;
  const aiBatchSetting = await getSetting('enrichAiBatchLimit');
  const AI_BATCH_SIZE = parseInt(aiBatchSetting?.value1) || perfPresets.enrichAiBatchLimit;
  const concurrencySetting = await getSetting('enrichScrapeConcurrency');
  const SCRAPE_CONCURRENCY = parseInt(concurrencySetting?.value1) || perfPresets.enrichScrapeConcurrency;

  // 1. Download full CSV
  log.info(` Worker downloading CSV file: ${fileId}`);
  const dl = await downloadCsvText(fileId);
  if (!dl.success) throw new Error(`Failed to download CSV: ${dl.error}`);
  const csvContent = dl.content;

  const cleanContent = csvContent.charCodeAt(0) === 0xFEFF ? csvContent.slice(1) : csvContent;

  // 2. Parse and find columns
  const parsedRows = parseCSV(cleanContent);
  if (parsedRows.length === 0) throw new Error("CSV file is empty");

  const rawHeaders = parsedRows[0];
  const headers = rawHeaders.map(h => h.trim().toUpperCase());

  const emailIdx = headers.indexOf("EMAIL");
  if (emailIdx === -1) throw new Error("EMAIL column not found");

  const firstNameIdx = headers.indexOf("FIRSTNAME");
  const companyIdx = headers.indexOf("BUSINESSNAME");
  const urlIdx = headers.indexOf("URL");
  const contextIdx = headers.indexOf("CONTEXT");
  const validationIdx = headers.indexOf("validation");
  const enrichStatusIdx = headers.findIndex(h => h.toLowerCase().trim() === "enrichmentstatus");

  const allDataRows = parsedRows.slice(1);

  // 3. Extract assigned slice
  const rowStart = serverBatch.rowStart || 0;
  const rowEnd = Math.min(serverBatch.rowEnd || allDataRows.length, allDataRows.length);
  const dataRows = allDataRows.slice(rowStart, rowEnd);

  log.info(` Worker processing ${dataRows.length} rows (slice ${rowStart}-${rowEnd})`);

  // 4. Inference pass
  for (const row of dataRows) {
    if (enrichStatusIdx !== -1 && row[enrichStatusIdx]?.trim() === "enriched") continue;
    const email = row[emailIdx]?.trim();
    if (!email) continue;
    if (firstNameIdx !== -1 && !row[firstNameIdx]?.trim()) {
      row[firstNameIdx] = inferFirstName(email);
    }
    if (companyIdx !== -1 && !row[companyIdx]?.trim()) {
      row[companyIdx] = inferCompany(email);
    }
  }

  // 5. URL Enrichment (batched)
  let urlScrapedCount = 0;
  let wasPaused = false;
  const scrapeCache = new Map();
  try {
  const rowsWithUrl = dataRows.filter(r => {
    const url = r[urlIdx]?.trim();
    return url && url.startsWith("http");
  });

  const enrichBatchCount = Math.ceil(rowsWithUrl.length / ENRICH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < enrichBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      log.info(` Worker campaign paused at URL batch ${batchIdx + 1}/${enrichBatchCount}`);
      wasPaused = true;
      break;
    }

    const start = batchIdx * ENRICH_BATCH_SIZE;
    const end = Math.min(start + ENRICH_BATCH_SIZE, rowsWithUrl.length);
    const batch = rowsWithUrl.slice(start, end);

    // Scrape with concurrency limit to prevent rate limiting
    for (let ci = 0; ci < batch.length; ci += SCRAPE_CONCURRENCY) {
      const chunk = batch.slice(ci, ci + SCRAPE_CONCURRENCY);
      const scrapePromises = chunk.map(async (row) => {
        const url = row[urlIdx]?.trim();
        if (scrapeCache.has(url)) {
          const cached = scrapeCache.get(url);
          if (cached && contextIdx !== -1) row[contextIdx] = sanitizeForCsv(cached);
          return;
        }

        const result = await scrapeUrl(url);
        if (result) {
          let contextValue = null;
          const parts = [];
          if (result.title) parts.push(`Page: ${result.title}`);
          if (result.description) parts.push(result.description);
          contextValue = parts.join(". ") || "";

          if (contextIdx !== -1) row[contextIdx] = sanitizeForCsv(contextValue);
          scrapeCache.set(url, contextValue);
          urlScrapedCount++;
          log.info(`[Row scrape] ${url}: ${result.title || 'no title'} (${contextValue.length} chars)`);
        } else {
          log.info(`[Row scrape] ${url}: no result`);
        }
      });
      await Promise.allSettled(scrapePromises);
      if (ci + SCRAPE_CONCURRENCY < batch.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    await updateMyAssignment(campaignId, 'enrich', {
      processedUpTo: rowStart + (batchIdx + 1) * ENRICH_BATCH_SIZE
    });
    await mergeAndFlush(campaignId, 'enrich', parsedRows, fileId);

    log.info(` Worker URL batch ${batchIdx + 1}/${enrichBatchCount} complete (${urlScrapedCount} scraped)`);
  }

  // 6. Google Search Fallback
  let searchFoundCount = 0;
  const rowsWithoutUrl = dataRows.filter(r => {
    if (enrichStatusIdx !== -1 && r[enrichStatusIdx]?.trim() === "enriched") return false;
    const url = r[urlIdx]?.trim();
    const email = r[emailIdx]?.trim();
    const context = r[contextIdx]?.trim();
    return email && (!url || !url.startsWith("http")) && (!context || context.length < 10);
  });

  const searchBatchCount = Math.ceil(rowsWithoutUrl.length / SEARCH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < searchBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      log.info(` Worker campaign paused at search batch ${batchIdx + 1}/${searchBatchCount}`);
      wasPaused = true;
      break;
    }

    const start = batchIdx * SEARCH_BATCH_SIZE;
    const end = Math.min(start + SEARCH_BATCH_SIZE, rowsWithoutUrl.length);
    const batch = rowsWithoutUrl.slice(start, end);

    for (const row of batch) {
      const email = row[emailIdx]?.trim();
      const firstName = firstNameIdx !== -1 ? row[firstNameIdx]?.trim() : "";
      const company = companyIdx !== -1 ? row[companyIdx]?.trim() : "";

      if (!email) continue;

      const query = [
        firstName && company ? `"${firstName}" "${company}"` : "",
        company || "",
        "site:linkedin.com OR site:twitter.com OR site:github.com"
      ].filter(Boolean).join(" ");

      if (!query) continue;

      const results = await multiSearch(query);
      if (results.length > 0) {
        const bestResult = results.find(r =>
          r.url.includes("linkedin.com") || r.url.includes("twitter.com") || r.url.includes("github.com")
        ) || results[0];

        let contextValue = bestResult.snippet || bestResult.title || "";
        if (bestResult.url && contextIdx !== -1) {
          contextValue = `${contextValue} | Profile: ${bestResult.url}`.trim();
        }
        if (contextIdx !== -1) row[contextIdx] = sanitizeForCsv(contextValue);
        searchFoundCount++;
        log.info(`[Row search] ${email}: found "${bestResult.url}"`);
      } else {
        log.info(`[Row search] ${email}: no results`);
      }

      await new Promise(r => setTimeout(r, 500));
    }

    await updateMyAssignment(campaignId, 'enrich', {
      processedUpTo: rowStart + (batchIdx + 1) * SEARCH_BATCH_SIZE
    });
    await mergeAndFlush(campaignId, 'enrich', parsedRows, fileId);

    log.info(` Worker search batch ${batchIdx + 1}/${searchBatchCount} complete (${searchFoundCount} found)`);
  }

  // 7. Batch AI Analysis
  const rowsNeedingAnalysis = dataRows.filter(r => {
    if (enrichStatusIdx !== -1 && r[enrichStatusIdx]?.trim() === "enriched") return false;
    const context = r[contextIdx]?.trim();
    return context && context.length > 10 && !context.includes("Industry:");
  });

  const aiBatchCount = Math.ceil(rowsNeedingAnalysis.length / AI_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < aiBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) { wasPaused = true; break; }

    const start = batchIdx * AI_BATCH_SIZE;
    const end = Math.min(start + AI_BATCH_SIZE, rowsNeedingAnalysis.length);
    const batch = rowsNeedingAnalysis.slice(start, end);

    const scrapeResults = batch.map(row => ({
      title: "",
      description: row[contextIdx]?.trim() || "",
      bodyText: ""
    }));

    const targetCols = ['FIRSTNAME', 'LASTNAME', 'JOBTITLE', 'BUSINESSNAME', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'CONTEXT', 'SOCIALUSERNAME', 'SOCIALPLATFORM'];
let aiResults = await analyzeBatchWithAI(scrapeResults, targetCols);

    // Dynamic batch reduction: if AI fails, retry with half batch
    if (!aiResults || aiResults.length === 0) {
      const halfSize = Math.ceil(scrapeResults.length / 2);
      if (halfSize >= 2) {
        log.warn(` Worker AI batch failed, retrying with half size (${halfSize})`);
        const halfResults = scrapeResults.slice(0, halfSize);
        const retryResults = await analyzeBatchWithAI(halfResults, targetCols);
        if (retryResults && retryResults.length > 0) {
          aiResults = retryResults;
          for (let i = 0; i < Math.min(halfSize, batch.length); i++) {
            const aiResult = retryResults[i];
            if (aiResult) {
              const enriched = [
                aiResult.summary,
                aiResult.industry ? `Industry: ${aiResult.industry}` : "",
                aiResult.services ? `Services: ${aiResult.services}` : ""
              ].filter(Boolean).join(". ");
              if (enriched) batch[i][contextIdx] = sanitizeForCsv(enriched);
            }
          }
          log.info(` Worker AI retry succeeded for ${halfSize} items`);
          continue;
        }
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const aiResult = aiResults[i];
      if (aiResult) {
        const colMap = {
          FIRSTNAME: 'FIRSTNAME', LASTNAME: 'LASTNAME', JOBTITLE: 'JOBTITLE',
          BUSINESSNAME: 'BUSINESSNAME', BUSINESSCITY: 'BUSINESSCITY',
          BUSINESSSTATE: 'BUSINESSSTATE', BUSINESSCOUNTRY: 'BUSINESSCOUNTRY',
          CONTEXT: 'CONTEXT', SOCIALUSERNAME: 'SOCIALUSERNAME',
          SOCIALPLATFORM: 'SOCIALPLATFORM', PHONE: 'PHONE',
        };
        let anyFilled = false;
        for (const [aiKey, colName] of Object.entries(colMap)) {
          const ci = headers.indexOf(colName);
          if (ci === -1) continue;
          const val = aiResult[aiKey];
          if (val && String(val).trim() !== '') {
            batch[i][ci] = sanitizeForCsv(String(val));
            anyFilled = true;
          }
        }
        if (contextIdx !== -1 && !(batch[i][contextIdx] || '').trim()) {
          const parts = [aiResult.summary, aiResult.industry ? `Industry: ${aiResult.industry}` : '', aiResult.services ? `Services: ${aiResult.services}` : ''].filter(Boolean);
          if (parts.length) { batch[i][contextIdx] = sanitizeForCsv(parts.join('. ')); anyFilled = true; }
        }
        const reviewed = await reviewBatchWithAI([aiResult], [batch[i]]);
        if (reviewed && reviewed[0]) {
          for (const [aiKey, colName] of Object.entries(colMap)) {
            const ci = headers.indexOf(colName);
            if (ci === -1) continue;
            const val = reviewed[0][aiKey];
            if (val && String(val).trim() !== '') {
              batch[i][ci] = sanitizeForCsv(String(val));
            } else if (reviewed[0].confidence === 'none' && aiKey !== 'FIRSTNAME' && aiKey !== 'LASTNAME') {
              batch[i][ci] = '';
            }
          }
        }
        if (enrichStatusIdx !== -1) {
          batch[i][enrichStatusIdx] = (aiResult.confidence === 'none' || !anyFilled) ? 'no_data' : 'enriched';
        }
        log.info(`[Row AI] batch item ${i}: confidence=${aiResult.confidence || 'low'} filled=${anyFilled}`);
      }
    }

    log.info(` Worker AI batch ${batchIdx + 1}/${aiBatchCount} complete`);
  }
  } catch (error) {
    log.error(`[Worker] Error: ${error.message}`, { stack: error.stack });
    await updateMyAssignment(campaignId, 'enrich', {
      status: 'failed',
      processedUpTo: rowEnd,
      error: error.message
    });
    throw error;
  }

  // 8. Mark all processed rows as enriched
  if (enrichStatusIdx !== -1) {
    for (const row of dataRows) {
      row[enrichStatusIdx] = "enriched";
    }
  }

  // 9. Final flush
  log.info(` Worker final flush to Drive: ${fileId}`);
  try {
    await uploadCsvText(fileId, stringifyCSV(parsedRows));
  } catch (flushErr) {
    log.warn(` Worker final flush failed: ${flushErr.message}`);
  }

  await updateMyAssignment(campaignId, 'enrich', {
    status: wasPaused ? 'paused' : 'completed',
    processedUpTo: wasPaused ? rowStart + urlScrapedCount + searchFoundCount : rowEnd
  });

  // 9. Check if all workers are done
  const allDone = await checkAllComplete(campaignId, 'enrich');
  if (allDone) {
    await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
    try {
      const selfUrl = getSelfUrlWithFallback();
      fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId })
      }).catch(err => log.warn(` Worker auto-advance failed: ${err.message}`));
    } catch {}
  }

  return NextResponse.json({
    success: true,
    message: "Worker enrichment completed",
    total: dataRows.length,
    urlsScraped: urlScrapedCount,
    searchFound: searchFoundCount,
    aiAnalyzed: rowsNeedingAnalysis.length
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}

async function analyzeBatchWithAI(scrapeResults, targetColumns) {
  if (scrapeResults.length === 0) return [];
  const batchContent = scrapeResults.map((r, i) => {
    const known = r.knownData ? 'KNOWN DATA: ' + JSON.stringify(r.knownData) : '';
    const parts = [r.title, r.description, r.bodyText && r.bodyText.slice(0, 1500), (r.internalTexts || []).join(' ').slice(0, 1500)].filter(Boolean).join('. ');
    return '[' + (i + 1) + '] ' + known + '\nCONTENT: ' + parts;
  }).join('\n\n---\n\n');

  const colList = targetColumns.join(', ');

  const prompt = 'You are a data enrichment agent. For each row below, extract information into these columns: ' + colList + '.\n\n' + batchContent + '\n\nRules:\n1. Clean up FIRSTNAME if it contains "First Last" -> split into FIRSTNAME and LASTNAME.\n2. Only fill a field if directly supported by the scraped content or known data.\n3. For generic email domains (gmail, yahoo, etc.), try to find the person by name + email. For business domains, search the company site.\n4. If you cannot verify a field, leave it empty - do not guess.\n5. Return a JSON array with one object per row (same order). Each object has keys matching the target columns plus a "confidence" field ("high", "medium", "low", or "none").\n6. If confidence is "none", set all enriched fields to empty (except name cleanup).\n7. CONTEXT should contain a 2-3 sentence summary of what the person/company does.\n\nReturn ONLY valid JSON array.';

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 6000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed)) {
      return parsed.map(r => {
        if (!r || typeof r !== 'object') return null;
        const out = {};
        for (const col of targetColumns) {
          out[col] = ai.sanitizeAiPlainText(String(r[col] || ''), 2000);
        }
        out.confidence = String(r.confidence || 'low').toLowerCase();
        if (out.confidence === 'none') {
          for (const col of targetColumns) {
            if (col !== 'FIRSTNAME' && col !== 'LASTNAME') out[col] = '';
          }
        }
        return out;
      }).filter(Boolean);
    }
    if (typeof ai._salvageJsonArray === 'function') {
      const salvaged = ai._salvageJsonArray(text);
      if (Array.isArray(salvaged) && salvaged.length) {
        return salvaged.map(r => {
          const out = {};
          for (const col of targetColumns) out[col] = ai.sanitizeAiPlainText(String(r && r[col] || ''), 2000);
          out.confidence = String(r && r.confidence || 'low').toLowerCase();
          return out;
        });
      }
    }
  } catch (err) {
    logger.warn('[Enrich] Batch AI analysis failed: ' + err.message);
  }
  return [];
}

async function reviewBatchWithAI(extracted, scrapedData) {
  if (!extracted || extracted.length === 0) return extracted;
  const reviewContent = extracted.map((r, i) => {
    const source = scrapedData[i] ? (scrapedData[i].bodyText || '').slice(0, 1000) : '';
    return '[' + (i + 1) + '] EXTRACTED: ' + JSON.stringify(r) + '\nSOURCE: ' + source;
  }).join('\n\n');

  const prompt = 'Review these extracted data points against their source content. Remove any field not directly supported by the source. Adjust confidence. Return the corrected JSON array (same structure, same order).\n\n' + reviewContent + '\n\nReturn ONLY valid JSON array with the same keys plus "confidence".';

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 4000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed) && parsed.length === extracted.length) {
      return parsed.map((r, i) => {
        if (!r || typeof r !== 'object') return extracted[i];
        const out = Object.assign({}, extracted[i]);
        for (const key of Object.keys(r)) {
          if (r[key] !== undefined && r[key] !== null && r[key] !== '') {
            out[key] = (typeof r[key] === 'string') ? r[key] : String(r[key]);
          }
        }
        out.confidence = String(r.confidence || extracted[i].confidence || 'low').toLowerCase();
        return out;
      });
    }
  } catch (err) {
    logger.warn('[Enrich] Review pass failed: ' + err.message);
  }
  return extracted;
}
