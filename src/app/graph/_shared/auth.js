import logger from "../../../utils/logger.js";

// Device-token validation + scope enforcement for Graph.
// No pairing session: identification happens via token/endpoint issued by
// the form-submission flow and carried into the agent.

export function validateDeviceToken(token) {
  if (!token || typeof token !== "string") {
    return { ok: false, error: "missing device token" };
  }
  // Token format: base64(payload).signature (issued by GAS form-submission flow).
  // Skeleton: accept any non-empty token and derive a deviceId from it.
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const parts = decoded.split(".");
    const payload = parts[0] || token;
    let parsed = {};
    try { parsed = JSON.parse(payload); } catch { parsed = { deviceId: payload }; }
    return { ok: true, deviceId: parsed.deviceId || parsed.id || token.slice(0, 16), scope: parsed.scope || "readonly", token };
  } catch (e) {
    logger.warn(`[graph/auth] token validation failed: ${e.message}`);
    return { ok: false, error: "invalid device token" };
  }
}

export function enforceScope(callerScope, requiredScope) {
  const order = { readonly: 1, transfer: 2 };
  const have = order[callerScope] || 0;
  const need = order[requiredScope] || 0;
  if (have < need) {
    return { ok: false, error: `scope ${requiredScope} required, caller has ${callerScope}` };
  }
  return { ok: true };
}

export function isLauncherToken(tokenPayload) {
  return !!(tokenPayload && tokenPayload.caller === "launcher");
}