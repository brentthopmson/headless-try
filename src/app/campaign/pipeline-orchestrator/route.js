import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { getSelfUrl, getSelfUrlWithFallback, getSelfId, getInternalSelfUrl, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignSettings, updateCampaignSettings, isCampaignPaused, classifyStageFailure, recordStageError, clearStageError, getRetryBudget } from "../_shared/pipelineUtils.js";
import { acquireCampaignLock, releaseCampaignLock } from "../../../utils/campaignLock.js";
import { checkUserConcurrentCampaigns, registerActiveCampaignRun, unregisterActiveCampaignRun, getActiveCampaignIdsInProcess } from "../../../utils/campaignConcurrency.js";
import { getSheetDataApi, updateSheetRowApi } from "../../api/googlesheets.js";
import { notifyCampaignFailure } from "../../../utils/notifyCampaignFailure.js";

// Self-hosted: no platform timeout. Allow long-running pipelines (validation
// of 100k+ rows can take hours). Removed the 60s cap that caused premature
// timeouts and validation re-runs.
export const maxDuration = 0;
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
      // A stale lastError from a proxy/gateway cutoff (e.g. 524) must not block a stage that is idle/ready to run.
      if (status === "retry") {
        const le = settings.lastError;
        const staleGateway = le && le.stage === stage && /non_json_response|524|502|503|504|522|timeout|gateway|cloudflare|aborted/i.test(String(le.reason || ""));
        if (staleGateway) return { stage, action: "run" };
        return { stage, action: "retry" };
      }
      // Treat failed as resumable/retryable so campaigns can continue from checkpoint
      // (e.g. after engine crash, Drive flush error, or manual resume of a paused run).
      if (status === "failed") return { stage, action: "retry", wasFailed: true };
    }

    if (stage === "execute") {
      const campaignStatus = settings._campaignStatus;
      if (campaignStatus === "completed" || campaignStatus === "paused" || campaignStatus === "Limit Reached") continue;
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
  const selfUrl = getInternalSelfUrl();
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

      let result = null;
      const rawText = await response.text().catch(() => "");
      try {
        result = rawText ? JSON.parse(rawText) : {};
      } catch {
        const preview = String(rawText || "").slice(0, 300);
        const statusNum = Number(response.status) || 0;
        const isGatewayLike = statusNum === 502 || statusNum === 503 || statusNum === 504 || statusNum === 522 || statusNum === 524
          || /<!doctype\s+html|<html|cloudflare|cf-ray|bad gateway|gateway timeout|service unavailable/i.test(rawText || "");
        log.warn(`${config.label} returned non-JSON response (status ${response.status}): ${preview}`);
        // Long-running/resumable stages often outlive proxy/client connections (Cloudflare 524/502).
        // Never treat ambiguous/gateway cutoffs as a stage failure: trust persisted stage status.
        try {
          if (config.statusField) {
            const current = await getCampaignSettings(campaignId);
            const currentStatus = String(current?.settings?.[config.statusField] || current?.[config.statusField] || "").toLowerCase();
            if (currentStatus === "completed") {
              return { success: true, completed: true, message: `${config.label} completed (request ended with non-JSON/gateway response but persisted status is completed)` };
            }
            if (currentStatus === "processing" || currentStatus === "monitoring" || currentStatus === "running") {
              return { success: false, skipped: true, processing: true, message: `${config.label} returned non-JSON response but stage status is ${currentStatus}` };
            }
            if (currentStatus === "paused" || currentStatus === "waiting_quota" || currentStatus === "resting" || currentStatus === "retry") {
              return { success: false, skipped: true, paused: true, message: `${config.label} returned non-JSON response but stage status is ${currentStatus}` };
            }
            if (currentStatus === "failed") {
              return { success: false, error: `non_json_response_${response.status}`, message: `${config.label} failed (non-JSON response, status ${response.status})` };
            }
          }
        } catch (se) {
          log.warn(`${config.label} status check after non-JSON failed: ${se.message}`);
        }
        // idle/unknown/no-status-field/gateway: treat as in-flight/wait to avoid false fail/advance.
        return { success: false, skipped: true, processing: true, gatewayCutoff: isGatewayLike, message: `${config.label} returned non-JSON/gateway response (status ${response.status}) - treating as in-flight` };
      }
      log.info(`${config.label} response: ${JSON.stringify(result).slice(0, 500)}`);
      return result;
    } catch (err) {
      const errName = err.name || "";
      const errMsg = err.message || "unknown error";
      const isDisconnect = errName === "AbortError" || /aborted|timeout|timed out|terminated|socket|econnreset|fetch failed|network|gateway/i.test(errMsg);

      log.warn(`${config.label} fetch error: ${errMsg} (disconnect=${isDisconnect})`);

      // A dropped client/proxy connection does not mean the server-side stage stopped.
      // Trust persisted stage status; never fail/notify/retry while processing or already completed.
      if (config.statusField) {
        try {
          if (await isCampaignPaused(campaignId)) {
            log.info(`${config.label} campaign paused during fetch-error check - aborting`);
            return { success: false, skipped: true, paused: true, message: `${config.label} paused by user` };
          }
          const current = await getCampaignSettings(campaignId);
          const currentStatus = String(current?.settings?.[config.statusField] || current?.[config.statusField] || "").toLowerCase();
          if (currentStatus === "completed") {
            return { success: true, completed: true, message: `${config.label} completed (request disconnected but persisted status is completed)` };
          }
          if (currentStatus === "processing" || currentStatus === "monitoring" || currentStatus === "running") {
            return { success: false, skipped: true, processing: true, message: `${config.label} still processing in background after request disconnect` };
          }
          if (currentStatus === "paused" || currentStatus === "waiting_quota" || currentStatus === "resting" || currentStatus === "retry") {
            return { success: false, skipped: true, paused: true, message: `${config.label} status is ${currentStatus} after request disconnect` };
          }
          if (isDisconnect) {
            return { success: false, skipped: true, processing: true, message: `${config.label} request disconnected (${errMsg || 'network'}) - treating as in-flight` };
          }
        } catch (checkErr) {
          log.warn(`Status check after fetch error failed: ${checkErr.message}`);
          if (isDisconnect) {
            return { success: false, skipped: true, processing: true, message: `${config.label} request disconnected; status check failed - treating as in-flight` };
          }
        }
      } else if (stage === "execute") {
        return { success: false, skipped: true, processing: true, message: `${config.label} request disconnected - treating as in-flight` };
      }

      if (!isDisconnect && attempt < maxRetries) {
        log.warn(`${config.label} fetch failed (attempt ${attempt + 1}/${maxRetries + 1}): ${errMsg} — retrying in 30s`);
        await new Promise(r => setTimeout(r, 30_000));
        continue;
      }

      log.error(`${config.label} failed: ${errMsg}`);
      try {
        if (config.statusField) await updateCampaignSettings(campaignId, { [config.statusField]: "failed" });
      } catch (e) {
        log.warn(` Failed to set ${config.statusField} to failed: ${e.message}`);
      }
      await notifyCampaignFailure({
        campaignId,
        stage,
        channelType: 'campaign',
        failedCount: 1,
        error: errMsg,
        details: { route: config.route, statusField: config.statusField, stack: err.stack },
      });
      return { success: false, error: errMsg || `${config.label} request failed` };
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

    // Idempotency: a second run request (double click, stale frontend poll,
    // GAS re-dispatch) must never restart a campaign that already has a live
    // orchestrator/stage lease. Stage-completion self-triggers are explicitly
    // marked `fromStage` and are allowed through so auto-advance still works.
    const alreadyActive = getActiveCampaignIdsInProcess().includes(String(campaignId).trim());
    if (alreadyActive && !body.fromStage && !body.force) {
      log.info(`[orchestrator] duplicate start ignored - campaign already active`);
      return NextResponse.json({ success: true, message: "Campaign already active", locked: true, lockReason: "active_run" });
    }

    registerActiveCampaignRun(campaignId, 'orchestrator');
    let campaignData = await getCampaignSettings(campaignId);
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

    // Mark campaign as running (row) for UI/pause visibility, unless in a terminal/hold state
    try {
      const rowStatusNow = String(campaignData?.status || '').trim().toLowerCase();
      const terminalOrHold = new Set(['completed', 'paused', 'limit reached', 'error', 'failed']);
      if (!terminalOrHold.has(rowStatusNow)) {
        await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "running", updatedOn: new Date().toISOString() });
      }
    } catch (e) {
      log.warn(`[orchestrator] Could not mark campaign running: ${e.message}`);
    }

    const { settings } = campaignData;
    settings._campaignStatus = campaignData.status;

    // Expiry guard — INTERACTIONS ONLY. A campaign with a list (fileUrl)
    // must shoot the list to completion regardless of elapsed days.
    const durationGuardsInteractions = (settings.channel || 'email') === 'social' || !settings.fileUrl;
    try {
      const firstStartedAt = settings.firstStartedAt || settings.startedAt;
      let expiresAt = settings.expiresAt || null;
      if (!expiresAt && firstStartedAt && settings.durationDays) {
        const ms = new Date(firstStartedAt).getTime() + parseInt(settings.durationDays, 10) * 86400000;
        expiresAt = new Date(ms).toISOString();
      }
      if (durationGuardsInteractions && expiresAt && Date.now() >= new Date(expiresAt).getTime()) {
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
    // — INTERACTIONS ONLY (see expiry guard above).
    const headers = campaignData.headers || [];
    const createdOnIdx = headers.indexOf("createdOn");
    const createdOnRaw = createdOnIdx !== -1 && campaignData.campaignRow ? campaignData.campaignRow[createdOnIdx] : null;
    const durationDays = Math.max(1, parseInt(settings.durationDays, 10) || 7);
    if (durationGuardsInteractions && createdOnRaw) {
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

    // Allow non-interruptible stages (validate/enrich/personalize) to run to completion
    // even if the campaign row is marked paused. Execute/interact remain pausable.
    const NON_INTERRUPTIBLE = new Set(['validate', 'enrich', 'personalize']);
    const earlyResolution = resolveCurrentStage(settings);
    const earlyStage = earlyResolution?.stage || null;
    const earlyMustRun = earlyResolution && (earlyResolution.action === 'run' || earlyResolution.action === 'retry' || earlyResolution.action === 'wait') && NON_INTERRUPTIBLE.has(earlyStage);
    if (!earlyMustRun && await isCampaignPaused(campaignId)) {
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
        const mailMergeUrl = getInternalSelfUrl();
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
          } else {
            // Mail merge failed (e.g. Drive CSV flush) — pause, do NOT proceed to later stages.
            await recordStageError(campaignId, { stage: 'mail-merge', reason: mailMergeResult.error || 'mail merge failed', kind: 'permanent' });
            await updateCampaignSettings(campaignId, { status: "paused", lastError: { stage: 'mail-merge', reason: mailMergeResult.error || 'mail merge failed', kind: 'permanent' } });
            await notifyCampaignFailure({ campaignId, stage: 'mail-merge', channelType: 'campaign', failedCount: 1, reason: mailMergeResult.error || 'mail merge failed' });
            return NextResponse.json({ success: false, message: 'Mail merge failed', failedStage: 'mail-merge', details: mailMergeResult }, { status: 500 });
          }
        } catch (mmErr) {
          log.error(`Mail merge failed: ${mmErr.message}`);
          await recordStageError(campaignId, { stage: 'mail-merge', reason: mmErr.message, kind: 'transient' });
          await updateCampaignSettings(campaignId, { status: "paused", lastError: { stage: 'mail-merge', reason: mmErr.message, kind: 'transient' } });
          await notifyCampaignFailure({ campaignId, stage: 'mail-merge', channelType: 'campaign', failedCount: 1, reason: mmErr.message });
          return NextResponse.json({ success: false, message: 'Mail merge failed', failedStage: 'mail-merge', error: mmErr.message }, { status: 500 });
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

    const { stage, action, wasFailed } = resolution;
    const config = STAGE_CONFIG[stage];

    if (action === "retry") {
      const budget = await getRetryBudget();
      const attempts = typeof settings.retryAttempts === 'number' ? settings.retryAttempts : 0;
      // When resuming a previously-failed stage, allow a fresh attempt (reset counter)
      // so the campaign can continue from its checkpoint instead of being stuck terminal.
      const effectiveAttempts = wasFailed ? 0 : attempts;
      if (effectiveAttempts < budget) {
        const retryPatch = {
          ...(config.statusField ? { [config.statusField]: "processing" } : {}),
          status: "running",
          retryAttempts: effectiveAttempts + 1,
        };
        // Clear stale terminal error when resuming from failed
        if (wasFailed) {
          retryPatch.lastError = null;
        }
        await updateCampaignSettings(campaignId, retryPatch);
        // fall through to dispatch below
      } else {
        // Budget exhausted but stage was failed and user is trying to run: pause (resumable) not hard-fail.
        if (wasFailed) {
          await updateCampaignSettings(campaignId, {
            ...(config.statusField ? { [config.statusField]: "retry" } : {}),
            status: "paused",
            lastError: { ...(settings.lastError || {}), reason: `${config.label} needs retry (budget reached). Resume to continue.` },
          });
          return NextResponse.json({
            success: false,
            message: `${config.label} paused for retry (resume to continue)`,
            failedStage: stage,
            paused: true,
          });
        }
        await recordStageError(campaignId, { stage, reason: settings.lastError?.reason || `${config.label} failed`, kind: 'transient' });
        await updateCampaignSettings(campaignId, {
          ...(config.statusField ? { [config.statusField]: "failed" } : {}),
          status: "paused",
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
          message: `${config.label} stage failed after retries (paused, resumable)`,
          failedStage: stage,
          error: true,
          paused: true,
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
      await updateCampaignSettings(campaignId, { status: "paused" });
      return NextResponse.json({
        success: false,
        message: `${config.label} stage failed (paused, resumable)`,
        failedStage: stage,
        paused: true,
      });
    }

    if (action === "wait") {
      log.info(`Waiting for ${config.label} to complete`);
      try {
        const fresh = await getCampaignSettings(campaignId);
        const rs = String(fresh?.status || '').toLowerCase();
        if (rs !== 'paused' && rs !== 'completed' && rs !== 'limit reached') {
          await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "running", updatedOn: new Date().toISOString() });
        }
      } catch {}
      return NextResponse.json({
        success: true,
        message: `Waiting for ${config.label} to complete`,
        waitingStage: stage,
      });
    }

    // Race condition guard: if stage is already processing, skip duplicate call
    if (config.statusField && settings[config.statusField] === "processing" && action !== "retry") {
      log.info(`${config.label} already processing, skipping duplicate call`);
      try {
        const fresh = await getCampaignSettings(campaignId);
        const rs = String(fresh?.status || '').toLowerCase();
        if (rs !== 'paused' && rs !== 'completed' && rs !== 'limit reached') {
          await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "running", updatedOn: new Date().toISOString() });
        }
      } catch {}
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
      let result = await triggerStage(campaignId, stage, settings, scope);

      if (!result || !result.success) {
        // If the route is still processing in background (fetch/proxy dropped but stage alive/completing),
        // don't treat as failure — return success so caller knows to poll/wait and we can re-evaluate.
        if (result?.skipped) {
          // If background work actually completed, clear stale cutoff errors and advance via normal success path.
          if (result.completed && config.statusField) {
            try {
              const freshAfter = await getCampaignSettings(campaignId);
              const le = freshAfter?.settings?.lastError;
              if (!le || le.stage === stage || /non_json_response|524|502|503|504|522|timeout|gateway|cloudflare|aborted/i.test(String(le.reason || ""))) {
                await clearStageError(campaignId);
              }
            } catch {}
            result = { ...(result || {}), success: true, completed: true };
          } else {
            return NextResponse.json({
              success: true,
              message: result.message || `${config.label} still processing`,
              waitingStage: stage,
              processing: !!result.processing,
              paused: !!result.paused,
              completed: result.completed,
            });
          }
        }
      }

      // execute-campaign returns 202 {accepted,processing} and runs in background to
      // avoid client/proxy aborts. Treat as in-flight: do NOT mark completed or
      // auto-advance; completion/limit status is persisted to the sheet by the bg task.
      if (result?.accepted && result?.processing) {
        // Start interact stage in parallel (same day as execute) if staged and not yet started.
        // Interact reads the CSV for sent rows independently, so it can run
        // concurrently with execute without waiting for execute to complete.
        if (stage === "execute" && settings.interactionStaged === true) {
          const interactConfig = STAGE_CONFIG.interact;
          const interactStatus = settings[interactConfig.statusField];
          if (!interactStatus || interactStatus === "idle") {
            // Fire-and-forget: trigger interact in background
            const selfUrl = getInternalSelfUrl();
            const interactUrl = `${selfUrl}${interactConfig.route}`;
            fetch(interactUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ campaignId, fileUrl: settings.fileUrl }),
            }).catch(err => log.warn(`Parallel interact trigger failed (non-fatal): ${err.message}`));
            log.info(`Triggered interact stage in parallel with execute`);
          }
        }
        return NextResponse.json({
          success: true,
          message: result.message || `${config.label} started in background`,
          waitingStage: stage,
          processing: true,
          accepted: true,
        });
      }

      if (!result || !result.success) {
        const kind = classifyStageFailure(result?.error || result?.message || result);
        if (kind === 'limit' || result?.limitReached) {
          await clearStageError(campaignId);
          await updateCampaignSettings(campaignId, { status: "resting", restReason: "limit_reached", restUntil: Date.now() + 60 * 60 * 1000 });
          await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "resting", updatedOn: new Date().toISOString() }).catch(() => {});
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
        // UI shows a truthful state instead of running forever. Use "paused"
        // (not "failed") so the campaign remains resumable.
        if (stage !== "execute" || !result?.limitReached) {
          await updateCampaignSettings(campaignId, { status: "paused" });
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
        await updateCampaignSettings(campaignId, { status: "resting", restReason: "limit_reached", restUntil: Date.now() + 60 * 60 * 1000 });
        await updateSheetRowApi("campaigns", "campaignId", campaignId, { status: "resting", updatedOn: new Date().toISOString() }).catch(() => {});
        return NextResponse.json({
          success: true,
          message: `${config.label} stopped: limit reached`,
          limitReached: true,
          completedStage: stage,
        });
      }

      // Stage reported in-progress/paused/incomplete — never advance.
      if (result.paused || result.processing || result.completed === false) {
        return NextResponse.json({
          success: true,
          message: result.message || `${config.label} still processing`,
          waitingStage: stage,
          processing: !!result.processing,
          paused: !!result.paused,
          completed: result.completed === false ? false : undefined,
          result,
        });
      }

      // Clear errors on successful/verified stage completion (including completed detected after a proxy cutoff).
      try {
        let stageCompletedNow = !!(result && result.success && result.completed !== false && !result.processing && !result.paused);
        if (!stageCompletedNow && config.statusField) {
          const freshNow = await getCampaignSettings(campaignId);
          const s = String(freshNow?.settings?.[config.statusField] || "").toLowerCase();
          stageCompletedNow = s === "completed";
        }
        if (stageCompletedNow) {
          const freshErr = await getCampaignSettings(campaignId);
          const le = freshErr?.settings?.lastError;
          // Clear stale/transient artifacts (e.g. prior 524/non-JSON cutoff) once this stage is actually completed.
          if (!le || le.stage === stage || /non_json_response|524|502|503|504|522|timeout|gateway|cloudflare|aborted/i.test(String(le.reason || ""))) {
            await clearStageError(campaignId);
          }
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
      try { await updateCampaignSettings(campaignId, { status: "paused" }); } catch { /* best-effort */ }
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
