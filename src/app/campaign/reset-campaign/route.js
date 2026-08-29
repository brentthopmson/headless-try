import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignSettings, updateCampaignSettings } from "../_shared/pipelineUtils.js";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const STAGE_CONFIG = {
  validate: { statusField: "validationStatus", label: "Validation" },
  enrich: { statusField: "enrichmentStatus", label: "Enrichment" },
  personalize: { statusField: "personalizationStatus", label: "AI Personalization" },
  execute: { statusField: null, label: "Execute" },
  interact: { statusField: "interactionStatus", label: "Interaction" },
};

export async function POST(request) {
  try {
    await identifySelfFromHost(request.headers.get("host"));
    const body = await request.json();
    const { campaignId, stage } = body;

    if (!campaignId || !stage) {
      return NextResponse.json(
        { success: false, error: "Missing campaignId or stage" },
        { status: 400 }
      );
    }

    const config = STAGE_CONFIG[stage];
    if (!config) {
      return NextResponse.json(
        { success: false, error: `Unknown stage: ${stage}. Valid: ${Object.keys(STAGE_CONFIG).join(", ")}` },
        { status: 400 }
      );
    }

    const campaignData = await getCampaignSettings(campaignId);
    if (!campaignData) {
      return NextResponse.json(
        { success: false, error: "Campaign not found" },
        { status: 404 }
      );
    }

    const updates = {};

    if (config.statusField) {
      const currentStatus = campaignData.settings?.[config.statusField];
      if (currentStatus !== "failed" && currentStatus !== "paused") {
        return NextResponse.json({
          success: false,
          error: `Stage "${stage}" is currently "${currentStatus || "null"}". Can only reset "failed" or "paused" stages.`,
        });
      }
      updates[config.statusField] = null;
    }

    if (stage === "execute") {
      const campaignStatus = campaignData.status;
      if (campaignStatus !== "failed" && campaignStatus !== "paused") {
        return NextResponse.json({
          success: false,
          error: `Execute stage campaign status is "${campaignStatus}". Can only reset "failed" or "paused".`,
        });
      }
    }

    updates.serverAssignments = campaignData.settings?.serverAssignments || {};
    if (updates.serverAssignments[stage]) {
      delete updates.serverAssignments[stage];
    }

    await updateCampaignSettings(campaignId, updates);

    logger.info(`[Reset Campaign] Stage "${stage}" reset for campaign ${campaignId}`);

    return NextResponse.json({
      success: true,
      message: `Stage "${config.label}" has been reset. You can now re-run the pipeline.`,
      campaignId,
      stage,
    });
  } catch (error) {
    logger.error(`[Reset Campaign] Error: ${error.message}`, { stack: error.stack });
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
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
