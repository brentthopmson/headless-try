import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";
import { launchBrowserWithSession, resolveSocialSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { getCampaignLimits, checkActionAllowed, checkUserQuota } from "../../socials/_shared/limits.js";
import { resolveAccountGate } from "../../socials/_shared/accountGate.js";
import { getAccountUsage, updateAccountUsage, updateUserUsage, setActiveCampaignForAccount, clearActiveCampaignForAccount, seedCampaignAccountsInStats } from "../../socials/_shared/hubUpdater.js";
import { isCampaignPaused, updateCampaignSettings, getCampaignSettings, buildQueryUrl } from "../../campaign/_shared/pipelineUtils.js";
import { updateSheetRowApi } from "../../api/googlesheets.js";
import { INBOX_CONFIGS, detectInboxProvider } from "./platform.js";
import { notifyCampaignFailure } from "../../../utils/notifyCampaignFailure.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// Extract inbox items from the DOM on the current page.
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
          // Thread identity: prefer the provider's stable thread id so the
          // same thread seen on two surfaces (search + label + inbox)
          // dedupes to one ledger entry.
          let threadId = "";
          try {
            threadId = (await row.evaluate(el =>
              el.getAttribute('data-thread-id') || el.getAttribute('data-legacy-thread-id') ||
              el.getAttribute('data-convid') || el.getAttribute('data-id') || ''
            ).catch(() => '')) || '';
          } catch { /* noop */ }
          items.push({ row, sender: sender.trim(), subject: subject.trim(), snippet: snippet.trim(), text, threadId: String(threadId) });
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

// Never reply to automated/system mail — these are not conversations.
const AUTOMATED_SENDER_RE = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|bounce|undeliverable|delivery-?status|auto-?reply)/i;
function isAutomatedSender(item) {
  return AUTOMATED_SENDER_RE.test(String(item?.sender || '')) || /out of office|automatic reply|delivery status notification/i.test(String(item?.subject || ''));
}

// Person-specific interaction link: interactionTargetLink (fallback:
// targetLink) + ?email=<thread contact>. Extracted from the sender field.
function extractContactEmail(item) {
  const m = String(item?.sender || item?.text || "").match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  return m ? m[0] : "";
}

function buildPersonalInteractionLink(item, settings) {
  const base = String(settings.interactionTargetLink || settings.targetLink || "").trim();
  if (!base) return "";
  const email = extractContactEmail(item);
  return email ? buildQueryUrl(base, "email", email) : base;
}

function buildRelevancePrompt(itemList, settings, knownContacts = [], helperKeywords = []) {
  // Watch keywords ∪ campaign helper keyword (stamped on every CSV row at
  // shoot time) ∪ any per-row HELPERKEYWORD values from the CSV.
  const keywordSet = new Set([...(settings.emailKeywords || []).map(k => String(k).trim()).filter(Boolean)]);
  if (settings.helperKeyword) keywordSet.add(String(settings.helperKeyword).trim());
  for (const k of helperKeywords) if (k) keywordSet.add(k);
  const keywords = [...keywordSet].join(", ");
  const strategy = settings.emailStrategyPrompt || "";
  const targetLink = settings.interactionTargetLink || settings.targetLink || "";
  const listing = itemList.map((it, i) =>
    `[${i}] From: ${it.sender || "unknown"} | Subject: ${it.subject || "no subject"} | Snippet: ${(it.snippet || it.text).slice(0, 200)}`
  ).join("\n");
  const known = knownContacts.length
    ? `\nKnown campaign recipients (replies from these addresses are HIGHLY relevant): ${knownContacts.slice(0, 50).join(", ")}${knownContacts.length > 50 ? ` (+${knownContacts.length - 50} more)` : ""}\n`
    : "";
  return `You are screening an email inbox for a campaign.

Campaign keywords: ${keywords || "(none provided — use the strategy context)"}
Campaign strategy: ${strategy || "General outreach engagement"}
${targetLink ? `Campaign target link: ${targetLink}` : ""}${known}
Inbox items:
${listing}

Decide which items are RELEVANT to this campaign (matches the keywords/strategy, or is a reply from a known campaign recipient; real sender — not automated no-reply addresses, not spam).

Return ONLY a JSON object: {"relevant": [{"index": 0, "reason": "why"}]}
Return {"relevant": []} if none match.`;
}

function buildReplyPrompt(item, settings, threadTurn = 0) {
  const strategy = settings.emailStrategyPrompt || "";
  const keywords = (settings.emailKeywords || []).join(", ");
  const linkAfterTurns = Math.max(0, parseInt(settings.linkAfterTurns, 10) || 0);
  const personalLink = buildPersonalInteractionLink(item, settings);
  // Link gate: only hand the AI the person-specific link once the contact
  // has replied linkAfterTurns times (threadTurn = prior replies by us,
  // which tracks their exchanges). 0 = include immediately.
  const includeLink = !!personalLink && threadTurn >= linkAfterTurns;
  return `You are the account OWNER replying to an email that was sent TO you. The message below was written by the sender TO you (not a public post, not a cold message from you).

Write a brief, professional email reply for this campaign.

Campaign keywords: ${keywords}
Campaign strategy: ${strategy || "General outreach engagement"}
${includeLink ? `Person-specific destination link (use this EXACT URL verbatim when you mention the destination — it is personalized for this contact with ?email=, never invent or re-type a different URL): ${personalLink}` : "Do NOT include any link or URL in this reply."}
Replying to (sender wrote TO you):
From: ${item.sender || "unknown"}
Subject: ${item.subject || "no subject"}
Message: ${(item.snippet || item.text).slice(0, 800)}

Rules:
- Under 80 words
- Professional, human, no placeholders
- Stay on-campaign; do not invent facts
- "You" (in the reply) = the sender; "I/we" = the account owner replying. Never act as if you sent the original email.
${includeLink ? "- Weave the person-specific link into the reply as a plain URL where it naturally fits the conversation." : "- Ask a question or continue the conversation without sending a link yet."}

Return ONLY the reply body text.`;
}

async function aiGenerate(prompt, fallback = null) {
  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt);
    if (!text) return fallback;
    // AI text is typed straight into the inbox compose box — HTML/scripts/
    // fences/controls must never reach the email body. Relevance JSON is
    // parsed via parseAiJson (which re-sanitizes), so plain text here is safe.
    const clean = ai.sanitizeAiPlainText(String(text), 4000);
    return clean ? clean : fallback;
  } catch (err) {
    logger.warn(`[interact-inbox] AI generate failed: ${err.message}`);
    return fallback;
  }
}

async function aiSelectRelevant(itemList, settings, knownContacts = [], helperKeywords = []) {
  const ai = new MultiProviderAI();
  const raw = await aiGenerate(buildRelevancePrompt(itemList, settings, knownContacts, helperKeywords));
  if (!raw) return [];
  const parsed = ai.parseAiJson(raw);
  if (!parsed || !Array.isArray(parsed.relevant)) return [];
  const out = [];
  for (const entry of parsed.relevant) {
    const idx = parseInt(entry.index, 10);
    if (!isNaN(idx) && idx >= 0 && idx < itemList.length) out.push({ item: itemList[idx], reason: String(entry.reason || '').slice(0, 200) });
  }
  return out;
}

function ledgerKey(item) {
  // Stable thread identity: provider thread id first; fallback is sender +
  // subject with Re:/Fw:/Fwd: chains stripped (subjects mutate across turns).
  if (item?.threadId) return `tid:${String(item.threadId).trim().toLowerCase()}`;
  const subj = String(item?.subject || '').toLowerCase()
    .replace(/^(re|fw|fwd)\s*:\s*/g, '')
    .replace(/^(re|fw|fwd)\s*:\s*/g, '')
    .replace(/\[.+?\]\s*/g, '');
  return `${(item.sender || "").toLowerCase()}|${subj}`
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
  // Verify the send landed: the compose box must close (or empty). A blind
  // true here used to write the ledger for replies that never sent.
  try {
    const stillOpen = await page.evaluate((sel) => {
      const els = document.querySelectorAll(sel);
      return Array.from(els).some(el => el && el.offsetParent !== null && (el.textContent || '').trim().length > 0);
    }, cfg.bodyInput).catch(() => false);
    if (stillOpen) {
      logger.warn(`[interact-inbox] compose box still open with text after send — treating as NOT sent.`);
      return false;
    }
  } catch (_) { /* eval failure: keep legacy behaviour */ }
  return true;
}

async function replyToThread(page, cfg, replyText, item) {
  // Open the thread FIRST — the Reply button only exists in thread view,
  // not on the inbox list (attempting reply on the list silently failed
  // forever and no ledger entry was ever written).
  try {
    if (item && item.row) {
      await item.row.click();
      await DOMHelpers.randomDelay(cfg.waitAfterOpen * 0.6, cfg.waitAfterOpen * 1.1);
    }
  } catch (e) {
    logger.warn(`[interact-inbox] opening thread failed: ${e.message}`);
  }
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
  const identityIdx = headers.indexOf("browserIdentity");
  const driveUrlIdx = headers.indexOf("driveUrl");
  const platformIdx = headers.indexOf("platform");
  const idSet = new Set(accountIds);
  const out = [];
  for (const row of result.data) {
    const id = row[idIdx];
    if (!idSet.has(id)) continue;
    const cookie = cookieIdx !== -1 ? row[cookieIdx] : "";
    let browserIdentity = null;
    if (identityIdx !== -1 && row[identityIdx]) {
      try { browserIdentity = typeof row[identityIdx] === 'string' ? JSON.parse(row[identityIdx]) : row[identityIdx]; } catch (_) {}
    }
    out.push({
      accountId: id,
      identifier: row[emailIdx] || "",
      cookieJSON: cookie && String(cookie).length > 10 ? cookie : "",
      provider: detectInboxProvider(row[emailIdx] || ""),
      browserIdentity,
      driveUrl: driveUrlIdx !== -1 ? row[driveUrlIdx] || "" : "",
      platform: platformIdx !== -1 ? String(row[platformIdx] || "").trim() : "",
    });
  }
  return out;
}

export async function processInboxInteract(body) {
  let campaignId = null;
  try {
    campaignId = body?.campaignId;
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

    // Campaign duration guard: if durationDays has elapsed, complete and abandon
    const headers = campaignData.headers || [];
    const createdOnIdx = headers.indexOf("createdOn");
    const createdOnRaw = createdOnIdx !== -1 && campaignData.campaignRow ? campaignData.campaignRow[createdOnIdx] : null;
    const durationDays = Math.max(1, parseInt(settings.durationDays, 10) || 7);
    const createdOnTime = createdOnRaw ? new Date(createdOnRaw).getTime() : 0;
    const maxDurationMs = durationDays * 24 * 60 * 60 * 1000;
    const isDurationElapsed = () => createdOnTime > 0 && (Date.now() - createdOnTime >= maxDurationMs);
    if (isDurationElapsed()) {
      log.info(`[campaign-duration] Campaign ${campaignId} reached its scheduled duration (${durationDays}d). Completing campaign.`);
      await updateSheetRowApi("campaigns", "campaignId", campaignId, {
        status: "completed",
        updatedOn: new Date().toISOString(),
      }).catch(() => {});
      await updateCampaignSettings(campaignId, { interactionStatus: "completed", status: "completed", interactionStoppedReason: "duration_elapsed" });
      return NextResponse.json({ success: true, completed: true, durationExpired: true, message: "Campaign duration reached; completed.", replies: 0 });
    }

    const interactionAccountIds = settings.interactionAccounts || [];
    const emailKeywords = settings.emailKeywords || [];
    log.info(`Watcher start: accounts=${interactionAccountIds.length} keywords=[${emailKeywords.join(',')}] helperKeyword=${settings.helperKeyword || 'none'} linkAfterTurns=${settings.linkAfterTurns ?? 2} replyFolder=${settings.replyFolder || 'Campaign-Replies'}`);
    if (interactionAccountIds.length === 0) {
      return NextResponse.json({ success: false, error: "No interaction accounts selected for interactions-only campaign" }, { status: 400 });
    }
    if (emailKeywords.length === 0 && !settings.helperKeyword && !settings.emailStrategyPrompt) {
      return NextResponse.json({ success: false, error: "Interactions-only campaigns require at least one keyword, a helper keyword, or a strategy prompt" }, { status: 400 });
    }

    // ─── Stop guards (same semantics as interact-campaign) ──────────
    // No stop-after-hours timer: interactions run until durationDays expires
    // or quotas cap out (duration guard above + platform/user quotas below).
    let replyCount = settings.interactionRepliesCount || 0;
    // No per-campaign reply cap: the platform gates (hourly/daily/monthly)
    // are the ceiling and renew on their own windows.
    // Strict per-run interaction cap: unset/empty/0 in the SETTINGS sheet
    // (interactionBatchLimit) blocks the watcher entirely — no Infinity
    // fallback (was the last fail-open path for interactionLimit).
    let planInteractionLimit = 0;
    try {
      const limits = await getCampaignLimits();
      planInteractionLimit = Number(limits.interactionLimit) || 0;
    } catch (capErr) {
      // Fail-closed like the social path: no readable cap = block the pass
      // (never unlimited replies on a settings read failure).
      log.warn(` interactionBatchLimit read failed (${capErr.message}) — blocking pass (fail-closed).`);
      return NextResponse.json({ success: true, message: "Interact blocked: interactionBatchLimit unreadable", replies: 0 });
    }
    log.info(`Watcher per-pass cap: ${planInteractionLimit} (interactionBatchLimit)`);
    if (!(planInteractionLimit > 0)) {
      log.info(` interactionBatchLimit is 0 or unavailable, blocking watcher - set interactionBatchLimit in the SETTINGS sheet`);
      return NextResponse.json({ success: true, message: "Interact blocked: interactionBatchLimit is 0 - set it in the SETTINGS sheet", replies: 0 });
    }

    if (await isCampaignPaused(campaignId)) {
      return NextResponse.json({ success: true, message: "Campaign paused", replies: 0 });
    }

    // Monthly spend gate: plan interactionLimit vs users-sheet interactionUsage.
    // Exhausted = stop the watcher with the campaign controlling key.
    const userId = settings.userId || null;
    const entryQuota = await checkUserQuota(userId, { keys: ["interactionUsage"] });
    if (!entryQuota.allowed) {
      log.info(` Stop guard: monthly interaction quota exhausted (${entryQuota.reason})`);
      await updateCampaignSettings(campaignId, {
        executionStatus: "completed",
        status: "Limit Reached",
        interactionStatus: "completed",
        interactionStoppedReason: "monthly_interaction_quota"
      });
      return NextResponse.json({ success: true, limitReached: true, message: `Interact blocked: monthly interaction quota reached (${entryQuota.reason})`, replies: 0 });
    }

    // ─── Resolve hub accounts → cookies ─────────────────────────────
    const accounts = (await getHubRows(interactionAccountIds)).filter(a => a.cookieJSON);
    if (accounts.length === 0) {
      await updateCampaignSettings(campaignId, { interactionStatus: "failed", interactionStoppedReason: "no_account_cookies" });
      return NextResponse.json({ success: false, error: "No interaction accounts have cookies" }, { status: 400 });
    }

    await seedCampaignAccountsInStats(campaignId, accounts.map(a => ({
      accountId: a.accountId,
      identifier: a.identifier || a.accountId,
      platform: a.platform || a.provider || "email",
    }))).catch(() => {});

    // CSV campaigns: known recipient emails are a relevance signal (a reply
    // from someone we emailed about this campaign outranks keyword matches).
    // Per-row HELPERKEYWORD values join the watch set too.
    let knownContacts = [];
    let helperKeywords = [];
    if (settings.fileUrl || body?.fileUrl) {
      try {
        const { extractFileId, parseCSV } = await import("../../campaign/_shared/pipelineUtils.js");
        const { downloadCsvText } = await import("../../api/googlesheets.js");
        const fid = extractFileId(settings.fileUrl || body.fileUrl);
        if (fid) {
          const dl = await downloadCsvText(fid);
          if (dl.success && typeof dl.content === 'string') {
            const rows = parseCSV(dl.content);
            if (rows.length > 1) {
              const eIdx = rows[0].findIndex(h => /^(email|mail|e-mail|lead)$/i.test(String(h || '').trim()));
              if (eIdx !== -1) knownContacts = rows.slice(1).map(r => String(r[eIdx] || '').trim().toLowerCase()).filter(Boolean);
              const hIdx = rows[0].findIndex(h => /^(helperkeyword|helper keyword|helperkey)$/i.test(String(h || '').trim()));
              if (hIdx !== -1) helperKeywords = [...new Set(rows.slice(1).map(r => String(r[hIdx] || '').trim()).filter(Boolean))];
            }
          }
        }
      } catch (csvErr) {
        log.warn(` CSV relevance signal load failed (continuing without): ${csvErr.message}`);
      }
    }

    // Ledger of replied threads (persisted in settings, capped). threadTurns
    // tracks exchanges per thread so linkAfterTurns can gate the link.
    const repliedThreads = new Set(settings.repliedThreads || []);
    const threadTurns = (settings.threadTurns && typeof settings.threadTurns === "object") ? { ...settings.threadTurns } : {};
    // Threads already in the legacy repliedThreads ledger count as turn 1.
    for (const k of repliedThreads) if (!(k in threadTurns)) threadTurns[k] = 1;
    const linkAfterTurns = Math.max(0, parseInt(settings.linkAfterTurns, 10) || 0);
    // Max replies per thread: link turn + one closing turn, capped at 5.
    const maxThreadTurns = Math.min(5, linkAfterTurns + 1);
    const maxScan = parseInt(String(settings.interactionMaxScan || ""), 10) || 25;

    let newReplies = 0;
    let scannedAccounts = 0;
    let blockedByPlatform = 0;

    await updateCampaignSettings(campaignId, {
      interactionStatus: "monitoring",
      interactionStartedAt: settings.interactionStartedAt || new Date().toISOString(),
    });

    for (const account of accounts) {
      if (isDurationElapsed()) {
        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          status: "completed",
          updatedOn: new Date().toISOString(),
        }).catch(() => {});
        await updateCampaignSettings(campaignId, { interactionStatus: "completed", status: "completed", interactionStoppedReason: "duration_elapsed" });
        break;
      }
      if (await isCampaignPaused(campaignId)) break;
      setActiveCampaignForAccount(account.accountId, {
        campaignId,
        userId,
        identifier: account.identifier || account.accountId,
        platform: account.platform || account.provider || "email",
      });

      // Monthly quota re-check per account (spend can move between passes)
      const accountQuota = await checkUserQuota(userId, { keys: ["interactionUsage"] });
      if (!accountQuota.allowed) {
        log.info(` Stop guard: monthly interaction quota exhausted (${accountQuota.reason})`);
        await updateCampaignSettings(campaignId, {
          executionStatus: "completed",
          status: "Limit Reached",
          interactionStatus: "completed",
          interactionStoppedReason: "monthly_interaction_quota"
        });
        break;
      }

      const cfg = INBOX_CONFIGS[account.provider];
      if (!cfg) {
        log.warn(` Unsupported inbox provider for account ${account.identifier}: ${account.provider}`);
        continue;
      }

      // Account status gate (CANCELLED / RATE_LIMITED) + platform inboxReply
      // policy vs this account's hub usage — same tier as every other route
      // that performs actions. Blocked accounts are skipped for this pass.
      const gate = await resolveAccountGate(account.accountId, account.platform || "");
      if (gate.blocked) {
        log.warn(` [${account.identifier}] blocked by account limits: ${gate.reason}`);
        continue;
      }
      let accountUsage = {};
      try {
        const accountData = await getAccountUsage(account.accountId);
        accountUsage = (accountData && accountData.interactionUsage) || {};
      } catch (uErr) {
        log.warn(` [${account.identifier}] usage read failed: ${uErr.message}`);
      }
      const platformCheck = await checkActionAllowed(account.platform || "", "inboxReply", accountUsage);
      if (!platformCheck.allowed) {
        log.warn(` [${account.identifier}] blocked by platform limits: ${platformCheck.reason}`);
        blockedByPlatform++;
        continue;
      }

      let browser, page;
      let profileDir = null;
      try {
        // Hybrid session: use Drive profile + identity if available
        try {
          const sessionResult = await resolveSocialSession({
            cookies: account.cookieJSON,
            browserIdentity: account.browserIdentity || null,
            driveUrl: account.driveUrl || "",
            profileId: account.accountId,
          }, false);
          browser = sessionResult.browser;
          page = sessionResult.page;
          profileDir = sessionResult.profileDir;
        } catch (e) {
          ({ browser, page } = await launchBrowserWithSession(account.cookieJSON, false));
        }
        scannedAccounts++;
        // Scan surfaces in priority order: campaignId search (finds replies
        // anywhere, incl. archived-by-filter), reply-folder label, inbox.
        const replyFolder = String(settings.replyFolder || "").trim() || "Campaign-Replies";
        const surfaces = [];
        if (typeof cfg.searchUrlTemplate === 'function') surfaces.push({ name: 'campaign-search', url: cfg.searchUrlTemplate(`[${campaignId}]`) });
        if (typeof cfg.labelUrlTemplate === 'function') surfaces.push({ name: 'reply-label', url: cfg.labelUrlTemplate(replyFolder) });
        surfaces.push({ name: 'inbox', url: cfg.inboxUrl });

        const items = [];
        const surfaceSeen = new Set();
        for (const surf of surfaces) {
          try {
            await page.goto(surf.url, { waitUntil: "domcontentloaded", timeout: 45000 });
            await DOMHelpers.randomDelay(2500, 4000);
            for (const it of await scanInbox(page, cfg, maxScan)) {
              const k = ledgerKey(it);
              if (surfaceSeen.has(k)) continue;
              surfaceSeen.add(k);
              it.surface = surf.name;
              items.push(it);
            }
          } catch (surfErr) {
            log.warn(` [${account.identifier}] surface ${surf.name} scan failed: ${surfErr.message}`);
          }
        }
        log.info(` [${account.identifier}] scanned ${items.length} items across ${surfaces.map(s => s.name).join('+')}`);

        if (items.length > 0) {
          // 1) AI relevance pass over the list; 2) DOM keyword pre-filter as safety net.
          // Automated/system senders are NEVER candidates (not conversations).
          const liveItems = items.filter(it => !isAutomatedSender(it));
          if (liveItems.length < items.length) {
            log.info(` [${account.identifier}] dropped ${items.length - liveItems.length} automated sender(s) from candidacy`);
          }
          const candidates = [];
          const seenKeys = new Set();
          for (const hit of await aiSelectRelevant(liveItems, settings, knownContacts, helperKeywords)) {
            const key = ledgerKey(hit.item);
            if (!seenKeys.has(key)) { candidates.push(hit.item); seenKeys.add(key); }
          }
          for (const item of liveItems) {
            const key = ledgerKey(item);
            if (keywordMatches(item, emailKeywords) && !seenKeys.has(key)) {
              candidates.push(item);
              seenKeys.add(key);
            }
          }
          log.info(` [${account.identifier}] candidates: ${candidates.length} of ${liveItems.length} scanned (AI-relevant + keyword matches, automated senders excluded)`);

          for (const item of candidates) {
            const key = ledgerKey(item);
            const priorTurns = threadTurns[key] || 0;
            if (priorTurns >= maxThreadTurns) {
              log.info(` [${account.identifier}] skip thread "${item.subject || item.sender}" — turn cap reached (${priorTurns}/${maxThreadTurns}).`);
              continue;
            }

            // Per-pass cap (SETTINGS interactionBatchLimit): stop this pass at
            // the cap — never complete on it (rest/resume owns the rest).
            if (Number.isFinite(planInteractionLimit) && newReplies >= planInteractionLimit) {
              log.info(` [${account.identifier}] per-pass interaction cap (${planInteractionLimit}) reached — stopping pass (rest, not completed).`);
              break;
            }

            // Re-check the platform policy with locally-incremented usage so
            // a batch can't overshoot the hourly/daily window mid-pass.
            const actionCheck = await checkActionAllowed(account.platform || "", "inboxReply", accountUsage);
            if (!actionCheck.allowed) {
              log.warn(` [${account.identifier}] blocked by platform limits: ${actionCheck.reason}`);
              break;
            }

            const replyText = await aiGenerate(buildReplyPrompt(item, settings, priorTurns));
            if (!replyText) {
              log.warn(` [${account.identifier}] AI reply empty for "${item.subject || item.sender}" — skipping (will retry next pass).`);
              continue;
            }

            const sent = await replyToThread(page, cfg, replyText, item);
            if (!sent) {
              log.warn(` [${account.identifier}] reply NOT sent to "${item.subject || item.sender}" (turn ${priorTurns}) — not ledgered, will retry next pass.`);
            }
            if (sent) {
              repliedThreads.add(key);
              threadTurns[key] = priorTurns + 1;
              replyCount++;
              newReplies++;
              log.info(` [${account.identifier}] AI replied to: ${item.subject || item.sender}`);
              // Count the action against BOTH tiers: platform account usage
              // (inboxReply column) and the user's monthly interactionUsage.
              await updateAccountUsage(account.accountId, "inboxReply");
              if (userId) await updateUserUsage(userId, "interactionUsage");
              const cur = accountUsage["inboxReply"] || { hourly: 0, daily: 0, monthly: 0, total: 0 };
              accountUsage["inboxReply"] = {
                ...cur,
                hourly: (cur.hourly || 0) + 1,
                daily: (cur.daily || 0) + 1,
                monthly: (cur.monthly || 0) + 1,
                total: (cur.total || 0) + 1,
              };
              // Persist ledger + count after each reply so we never double-reply.
              // Both maps are capped so the settings JSON can't bloat.
              const turnEntries = Object.entries(threadTurns).slice(-200);
              await updateCampaignSettings(campaignId, {
                repliedThreads: Array.from(repliedThreads).slice(-200),
                threadTurns: Object.fromEntries(turnEntries),
                interactionRepliesCount: replyCount,
              });
            }

            // Re-open the primary surface after handling a thread
            await page.goto(surfaces[0].url, { waitUntil: "domcontentloaded", timeout: 45000 });
            await DOMHelpers.randomDelay(2500, 4000);
          }
        }
      } catch (accErr) {
        log.warn(` [${account.identifier}] inbox pass failed: ${accErr.message}`);
      } finally {
        clearActiveCampaignForAccount(account.accountId, campaignId);
        try { if (page) await page.close(); } catch { /* noop */ }
        try { if (browser) await browser.close(); } catch { /* noop */ }
        if (profileDir) { const fs = await import('fs-extra'); await fs.remove(profileDir).catch(() => {}); }
      }
    }

    // "Done" only when the platform gates blocked EVERY eligible account
    // (hourly/daily exhausted). Usage renews on the next window.
    const done = accounts.length > 0 && blockedByPlatform >= accounts.length;
    if (done) {
      await updateCampaignSettings(campaignId, { interactionStatus: "completed", interactionStoppedReason: "platform_limit_reached" });
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

export async function POST(request) {
  try {
    return await processInboxInteract(await request.json());
  } catch (error) {
    logger.error(`[interact-inbox] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
