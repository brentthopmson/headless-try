import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { setCorsHeaders } from "../../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import { validateDeviceToken, enforceScope } from "../../_shared/auth.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    const body = await request.json().catch(() => ({}));
    const token = body.deviceToken || body.token;
    const auth = token ? validateDeviceToken(token) : { ok: true, scope: "transfer" };
    if (token && !auth.ok) return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));

    const scopeCheck = enforceScope(auth.scope, "transfer");
    if (!scopeCheck.ok) return setCorsHeaders(NextResponse.json({ success: false, error: scopeCheck.error }, { status: 403 }));

    // Chunked relay ack (skeleton). Real streaming handled by agent polling.
    return setCorsHeaders(NextResponse.json({ success: true, received: true, transferId: body.transferId, chunkIndex: body.chunkIndex ?? 0 }));
  } catch (error) {
    logger.error(`[graph/transfer/stream] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}