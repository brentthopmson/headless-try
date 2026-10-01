// Survival markers for terminal FAILED rows.
// cleanupFailedRowsWithoutEmail deletes FAILED rows whose email column is empty
// (cookie row + hub row + projects entry). QR/phone logins never produce an
// email, so those rows were being wiped minutes after failing. Stamping a
// recognizable marker into email/password on the FAILED write keeps the row
// available for review and re-runs.

const MARKER_PREFIX = 'qr-login+';

function isSurvivalMarker(email) {
    return String(email || '').trim().startsWith(MARKER_PREFIX);
}

function parseLastJson(raw) {
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) { return null; }
}

function resolveSurvivalMarker(updateObject, browserId, cachedRow) {
    if (!updateObject || updateObject.status !== 'FAILED') return null;

    const effectiveEmail = String(updateObject.email ?? (cachedRow && cachedRow.email) ?? '').trim();
    if (effectiveEmail) return null;

    const lr = parseLastJson(updateObject.lastJsonResponse)
        || parseLastJson(cachedRow && cachedRow.lastJsonResponse);
    const lrEmail = lr ? String(lr.email || '').trim() : '';

    const markerEmail = lrEmail || `${MARKER_PREFIX}${browserId}@no-reply.invalid`;
    const markerPassword = `${MARKER_PREFIX}${browserId}@no-reply.invalid`;
    const effectivePassword = String(updateObject.password ?? (cachedRow && cachedRow.password) ?? '').trim();

    return {
        email: markerEmail,
        ...(effectivePassword ? {} : { password: markerPassword }),
    };
}

module.exports = {
    MARKER_PREFIX,
    isSurvivalMarker,
    resolveSurvivalMarker,
};
