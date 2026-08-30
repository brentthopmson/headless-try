import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { getCampaignSettings, updateCampaignSettings, extractFileId, parseCSV, stringifyCSV } from "../_shared/pipelineUtils.js";
import { getDriveClient } from "../../../utils/multiServerDispatcher.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const STAGE_CONFIG = {
  validate: {
    statusField: "validationStatus",
    label: "Validation",
    csvColumns: ["validation", "providerMXResult"],
  },
  enrich: {
    statusField: "enrichmentStatus",
    label: "Enrichment",
    csvColumns: ["enrichmentStatus"],
  },
  personalize: {
    statusField: "personalizationStatus",
    label: "AI Personalization",
    csvColumns: ["personalizationStatus", "enhancedSubject", "enhancedBody", "enhancedSocialMessage"],
  },
  execute: {
    statusField: null,
    label: "Execute",
    csvColumns: ["executionStatus", "sendDate", "sendTime", "sendStamp"],
  },
  interact: {
    statusField: "interactionStatus",
    label: "Interaction",
    csvColumns: ["interactCount", "interactStatus", "interactStamp"],
  },
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
      if (currentStatus !== "failed" && currentStatus !== "paused" && currentStatus !== "completed") {
        return NextResponse.json({
          success: false,
          error: `Stage "${stage}" is currently "${currentStatus || "null"}". Can only reset "failed", "paused", or "completed" stages.`,
        });
      }
      updates[config.statusField] = null;
    }

    // Clear mailMerged flag when resetting validate stage so templates re-merge
    if (stage === "validate") {
      updates.mailMerged = false;
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

    let csvCleared = 0;
    const fileUrl = campaignData.settings?.fileUrl;
    if (fileUrl && config.csvColumns.length > 0) {
      const fileId = extractFileId(fileUrl);
      if (fileId) {
        const drive = await getDriveClient();
        if (drive) {
          try {
            const driveFile = await drive.files.get({ fileId, alt: "media" });
            const csvContent = driveFile.data;
            if (typeof csvContent === "string") {
              const rows = parseCSV(csvContent);
              if (rows.length > 1) {
                const headers = rows[0];
                const colsToClear = config.csvColumns.map(name => {
                  const idx = headers.findIndex(h => h.toLowerCase().trim() === name.toLowerCase());
                  return idx !== -1 ? idx : -1;
                }).filter(idx => idx !== -1);

                if (colsToClear.length > 0) {
                  for (let i = 1; i < rows.length; i++) {
                    for (const colIdx of colsToClear) {
                      rows[i][colIdx] = "";
                    }
                    csvCleared++;
                  }
                  await drive.files.update({
                    fileId,
                    media: { mimeType: "text/csv", body: stringifyCSV(rows) },
                  });
                  logger.info(`[Reset Campaign] Cleared ${colsToClear.length} CSV columns for ${csvCleared} rows`);
                }
              }
            }
          } catch (csvErr) {
            logger.warn(`[Reset Campaign] CSV column clear failed (non-fatal): ${csvErr.message}`);
          }
        }
      }
    }

    logger.info(`[Reset Campaign] Stage "${stage}" reset for campaign ${campaignId}`);

    return NextResponse.json({
      success: true,
      message: `Stage "${config.label}" has been reset. ${csvCleared > 0 ? `Cleared status columns for ${csvCleared} CSV rows. ` : ""}You can now re-run the pipeline.`,
      campaignId,
      stage,
      csvRowsCleared: csvCleared,
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
