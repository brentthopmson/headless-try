import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import { launchBrowserWithSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";
import { isCampaignPaused, updateCampaignSettings, getCampaignSettings } from "../_shared/pipelineUtils.js";
import { notifyCampaignFailure } from "../../../utils/notifyCampaignFailure.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// ==================== Per-provider inbox automation config ====================
// Mirrors PROVIDER_CONFIGS in wireSender.js but for reading + replying in the inbox.
const INBOX_CONFIGS = {
  gmail: {
    inboxUrl: "https://mail.google.com/mail/u/0/#inbox",
    unreadRow: "tr.zA.zE",
    anyRow: "tr.zA",
    rowSender: ".yW span[email], .yW .zF",
    rowSubject: ".bog, .bqe",
    rowSnippet: ".y6 span",
    replyButton: "div[aria-label*='Reply'][role='button'], span[aria-label*='Reply'][role='button']",
    bodyInput: "div[role='textbox'][aria-label*='Message Body'], div.editable.LW-avf",
    sendButton: "div[aria-label*='Send'][role='button'], td[aria-label*='Send'] div[role='button']",
    keyboardFallback: "r",
    waitAfterOpen: 3500,
    waitAfterReplyOpen: 2500,
  },
  outlook: {
    inboxUrl: "https://outlook.live.com/mail/0/inbox",
    unreadRow: "div[role='option'][aria-label*='Unread'], div[data-convid]",
    anyRow: "div[role='option']",
    rowSender: "div[role='option'] div[title]",
    rowSubject: "div[role='option'] [aria-label*='Subject'], div[role='option'] span",
    rowSnippet: "",
    replyButton: "button[aria-label='Reply'], button[title='Reply']",
    bodyInput: "div[role='textbox'][aria-label*='Message'], div[role='textbox'][contenteditable='true']",
    sendButton: "button[aria-label='Send']",
    keyboardFallback: null,
    waitAfterOpen: 3500,
    waitAfterReplyOpen: 2500,
  },
  yahoo: {
    inboxUrl: "https://mail.yahoo.com/d/folders/1",
    unreadRow: "li[data-test='message-row'][data-is-unread='true']",
    anyRow: "li[data-test='message-row']",
    rowSender: "[data-test-id='sender']",
    rowSubject: "[data-test-id='subject']",
    rowSnippet: "[data-test-id='message-subtitle']",
    replyButton: "button[title='Reply'], button[aria-label='Reply']",
    bodyInput: "div[role='textbox'][contenteditable='true']",
    sendButton: "button[data-test-id='compose-send-button'], button[title='Send']",
    keyboardFallback: null,
    waitAfterOpen: 3500,
    waitAfterReplyOpen: 2500,
  },
  aol: {
    inboxUrl: "https://mail.aol.com/d/folders/1",
    unreadRow: "li[data-test='message-row'][data-is-unread='true']",
    anyRow: "li[data-test='message-row']",
    rowSender: "[data-test-id='sender']",
    rowSubject: "[data-test-id='subject']",
    rowSnippet: "",
    replyButton: "button[title='Reply'], button[aria-label='Reply']",
    bodyInput: "div[role='textbox'][contenteditable='true']",
    sendButton: "button[data-test-id='compose-send-button'], button[title='Send']",
    keyboardFallback: null,
    waitAfterOpen: 3500,
    waitAfterReplyOpen: 2500,
  },
};

function detectInboxProvider(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase() || "";
  if (domain.includes("gmail") || domain.includes("googlemail")) return "gmail";
  if (domain.includes("outlook") || domain.includes("hotmail") || domain.includes("live")) return "outlook";
  if (domain.includes("yahoo")) return "yahoo";
  if (domain.includes("aol")) return "aol";
  return null;
}

// Extract unread inbox items from the DOM.
async function scanInbox(page, cfg, maxScan) {
  const items = [];
  for (const rowSelector of [cfg.unreadRow, cfg.anyRow]) {
    if (!rowSelector) continue;
    try {
      const rows = await page.$$(rowSelector);
      for (const row of rows.slice(0, maxScan)) {
        try {
          const senderEl = await row.$(cfg.rowSender);
          const subjectEl = await row.$(cfg.rowSubject);
          const snippetEl = cfg.rowSnippet ? await row.$(cfg.rowSnippet) : null;
          const sender = senderEl ? ((await senderEl.textContent()) || "") : "";
          const subject = subjectEl ? ((await subjectEl.textContent()) || "") : "";
          const snippet = snippetEl ? ((await snippetEl.textContent()) || "") : "";
          const text = `${sender} ${subject} ${snippet}`.replace(/\s+/g, " ").trim();
          if (!text) continue;
          items.push({ row, sender: sender.trim(), subject: subject.trim(), snippet: snippet.trim(), text });
        } catch { /* skip malformed row */ }
      }
      if (items.length > 0) break;
    } catch { /* selector miss, try next */ }
  }
  const seen = new Set();
  return items.filter(i => {
    if (seen.has(i.text)) return false;
    seen.add(i.text);
    return true;
  });
}

// DOM keyword pre-filter — cheap, runs before the AI relevance pass.
function keywordMatches(item, keywords) {
  const text = item.text.toLowerCase();
  return keywords.some(k => text.includes(String(k).toLowerCase()));
}

function buildRelevancePrompt(itemList, settings) {
  const keywords = (settings.emailKeywords || []).join(", ");
  const strategy = settings.emailStrategyPrompt || "";
  const targetLink = settings.targetLink || "";
  const listing = itemList.map((it, i) =>
    `[${i}] From: ${it.sender || "unknown"} | Subject: ${it.subject || "no subject"} | Snippet: ${(it.snippet || it.text).slice(0, 200)}`
  ).join("\n");
  return `You are screening an email inbox for a campaign.

Campaign keywords: ${keywords || "(none provided — use the strategy context)"}
Campaign strategy: ${strategy || "General outreach engagement"}
${targetLink ? `Campaign target link: ${targetLink}` : ""}

Inbox items:
${listing}

Decide which items are RELEVANT to this campaign (matches the keywords/strategy, real sender — not automated no-reply addresses, not spam).

Return ONLY a JSON object: {"relevant": [{"index": 0, "reason": "why"}]}
Return {"relevant": []} if none match.`;
}

function buildReplyPrompt(item, settings) {
  const strategy = settings.emailStrategyPrompt || "";
  const targetLink = settings.targetLink || "";
  const keywords = (settings.emailKeywords || []).join(", ");
  return `Write a brief, professional email reply for this campaign.

Campaign keywords: ${keywords}
Campaign strategy: ${strategy || "General outreach engagement"}
${targetLink ? `Campaign target link: ${targetLink} — mention this destination naturally where it helps the conversation (show it as a plain URL).` : ""}
Replying to:
From: ${item.sender || "unknown"}
Subject: ${item.subject || "no subject"}
Message: ${(item.snippet || item.text).slice(0, 800)}

Rules:
- Under 80 words
- Professional, human, no placeholders
- Stay on-campaign; do not invent facts

Return ONLY the reply body text.`;
}

async function aiGenerate(prompt, fallback = null) {
  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt);
    return text ? text.trim() : fallback;
  } catch (err) {
    logger.warn(`[interact-inbox] AI generate failed: ${err.message}`);
    return fallback;
  }
}

async function aiSelectRelevant(itemList, settings) {
  const raw = await aiGenerate(buildRelevancePrompt(itemList, settings));
  if (!raw) return [];
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const out = [];
    for (const entry of parsed.relevant || []) {
      const idx = parseInt(entry.index, 10);
      if (!isNaN(idx) && idx >= 0 && idx < itemList.length) out.push({ item: itemList[idx], reason: entry.reason || "" });
    }
    return out;
  } catch {
    return [];
  }
}

function ledgerKey(item) {
  return `${(item.sender || "").toLowerCase()}|${(item.subject || "").toLowerCase()}`
    .replace(/[^a-z0-9|]/g, "").slice(0, 120);
}

async function fillAndSendReply(page, cfg, replyText) {
  const body = await page.$(cfg.bodyInput);
  if (!body) return false;
  await body.click();
  await body.type(replyText, { delay: 15 });
  await DOMHelpers.randomDelay(800, 1500);
  const send = await page.$(cfg.sendButton);
  if (send) {
    await send.click();
  } else {
    await page.keyboard.down("Control");
    await page.keyboard.press("Enter");
    await page.keyboard.up("Control");
  }
  await DOMHelpers.randomDelay(2000, 3000);
  return true;
}

async function replyToThread(page, cfg, replyText) {
  // Attempt 1: click the reply button
  const replyEl = await page.$(cfg.replyButton);
  if (replyEl) {
    await replyEl.click();
    await DOMHelpers.randomDelay(cfg.waitAfterReplyOpen * 0.8, cfg.waitAfterReplyOpen * 1.2);
    if (await fillAndSendReply(page, cfg, replyText)) return true;
  }
  // Attempt 2: keyboard fallback (e.g. Gmail "r")
  if (cfg.keyboardFallback) {
    await page.keyboard.press(cfg.keyboardFallback);
    await DOMHelpers.randomDelay(cfg.waitAfterReplyOpen * 0.8, cfg.waitAfterReplyOpen * 1.2);
    if (await fillAndSendReply(page, cfg, replyText)) return true;
  }
  return false;
}

// Fetch hub rows for the given account (submissionId) list.
async function getHubRows(accountIds) {
  const { getSheetDataApi } = await import("../../api/googlesheets.js");
  const result = await getSheetDataApi("hub");
  if (!result.success) return [];
  const headers = result.headers;
  const idIdx = headers.indexOf("submissionId");
  const emailIdx = headers.indexOf("email");
  const cookieIdx = headers.indexOf("formattedCookie") !== -1 ? headers.indexOf("formattedCookie") : headers.indexOf("cookieJSON");
  const idSet = new Set(accountIds);
  const out = [];
  for (const row of result.data) {
    const id = row[idIdx];
    if (!idSet.has(id)) continue;
    const cookie = cookieIdx !== -1 ? row[cookieIdx] : "";
    out.push({
      accountId: id,
      identifier: row[emailIdx] || "",
      cookieJSON: cookie && String(cookie).length > 10 ? cookie : "",
      provider: detectInboxProvider(row[emailIdx] || ""),
    });
  }
  return out;
}

export async function POST(request) {
  let campaignId = null;
  try {
    const body = await request.json();
    campaignId = body.campaignId;
    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    const log = logger.child({ campaignId, stage: "interact-inbox" });
    log.info(`AI inbox watcher triggered (interactions-only campaign)`);

    const campaignData = await getCampaignSettings(campaignId);
    if (!campaignData) {
      return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
    }
    const settings = campaignData.settings || {};

    const interactionAccountIds = settings.interactionAccounts || [];
    const emailKeywords = settings.emailKeywords || [];
    if (interactionAccountIds.length === 0) {
      return NextResponse.json({ success: false, error: "No interaction accounts selected for interactions-only campaign" }, { status: 400 });
    }
    if (emailKeywords.length === 0 && !settings.emailStrategyPrompt) {
      return NextResponse.json({ success: false, error: "Interactions-only campaigns require at least one keyword or a strategy prompt" }, { status: 400 });
    }

    // ─── Stop guards (same semantics as interact-campaign) ──────────
    const startedAt = settings.interactionStartedAt ? new Date(settings.interactionStartedAt) : new Date();
    const stopAfterHours = settings.interactionStopAfterHours || 72;
    const hoursElapsed = (Date.now() - startedAt.getTime()) / 3600000;
    let replyCount = settings.interactionRepliesCount || 0;
    const maxReplies = settings.interactionMaxReplies || 100;
    let planInteractionLimit = Infinity;
    try {
      const limits = await getCampaignLimits();
      planInteractionLimit = limits.interactionLimit || Infinity;
    } catch { /* unlimited if limits unavailable */ }

    if (hoursElapsed >= stopAfterHours) {
      await updateCampaignSettings(campaignId, { interactionStatus: "completed", interactionStoppedReason: "time_limit_reached" });
      return NextResponse.json({ success: true, message: "Stop guard: time limit reached", replies: 0 });
    }
    if (await isCampaignPaused(campaignId)) {
      return NextResponse.json({ success: true, message: "Campaign paused", replies: 0 });
    }

    // ─── Resolve hub accounts → cookies ─────────────────────────────
    const accounts = (await getHubRows(interactionAccountIds)).filter(a => a.cookieJSON);
    if (accounts.length === 0) {
      await updateCampaignSettings(campaignId, { interactionStatus: "failed", interactionStoppedReason: "no_account_cookies" });
      return NextResponse.json({ success: false, error: "No interaction accounts have cookies" }, { status: 400 });
    }

    // Ledger of already-replied threads (persisted in settings, capped)
    const repliedThreads = new Set(settings.repliedThreads || []);
    const maxScan = parseInt(String(settings.interactionMaxScan || ""), 10) || 25;

    let newReplies = 0;
    let scannedAccounts = 0;

    await updateCampaignSettings(campaignId, {
      interactionStatus: "monitoring",
      interactionStartedAt: settings.interactionStartedAt || new Date().toISOString(),
    });

    for (const account of accounts) {
      if (await isCampaignPaused(campaignId)) break;
      if (replyCount >= maxReplies || replyCount >= planInteractionLimit) break;

      const cfg = INBOX_CONFIGS[account.provider];
      if (!cfg) {
        log.warn(` Unsupported inbox provider for account ${account.identifier}: ${account.provider}`);
        continue;
      }

      let browser, page;
      try {
        ({ browser, page } = await launchBrowserWithSession(account.cookieJSON, false));
        scannedAccounts++;
        await page.goto(cfg.inboxUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
        await DOMHelpers.randomDelay(3000, 5000);

        const items = await scanInbox(page, cfg, maxScan);
        log.info(` [${account.identifier}] scanned ${items.length} inbox items`);

        if (items.length > 0) {
          // 1) AI relevance pass over the list; 2) DOM keyword pre-filter as safety net
          const candidates = [];
          const seenKeys = new Set();
          for (const hit of await aiSelectRelevant(items, settings)) {
            const key = ledgerKey(hit.item);
            if (!seenKeys.has(key)) { candidates.push(hit.item); seenKeys.add(key); }
          }
          for (const item of items) {
            const key = ledgerKey(item);
            if (keywordMatches(item, emailKeywords) && !seenKeys.has(key)) {
              candidates.push(item);
              seenKeys.add(key);
            }
          }

          for (const item of candidates) {
            if (replyCount >= maxReplies || replyCount >= planInteractionLimit) break;
            const key = ledgerKey(item);
            if (repliedThreads.has(key)) continue;

            const replyText = await aiGenerate(buildReplyPrompt(item, settings));
            if (!replyText) continue;

            const sent = await replyToThread(page, cfg, replyText);
            if (sent) {
              repliedThreads.add(key);
              replyCount++;
              newReplies++;
              log.info(` [${account.identifier}] AI replied to: ${item.subject || item.sender}`);
              // Persist ledger + count after each reply so we never double-reply
              await updateCampaignSettings(campaignId, {
                repliedThreads: Array.from(repliedThreads).slice(-200),
                interactionRepliesCount: replyCount,
              });
            }

            // Re-open the inbox after handling a thread
            await page.goto(cfg.inboxUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
            await DOMHelpers.randomDelay(2500, 4000);
          }
        }
      } catch (accErr) {
        log.warn(` [${account.identifier}] inbox pass failed: ${accErr.message}`);
      } finally {
        try { if (page) await page.close(); } catch { /* noop */ }
        try { if (browser) await browser.close(); } catch { /* noop */ }
      }
    }

    const done = replyCount >= maxReplies || replyCount >= planInteractionLimit;
    if (done) {
      await updateCampaignSettings(campaignId, { interactionStatus: "completed", interactionStoppedReason: "reply_limit_reached" });
    }

    log.info(` Inbox watcher done: scanned=${scannedAccounts} accounts, replies=${newReplies}, total=${replyCount}`);
    return NextResponse.json({
      success: true,
      message: "AI inbox interaction pass completed",
      stats: { scannedAccounts, newReplies, totalReplies: replyCount },
    });
  } catch (error) {
    logger.error(`[interact-inbox] Error: ${error.message}`, { stack: error.stack });
    if (campaignId) {
      await updateCampaignSettings(campaignId, { interactionStatus: "failed" }).catch(() => {});
      await notifyCampaignFailure({
        campaignId,
        stage: "interact",
        channelType: "email",
        failedCount: 1,
        error: error.message,
        details: { route: "/campaign/interact-inbox", stack: error.stack },
      }).catch(() => {});
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
