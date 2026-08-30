import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { extractFileId, parseCSV, stringifyCSV, getCampaignSettings, mergeTemplate } from "../_shared/pipelineUtils.js";
import { getDriveClient } from "../../../utils/multiServerDispatcher.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request) {
  try {
    await identifySelfFromHost(request.headers.get("host"));
    const body = await request.json();
    const { campaignId, fileUrl } = body;

    if (!campaignId || !fileUrl) {
      return NextResponse.json(
        { success: false, error: "Missing campaignId or fileUrl" },
        { status: 400 }
      );
    }

    const fileId = extractFileId(fileUrl);
    if (!fileId) {
      return NextResponse.json(
        { success: false, error: "Invalid fileUrl or Drive file ID" },
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

    const settings = campaignData.settings || {};
    const channel = settings.channel || "email";
    const subjectTemplate = settings.subject || "";
    const bodyTemplate = settings.body || "";
    const socialTemplate = settings.socialMessage || bodyTemplate;

    if (!subjectTemplate && !bodyTemplate && !socialTemplate) {
      logger.info(`[Mail Merge] No templates for campaign ${campaignId}, skipping`);
      return NextResponse.json({
        success: true,
        message: "No templates to merge",
        processed: 0,
      });
    }

    const drive = await getDriveClient();
    if (!drive) {
      return NextResponse.json(
        { success: false, error: "Failed to get Drive client" },
        { status: 500 }
      );
    }

    const driveFile = await drive.files.get({ fileId, alt: "media" });
    const csvContent = driveFile.data;
    if (typeof csvContent !== "string") {
      return NextResponse.json(
        { success: false, error: "CSV file is not text" },
        { status: 400 }
      );
    }

    const rows = parseCSV(csvContent);
    if (rows.length <= 1) {
      return NextResponse.json({
        success: true,
        message: "CSV has no data rows",
        processed: 0,
      });
    }

    const headers = rows[0];
    const enhancedSubjectIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsubject");
    const enhancedBodyIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedbody");
    const enhancedSocialMsgIdx = headers.findIndex(h => h.toLowerCase().trim() === "enhancedsocialmessage");

    let processed = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];

      if (channel === "email") {
        if (enhancedSubjectIdx !== -1 && subjectTemplate) {
          row[enhancedSubjectIdx] = mergeTemplate(subjectTemplate, row, headers);
        }
        if (enhancedBodyIdx !== -1 && bodyTemplate) {
          row[enhancedBodyIdx] = mergeTemplate(bodyTemplate, row, headers);
        }
      }

      if (channel === "social") {
        if (enhancedSocialMsgIdx !== -1 && socialTemplate) {
          row[enhancedSocialMsgIdx] = mergeTemplate(socialTemplate, row, headers);
        }
      }

      processed++;
    }

    await drive.files.update({
      fileId,
      media: { mimeType: "text/csv", body: stringifyCSV(rows) },
    });

    logger.info(`[Mail Merge] Campaign ${campaignId}: merged ${processed} rows (channel: ${channel})`);

    return NextResponse.json({
      success: true,
      message: `Mail merge completed for ${processed} rows`,
      processed,
      channel,
    });
  } catch (error) {
    logger.error(`[Mail Merge] Error: ${error.message}`, { stack: error.stack });
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
