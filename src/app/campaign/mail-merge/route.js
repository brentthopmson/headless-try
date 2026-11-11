import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { extractFileId, parseCSV, stringifyCSV, getCampaignSettings, mergeTemplate, buildPersonalizedLink, ensureLinkColumn } from "../_shared/pipelineUtils.js";
import { downloadCsvText, uploadCsvText } from "../../api/googlesheets.js";

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
    const mlog = logger.child({ campaignId, stage: "mail-merge" });
    mlog.info(`Mail-merge start (channel=${channel}, subject=${subjectTemplate ? 'yes' : 'no'}, body=${bodyTemplate ? 'yes' : 'no'}, personalizeLink=${!!settings.personalizeLink}, helperKeyword=${settings.helperKeyword ? 'yes' : 'no'})`);

    if (!subjectTemplate && !bodyTemplate && !socialTemplate) {
      logger.info(`[Mail Merge] No templates for campaign ${campaignId} — skipping merge (link/helper still computed below)`);
    }

    const dl = await downloadCsvText(fileId);
    if (!dl.success) {
      return NextResponse.json(
        { success: false, error: `Failed to download CSV: ${dl.error}` },
        { status: 500 }
      );
    }
    const csvContent = dl.content;

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

    // Personalized link: write a per-recipient `link` column BEFORE merging so
    // {{link}}/{{url}} in the body template resolves to that recipient's
    // unique targetLink?param=value URL (deterministic, never AI-written).
    let linkIdx = -1;
    if (settings.personalizeLink && settings.targetLink) {
      linkIdx = ensureLinkColumn(rows);
    }

    // Helper keyword stamping: one campaign-level keyword onto every row
    // (HELPERKEYWORD column) so interactions can detect our emails.
    let helperIdx = -1;
    const campaignHelperKeyword = String(settings.helperKeyword || '').trim();
    if (campaignHelperKeyword) {
      helperIdx = rows[0].findIndex(h => String(h).trim().toUpperCase() === 'HELPERKEYWORD');
      if (helperIdx === -1) {
        rows[0].push('HELPERKEYWORD');
        helperIdx = rows[0].length - 1;
      }
    }

    let processed = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (linkIdx !== -1) {
        row[linkIdx] = buildPersonalizedLink(settings, row, rows[0]);
      }
      if (helperIdx !== -1 && !String(row[helperIdx] || '').trim()) {
        row[helperIdx] = campaignHelperKeyword;
      }

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

    mlog.info(`Columns after merge-prep: [${rows[0].join(', ')}]`);
    mlog.info(`link column: ${linkIdx === -1 ? 'not requested' : 'computed per row'}; helper column: ${helperIdx === -1 ? 'not requested' : 'stamped per row'}`);

    await uploadCsvText(fileId, stringifyCSV(rows));

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
