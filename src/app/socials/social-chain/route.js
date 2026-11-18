import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import {
  resolveSocialSession,
  launchBrowserWithSession,
  setCorsHeaders,
} from "../_shared/routeHelper.js";
import { runSearchInteractEngagement } from "../search-interact/routeHelper.js";
import {
  getPlatformConfig as getSearchPlatformConfig,
  MultiProviderAI,
} from "../search-interact/platforms.js";
import {
  runPageInteract,
  supportsPageRunner,
  pageActionForOperation,
} from "../page-interact/routeHelper.js";
import { getPlatformConfig as getPagePlatformConfig } from "../page-interact/platforms.js";
import { discoverPeopleHandles } from "../page-interact/route.js";
import {
  runActivitiesInteract,
  supportsActivitiesRunner,
} from "../activities-interact/routeHelper.js";
import { resolveAccountGate, accountGateError } from "../_shared/accountGate.js";
import { markTagsDone } from "../../campaign/_shared/pipelineUtils.js";

export { processTask as processSocialChainTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const activeTasks = new Map();

function addQuota(target, source) {
  if (!source || typeof source !== "object") return;
  for (const [k, v] of Object.entries(source)) {
    if (k === "total") continue;
    target[k] = (target[k] || 0) + (Number(v) || 0);
  }
}

function stageStatus(summary) {
  if (!summary) return "none";
  if (summary.stopType === "hourly") return "rate_limited";
  if (["daily", "monthly", "yearly", "cap"].includes(summary.stopType)) return "limit_reached";
  if (summary.captchaFailed) return "captcha_failed";
  if (summary.isNetworkError || summary.stopType === "network_error") return "network_error";
  return "done";
}

/**
 * The search runner can internally swap in a fresh page on a detached frame
 * (it does not return that reference). Before running a later stage, make sure
 * our shared page is still alive; if not, open a replacement in the same browser.
 */
async function ensureUsablePage(taskId, browser, page) {
  if (!browser) return page;
  try {
    if (page && !page.isClosed()) {
      await page.evaluate(() => document.readyState); // throws when frame is detached
      return page;
    }
  } catch (_) { /* fall through and reopen */ }
  try {
    const ctx = typeof browser.contexts === "function" ? browser.contexts()[0] : null;
    const fresh = ctx ? await ctx.newPage() : await browser.newPage();
    logger.warn(`[social-chain] ${taskId}: prior stage detached the page — reopened a replacement in the same session`);
    return fresh;
  } catch (e) {
    logger.warn(`[social-chain] ${taskId}: could not reopen page: ${e.message}`);
    return page;
  }
}

/**
 * Runs ALL enabled interaction hooks for one account sequentially inside ONE
 * browser/tab: search -> profile-interact (People Search when no CSV) ->
 * activities (normal feed/notifications). This is the "one stack" replacement
 * for launching one parallel browser/tab per hook.
 */
async function processTask(task) {
  const taskId = task.taskId || ("chain-" + Math.random().toString(36).substring(2, 11));
  let browser = null;
  let page = null;
  let finalStatus = "FAILED";
  const results = [];
  const quota = {};

  try {
    const platform = String(task.platform || "").toLowerCase();
    const profileId = task.profileId || task.accountId || null;
    const campaignId = task.campaignId || null;
    const operations = Array.isArray(task.operations) && task.operations.length
      ? task.operations
      : ["search-interact", "page-interact", "activities-interact"];
    const keywords = (Array.isArray(task.searchQueries)
      ? task.searchQueries
      : (task.searchQuery ? [task.searchQuery] : []))
      .map(k => String(k || "").trim()).filter(Boolean);
    const targets = (Array.isArray(task.targets) ? task.targets : [])
      .map(h => String(h || "").trim().replace(/^@+/, "")).filter(Boolean);
    const discoveryTags = (Array.isArray(task.discoveryTags) ? task.discoveryTags : [])
      .map(t => String(t || "").trim()).filter(Boolean);
    const maxResultsPerKeyword = Math.max(1, parseInt(task.maxResultsPerKeyword, 10) || 5);
    const stopAfterHours = Math.max(0, parseFloat(task.interactionStopAfterHours ?? task.stopAfterHours) || 0);
    const engagementMode = task.engagementMode === true || String(task.engagementMode || "").toLowerCase() === "true";
    const messageText = task.messageText || task.commentText || task.comment || "";
    const socialStrategyPrompt = task.socialStrategyPrompt || null;

    logger.info(
      `[social-chain] ${taskId}: profile=${profileId} platform=${platform} ops=${operations.join(" -> ")} keywords=${keywords.length} targets=${targets.length} tags=${discoveryTags.length}`
    );

    if (!platform) throw new Error("Platform not specified");
    if (!task.cookieJSON) throw new Error("No cookies found. Must login first via social/cookie/cookie-api-login");

    const gate = await resolveAccountGate(profileId, platform);
    if (gate.blocked) throw accountGateError(profileId, gate);

    // ONE browser/session for the whole chain — no second tab.
    try {
      const session = await resolveSocialSession(
        {
          cookies: task.cookieJSON,
          browserIdentity: task.browserIdentity || null,
          driveUrl: task.driveUrl || "",
          profileId,
          platform,
        },
        undefined,
        { fullPage: true }
      );
      browser = session.browser;
      page = session.page;
    } catch (e) {
      ({ browser, page } = await launchBrowserWithSession(task.cookieJSON, undefined, { fullPage: true }));
    }

    // ---- Stage 1: SEARCH (top priority) ----
    if (operations.includes("search-interact")) {
      if (!keywords.length) {
        logger.warn(`[social-chain] ${taskId}: search stage skipped — no keywords`);
      } else {
        const cfg = getSearchPlatformConfig(platform);
        const summary = await runSearchInteractEngagement(page, {
          platform,
          platformConfig: cfg,
          ai: MultiProviderAI,
          profileId,
          campaignId,
          keywords,
          maxResultsPerKeyword,
          stopAfterHours,
          socialStrategyPrompt,
          taskId: `${taskId}-search`,
        });
        addQuota(quota, summary.quota);
        results.push(...(summary.results || []).map(r => ({ ...r, stage: "search" })));
        try {
          await markTagsDone(campaignId, profileId, summary.completedKeywords || []);
        } catch (e) {
          logger.warn(`[social-chain] ${taskId}: tag status persist failed: ${e.message}`);
        }
        logger.info(
          `[social-chain] ${taskId}: search stage done — engaged=${summary.engaged || 0} failed=${summary.failed || 0} stop=${stageStatus(summary)}`
        );
        if ((summary.unresolvedKeywords || []).length) {
          results.push({
            stage: "search",
            status: "network_error",
            reason: "partial_unresolved_keywords",
            unresolvedKeywords: summary.unresolvedKeywords,
            resumedNextCycle: true,
          });
        }
      }
    }

    // ---- Stage 2: PROFILE INTERACT (always runs after search in this chain) ----
    if (operations.includes("page-interact")) {
      page = await ensureUsablePage(taskId, browser, page);
      const cfg = getPagePlatformConfig(platform);
      const tagsToUse = discoveryTags.length ? discoveryTags : keywords;
      let handles = targets.slice();
      let discovered = [];

      if (!handles.length && tagsToUse.length) {
        const d = await discoverPeopleHandles(page, cfg, tagsToUse, maxResultsPerKeyword);
        discovered = d.handles || [];
        handles = discovered.map(h => h.username);
        if ((d.failedTags || []).length) {
          results.push({
            stage: "page",
            status: "network_error",
            reason: "discovery_navigation_failed",
            failedTags: d.failedTags,
            resumedNextCycle: true,
          });
        }
        logger.info(`[social-chain] ${taskId}: discovery found ${handles.length} profile(s) from ${tagsToUse.length} tag(s)`);
      }

      const useRunner = supportsPageRunner(platform) && !!pageActionForOperation("page-interact", engagementMode);
      if (useRunner) {
        for (const h of handles) {
          const run = await runPageInteract({
            page,
            platform,
            profileId,
            campaignId,
            taskId: `${taskId}-page`,
            handles: [h],
            operation: "page-interact",
            engagementMode,
            messageText,
            stopAfterHours,
          });
          addQuota(quota, run.quota);
          results.push(...(run.results || []).map(r => ({
            ...r,
            stage: "page",
            keyword: h,
            discovered: discovered.some(d => d.username === h),
          })));
          if (run.stopType) break;
        }
      } else if (handles.length) {
        logger.warn(`[social-chain] ${taskId}: no page runner for ${platform} — ${handles.length} handle(s) not processed`);
      }
    }

    // ---- Stage 3: ACTIVITIES (normal feed/notifications fallback) ----
    if (operations.includes("activities-interact") && supportsActivitiesRunner(platform)) {
      page = await ensureUsablePage(taskId, browser, page);
      const actRun = await runActivitiesInteract({
        page,
        platform,
        profileId,
        campaignId,
        taskId: `${taskId}-activities`,
        operation: "engageWithNotifications",
        engagementMode: true,
        messageText,
        stopAfterHours,
        maxEngagements: 20,
      });
      addQuota(quota, actRun.quota);
      results.push(...(actRun.results || []).map(r => ({ ...r, stage: "activities" })));
      if (actRun.stopType) {
        results.push({ stage: "activities", status: "limit_reached", reason: actRun.stopType });
      }
    }

    finalStatus = "COMPLETED";
    logger.info(
      `[social-chain] ${taskId}: completed in one session — actions=${Object.values(quota).reduce((a, b) => a + (Number(b) || 0), 0)}`
    );
  } catch (error) {
    logger.error(`[social-chain] ${taskId} failed: ${error.message}`);
    finalStatus = "FAILED";
    results.push({ error: error.message, timestamp: new Date().toISOString() });
  } finally {
    if (page) { try { await page.close(); } catch (e) {} }
    if (browser) { try { await browser.close(); } catch (e) {} }
    activeTasks.delete(taskId);
  }

  const total = Object.entries(quota)
    .filter(([k]) => k !== "total")
    .reduce((a, [, v]) => a + (Number(v) || 0), 0);
  return {
    taskId,
    status: finalStatus,
    resultCount: results.length,
    results,
    quota: { ...quota, total },
  };
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, task } = body;
    if (action === "execute") {
      if (!task) {
        return setCorsHeaders(NextResponse.json({ error: "Missing task payload" }, { status: 400 }));
      }
      const tid = task.taskId || ("chain-" + Math.random().toString(36).substring(2, 11));
      activeTasks.set(tid, true);
      const result = await processTask(task);
      return setCorsHeaders(NextResponse.json({ message: "Task executed", task: result }));
    }
    return setCorsHeaders(NextResponse.json({ error: "Invalid action" }, { status: 400 }));
  } catch (e) {
    logger.error(`[social-chain POST] Error: ${e.message}`);
    return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
