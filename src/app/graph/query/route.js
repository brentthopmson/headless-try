import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { setCorsHeaders } from "../../socials/_shared/routeHelper.js";
import { requireFeature } from "../../../utils/featureGate.js";
import { validateDeviceToken, enforceScope } from "../_shared/auth.js";
import { findGraphDevice } from "../_shared/sheets.js";
import { downloadGraphIndex } from "../_shared/drive.js";

export const maxDuration = 120;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  try {
    const gate = await requireFeature('allowGraph', 'graph');
    if (gate) return setCorsHeaders(gate);

    const body = await request.json().catch(() => ({}));
    const token = body.deviceToken || body.token;
    const auth = token ? validateDeviceToken(token) : { ok: true, scope: "readonly" };
    if (token && !auth.ok) return setCorsHeaders(NextResponse.json({ success: false, error: auth.error }, { status: 401 }));

    const scopeCheck = enforceScope(auth.scope, "readonly");
    if (!scopeCheck.ok) return setCorsHeaders(NextResponse.json({ success: false, error: scopeCheck.error }, { status: 403 }));

    const deviceId = body.deviceId;
    const device = await findGraphDevice(deviceId);
    if (!device) return setCorsHeaders(NextResponse.json({ success: false, error: "device not found" }, { status: 404 }));

    // readonly: return metadata/previews only, no file bytes
    let index = null;
    if (device.graphIndexFileId) {
      const dl = await downloadGraphIndex(device.graphIndexFileId);
      if (dl.success) index = dl.content;
    }

    const q = (body.query || "").toLowerCase();
    const results = [];
    if (index) {
      const items = Array.isArray(index) ? index : (index.items || index.files || []);
      for (const it of items) {
        const name = String(it.name || it.path || "").toLowerCase();
        if (!q || name.includes(q)) {
          results.push({ path: it.path || it.name, name: it.name, size: it.size, mtime: it.mtime, mime: it.mime });
        }
      }
    }

    // size-cap previews
    const previewCap = 4096;
    const previews = results.slice(0, 50).map((r) => ({ ...r, preview: null }));

    return setCorsHeaders(NextResponse.json({ success: true, deviceId, scope: "readonly", count: results.length, results: previews, cap: previewCap }));
  } catch (error) {
    logger.error(`[graph/query] ${error.message}`);
    return setCorsHeaders(NextResponse.json({ success: false, error: error.message }, { status: 500 }));
  }
}