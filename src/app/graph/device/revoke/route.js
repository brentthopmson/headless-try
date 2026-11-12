import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import { setCorsHeaders } from "../../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import { validateDeviceToken } from "../../_shared/auth.js";
import { markRevoked } from "../../_shared/sheets.js";
import { getSheetDataApi, updateSheetRowApi } from "../../../api/googlesheets.js";

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
    let projectId = body.projectId;
    if (!projectId) {
      try {
        const { findGraphDevice } = await import("../../_shared/sheets.js");
        const dev = await findGraphDevice(deviceId);
        if (dev) projectId = dev.projectId;
      } catch (e) { logger.warn(e.message); }
    }
    await markRevoked(deviceId);
    // best-effort project response update
    try {
      const pid = projectId;
      if (pid) {
        const projRes = await getSheetDataApi("projects");
        if (projRes && projRes.success) {
          const headers = projRes.headers;
          const pidIdx = headers.indexOf("projectId");
          const respIdx = headers.indexOf("response");
          const row = (projRes.data || []).find((r) => String(r[pidIdx]).trim() === String(pid).trim());
          if (row && respIdx !== -1) {
            let existing = [];
            try { existing = JSON.parse(row[respIdx] || "[]"); } catch { existing = []; }
            if (Array.isArray(existing)) {
              existing = existing.map((e) => (e && e.deviceId === deviceId) ? Object.assign({}, e, { status: "REVOKED" }) : e);
              await updateSheetRowApi("projects", "projectId", pid, { response: JSON.stringify(existing) });
            }
          }
        }
      }
    } catch (pe) { logger.warn(`[graph/project-revoke] ${pe.message}`); }
    return setCorsHeaders(NextResponse.json({ success: true, deviceId, status: "REVOKED" }));
  } catch (error) {
    logger.error(`[graph/device/revoke] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}