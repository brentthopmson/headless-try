import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { getSelfUrl, getSelfUrlWithFallback, getSelfId, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignSettings, updateCampaignSettings, isCampaignPaused } from "../_shared/pipelineUtils.js";
import { acquireCampaignLock, releaseCampaignLock } from "../../../utils/campaignLock.js";
import { getCampaignLimits } from "../../socials/_shared/limits.js";
import { getSheetDataApi } from "../../api/googlesheets.js";

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
  for (const stage of STAGE_ORDER) {
    const config = STAGE_CONFIG[stage];
    const isStaged = settings[config.stagedField] === true;
    if (!isStaged) continue;

    if (config.statusField) {
      const status = settings[config.statusField];
      if (status === "completed") continue;
      if (status === "monitoring") continue;
      if (status === "processing") return { stage, action: "wait" };
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
 * Check if the user has exceeded their concurrent campaign limit.
 * @param {string} userId
 * @returns {Promise<{ allowed: boolean, current: number, limit: number }>}
 */
async function checkConcurrentLimit(userId) {
  if (!userId) return { allowed: true, current: 0, limit: 3 };

  try {
    const limits = await getCampaignLimits();
    const concurrentLimit = limits.campaignConcurrentLimit || 3;

    const campaignsResult = await getSheetDataApi("campaigns");
    if (!campaignsResult.success) return { allowed: true, current: 0, limit: concurrentLimit };

    const headers = campaignsResult.headers;
    const userIdIdx = headers.indexOf("userId");
    const statusIdx = headers.indexOf("status");

    if (userIdIdx === -1) return { allowed: true, current: 0, limit: concurrentLimit };

    // Count active campaigns for this user (running, processing, or staged)
    const activeStatuses = ["running", "processing", "staged"];
    const activeCampaigns = campaignsResult.data.filter(r => {
      const rUserId = String(r[userIdIdx] || "").trim();
      const rStatus = String(r[statusIdx] || "").trim().toLowerCase();
      return rUserId === String(userId).trim() && activeStatuses.includes(rStatus);
    });

    const current = activeCampaigns.length;
    return {
      allowed: current < concurrentLimit,
      current,
      limit: concurrentLimit,
    };
  } catch (err) {
    logger.warn(`[Pipeline Orchestrator] Failed to check concurrent limit: ${err.message}`);
    return { allowed: true, current: 0, limit: 3 };
  }
}

async function triggerStage(campaignId, stage, settings) {
  const config = STAGE_CONFIG[stage];
  const selfUrl = getSelfUrlWithFallback();
  const url = `${selfUrl}${config.route}`;
  const log = logger.child({ campaignId, stage: 'orchestrator' });

  const body = { campaignId };

  if (stage !== "execute") {
    const fileUrl = settings.fileUrl;
    if (!fileUrl) {
      log.warn(`No fileUrl for stage ${stage}`);
      return null;
    }
    body.fileUrl = fileUrl;
  }

  log.info(`Triggering ${config.label}`);

  try {
    if (config.statusField) {
      await updateCampaignSettings(campaignId, { [config.statusField]: "processing" });
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const result = await response.json();
    log.info(`${config.label} response: ${JSON.stringify(result).slice(0, 500)}`);
    return result;
  } catch (err) {
    log.error(`${config.label} failed: ${err.message}`);
    if (config.statusField) {
      await updateCampaignSettings(campaignId, { [config.statusField]: "failed" });
    }
    return null;
  }
}

export async function POST(request) {
  try {
    await identifySelfFromHost(request.headers.get('host'));
    const body = await request.json();
    const { campaignId } = body;

    if (!campaignId) {
      return NextResponse.json({ success: false, error: "Missing campaignId" }, { status: 400 });
    }

    const log = logger.child({ campaignId, stage: 'orchestrator' });
    const campaignData = await getCampaignSettings(campaignId);
    if (!campaignData) {
      return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
    }

    const { settings } = campaignData;
    settings._campaignStatus = campaignData.status;

    if (await isCampaignPaused(campaignId)) {
      log.info(`Campaign is paused, skipping`);
      return NextResponse.json({ success: true, message: "Campaign is paused", paused: true });
    }

    // Check concurrent campaign limit per user
    const userId = settings.userId || body.userId;
    if (userId) {
      const concurrentCheck = await checkConcurrentLimit(userId);
      if (!concurrentCheck.allowed) {
        log.info(`User ${userId} exceeded concurrent limit: ${concurrentCheck.current}/${concurrentCheck.limit}`);
        return NextResponse.json({
          success: false,
          error: `Concurrent campaign limit reached (${concurrentCheck.current}/${concurrentCheck.limit})`,
          concurrentLimit: true,
          current: concurrentCheck.current,
          limit: concurrentCheck.limit,
        }, { status: 429 });
      }
    }

    // Mail merge: merge subject/body templates with CSV data before any stage
    if (!settings.mailMerged) {
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

    if (action === "fail") {
      log.info(`Stage ${config.label} is failed, auto-resetting`);
      const resetUpdates = {};
      if (config.statusField) {
        resetUpdates[config.statusField] = null;
      }
      resetUpdates.serverAssignments = settings.serverAssignments || {};
      if (resetUpdates.serverAssignments[stage]) {
        delete resetUpdates.serverAssignments[stage];
      }
      await updateCampaignSettings(campaignId, resetUpdates);
      // Re-run this stage
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
    if (config.statusField && settings[config.statusField] === "processing") {
      log.info(`${config.label} already processing, skipping duplicate call`);
      return NextResponse.json({ success: true, message: `${config.label} already processing`, waitingStage: stage });
    }

    // Acquire per-campaign lock before triggering stage
    const serverlessId = getSelfId() || process.env.SERVERLESS_ID || "unknown";
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

    try {
      const result = await triggerStage(campaignId, stage, settings);

      if (!result || !result.success) {
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

      const updatedData = await getCampaignSettings(campaignId);
      if (updatedData) {
        updatedData.settings._campaignStatus = updatedData.status;
        const nextResolution = resolveCurrentStage(updatedData.settings);
        if (nextResolution && nextResolution.action === "run") {
          const nextConfig = STAGE_CONFIG[nextResolution.stage];
          log.info(`Auto-advancing to ${nextConfig.label}`);
          const nextResult = await triggerStage(campaignId, nextResolution.stage, updatedData.settings);
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
      await releaseCampaignLock(campaignId, serverlessId);
    }

  } catch (error) {
    log.error(`Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
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
