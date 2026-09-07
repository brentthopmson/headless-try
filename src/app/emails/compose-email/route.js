import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { getSheetDataApi } from "../../api/googlesheets.js";
import { getPlatformConfig, detectEmailPlatform } from "../_shared/platforms.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

// ==================== Hub Row Lookup ====================

async function getHubRowByBrowserId(browserId) {
  const result = await getSheetDataApi("hub");
  if (!result.success) return null;
  const headers = result.headers;
  const browserIdIdx = headers.indexOf("browserId");
  const submissionIdIdx = headers.indexOf("submissionId");
  for (const row of result.data) {
    const bid = row[browserIdIdx] || "";
    const sid = row[submissionIdIdx] || "";
    if (bid === browserId || sid === browserId) {
      const hubRow = {};
      for (let i = 0; i < headers.length; i++) hubRow[headers[i]] = row[i];
      return hubRow;
    }
  }
  return null;
}

// ==================== Read Mailbox History ====================

async function readMailboxHistory(page, config, contactEmail, maxThreads = 20) {
  const { selectors, timing } = config;
  const threads = [];

  try {
    // Navigate to inbox
    await page.goto(config.inboxUrl, { waitUntil: "networkidle0", timeout: 30000 });
    await DOMHelpers.randomDelay(timing.afterNavigate, timing.afterNavigate * 1.5);

    // Search for emails from/to contactEmail
    const searchSelector = selectors.searchBox || selectors.searchInput;
    const searchEl = await page.$(searchSelector);
    if (searchEl) {
      await searchEl.click();
      await page.keyboard.down("Control");
      await page.keyboard.press("a");
      await page.keyboard.up("Control");
      await page.type(searchSelector, `from:${contactEmail} OR to:${contactEmail}`, { delay: 15 });
      await page.keyboard.press("Enter");
      await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);
    }

    // Read thread rows
    const rows = await page.$$(selectors.threadRow);
    for (const row of rows.slice(0, maxThreads)) {
      try {
        const subjectEl = await row.$(selectors.threadSubject);
        const snippetEl = await row.$(selectors.threadSnippet);
        const senderEl = await row.$(selectors.threadSender);

        const subject = subjectEl ? (await subjectEl.textContent()).trim() : "";
        const snippet = snippetEl ? (await snippetEl.textContent()).trim() : "";
        const sender = senderEl ? (await senderEl.textContent()).trim() : "";

        if (subject || snippet) {
          threads.push({ subject, snippet, sender });
        }
      } catch {
        // skip malformed row
      }
    }
  } catch (e) {
    logger.warn(`[compose-email] Mailbox read error: ${e.message}`);
  }

  return threads;
}

// ==================== AI Compose ====================

function buildComposePrompt(contactEmail, threads, senderIdentity) {
  const threadHistory = threads.length > 0
    ? threads.map((t, i) => `[${i + 1}] Subject: ${t.subject || "(no subject)"}\n    From: ${t.sender || "unknown"}\n    Preview: ${(t.snippet || "").slice(0, 300)}`).join("\n\n")
    : "(No previous emails found with this contact)";

  return `You are composing a new email to ${contactEmail}.

Here is the conversation history with this contact (most recent first):
${threadHistory}

Your identity:
- Name: ${senderIdentity.firstName || ""} ${senderIdentity.lastName || ""}
- Email: ${senderIdentity.email || ""}

TASK: Compose a NEW email thread (NOT a reply) to this contact.
- Analyze the conversation history to understand the relationship and context
- If there are past emails, reference the context naturally (e.g., "Following up on our previous conversation about...")
- If no past emails, compose a professional cold outreach
- Keep it under 120 words
- Make it feel personal and human, not robotic
- Do not use placeholders like [Company Name] — use what you know from the history

Return ONLY a JSON object (no markdown, no code fences):
{"subject": "email subject line", "body": "email body text"}`;
}

async function composeAIMessage(contactEmail, threads, senderIdentity) {
  const prompt = buildComposePrompt(contactEmail, threads, senderIdentity);
  try {
    const ai = new MultiProviderAI();
    const response = await ai.generate(prompt);
    if (!response) return null;

    // Parse JSON from response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      subject: parsed.subject || "",
      body: parsed.body || "",
    };
  } catch (e) {
    logger.warn(`[compose-email] AI compose failed: ${e.message}`);
    return null;
  }
}

// ==================== POST Handler ====================

export async function POST(request) {
  try {
    const body = await request.json();
    const { browserId, contactEmail } = body;

    if (!browserId || !contactEmail) {
      return NextResponse.json({ success: false, error: "Missing browserId or contactEmail" }, { status: 400 });
    }

    const log = logger.child({ browserId, action: "compose-email" });
    log.info(`AI compose requested for ${contactEmail}`);

    // 1. Get hub row
    const hubRow = await getHubRowByBrowserId(browserId);
    if (!hubRow) {
      return NextResponse.json({ success: false, error: "Profile not found" }, { status: 404 });
    }

    // 2. Get cookies
    const cookieJSON = hubRow.formattedCookie || hubRow.cookieJSON || "";
    if (!cookieJSON || String(cookieJSON).length < 10) {
      return NextResponse.json({ success: false, error: "No valid cookies" }, { status: 400 });
    }

    // 3. Detect provider
    const accountEmail = hubRow.email || "";
    const platform = detectEmailPlatform(accountEmail);
    const config = getPlatformConfig(platform);

    // 4. Launch browser and read mailbox
    const { browser, page } = await launchBrowserWithSession(cookieJSON, false);

    let threads = [];
    try {
      threads = await readMailboxHistory(page, config, contactEmail, 20);
      log.info(`Found ${threads.length} threads with ${contactEmail}`);
    } finally {
      await page.close();
      await browser.close();
    }

    // 5. Build sender identity
    const nameParts = accountEmail.split("@")[0]?.split(".") || [];
    const senderIdentity = {
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: accountEmail,
    };

    // 6. Generate AI message
    const aiMessage = await composeAIMessage(contactEmail, threads, senderIdentity);
    if (!aiMessage) {
      return NextResponse.json({
        success: false,
        error: "AI failed to generate message",
      });
    }

    return NextResponse.json({
      success: true,
      subject: aiMessage.subject,
      body: aiMessage.body,
      context: {
        threadCount: threads.length,
        lastInteraction: threads[0]?.subject || "",
        platform,
      },
    });

  } catch (error) {
    logger.error(`[compose-email] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
