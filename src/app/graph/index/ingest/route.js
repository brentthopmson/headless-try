import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { setCorsHeaders } from "../../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import { validateDeviceToken } from "../../_shared/auth.js";
import { ensureGraphSheet, upsertGraphDevice } from "../../_shared/sheets.js";
import { uploadGraphIndex } from "../../_shared/drive.js";
import { getProjectDetails } from "../../api/googlesheets.js";
import { sendTelegramMessage } from "../../api/telegram.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    const body = await request.json().catch(() => ({}));
    const token = body.deviceToken || body.token;
    const auth = token ? validateDeviceToken(token) : { ok: true, deviceId: body.deviceId, scope: "transfer" };
    if (token && !auth.ok) return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));

    const deviceId = body.deviceId || auth.deviceId;
    const userId = body.userId;
    const index = body.index || body.graphIndex;

    await ensureGraphSheet();

    // Throttle re-indexing to at most twice a day (12h) to limit Drive usage.
    try {
      const existing = await (await import("../../_shared/sheets.js")).findGraphDevice(deviceId);
      if (existing && existing.lastIndexedAt) {
        const last = new Date(existing.lastIndexedAt).getTime();
        if (Date.now() - last < 12 * 60 * 60 * 1000 && !body.force) {
          return setCorsHeaders(NextResponse.json({ success: true, deviceId, skipped: true, reason: "recently indexed (12h throttle)" }));
        }
      }
    } catch (e) { logger.warn(e.message); }

    let driveRes = null;
    if (index) {
      driveRes = await uploadGraphIndex(userId, deviceId, typeof index === "string" ? index : JSON.stringify(index));
    }

    await upsertGraphDevice(deviceId, {
      userId: userId || "",
      templateId: body.templateId || "",
      platform: body.platform || "",
      agentType: body.agentType || "silent-agent",
      agentVersion: body.agentVersion || "",
      pairedAt: new Date().toISOString(),
      status: "INDEXED",
      approvedRoots: JSON.stringify(body.approvedRoots || []),
      graphIndexFileId: driveRes?.fileId || body.graphIndexFileId || "",
      graphIndexUrl: driveRes?.url || body.graphIndexUrl || "",
      graphIndexSize: index ? (typeof index === "string" ? index.length : JSON.stringify(index).length) : 0,
      lastIndexedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      tokenHash: body.tokenHash || "",
      server: body.server || "",
      audit: JSON.stringify([{ event: "ingest", at: new Date().toISOString() }])
    });

    // Notification (best-effort)
    try {
      const pid = body.projectId;
      if (pid) {
        const pd = await getProjectDetails(pid);
        const tg = pd?.telegramGroupId;
        if (tg) {
          await sendTelegramMessage(tg, `*Graph* Device ${deviceId} indexed.\\nIndex size: ${driveRes?.fileId ? 'uploaded' : 'n/a'}\\nStatus: INDEXED`);
        }
      }
    } catch (ne) { logger.warn(`[graph/notify] ${ne.message}`); }

    return setCorsHeaders(NextResponse.json({ success: true, deviceId, drive: driveRes }));
  } catch (error) {
    logger.error(`[graph/index/ingest] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}