import { NextResponse } from "next/server";
import { getSheetsAuthClient, updateSheetRowApi, getSheetDataApi } from "../../api/googlesheets.js";
import { google } from "googleapis";
import axios from "axios";
import * as cheerio from "cheerio";
import geminiHelper from "../../api/gemini.js";
import logger from "../../../utils/logger.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const STANDARD_88_COLUMNS = [
  'SN',
  'FIRSTNAME', 'LASTNAME', 'EMAIL', 'ADDRESS', 'CITY', 'STATE', 'COUNTRY', 'ZIPCODE', 'PHONE', 'SEX',
  'BUSINESSNAME', 'BUSINESSADDRESS', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'BUSINESSZIPCODE', 'BUSINESSPHONE', 'BUSINESSEMAIL',
  'SOCIALPLATFORM', 'SOCIALUSERNAME', 'SOCIALPHONE',
  'CONTEXT',
  'URL', '', '', '', '', '',
  'campaignType', 'engine', 'provider',
  'shooterFirstName', 'shooterLastName', 'shooterEmail', 'shooterAddress', 'shooterCity', 'shooterState', 'shooterCountry', 'shooterZipCode', 'shooterPhone', 'shooterSex',
  'smtp', 'port', 'username', 'password', 'appPassword', 'backupCode', 'oAuth2ClientId', 'oAuth2ClientSecret', 'oAuth2RefreshToken',
  '',
  'shouldValidate', 'shouldEnhance', 'shouldSearchInteract', 'shouldPageInteract', 'shouldInboxInteract', 'shouldActivitiesInteract', 'shouldSendMessage',
  '', '',
  'emailSubject', 'emailBody', 'socialMessage', 'replyTo',
  '', '', '',
  'validation', 'providerMXResult', 'enhancedSubject', 'enhancedBody', 'enhancedSocialMessage',
  '', '',
  'sendDate', 'sendTime', 'sendStamp',
  '', '', '',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  '',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp'
];

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

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else { inQuotes = false; }
      } else {
        row[row.length - 1] += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(""); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
  }
  if (row.length > 1 || row[0] !== "") lines.push(row);
  return lines;
}

function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? "" : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');
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

    // Remove noise elements
    $("script, style, noscript, nav, footer, header").remove();

    const title = $("title").text().trim()
      || $("meta[property='og:title']").attr("content")
      || "";

    const description = $("meta[name='description']").attr("content")
      || $("meta[property='og:description']").attr("content")
      || "";

    // Prefer main > article > body for content extraction
    const main = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    const bodyText = main.text().replace(/\s+/g, " ").trim().slice(0, 3000);

    return { title, description, bodyText, status: resp.status, url };
  } catch (err) {
    logger.warn(`[Enrich] Scrape failed for ${url}: ${err.message}`);
    return null;
  }
}

async function analyzeWithGemini(scrapeResult) {
  if (!geminiHelper.model) {
    logger.warn("[Enrich] Gemini model not initialized, using raw scrape data");
    return null;
  }

  const { title = "", description = "", bodyText = "" } = scrapeResult;
  const content = [title, description, bodyText.slice(0, 1500)].filter(Boolean).join(". ");

  if (!content) return null;

  const prompt = `Analyze this webpage content and extract a concise summary useful for cold outreach.
Extract: company description, industry, key services/products, tone of the page.

Page content:
${content}

Return ONLY a valid JSON object:
{"summary": "2-3 sentence company summary", "industry": "detected industry", "services": "key services or products"}`;

  try {
    const result = await geminiHelper.model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return `${parsed.summary || ""} Industry: ${parsed.industry || "unknown"}. Services: ${parsed.services || "unknown"}.`;
    }
  } catch (err) {
    logger.warn(`[Enrich] Gemini analysis failed: ${err.message}`);
  }
  return null;
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { campaignId, fileUrl } = body;

    logger.info(`[Enrich Campaign] Received enrichment request for campaign: ${campaignId}`);

    if (!campaignId || !fileUrl) {
      return NextResponse.json({ success: false, error: "Missing campaignId or fileUrl" }, { status: 400 });
    }

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json({ success: false, error: "Invalid fileUrl or Drive file ID" }, { status: 400 });
    }

    const authClient = await getSheetsAuthClient();
    if (!authClient) {
      return NextResponse.json({ success: false, error: "Failed to authenticate with Google APIs" }, { status: 500 });
    }

    const drive = google.drive({ version: "v3", auth: authClient });

    // 1. Download CSV
    logger.info(`[Enrich Campaign] Downloading CSV file: ${fileId}`);
    const driveFile = await drive.files.get({ fileId, alt: "media" });
    const csvContent = driveFile.data;
    if (typeof csvContent !== "string") {
      throw new Error("Failed to download CSV as text content");
    }

    const rows = parseCSV(csvContent);
    if (rows.length === 0) throw new Error("CSV file is empty");

    const headers = rows[0];

    // 2. Find column indices (header-name lookup, works with both normalized and raw CSV)
    const emailIdx = headers.findIndex(h => {
      const n = h.toLowerCase().trim();
      return n === "email" || n === "mail" || n === "email address";
    });
    if (emailIdx === -1) throw new Error("No email column found in CSV headers");

    const firstNameIdx = headers.findIndex(h => {
      const n = h.toLowerCase().trim();
      return n === "firstname" || n === "first name" || n === "first" || n === "name";
    });
    const companyIdx = headers.findIndex(h => {
      const n = h.toLowerCase().trim();
      return n === "businessname" || n === "business name" || n === "company" || n === "organization";
    });
    const urlIdx = headers.findIndex(h => h.toUpperCase() === "URL");
    const contextIdx = headers.findIndex(h => h.toUpperCase() === "CONTEXT");

    logger.info(`[Enrich Campaign] Columns - email:${emailIdx}, firstName:${firstNameIdx}, company:${companyIdx}, url:${urlIdx}, context:${contextIdx}`);

    // 3. Enrich rows
    let enrichedCount = 0;
    let urlScrapedCount = 0;
    const MAX_URLS = 30;

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      while (row.length < headers.length) row.push("");

      const email = row[emailIdx]?.trim();
      if (!email) continue;

      // Infer first name if missing
      if (firstNameIdx !== -1 && !row[firstNameIdx]?.trim()) {
        row[firstNameIdx] = inferFirstName(email);
      }

      // Infer company if missing
      if (companyIdx !== -1 && !row[companyIdx]?.trim()) {
        row[companyIdx] = inferCompany(email);
      }

      // URL enrichment: scrape + Gemini analysis -> CONTEXT
      if (urlIdx !== -1 && urlScrapedCount < MAX_URLS) {
        const url = row[urlIdx]?.trim();
        if (url && url.startsWith("http")) {
          logger.info(`[Enrich Campaign] Scraping URL ${urlScrapedCount + 1}/${MAX_URLS}: ${url}`);
          const scrapeResult = await scrapeUrl(url);

          if (scrapeResult && !scrapeResult.error) {
            urlScrapedCount++;

            // Try Gemini analysis first
            let contextValue = await analyzeWithGemini(scrapeResult);

            // Fall back to raw scrape data
            if (!contextValue) {
              const parts = [];
              if (scrapeResult.title) parts.push(`Page: ${scrapeResult.title}`);
              if (scrapeResult.description) parts.push(scrapeResult.description);
              contextValue = parts.join(". ") || "";
            }

            if (contextValue && contextIdx !== -1) {
              row[contextIdx] = contextValue;
            }
          }

          // Rate limit between fetches
          await new Promise(r => setTimeout(r, 200));
        }
      }

      enrichedCount++;
    }

    // 4. Save CSV back to Drive
    logger.info(`[Enrich Campaign] Uploading enriched CSV to Drive: ${fileId}`);
    await drive.files.update({
      fileId,
      media: { mimeType: "text/csv", body: stringifyCSV(rows) }
    });

    // 5. Update campaign status
    logger.info(`[Enrich Campaign] Updating enrichmentStatus = 'completed'`);
    const campaignsResult = await getSheetDataApi("campaigns");
    if (campaignsResult.success) {
      const cHeaders = campaignsResult.headers;
      const cIdIndex = cHeaders.indexOf("campaignId");
      const cSettingsIndex = cHeaders.indexOf("settings");
      const campaignRow = campaignsResult.data.find(r => r[cIdIndex] === campaignId);
      if (campaignRow && cSettingsIndex !== -1) {
        const settingsStr = campaignRow[cSettingsIndex];
        let settings = {};
        try {
          settings = typeof settingsStr === "string" ? JSON.parse(settingsStr) : (settingsStr || {});
        } catch (e) {
          logger.warn(`[Enrich Campaign] Settings parse failed: ${e.message}`);
        }
        settings.enrichmentStatus = "completed";
        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          settings: JSON.stringify(settings),
          updatedOn: new Date().toISOString()
        });
      }
    }

    return NextResponse.json({
      success: true,
      message: "Campaign enrichment completed",
      total: rows.length - 1,
      enrichedCount,
      urlsScraped: urlScrapedCount
    });

  } catch (error) {
    logger.error(`[Enrich Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
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
