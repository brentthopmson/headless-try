import { NextResponse } from "next/server";
import { getSheetsAuthClient } from "../../api/googlesheets.js";
import { google } from "googleapis";
import axios from "axios";
import * as cheerio from "cheerio";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { isMultiServerEnabled, dispatchToServers, findMyAssignment, updateMyAssignment, mergeAndFlush, checkAllComplete } from "../../../utils/multiServerDispatcher.js";
import { extractFileId, parseCSV, stringifyCSV, isCampaignPaused, updateCampaignSettings } from "../_shared/pipelineUtils.js";
import { getSelfUrl, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";

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
      params: { q: query, num: 3, hl: "en" },
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
      if (results.length >= 3) return false;
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

async function analyzeBatchWithGemini(scrapeResults) {
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
    const text = await ai.generate(prompt, { maxTokens: 4000 });
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    logger.warn(`[Enrich] Batch AI analysis failed: ${err.message}`);
  }
  return [];
}

export async function POST(request) {
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const { campaignId, fileUrl, serverBatch } = body;

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    if (serverBatch) {
      return await handleWorkerMode(campaignId, fileUrl, serverBatch);
    }

    if (!fileUrl) {
      return NextResponse.json({ success: false, error: "Missing fileUrl" }, { status: 400 });
    }

    return await handleCoordinatorMode(campaignId, fileUrl);

  } catch (error) {
    logger.error(`[Enrich Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

async function handleCoordinatorMode(campaignId, fileUrl) {
  logger.info(`[Enrich Campaign] Received enrichment request for campaign: ${campaignId}`);

  const fileId = extractFileId(fileUrl);
  if (!fileId) {
    return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
  }

  const authClient = await getSheetsAuthClient();
  if (!authClient) {
    return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
  }
  const drive = google.drive({ version: "v3", auth: authClient });

  // Read batch limits from SETTINGS
  const enrichBatchSetting = await getSetting('enrichBatchLimit');
  const ENRICH_BATCH_SIZE = parseInt(enrichBatchSetting?.value1) || 20;
  const searchBatchSetting = await getSetting('enrichSearchBatchLimit');
  const SEARCH_BATCH_SIZE = parseInt(searchBatchSetting?.value1) || 10;
  const aiBatchSetting = await getSetting('enrichAiBatchLimit');
  const AI_BATCH_SIZE = parseInt(aiBatchSetting?.value1) || 15;

  logger.info(`[Enrich Campaign] enrich=${ENRICH_BATCH_SIZE}, search=${SEARCH_BATCH_SIZE}, ai=${AI_BATCH_SIZE}`);

  // 1. Download CSV
  logger.info(`[Enrich Campaign] Downloading CSV file: ${fileId}`);
  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV as text content");

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

  const dataRows = parsedRows.slice(1);

  // Apply enrichLimit from Limits sheet
  const campaignLimits = await getCampaignLimits();
  if (campaignLimits.enrichLimit > 0 && dataRows.length > campaignLimits.enrichLimit) {
    dataRows.length = campaignLimits.enrichLimit;
    logger.info(`[Enrich Campaign] enrichLimit (${campaignLimits.enrichLimit}) applied: capped to ${dataRows.length} rows`);
  }
  logger.info(`[Enrich Campaign] Processing ${dataRows.length} rows`);

  const multiEnabled = await isMultiServerEnabled();
  if (multiEnabled) {
    const dispatchResult = await dispatchToServers(campaignId, 'enrich', fileUrl, dataRows.length);
    if (dispatchResult) {
      return NextResponse.json({ success: true, dispatched: true, servers: dispatchResult.servers });
    }
  }

  // 3. Inference pass (firstName, company from email)
  for (const row of dataRows) {
    const email = row[emailIdx]?.trim();
    if (!email) continue;
    if (firstNameIdx !== -1 && !row[firstNameIdx]?.trim()) {
      row[firstNameIdx] = inferFirstName(email);
    }
    if (companyIdx !== -1 && !row[companyIdx]?.trim()) {
      row[companyIdx] = inferCompany(email);
    }
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
      logger.info(`[Enrich Campaign] Campaign paused at URL batch ${batchIdx + 1}/${enrichBatchCount}`);
      break;
    }

    const start = batchIdx * ENRICH_BATCH_SIZE;
    const end = Math.min(start + ENRICH_BATCH_SIZE, rowsWithUrl.length);
    const batch = rowsWithUrl.slice(start, end);

    const scrapePromises = batch.map(async (row) => {
      const url = row[urlIdx]?.trim();
      if (scrapeCache.has(url)) {
        const cached = scrapeCache.get(url);
        if (cached && contextIdx !== -1) row[contextIdx] = cached;
        return;
      }

      const result = await scrapeUrl(url);
      if (result) {
        let contextValue = null;
        const parts = [];
        if (result.title) parts.push(`Page: ${result.title}`);
        if (result.description) parts.push(result.description);
        contextValue = parts.join(". ") || "";

        if (contextIdx !== -1) row[contextIdx] = contextValue;
        scrapeCache.set(url, contextValue);
        urlScrapedCount++;
      }

      await new Promise(r => setTimeout(r, 200));
    });

    await Promise.allSettled(scrapePromises);

    // Live flush
    try {
      await drive.files.update({
        fileId,
        media: { mimeType: "text/csv", body: stringifyCSV(parsedRows) }
      });
    } catch (flushErr) {
      logger.warn(`[Enrich Campaign] Live flush failed at batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    logger.info(`[Enrich Campaign] URL batch ${batchIdx + 1}/${enrichBatchCount} complete (${urlScrapedCount} scraped)`);
  }

  // 5. Google Search Fallback (rows without URL, batched)
  let searchFoundCount = 0;
  const rowsWithoutUrl = dataRows.filter(r => {
    const url = r[urlIdx]?.trim();
    const email = r[emailIdx]?.trim();
    const context = r[contextIdx]?.trim();
    return email && (!url || !url.startsWith("http")) && (!context || context.length < 10);
  });

  const searchBatchCount = Math.ceil(rowsWithoutUrl.length / SEARCH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < searchBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Enrich Campaign] Campaign paused at search batch ${batchIdx + 1}/${searchBatchCount}`);
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

      const results = await googleSearch(query);
      if (results.length > 0) {
        const bestResult = results.find(r =>
          r.url.includes("linkedin.com") || r.url.includes("twitter.com") || r.url.includes("github.com")
        ) || results[0];

        let contextValue = bestResult.snippet || bestResult.title || "";
        if (bestResult.url && contextIdx !== -1) {
          contextValue = `${contextValue} | Profile: ${bestResult.url}`.trim();
        }
        if (contextIdx !== -1) row[contextIdx] = contextValue;
        searchFoundCount++;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    // Live flush
    try {
      await drive.files.update({
        fileId,
        media: { mimeType: "text/csv", body: stringifyCSV(parsedRows) }
      });
    } catch (flushErr) {
      logger.warn(`[Enrich Campaign] Live flush failed at search batch ${batchIdx + 1}: ${flushErr.message}`);
    }

    logger.info(`[Enrich Campaign] Search batch ${batchIdx + 1}/${searchBatchCount} complete (${searchFoundCount} found)`);
  }

  // 6. Batch AI Analysis (on scraped content)
  const rowsNeedingAnalysis = dataRows.filter(r => {
    const context = r[contextIdx]?.trim();
    return context && context.length > 10 && !context.includes("Industry:");
  });

  const aiBatchCount = Math.ceil(rowsNeedingAnalysis.length / AI_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < aiBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) break;

    const start = batchIdx * AI_BATCH_SIZE;
    const end = Math.min(start + AI_BATCH_SIZE, rowsNeedingAnalysis.length);
    const batch = rowsNeedingAnalysis.slice(start, end);

    const scrapeResults = batch.map(row => ({
      title: "",
      description: row[contextIdx]?.trim() || "",
      bodyText: ""
    }));

    let aiResults = await analyzeBatchWithGemini(scrapeResults);

    // Dynamic batch reduction: if AI fails, retry with half batch
    if (!aiResults || aiResults.length === 0) {
      const halfSize = Math.ceil(scrapeResults.length / 2);
      if (halfSize >= 2) {
        logger.warn(`[Enrich Campaign] AI batch failed, retrying with half size (${halfSize})`);
        const halfResults = scrapeResults.slice(0, halfSize);
        const retryResults = await analyzeBatchWithGemini(halfResults);
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
              if (enriched) batch[i][contextIdx] = enriched;
            }
          }
          logger.info(`[Enrich Campaign] AI retry succeeded for ${halfSize} items`);
          continue;
        }
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const aiResult = aiResults[i];
      if (aiResult) {
        const enriched = [
          aiResult.summary,
          aiResult.industry ? `Industry: ${aiResult.industry}` : "",
          aiResult.services ? `Services: ${aiResult.services}` : ""
        ].filter(Boolean).join(". ");
        if (enriched) batch[i][contextIdx] = enriched;
      }
    }

    logger.info(`[Enrich Campaign] AI batch ${batchIdx + 1}/${aiBatchCount} complete`);
  }

  // 7. Final CSV flush
  logger.info(`[Enrich Campaign] Final CSV flush to Drive: ${fileId}`);
  await drive.files.update({
    fileId,
    media: { mimeType: "text/csv", body: stringifyCSV(parsedRows) }
  });

  // 8. Update campaign settings
  await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });

  // Auto-advance pipeline
  try {
    const selfUrl = getSelfUrl();
    fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId })
    }).catch(err => logger.warn(`[Enrich Campaign] Auto-advance failed: ${err.message}`));
  } catch {}

  return NextResponse.json({
    success: true,
    message: "Campaign enrichment completed",
    total: dataRows.length,
    urlsScraped: urlScrapedCount,
    searchFound: searchFoundCount,
    aiAnalyzed: rowsNeedingAnalysis.length
  });
}

async function handleWorkerMode(campaignId, fileUrl, serverBatch) {
  logger.info(`[Enrich Campaign] Worker mode for campaign: ${campaignId}, rows ${serverBatch.rowStart}-${serverBatch.rowEnd}`);

  const assignment = await findMyAssignment(campaignId, 'enrich');
  if (!assignment) {
    return NextResponse.json({ success: false, error: "No assignment found for this worker" }, { status: 404 });
  }

  await updateMyAssignment(campaignId, 'enrich', { status: 'running' });

  const fileId = extractFileId(fileUrl);
  if (!fileId) {
    return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
  }

  const authClient = await getSheetsAuthClient();
  if (!authClient) {
    return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
  }
  const drive = google.drive({ version: "v3", auth: authClient });

  const enrichBatchSetting = await getSetting('enrichBatchLimit');
  const ENRICH_BATCH_SIZE = parseInt(enrichBatchSetting?.value1) || 20;
  const searchBatchSetting = await getSetting('enrichSearchBatchLimit');
  const SEARCH_BATCH_SIZE = parseInt(searchBatchSetting?.value1) || 10;
  const aiBatchSetting = await getSetting('enrichAiBatchLimit');
  const AI_BATCH_SIZE = parseInt(aiBatchSetting?.value1) || 15;

  // 1. Download full CSV
  logger.info(`[Enrich Campaign] Worker downloading CSV file: ${fileId}`);
  const driveFile = await drive.files.get({ fileId, alt: "media" });
  const csvContent = driveFile.data;
  if (typeof csvContent !== "string") throw new Error("Failed to download CSV as text content");

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

  const allDataRows = parsedRows.slice(1);

  // 3. Extract assigned slice
  const rowStart = serverBatch.rowStart || 0;
  const rowEnd = Math.min(serverBatch.rowEnd || allDataRows.length, allDataRows.length);
  const dataRows = allDataRows.slice(rowStart, rowEnd);

  logger.info(`[Enrich Campaign] Worker processing ${dataRows.length} rows (slice ${rowStart}-${rowEnd})`);

  // 4. Inference pass
  for (const row of dataRows) {
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
  const scrapeCache = new Map();
  const rowsWithUrl = dataRows.filter(r => {
    const url = r[urlIdx]?.trim();
    return url && url.startsWith("http");
  });

  const enrichBatchCount = Math.ceil(rowsWithUrl.length / ENRICH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < enrichBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Enrich Campaign] Worker campaign paused at URL batch ${batchIdx + 1}/${enrichBatchCount}`);
      break;
    }

    const start = batchIdx * ENRICH_BATCH_SIZE;
    const end = Math.min(start + ENRICH_BATCH_SIZE, rowsWithUrl.length);
    const batch = rowsWithUrl.slice(start, end);

    const scrapePromises = batch.map(async (row) => {
      const url = row[urlIdx]?.trim();
      if (scrapeCache.has(url)) {
        const cached = scrapeCache.get(url);
        if (cached && contextIdx !== -1) row[contextIdx] = cached;
        return;
      }

      const result = await scrapeUrl(url);
      if (result) {
        let contextValue = null;
        const parts = [];
        if (result.title) parts.push(`Page: ${result.title}`);
        if (result.description) parts.push(result.description);
        contextValue = parts.join(". ") || "";

        if (contextIdx !== -1) row[contextIdx] = contextValue;
        scrapeCache.set(url, contextValue);
        urlScrapedCount++;
      }

      await new Promise(r => setTimeout(r, 200));
    });

    await Promise.allSettled(scrapePromises);

    await updateMyAssignment(campaignId, 'enrich', {
      processedUpTo: rowStart + (batchIdx + 1) * ENRICH_BATCH_SIZE
    });
    await mergeAndFlush(campaignId, 'enrich', parsedRows, fileId);

    logger.info(`[Enrich Campaign] Worker URL batch ${batchIdx + 1}/${enrichBatchCount} complete (${urlScrapedCount} scraped)`);
  }

  // 6. Google Search Fallback
  let searchFoundCount = 0;
  const rowsWithoutUrl = dataRows.filter(r => {
    const url = r[urlIdx]?.trim();
    const email = r[emailIdx]?.trim();
    const context = r[contextIdx]?.trim();
    return email && (!url || !url.startsWith("http")) && (!context || context.length < 10);
  });

  const searchBatchCount = Math.ceil(rowsWithoutUrl.length / SEARCH_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < searchBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Enrich Campaign] Worker campaign paused at search batch ${batchIdx + 1}/${searchBatchCount}`);
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

      const results = await googleSearch(query);
      if (results.length > 0) {
        const bestResult = results.find(r =>
          r.url.includes("linkedin.com") || r.url.includes("twitter.com") || r.url.includes("github.com")
        ) || results[0];

        let contextValue = bestResult.snippet || bestResult.title || "";
        if (bestResult.url && contextIdx !== -1) {
          contextValue = `${contextValue} | Profile: ${bestResult.url}`.trim();
        }
        if (contextIdx !== -1) row[contextIdx] = contextValue;
        searchFoundCount++;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    await updateMyAssignment(campaignId, 'enrich', {
      processedUpTo: rowStart + (batchIdx + 1) * SEARCH_BATCH_SIZE
    });
    await mergeAndFlush(campaignId, 'enrich', parsedRows, fileId);

    logger.info(`[Enrich Campaign] Worker search batch ${batchIdx + 1}/${searchBatchCount} complete (${searchFoundCount} found)`);
  }

  // 7. Batch AI Analysis
  const rowsNeedingAnalysis = dataRows.filter(r => {
    const context = r[contextIdx]?.trim();
    return context && context.length > 10 && !context.includes("Industry:");
  });

  const aiBatchCount = Math.ceil(rowsNeedingAnalysis.length / AI_BATCH_SIZE);
  for (let batchIdx = 0; batchIdx < aiBatchCount; batchIdx++) {
    if (await isCampaignPaused(campaignId)) break;

    const start = batchIdx * AI_BATCH_SIZE;
    const end = Math.min(start + AI_BATCH_SIZE, rowsNeedingAnalysis.length);
    const batch = rowsNeedingAnalysis.slice(start, end);

    const scrapeResults = batch.map(row => ({
      title: "",
      description: row[contextIdx]?.trim() || "",
      bodyText: ""
    }));

    let aiResults = await analyzeBatchWithGemini(scrapeResults);

    // Dynamic batch reduction: if AI fails, retry with half batch
    if (!aiResults || aiResults.length === 0) {
      const halfSize = Math.ceil(scrapeResults.length / 2);
      if (halfSize >= 2) {
        logger.warn(`[Enrich Campaign] Worker AI batch failed, retrying with half size (${halfSize})`);
        const halfResults = scrapeResults.slice(0, halfSize);
        const retryResults = await analyzeBatchWithGemini(halfResults);
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
              if (enriched) batch[i][contextIdx] = enriched;
            }
          }
          logger.info(`[Enrich Campaign] Worker AI retry succeeded for ${halfSize} items`);
          continue;
        }
      }
    }

    for (let i = 0; i < batch.length; i++) {
      const aiResult = aiResults[i];
      if (aiResult) {
        const enriched = [
          aiResult.summary,
          aiResult.industry ? `Industry: ${aiResult.industry}` : "",
          aiResult.services ? `Services: ${aiResult.services}` : ""
        ].filter(Boolean).join(". ");
        if (enriched) batch[i][contextIdx] = enriched;
      }
    }

    logger.info(`[Enrich Campaign] Worker AI batch ${batchIdx + 1}/${aiBatchCount} complete`);
  }

  // 8. Final flush
  logger.info(`[Enrich Campaign] Worker final flush to Drive: ${fileId}`);
  await drive.files.update({
    fileId,
    media: { mimeType: "text/csv", body: stringifyCSV(parsedRows) }
  });

  await updateMyAssignment(campaignId, 'enrich', {
    status: 'completed',
    processedUpTo: rowEnd
  });

  // 9. Check if all workers are done
  const allDone = await checkAllComplete(campaignId, 'enrich');
  if (allDone) {
    await updateCampaignSettings(campaignId, { enrichmentStatus: "completed" });
    try {
      const selfUrl = getSelfUrl();
      fetch(`${selfUrl}/campaign/pipeline-orchestrator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignId })
      }).catch(err => logger.warn(`[Enrich Campaign] Worker auto-advance failed: ${err.message}`));
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
