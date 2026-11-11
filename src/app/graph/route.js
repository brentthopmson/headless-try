import { NextResponse } from "next/server";
import logger from "../../utils/logger.js";
import { setCorsHeaders } from "../socials/_shared/routeHelper.js";
import { requireFeature } from "../../utils/featureGate.js";
import { validateDeviceToken, enforceScope } from "./_shared/auth.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    let body;
    try { body = await request.json(); } catch (e) {
      return setCorsHeaders(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
    }

    const action = String(body?.action || "").trim().toLowerCase();
    // device token validation for protected actions
    const token = body?.deviceToken || body?.token;
    const auth = token ? validateDeviceToken(token) : { ok: true, scope: "readonly" };

    if (token && !auth.ok) {
      return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));
    }

    switch (action) {
      case "ingest":
      case "index.ingest":
        return setCorsHeaders(NextResponse.json({ success: true, routed: "index/ingest", note: "use /graph/index/ingest" }));
      case "query":
        if (!enforceScope(auth.scope, "readonly").ok) {
          return setCorsHeaders(NextResponse.json({ success: false, error: "insufficient scope" }, { status: 403 }));
        }
        return setCorsHeaders(NextResponse.json({ success: true, routed: "query", note: "use /graph/query" }));
      case "transfer.request":
        if (!enforceScope(auth.scope, "transfer").ok) {
          return setCorsHeaders(NextResponse.json({ success: false, error: "transfer scope required" }, { status: 403 }));
        }
        return setCorsHeaders(NextResponse.json({ success: true, routed: "transfer/request" }));
      case "device.poll":
        return setCorsHeaders(NextResponse.json({ success: true, routed: "device/poll" }));
      case "device.revoke":
        return setCorsHeaders(NextResponse.json({ success: true, routed: "device/revoke" }));
      case "device.exec":
        return setCorsHeaders(NextResponse.json({ success: true, routed: "device/exec" }));
      case "device.result":
        return setCorsHeaders(NextResponse.json({ success: true, routed: "device/result" }));
      default:
        return setCorsHeaders(NextResponse.json({ success: false, error: "unknown action", action }, { status: 400 }));
    }
  } catch (error) {
    logger.error(`[graph] Error: ${error.message}`);
    return setCorsHeaders(NextResponse.json({ error: error.message }, { status: 500 }));
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
}