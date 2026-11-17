import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { identifySelfFromHost } from "../../../utils/serverlessTracker.js";
import { extractFileId, parseCSV, stringifyCSV, getCampaignSettings, mergeTemplate, buildPersonalizedLink, ensureLinkColumn } from "../_shared/pipelineUtils.js";
import { applyRowStatuses } from "../_shared/campaignFields.js";
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

    const normKey = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // Append-only ensure: never inserts in the middle (would shift indices).
    const ensure = (name) => {
      const key = normKey(name);
      let i = headers.findIndex((h) => normKey(h) === key);
      if (i === -1) {
        headers.push(name);
        i = headers.length - 1;
        for (let r = 1; r < rows.length; r++) rows[r][i] = '';
      }
      return i;
    };

    // Every standard field is populated here — before any AI stage runs — so
    // the sheet always carries a usable fallback if AI cannot produce output.
    const plainSubjectIdx = channel === 'email' ? ensure('emailSubject') : -1;
    const plainBodyIdx = channel === 'email' ? ensure('emailBody') : -1;
    const plainSocialIdx = channel === 'social' ? ensure('socialMessage') : -1;

    // Personalized link: write a per-recipient `link` column BEFORE merging so
    // {{link}}/{{url}} in the body template resolves to that recipient's
    // unique targetLink?param=value URL (deterministic, never AI-written).
    // Written whenever a targetLink exists — not gated on personalizeLink.
    let linkIdx = -1;
    if (settings.targetLink) {
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

    // When AI personalization is staged for email, do NOT pre-fill enhancedSubject/enhancedBody
    // with template text: that would preempt the personalize stage (it skips rows that look
    // personalized) and mislead progress/UI. Personalize writes AI-generated content (or an
    // explicit fallback) and sets personalizationStatus; templates remain the fallback source.
    const aiPersonalizationStaged = settings.aiPersonalizationStaged === true;
    const writeTemplateEnhancedEmail = channel === "email" && !aiPersonalizationStaged;

    let processed = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (linkIdx !== -1) {
        row[linkIdx] = buildPersonalizedLink(settings, row, rows[0]);
      }
      if (helperIdx !== -1 && !String(row[helperIdx] || '').trim()) {
        row[helperIdx] = campaignHelperKeyword;
      }

      // Plain (fallback) content — always written at mail-merge time.
      if (plainSubjectIdx !== -1 && subjectTemplate) {
        row[plainSubjectIdx] = mergeTemplate(subjectTemplate, row, headers);
      }
      if (plainBodyIdx !== -1 && bodyTemplate) {
        row[plainBodyIdx] = mergeTemplate(bodyTemplate, row, headers);
      }
      if (plainSocialIdx !== -1 && socialTemplate) {
        row[plainSocialIdx] = mergeTemplate(socialTemplate, row, headers);
      }

      if (writeTemplateEnhancedEmail) {
        if (enhancedSubjectIdx !== -1 && subjectTemplate) {
          row[enhancedSubjectIdx] = mergeTemplate(subjectTemplate, row, headers);
        }
        if (enhancedBodyIdx !== -1 && bodyTemplate) {
          row[enhancedBodyIdx] = mergeTemplate(bodyTemplate, row, headers);
        }
      }

      if (channel === "social") {
        // Social execution/interactions do not run a separate AI-personalization stage; template merge is final.
        if (enhancedSocialMsgIdx !== -1 && socialTemplate) {
          row[enhancedSocialMsgIdx] = mergeTemplate(socialTemplate, row, headers);
        }
      }

      processed++;
    }

    // Centralized per-row status: derive the initial state from pre-AI columns.
    applyRowStatuses(rows);

    mlog.info(`Columns after merge-prep: [${rows[0].join(', ')}]`);
    mlog.info(`link column: ${linkIdx === -1 ? 'not requested' : 'computed per row'}; helper column: ${helperIdx === -1 ? 'not requested' : 'stamped per row'}; templateEnhancedEmail=${writeTemplateEnhancedEmail} (aiPersonalizationStaged=${aiPersonalizationStaged})`);

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
