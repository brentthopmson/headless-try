import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { getSelfUrl, getSelfUrlWithFallback, getSelfId, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignSettings, updateCampaignSettings, isCampaignPaused, classifyStageFailure, recordStageError, clearStageError, getRetryBudget } from "../_shared/pipelineUtils.js";
import { acquireCampaignLock, releaseCampaignLock } from "../../../utils/campaignLock.js";
import { checkUserConcurrentCampaigns, registerActiveCampaignRun, unregisterActiveCampaignRun } from "../../../utils/campaignConcurrency.js";
import { getSheetDataApi, updateSheetRowApi } from "../../api/googlesheets.js";
import { notifyCampaignFailure } from "../../../utils/notifyCampaignFailure.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const STAGE_ORDER = ["validate", "enrich", "personalize", "execute", "interact"];

const STAGE_CONFIG = {
  validate: {
    stagedField: "validationStaged",
    statusField: "validationStatus",
    route: "/campaign/validate-campaign",
    label: "Validation",
  },
  enrich: {
    stagedField: "enrichmentStaged",
    statusField: "enrichmentStatus",
    route: "/campaign/enrich-campaign",
    label: "Enrichment",
  },
  personalize: {
    stagedField: "aiPersonalizationStaged",
    statusField: "personalizationStatus",
    route: "/campaign/personalize-campaign",
    label: "AI Personalization",
  },
  execute: {
    stagedField: "executeStaged",
    statusField: null,
    route: "/campaign/execute-campaign",
    label: "Execute",
  },
  interact: {
    stagedField: "interactionStaged",
    statusField: "interactionStatus",
    route: "/campaign/interact-campaign",
    label: "Interaction",
  },
};

function resolveCurrentStage(settings) {
  const channel = settings.channel || "email";
  for (const stage of STAGE_ORDER) {
    // Social campaigns execute in one step (interactions run inside the
    // execute stage) — mirror the frontend, which hides validate/enrich/
    // personalize/interact for social. Never run email-only stages on them.
    if (channel === "social" && stage !== "execute") continue;

    const config = STAGE_CONFIG[stage];
    const isStaged = settings[config.stagedField] === true;
    if (!isStaged) continue;

    if (config.statusField) {
      const status = settings[config.statusField];
      if (status === "completed") continue;
      // Email watcher: 'monitoring' means a pass finished and another is
      // due (the watcher is re-triggered by GAS polls) — it must re-run,
      // never be skipped as done. Other stages treat it as terminal.
      if (status === "monitoring") {
        if (stage === "interact" && channel === "email") return { stage, action: "run" };
        continue;
      }
      if (status === "processing") return { stage, action: "wait" };
      if (status === "retry") return { stage, action: "retry" };
      if (status === "failed") return { stage, action: "fail" };
    }

    if (stage === "execute") {
      const campaignStatus = settings._campaignStatus;
      if (campaignStatus === "completed" || campaignStatus === "Limit Reached") continue;
    }

    return { stage, action: "run" };
  }
  return null;
}

/**
 * Concurrent campaign limit — shared implementation lives in
 * utils/campaignConcurrency.js (checkUserConcurrentCampaigns) so GAS
 * pre-checks, execute-campaign and this orchestrator all count the same
 * active statuses and read the same SETTINGS campaignConcurrentLimit key.
 */

async function triggerStage(campaignId, stage, settings, scope) {
  const config = STAGE_CONFIG[stage];
  const selfUrl = getSelfUrlWithFallback();
  let route = config.route;
  const log = logger.child({ campaignId, stage: 'orchestrator' });

  const body = { campaignId };

  // Per-server fan-out scope: thread into the execute stage so it shoots only
  // this instance's accounts (other instances get their own scoped trigger).
  if (scope && stage === "execute") {
    if (Array.isArray(scope.accountIds) && scope.accountIds.length > 0) {
      body.accountIds = scope.accountIds;
      body.serverScope = scope.serverScope || selfUrl;
    }
  }

  if (stage !== "execute") {
    const fileUrl = settings.fileUrl;
    // Email interaction has ONE reply engine: the AI inbox watcher. It runs
    // for interactions-only campaigns (no CSV) AND for CSV campaigns with
    // interaction accounts + keywords/strategy (CSV emails become a
    // relevance signal inside the watcher; the old CSV-only monitor never
    // replied to anyone).
    const emailInteractReplies = stage === "interact"
      && (settings.channel || "email") === "email"
      && settings.interactionAccounts?.length
      && (settings.emailKeywords?.length || settings.emailStrategyPrompt);

    if (emailInteractReplies) {
      route = "/campaign/interact-inbox";
      log.info(` Email interact — routing interact stage to AI inbox watcher (${fileUrl ? 'with CSV relevance signal' : 'interactions-only'})`);
      if (fileUrl) body.fileUrl = fileUrl;
    } else if (!fileUrl) {
      log.warn(`No fileUrl for stage ${stage}`);
      return null;
    } else {
      body.fileUrl = fileUrl;
    }
  }

  const url = `${selfUrl}${route}`;

  log.info(`Triggering ${config.label}`);

  // Stage-specific timeouts (validation has browser verification which is slow)
  const stageTimeouts = { validate: 600_000, enrich: 300_000, personalize: 300_000, execute: 600_000, interact: 300_000 };
  const timeoutMs = stageTimeouts[stage] || 300_000;
  const maxRetries = 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (config.statusField) {
        await updateCampaignSettings(campaignId, { [config.statusField]: "processing" });
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const result = await response.json();
      log.info(`${config.label} response: ${JSON.stringify(result).slice(0, 500)}`);
      return result;
    } catch (err) {
      const errName = err.name || "";
      const errMsg = err.message || "unknown error";

      if (errName === "AbortError") {
        log.error(`${config.label} timed out after ${timeoutMs}ms`);
        // Don't retry on timeout — the route may still be running; check status below
        if (!config.statusField && stage === "execute") {
          // Execute has no status field to verify against, but a timeout does
          // NOT mean the route died — it keeps executing server-side. Don't
          // mark failed or alert; the campaign run continues in the background.
          log.info(`${config.label} timed out but execute has no status field — treating as still-running, not marking failed`);
          return { success: false, skipped: true, message: `${config.label} still running in background (timed out waiting)` };
        }
      } else {
        // Long-running stage routes (execute) can exceed fetch/undici's socket
        // timeout (~300s) while still executing server-side. The stage was
        // already marked "processing" before the POST — if it still is, the
        // route never died: DON'T retry (a retry re-triggers the whole stage
        // and double-runs the batch).
        if (config.statusField) {
          try {
            const currentSettings = await getCampaignSettings(campaignId);
            if (currentSettings?.[config.statusField] === "processing") {
              log.info(`${config.label} fetch dropped (${errMsg}) but stage is still processing — not retrying`);
              return { success: false, skipped: true, message: `${config.label} still processing in background` };
            }
          } catch (_) { /* status check is best-effort; fall through to retry */ }
        } else if (stage === "execute") {
          // Execute has no statusField, but it is the longest-running stage.
          // A non-abort fetch error here almost always means the socket
          // dropped while the route was STILL executing. Retrying re-fires
          // the whole campaign (duplicate profile downloads). The route now
          // also has its own re-entrancy guard — treat like timeout: don't
          // retry, don't mark failed, don't alert. The run continues
          // server-side.
          log.info(`${config.label} fetch dropped (${errMsg}) — execute has no status field; treating as still-running, not retrying`);
          return { success: false, skipped: true, message: `${config.label} still running in background (fetch dropped)` };
        }

        if (attempt < maxRetries) {
          log.warn(`${config.label} fetch failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in 30s`);
          await new Promise(r => setTimeout(r, 30_000));
          continue;
        }
        log.error(`${config.label} failed: ${errMsg}`);
      }

      // Before marking as failed, check if the route is still processing
      // (it may have continued running after the fetch failed)
      if (config.statusField) {
        try {
          const currentSettings = await getCampaignSettings(campaignId);
          const currentStatus = currentSettings?.[config.statusField];
          if (currentStatus === "processing") {
            log.info(`${config.label} still processing — not marking as failed, skipping stage advancement`);
            return { success: false, skipped: true, message: `${config.label} still processing in background` };
          }
        } catch (checkErr) {
          log.warn(`Failed to check stage status: ${checkErr.message}`);
        }

        await updateCampaignSettings(campaignId, { [config.statusField]: "failed" });
      }

      // Alert the admin for pipeline stage failures (debug sheet + Telegram).
      await notifyCampaignFailure({
        campaignId,
        stage,
        channelType: 'campaign',
        failedCount: 1,
        error: errMsg,
        details: { route: config.route, statusField: config.statusField, stack: err.stack },
      });
      return null;
    }
  }
  return null;
}

export async function POST(request) {
  let campaignId = null;
  // Hoisted so the catch block can always log (body-parse errors happen
  // before campaignId is known — a try-scoped `log` would ReferenceError).
  let log = logger.child({ campaignId: null, stage: 'orchestrator' });
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const retry = body.retry;
    ({ campaignId } = body);

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    log = logger.child({ campaignId, stage: 'orchestrator' });
    registerActiveCampaignRun(campaignId, 'orchestrator');
    const campaignData = await getCampaignSettings(campaignId);
    if (!campaignData) {
      return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
    }

    // Per-server fan-out scope (GAS dispatchCampaignToServers). Scoped runs
    // use a same-instance in-memory lock only — cross-server parallel is
    // intentional (disjoint account subsets).
    const scopeAccountIds = Array.isArray(body.accountIds) && body.accountIds.length > 0
      ? body.accountIds.map(String)
      : null;
    const scopeServer = typeof body.serverScope === "string" && body.serverScope ? body.serverScope : null;
    const scope = scopeAccountIds ? { accountIds: scopeAccountIds, serverScope: scopeServer } : null;

    const { settings } = campaignData;
    settings._campaignStatus = campaignData.status;

    // Expiry guard
    try {
      const firstStartedAt = settings.firstStartedAt || settings.startedAt;
      let expiresAt = settings.expiresAt || null;
      if (!expiresAt && firstStartedAt && settings.durationDays) {
        const ms = new Date(firstStartedAt).getTime() + parseInt(settings.durationDays, 10) * 86400000;
        expiresAt = new Date(ms).toISOString();
      }
      if (expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          status: "completed",
          updatedOn: new Date().toISOString()
        }).catch(() => {});
        await updateCampaignSettings(campaignId, { status: "completed" });
        return NextResponse.json({ success: false, error: 'campaign_expired', completed: true, durationExpired: true, message: 'This campaign has expired and cannot be continued.' }, { status: 400 });
      }
    } catch {}


    // Track first start time
    try {
      if (campaignData.status !== 'running' && settings.firstStartedAt) {
        // keep existing
      }
    } catch {}

    // Check Campaign Duration Window (immutable per-campaign durationDays stored at creation)
    const headers = campaignData.headers || [];
    const createdOnIdx = headers.indexOf("createdOn");
    const createdOnRaw = createdOnIdx !== -1 && campaignData.campaignRow ? campaignData.campaignRow[createdOnIdx] : null;
    const durationDays = Math.max(1, parseInt(settings.durationDays, 10) || 7);
    if (createdOnRaw) {
      const elapsedMs = Date.now() - new Date(createdOnRaw).getTime();
      const maxDurationMs = durationDays * 24 * 60 * 60 * 1000;
      if (elapsedMs >= maxDurationMs) {
        log.info(`[campaign-duration] Campaign ${campaignId} reached its scheduled duration (${(elapsedMs / 86400000).toFixed(1)} / ${durationDays} days). Completing campaign.`);
        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          status: "completed",
          updatedOn: new Date().toISOString()
        }).catch(() => {});
        await updateCampaignSettings(campaignId, { status: "completed" });
        return NextResponse.json({
          success: true,
          message: `Campaign reached its duration limit of ${durationDays} day(s) and is completed.`,
          completed: true,
          durationExpired: true,
        });
      }
    }

    if (await isCampaignPaused(campaignId)) {
      log.info(`Campaign is paused, skipping`);
      return NextResponse.json({ success: true, message: "Campaign is paused", paused: true });
    }

    // Check concurrent campaign limit per user (exclude this campaign)
    const userId = settings.userId || body.userId;
    if (userId) {
      const concurrentCheck = await checkUserConcurrentCampaigns(userId, campaignId);
      if (!concurrentCheck.allowed) {
        log.info(`User ${userId} exceeded concurrent limit: ${concurrentCheck.current}/${concurrentCheck.limit}`);
        // GAS marked this campaign 'running' before dispatching — revert so a
        // rejected start never sits as a zombie 'running' row with nothing
        // dispatched. 'paused' keeps it resumable once a slot frees.
        await updateSheetRowApi("campaigns", "campaignId", campaignId, {
          status: "paused",
          updatedOn: new Date().toISOString(),
        }).catch(() => {});
        await updateCampaignSettings(campaignId, { status: "paused" }).catch(() => {});
        return NextResponse.json({
          success: false,
          error: `Concurrent campaign limit reached (${concurrentCheck.current}/${concurrentCheck.limit} running). Pause or complete a campaign to free a slot.`,
          concurrentLimit: true,
          current: concurrentCheck.current,
          limit: concurrentCheck.limit,
        }, { status: 429 });
      }

      // USER tier campaign-start quota gate removed (plan redesign): monthly
      // *Usage quotas are enforced inside stage routes; only the concurrency
      // cap above still gates the start here.
    }

    // Mail merge: merge templates with CSV data before any stage. Only
    // campaigns WITH a CSV need it — social-no-CSV and interactions-only
    // email have nothing to merge (the route 400s without fileUrl and
    // would retry every poll). Mark those done once so polls skip them.
    if (!settings.mailMerged) {
      if (!settings.fileUrl) {
        await updateCampaignSettings(campaignId, { mailMerged: true });
        log.info(`No CSV (fileUrl) — mail merge not applicable, marked as done`);
      } else {
        const mailMergeUrl = getSelfUrlWithFallback();
        try {
          const mailMergeResp = await fetch(`${mailMergeUrl}/campaign/mail-merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ campaignId, fileUrl: settings.fileUrl }),
          });
          const mailMergeResult = await mailMergeResp.json();
          log.info(`Mail merge result: ${JSON.stringify(mailMergeResult).slice(0, 300)}`);
          if (mailMergeResult.success) {
            await updateCampaignSettings(campaignId, { mailMerged: true });
          }
        } catch (mmErr) {
          log.warn(`Mail merge failed (non-fatal): ${mmErr.message}`);
        }
      }
    } else {
      log.info(`Mail merge already done, skipping`);
    }

    const resolution = resolveCurrentStage(settings);

    if (!resolution) {
      log.info(`All enabled stages complete`);
      return NextResponse.json({
        success: true,
        message: "All enabled pipeline stages are complete",
        completed: true,
      });
    }

    const { stage, action } = resolution;
    const config = STAGE_CONFIG[stage];

    if (action === "retry") {
      const budget = await getRetryBudget();
      const attempts = typeof settings.retryAttempts === 'number' ? settings.retryAttempts : 0;
      if (attempts < budget) {
        await updateCampaignSettings(campaignId, {
          ...(config.statusField ? { [config.statusField]: "processing" } : {}),
          status: "running",
          retryAttempts: attempts + 1,
        });
        // fall through to dispatch below
      } else {
        await recordStageError(campaignId, { stage, reason: settings.lastError?.reason || `${config.label} failed`, kind: 'transient' });
        await updateCampaignSettings(campaignId, {
          ...(config.statusField ? { [config.statusField]: "failed" } : {}),
          status: "failed",
          lastError: { ...(settings.lastError || {}), reason: `retry budget exhausted (${budget}): ${settings.lastError?.reason || ''}` },
        });
        await notifyCampaignFailure({
          campaignId,
          stage,
          channelType: 'campaign',
          failedCount: 1,
          reason: `${config.label} stage failed after retries`,
          details: { stageStatus: settings[config.statusField], retryBudget: budget },
        });
        return NextResponse.json({
          success: false,
          message: `${config.label} stage failed after retries`,
          failedStage: stage,
          error: true,
        });
      }
    }

    if (action === "fail") {
      // Terminal: never auto-reset+re-trigger here unless explicitly marked retry.
      log.info(`Stage ${config.label} is failed — marking campaign failed`);
      if (!settings.lastError) {
        await recordStageError(campaignId, { stage, reason: `${config.label} stage failed`, kind: 'permanent' });
      }
      await notifyCampaignFailure({
        campaignId,
        stage,
        channelType: 'campaign',
        failedCount: 1,
        reason: `${config.label} stage failed`,
        details: { stageStatus: config.statusField ? settings[config.statusField] : null },
      });
      await updateCampaignSettings(campaignId, { status: "failed" });
      return NextResponse.json({
        success: false,
        message: `${config.label} stage failed`,
        failedStage: stage,
      });
    }

    if (action === "wait") {
      log.info(`Waiting for ${config.label} to complete`);
      return NextResponse.json({
        success: true,
        message: `Waiting for ${config.label} to complete`,
        waitingStage: stage,
      });
    }

    // Race condition guard: if stage is already processing, skip duplicate call
    if (config.statusField && settings[config.statusField] === "processing" && action !== "retry") {
      log.info(`${config.label} already processing, skipping duplicate call`);
      return NextResponse.json({ success: true, message: `${config.label} already processing`, waitingStage: stage });
    }

    // Acquire per-campaign lock before triggering stage.
    // Scoped fan-out runs skip the shared sheet lock (siblings run in parallel
    // on other instances by design) and keep a same-instance memory guard only.
    const serverlessId = getSelfId() || process.env.SERVERLESS_ID || "unknown";
    let scopedMemKey = null;
    if (scope) {
      scopedMemKey = `${campaignId}::${scope.serverScope || serverlessId}`;
      if (!globalThis.__scopedCampaignLocks) globalThis.__scopedCampaignLocks = new Map();
      const scopedLocks = globalThis.__scopedCampaignLocks;
      const held = scopedLocks.get(scopedMemKey);
      if (held && (Date.now() - held.at) < 300_000) {
        return NextResponse.json({
          success: true,
          message: `Scoped campaign already running on this instance`,
          locked: true,
          lockReason: "scoped_already_running",
        });
      }
      scopedLocks.set(scopedMemKey, { at: Date.now() });
    } else {
      const lockResult = await acquireCampaignLock(campaignId, serverlessId);
      if (!lockResult.acquired) {
        log.info(`Cannot acquire lock: ${lockResult.reason}`);
        return NextResponse.json({
          success: true,
          message: `Campaign locked (${lockResult.reason}), skipping`,
          locked: true,
          lockReason: lockResult.reason,
        });
      }
    }

    try {
      const result = await triggerStage(campaignId, stage, settings, scope);

      if (!result || !result.success) {
        // If the route is still processing in background (fetch failed but route alive),
        // don't treat as failure — return success so caller knows to poll again later.
        if (result?.skipped) {
          return NextResponse.json({
            success: true,
            message: result.message || `${config.label} still processing`,
            waitingStage: stage,
          });
        }

      // execute-campaign returns 202 {accepted,processing} and runs in background to
      // avoid client/proxy aborts. Treat as in-flight: do NOT mark completed or
      // auto-advance; completion/limit status is persisted to the sheet by the bg task.
      if (result?.accepted && result?.processing) {
        return NextResponse.json({
          success: true,
          message: result.message || `${config.label} started in background`,
          waitingStage: stage,
          processing: true,
          accepted: true,
        });
      }

        const kind = classifyStageFailure(result?.error || result?.message || result);
        if (kind === 'limit' || result?.limitReached) {
          await clearStageError(campaignId);
          await updateCampaignSettings(campaignId, { status: "Limit Reached" });
          return NextResponse.json({
            success: true,
            message: `${config.label} stopped: limit reached`,
            limitReached: true,
            completedStage: stage,
          });
        }
        if (kind === 'transient') {
          await updateCampaignSettings(campaignId, {
            ...(config.statusField ? { [config.statusField]: "retry" } : {}),
            status: "error",
          });
          await recordStageError(campaignId, { stage, reason: result?.error || result?.message || `${config.label} stage failed`, kind: 'transient' });
          await notifyCampaignFailure({
            campaignId,
            stage,
            channelType: 'campaign',
            failedCount: 1,
            reason: `transient: ${result?.error || result?.message || `${config.label} stage failed`}`,
            details: result,
          });
          return NextResponse.json({
            success: false,
            message: `${config.label} stage failed (retrying)`,
            failedStage: stage,
            error: true,
            retryable: true,
            details: result,
          });
        }

        await recordStageError(campaignId, { stage, reason: result?.error || result?.message || `${config.label} stage failed`, kind: 'permanent' });
        await notifyCampaignFailure({
          campaignId,
          stage,
          channelType: 'campaign',
          failedCount: 1,
          reason: `${config.label} stage failed`,
          details: result,
        });
        // Controlling key: flip the campaign row out of 'running' so the
        // UI shows a truthful terminal state instead of running forever.
        if (stage !== "execute" || !result?.limitReached) {
          await updateCampaignSettings(campaignId, { status: "failed" });
        }
        return NextResponse.json({
          success: false,
          message: `${config.label} stage failed`,
          failedStage: stage,
          details: result,
        });
      }

      if (result.dispatched) {
        return NextResponse.json({
          success: true,
          message: `${config.label} dispatched to workers`,
          dispatchedStage: stage,
          servers: result.servers,
        });
      }

      // Terminal for this run: a stage reported a cap/limit stop. Do NOT
      // auto-advance (execute has no statusField and resolves to itself —
      // advancing would re-trigger execute in the same invocation forever).
      // Single-point controlling-key write: any stage's block (execute,
      // validate, enrich, personalize, interact) flips status so the UI shows
      // 'Limit Reached' instead of polling forever. Idempotent — execute and
      // interact already write the same value themselves.
      if (result.limitReached) {
        await clearStageError(campaignId);
        await updateCampaignSettings(campaignId, { status: "Limit Reached" });
        return NextResponse.json({
          success: true,
          message: `${config.label} stopped: limit reached`,
          limitReached: true,
          completedStage: stage,
        });
      }

      // Clear errors on successful stage completion
      try {
        if (config.statusField && result && result.success) {
          await clearStageError(campaignId);
        }
      } catch {}

      const updatedData = await getCampaignSettings(campaignId);
      if (updatedData) {
        updatedData.settings._campaignStatus = updatedData.status;
        const nextResolution = resolveCurrentStage(updatedData.settings);
        if (nextResolution && (nextResolution.action === "run" || nextResolution.action === "retry") && nextResolution.stage !== stage) {
          const nextConfig = STAGE_CONFIG[nextResolution.stage];
          log.info(`Auto-advancing to ${nextConfig.label}`);
          const nextResult = await triggerStage(campaignId, nextResolution.stage, updatedData.settings, scope);
          return NextResponse.json({
            success: true,
            message: `${config.label} complete, advanced to ${nextConfig.label}`,
            currentStage: stage,
            nextStage: nextResolution.stage,
            nextResult,
          });
        }
      }

      return NextResponse.json({
        success: true,
        message: `${config.label} stage completed`,
        completedStage: stage,
        result,
      });
    } finally {
      if (scopedMemKey && globalThis.__scopedCampaignLocks) {
        globalThis.__scopedCampaignLocks.delete(scopedMemKey);
      } else {
        await releaseCampaignLock(campaignId, serverlessId);
      }
    }

  } catch (error) {
    log.error(`Error: ${error.message}`, { stack: error.stack });
    await notifyCampaignFailure({
      campaignId: campaignId,
      stage: 'orchestrator',
      channelType: 'campaign',
      failedCount: 1,
      error: error.message,
      details: { stack: error.stack },
    });
    if (campaignId) {
      try { await updateCampaignSettings(campaignId, { status: "failed" }); } catch { /* best-effort */ }
    }
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  } finally {
    if (campaignId) {
      unregisterActiveCampaignRun(campaignId, 'orchestrator');
    }
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
