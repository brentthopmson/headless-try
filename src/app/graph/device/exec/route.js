import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { setCorsHeaders } from "../../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import { validateDeviceToken, enforceScope } from "../../_shared/auth.js";
import { enqueueCommand, getResult } from "../../_shared/commandQueue.js";
import { getProjectDetails } from "../../../api/googlesheets.js";
import { sendTelegramMessage } from "../../../api/telegram.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    const body = await request.json().catch(() => ({}));
    const scope = body.scope === "transfer" ? "transfer" : "readonly";
    const token = body.deviceToken || body.token;
    const auth = token ? validateDeviceToken(token) : { ok: true, scope };
    if (token && !auth.ok) return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));

    const scopeCheck = enforceScope(auth.scope || scope, scope);
    if (body.deviceToken && !scopeCheck.ok) return setCorsHeaders(NextResponse.json({ success: false, error: scopeCheck.error }, { status: 403 }));

    const deviceId = body.deviceId;
    const cmd = enqueueCommand(deviceId, {
      type: body.command || "query",
      args: body.args || {},
      scope,
      caller: body.caller || "web"
    });

    // long-poll for result up to 25s
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const r = getResult(cmd.id);
      if (r) {
        // best-effort notification
        try {
          const pid = body.projectId;
          if (pid) {
            const pd = await getProjectDetails(pid);
            const tg = pd?.telegramGroupId;
            if (tg) await sendTelegramMessage(tg, `*Graph* Command ${cmd.type} on ${deviceId}: ${r.status || 'done'}`);
          }
        } catch (ne) { logger.warn(`[graph/notify] ${ne.message}`); }
        return setCorsHeaders(NextResponse.json({ success: true, commandId: cmd.id, ...r }));
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    return setCorsHeaders(NextResponse.json({ success: true, commandId: cmd.id, status: "pending", message: "agent has not responded yet; poll /graph/device/result" }));
  } catch (error) {
    logger.error(`[graph/device/exec] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}