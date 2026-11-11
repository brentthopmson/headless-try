import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { setCorsHeaders } from "../../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import { validateDeviceToken } from "../../_shared/auth.js";
import { storeResult, getResult } from "../../_shared/commandQueue.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    const body = await request.json().catch(() => ({}));
    // agent posts result
    if (body.commandId && (body.result !== undefined || body.error)) {
      const token = body.deviceToken || body.token;
      const auth = token ? validateDeviceToken(token) : { ok: true };
      if (token && !auth.ok) return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));
      storeResult(body.commandId, { result: body.result, error: body.error, status: body.error ? "failed" : "completed" });
      return setCorsHeaders(NextResponse.json({ success: true, commandId: body.commandId }));
    }
    // caller retrieves result
    if (body.commandId && body.get) {
      const r = getResult(body.commandId);
      return setCorsHeaders(NextResponse.json({ success: true, commandId: body.commandId, ...(r || { status: "pending" }) }));
    }
    return setCorsHeaders(NextResponse.json({ success: false, error: "invalid request" }, { status: 400 }));
  } catch (error) {
    logger.error(`[graph/device/result] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}