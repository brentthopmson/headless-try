import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { launchBrowserWithSession, DOMHelpers } from "../../socials/_shared/routeHelper.js";
import { getSheetDataApi } from "../../api/googlesheets.js";
import { getPlatformConfig, detectEmailPlatform } from "../_shared/platforms.js";
import MultiProviderAI from "../../../utils/multiProviderAI.js";

export const maxDuration = 300;
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

// ==================== Project Lookup ====================

async function getProjectById(projectId) {
  if (!projectId) return null;

  // Try campaigns sheet first
  let result = await getSheetDataApi("campaigns");
  if (result.success) {
    const headers = result.headers;
    const idIdx = headers.indexOf("id");
    if (idIdx !== -1) {
      for (const row of result.data) {
        if (row[idIdx] === projectId) {
          const project = {};
          for (let i = 0; i < headers.length; i++) project[headers[i]] = row[i];
          return project;
        }
      }
    }
  }

  // Try projects sheet
  result = await getSheetDataApi("projects");
  if (result.success) {
    const headers = result.headers;
    const projectIdIdx = headers.indexOf("projectId");
    if (projectIdIdx !== -1) {
      for (const row of result.data) {
        if (row[projectIdIdx] === projectId) {
          const project = {};
          for (let i = 0; i < headers.length; i++) project[headers[i]] = row[i];
          return project;
        }
      }
    }
  }

  return null;
}

// ==================== Redirect Lookup ====================

async function getRedirectById(redirectId) {
  if (!redirectId) return null;
  const result = await getSheetDataApi("redirect");
  if (!result.success) return null;
  const headers = result.headers;
  const redirectIdIdx = headers.indexOf("redirectId");
  if (redirectIdIdx === -1) return null;
  for (const row of result.data) {
    if (row[redirectIdIdx] === redirectId) {
      const redirect = {};
      for (let i = 0; i < headers.length; i++) redirect[headers[i]] = row[i];
      return redirect;
    }
  }
  return null;
}

// ==================== Read Mailbox History (Enhanced) ====================

async function readMailboxHistory(page, config, contactEmail, maxThreads = 10) {
  const { selectors, timing } = config;
  const platform = config.platform;
  const threads = [];

  try {
    if (platform === "gmail") {
      // Gmail: URL-based search (more reliable for headless)
      const searchUrl = `https://mail.google.com/mail/u/0/#search/from%3A${encodeURIComponent(contactEmail)}+OR+to%3A${encodeURIComponent(contactEmail)}`;
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);
    } else {
      // Outlook: navigate to inbox, then use DOM search bar
      await page.goto(config.inboxUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await DOMHelpers.randomDelay(timing.afterNavigate, timing.afterNavigate * 1.5);

      // Type into #topSearchInput
      const searchEl = await page.$(selectors.searchBox);
      if (searchEl) {
        await searchEl.click();
        await page.keyboard.down("Control");
        await page.keyboard.press("a");
        await page.keyboard.up("Control");
        await page.type(selectors.searchBox, `from:${contactEmail} OR to:${contactEmail}`, { delay: 15 });
        await page.keyboard.press("Enter");
        await DOMHelpers.randomDelay(timing.afterSearch, timing.afterSearch * 1.5);
      }
    }

    // Read thread rows from search results
    const threadData = await page.evaluate((sels) => {
      const rows = document.querySelectorAll(sels.threadRow);
      const out = [];
      for (const row of rows) {
        // Outlook: skip UNREAD messages (has DLvHz class)
        if (sels.threadRowRead) {
          const readRow = row.querySelector(sels.threadRowRead);
          const isUnread = row.classList.contains("DLvHz") || row.querySelector(".DLvHz");
          if (isUnread && !readRow) continue;
        }

        const subjectEl = row.querySelector(sels.threadSubject);
        const snippetEl = row.querySelector(sels.threadSnippet);
        const senderEl = row.querySelector(sels.threadSender);
        const dateEl = row.querySelector(sels.threadDate);

        const subject = subjectEl?.textContent?.trim() || "";
        const snippet = snippetEl?.textContent?.trim() || "";
        const sender = senderEl?.getAttribute("title") || senderEl?.textContent?.trim() || "";
        const date = dateEl?.getAttribute("title") || dateEl?.textContent?.trim() || "";

        // Gmail: get sender email from attribute
        const senderEmail = senderEl?.getAttribute("email") || "";

        if (subject || snippet) {
          out.push({ subject, snippet, sender, senderEmail, date });
        }
        if (out.length >= 15) break;
      }
      return out;
    }, selectors);

    // Take up to maxThreads
    const selectedThreads = threadData.slice(0, maxThreads);

    // Click into each thread to read full message body
    for (let i = 0; i < selectedThreads.length; i++) {
      const thread = selectedThreads[i];
      try {
        // Click the thread row
        const clicked = await page.evaluate((idx, threadRowSel) => {
          const rows = document.querySelectorAll(threadRowSel);
          // Outlook uses data-index, Gmail uses tr.zA
          for (const row of rows) {
            if (row.getAttribute("data-index") === String(idx) || row === rows[idx]) {
              row.click();
              return true;
            }
          }
          if (rows[idx]) {
            rows[idx].click();
            return true;
          }
          return false;
        }, i, selectors.threadRow);

        if (clicked) {
          await DOMHelpers.randomDelay(2500, 4000);

          // Read full message body from the inner template
          const fullBody = await page.evaluate((sels) => {
            const bodyEl = document.querySelector(sels.messageBody);
            return bodyEl?.textContent?.trim()?.slice(0, 3000) || "";
          }, selectors);

          thread.fullBody = fullBody;

          // Go back to search results
          await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          await DOMHelpers.randomDelay(1500, 2500);
        }
      } catch (e) {
        // Thread click failed, use snippet only
        thread.fullBody = thread.snippet;
      }

      threads.push(thread);
    }

    // If no threads were clicked successfully, use the snippet-only data
    if (threads.length === 0) {
      threads.push(...selectedThreads.map(t => ({ ...t, fullBody: t.snippet })));
    }
  } catch (e) {
    logger.warn(`[compose-email] Mailbox read error: ${e.message}`);
  }

  return threads;
}

// ==================== Relationship Analysis ====================

function analyzeRelationship(threads) {
  if (!threads || threads.length === 0) {
    return { type: "cold", lastInteraction: null, threadCount: 0, context: "" };
  }

  const lastDate = threads[0]?.date;
  let daysSinceLastInteraction = 999;
  if (lastDate) {
    try {
      const parsed = new Date(lastDate);
      if (!isNaN(parsed.getTime())) {
        daysSinceLastInteraction = Math.floor((Date.now() - parsed.getTime()) / (1000 * 60 * 60 * 24));
      }
    } catch { /* ignore */ }
  }

  let type = "cold";
  if (threads.length > 0) {
    if (daysSinceLastInteraction <= 30) {
      type = "warm";
    } else if (daysSinceLastInteraction <= 90) {
      type = "followup";
    } else {
      type = "reengagement";
    }
  }

  // Build context summary
  const subjects = threads.map(t => t.subject).filter(Boolean);
  const snippets = threads.map(t => t.snippet || t.fullBody || "").filter(Boolean);
  const context = [
    subjects.length > 0 ? `Previous subjects: ${subjects.join("; ")}` : "",
    snippets.length > 0 ? `Key messages: ${snippets.slice(0, 3).join(" | ").slice(0, 500)}` : "",
  ].filter(Boolean).join("\n");

  return {
    type,
    lastInteraction: lastDate || null,
    daysSinceLastInteraction,
    threadCount: threads.length,
    context,
  };
}

// ==================== AI Compose (Adaptive) ====================

function buildComposePrompt(contactEmail, threads, senderIdentity, relationship, projectContext) {
  const threadHistory = threads.length > 0
    ? threads.map((t, i) => {
        const parts = [
          `[${i + 1}] Subject: ${t.subject || "(no subject)"}`,
          `  From: ${t.sender || "unknown"}`,
          t.date ? `  Date: ${t.date}` : "",
          `  Preview: ${(t.snippet || "").slice(0, 200)}`,
          t.fullBody ? `  Full message: ${t.fullBody.slice(0, 500)}` : "",
        ].filter(Boolean);
        return parts.join("\n");
      }).join("\n\n")
    : "(No previous emails found with this contact)";

  const projectSection = projectContext
    ? `\nACTIVE PROJECT:\n- Name: ${projectContext.name || "N/A"}\n- Description: ${(projectContext.description || projectContext.message || "").slice(0, 300)}\n- Status: ${projectContext.status || "active"}\n`
    : "";

  const identitySection = `YOUR IDENTITY:
- Name: ${senderIdentity.firstName || ""} ${senderIdentity.lastName || ""}
- Email: ${senderIdentity.email || ""}
- Company: ${senderIdentity.company || ""}`;

  let taskInstructions = "";
  switch (relationship.type) {
    case "cold":
      taskInstructions = `This is a COLD OUTREACH — you have no prior relationship.
- Introduce yourself and your company professionally
- Reference why you're reaching out (the project above if available)
- Keep it concise, under 100 words
- Make it personal, not generic spam
- Do NOT use placeholders like [Company Name] — use what you know`;
      break;
    case "warm":
      taskInstructions = `This is a WARM FOLLOW-UP — you've spoken recently (last ${relationship.daysSinceLastInteraction} days ago).
- Reference the previous conversation naturally
- Build on the existing relationship
- Include the project context
- Keep it under 100 words
- Feel familiar, not like a cold email`;
      break;
    case "followup":
      taskInstructions = `This is a FOLLOW-UP after ${relationship.daysSinceLastInteraction} days of no contact.
- Acknowledge the gap briefly
- Re-establish connection with something relevant
- Include the project context
- Keep it under 100 words
- Professional but warm`;
      break;
    case "reengagement":
      taskInstructions = `This is a RE-ENGAGEMENT after ${relationship.daysSinceLastInteraction}+ days of no contact.
- Acknowledge it's been a while
- Provide fresh value or reason to reconnect
- Include the project context
- Keep it under 100 words
- Make it compelling enough to reply`;
      break;
  }

  return `You are composing a new email to ${contactEmail}.

CONVERSATION HISTORY:
${threadHistory}
${projectSection}
${identitySection}

RELATIONSHIP ANALYSIS:
- Type: ${relationship.type}
- Last interaction: ${relationship.lastInteraction || "Never"}
- Thread count: ${relationship.threadCount}

TASK INSTRUCTIONS:
${taskInstructions}

COMPOSITION RULES:
- Return ONLY a JSON object (no markdown, no code fences)
- Subject line should be relevant and engaging
- Body should feel human and personal, not robotic
- Do not use placeholders like [First Name] — use what you know from the history
- If you know the contact's name from threads, use it

Return: {"subject": "email subject line", "body": "email body text"}`;
}

async function composeAIMessage(contactEmail, threads, senderIdentity, relationship, projectContext) {
  const prompt = buildComposePrompt(contactEmail, threads, senderIdentity, relationship, projectContext);
  try {
    const ai = new MultiProviderAI();
    const response = await ai.generate(prompt);
    if (!response) return null;

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
    const { browserId, contactEmail, projectId, linkType, linkId } = body;

    if (!browserId || !contactEmail) {
      return NextResponse.json({ success: false, error: "Missing browserId or contactEmail" }, { status: 400 });
    }

    const log = logger.child({ browserId, action: "compose-email" });
    log.info(`AI compose requested for ${contactEmail} (project: ${projectId || "none"})`);

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

    // 4. Get project/redirect context if provided
    let projectContext = null;
    if (linkType === 'project' && linkId) {
      projectContext = await getProjectById(linkId);
    } else if (linkType === 'redirect' && linkId) {
      projectContext = await getRedirectById(linkId);
    } else if (projectId) {
      projectContext = await getProjectById(projectId);
    }

    // 5. Launch browser and read mailbox (up to 10 threads)
    const { browser, page } = await launchBrowserWithSession(cookieJSON, false);

    let threads = [];
    try {
      threads = await readMailboxHistory(page, config, contactEmail, 10);
      log.info(`Found ${threads.length} threads with ${contactEmail}`);
    } finally {
      await page.close();
      await browser.close();
    }

    // 5b. AI Fallback: If no threads found, use extract data as context
    if (threads.length === 0) {
      log.info(`No threads found, falling back to extract data`);
      const extractRaw = hubRow.wireExtract || hubRow.socialExtract || "";
      if (extractRaw) {
        try {
          const extract = typeof extractRaw === 'string' ? JSON.parse(extractRaw) : extractRaw;
          // Build synthetic threads from extract contacts
          const extractContacts = extract.contacts || [];
          const matchingContact = extractContacts.find(c =>
            c.email?.toLowerCase() === contactEmail.toLowerCase()
          );
          if (matchingContact) {
            threads = [{
              subject: matchingContact.relationshipSummary || `Contact: ${matchingContact.name || contactEmail}`,
              snippet: `Previous relationship: ${matchingContact.relationshipSummary || "N/A"}. Interactions: ${matchingContact.interactionCount || 0}. Company: ${matchingContact.otherData?.company || "N/A"}.`,
              sender: matchingContact.name || contactEmail,
              senderEmail: contactEmail,
              date: matchingContact.lastInteractionDate || "",
              fullBody: JSON.stringify(matchingContact.otherData || {}),
            }];
          } else {
            // Use activities as context
            const activities = extract.activities || [];
            const relevantActivities = activities.filter(a =>
              a.to?.toLowerCase().includes(contactEmail.toLowerCase()) ||
              a.type === 'SENT'
            ).slice(0, 5);
            if (relevantActivities.length > 0) {
              threads = relevantActivities.map(a => ({
                subject: a.subject || "(no subject)",
                snippet: a.summary || a.text || "",
                sender: a.type === 'SENT' ? "me" : contactEmail,
                senderEmail: a.type === 'SENT' ? "" : contactEmail,
                date: a.on || "",
                fullBody: a.summary || a.text || "",
              }));
            }
          }
        } catch (e) {
          log.warn(`Failed to parse extract data: ${e.message}`);
        }
      }
    }

    // 6. Analyze relationship
    const relationship = analyzeRelationship(threads);
    log.info(`Relationship: ${relationship.type}, threads: ${relationship.threadCount}, last: ${relationship.daysSinceLastInteraction}d ago`);

    // 7. Build sender identity
    const nameParts = accountEmail.split("@")[0]?.split(".") || [];
    const senderIdentity = {
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: accountEmail,
      company: hubRow.company || hubRow.businessName || "",
    };

    // 8. Generate AI message with relationship context
    const aiMessage = await composeAIMessage(contactEmail, threads, senderIdentity, relationship, projectContext);
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
        lastInteraction: threads[0]?.date || "",
        relationshipType: relationship.type,
        daysSinceLastInteraction: relationship.daysSinceLastInteraction,
        platform,
        linkType: linkType || null,
        linkId: linkId || projectId || null,
      },
    });

  } catch (error) {
    logger.error(`[compose-email] Error: ${error.message}`);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
