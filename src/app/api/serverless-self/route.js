import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import {
    identifySelf,
    identifySelfFromHost,
    getSelfId,
    getSelfUrl,
} from "../../../utils/serverlessTracker.js";

export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

// Guard so a failing env identification doesn't re-read the sheet every call.
let envIdentifyAttempted = false;

/**
 * Prod severlessId assertion (Phase 4).
 *
 * Compares three sources of truth and reports PASS/FAIL:
 *   1. SERVERLESS_ID env var on this deployment
 *   2. links-sheet row resolved from the request Host (identifySelfFromHost)
 *   3. the row's severlessURL host vs the Host that actually served this request
 *
 * GAS picks an engine by severlessURL from the links sheet — if any of these
 * disagree, dispatch lands on a different machine than the sheet thinks it did
 * (stale row, wrong env, domain moved). GET /api/serverless-self:
 *   - 200 → assertion passed
 *   - 409 → mismatch (body.checks names the failing dimension)
 *   - local/dev (no matching row) → 409 with hostMatchedLinksRow=false
 */
export async function GET(request) {
    const hostHeader = request.headers.get('host') || '';
    const forwardedHost = request.headers.get('x-forwarded-host') || '';
    // Proxies (Vercel, devtunnels) may rewrite Host to the upstream address —
    // prefer the public host the client actually used.
    const effectiveHost = (forwardedHost || hostHeader).split(',')[0].trim();
    const requestHost = effectiveHost.split(':')[0].toLowerCase();

    let row = null;
    let rowError = null;
    try {
        // Env-based first: SERVERLESS_ID → links row works even when a proxy
        // rewrites Host. Host detection as fallback for auto-detect mode; when
        // already identified both calls return the cached row (no sheet read).
        if (!getSelfId() && !envIdentifyAttempted) {
            envIdentifyAttempted = true;
            await identifySelf();
        }
        row = await identifySelfFromHost(requestHost);
    } catch (e) {
        rowError = e.message;
        logger.error(`[ServerlessSelf] self identification failed: ${e.message}`);
    }

    const envId = process.env.SERVERLESS_ID || null;
    const resolvedId = getSelfId() || null;
    const selfUrl = getSelfUrl();

    let rowUrlHost = null;
    try {
        rowUrlHost = selfUrl ? new URL(selfUrl).hostname.toLowerCase() : null;
    } catch (e) {
        rowUrlHost = null;
    }

    const checks = {
        // Public host matched a links-sheet row (false on local/dev).
        hostMatchedLinksRow: !!row,
        // Env SERVERLESS_ID equals the row the host resolved to (null = not comparable).
        envMatchesResolved: (envId && resolvedId) ? (envId === resolvedId) : null,
        // The row's severlessURL points back at the host serving this request.
        rowUrlHostMatchesRequest: rowUrlHost ? (rowUrlHost === requestHost) : null,
    };

    const pass = checks.hostMatchedLinksRow
        && checks.envMatchesResolved !== false
        && checks.rowUrlHostMatchesRequest !== false;

    const payload = {
        pass,
        severlessId: resolvedId || envId,
        envId,
        resolvedId,
        selfUrl,
        host: effectiveHost,
        hostHeader,
        forwardedHost,
        rowUrlHost,
        checks,
        rowError,
        timestamp: new Date().toISOString(),
    };

    logger.info(`[ServerlessSelf] assertion ${pass ? 'PASS' : 'FAIL'} host=${effectiveHost} env=${envId} resolved=${resolvedId} checks=${JSON.stringify(checks)}`);

    return NextResponse.json(payload, { status: pass ? 200 : 409 });
}
