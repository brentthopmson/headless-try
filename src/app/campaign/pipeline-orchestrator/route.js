import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { getSetting } from "../../../utils/settingsCache.js";
import { getSelfUrl, identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignSettings, updateCampaignSettings, isCampaignPaused } from "../_shared/pipelineUtils.js";

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

async function triggerStage(campaignId, stage, settings) {
  const config = STAGE_CONFIG[stage];
  const selfUrl = getSelfUrl();
  const url = `${selfUrl}${config.route}`;

  const body = { campaignId };

  if (stage !== "execute") {
    const fileUrl = settings.fileUrl;
    if (!fileUrl) {
      logger.warn(`[Pipeline Orchestrator] No fileUrl for stage ${stage}`);
      return null;
    }
    body.fileUrl = fileUrl;
  }

  logger.info(`[Pipeline Orchestrator] Triggering ${config.label} for campaign ${campaignId}`);

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
    logger.info(`[Pipeline Orchestrator] ${config.label} response: ${JSON.stringify(result).slice(0, 500)}`);
    return result;
  } catch (err) {
    logger.error(`[Pipeline Orchestrator] ${config.label} failed: ${err.message}`);
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

    const campaignData = await getCampaignSettings(campaignId);
    if (!campaignData) {
      return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
    }

    const { settings } = campaignData;
    settings._campaignStatus = campaignData.status;

    if (await isCampaignPaused(campaignId)) {
      logger.info(`[Pipeline Orchestrator] Campaign ${campaignId} is paused, skipping`);
      return NextResponse.json({ success: true, message: "Campaign is paused", paused: true });
    }

    const resolution = resolveCurrentStage(settings);

    if (!resolution) {
      logger.info(`[Pipeline Orchestrator] Campaign ${campaignId} — all enabled stages complete`);
      return NextResponse.json({
        success: true,
        message: "All enabled pipeline stages are complete",
        completed: true,
      });
    }

    const { stage, action } = resolution;
    const config = STAGE_CONFIG[stage];

    if (action === "fail") {
      logger.warn(`[Pipeline Orchestrator] Campaign ${campaignId} — stage ${config.label} has failed`);
      return NextResponse.json({
        success: false,
        message: `Pipeline stopped: ${config.label} stage failed`,
        failedStage: stage,
      });
    }

    if (action === "wait") {
      logger.info(`[Pipeline Orchestrator] Campaign ${campaignId} — waiting for ${config.label} to complete`);
      return NextResponse.json({
        success: true,
        message: `Waiting for ${config.label} to complete`,
        waitingStage: stage,
      });
    }

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
        logger.info(`[Pipeline Orchestrator] Auto-advancing to ${nextConfig.label}`);
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

  } catch (error) {
    logger.error(`[Pipeline Orchestrator] Error: ${error.message}`, { stack: error.stack });
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
