import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { setCorsHeaders } from "../../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import { validateDeviceToken } from "../../_shared/auth.js";
import { findGraphDevice, upsertGraphDevice } from "../../_shared/sheets.js";
import { dequeueCommands } from "../../_shared/commandQueue.js";

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    const body = await request.json().catch(() => ({}));
    const token = body.deviceToken || body.token;
    const auth = token ? validateDeviceToken(token) : { ok: true, deviceId: body.deviceId };
    if (token && !auth.ok) return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));

    const deviceId = body.deviceId || auth.deviceId;
    // heartbeat
    try { await upsertGraphDevice(deviceId, { lastSeenAt: new Date().toISOString(), status: body.status || "INDEXED" }); } catch (e) { logger.warn(e.message); }

    const commands = dequeueCommands(deviceId);
    return setCorsHeaders(NextResponse.json({ success: true, deviceId, commands, heartbeat: new Date().toISOString() }));
  } catch (error) {
    logger.error(`[graph/device/poll] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}