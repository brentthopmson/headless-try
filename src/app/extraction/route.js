import { NextResponse } from "next/server";
import logger from "../../utils/logger.js";
import { setCorsHeaders } from "../socials/_shared/routeHelper.js";
import { requireFeature } from "../../utils/featureGate.js";
import { handleEmailExtraction } from "./email/handler.js";
import { handleSocialExtraction } from "./social/handler.js";
import { handleBankExtraction } from "./bank/handler.js";

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CHANNEL_ALIASES = {
    wire: "email",
    email: "email",
    emails: "email",
    mail: "email",
    social: "social",
    socials: "social",
    dm: "social",
    message: "social",
    bank: "bank",
    banks: "bank",
};

function inferChannel(body) {
    const explicit = String(body?.channel || body?.category || body?.domain || body?.type || "").trim().toLowerCase();
    if (explicit) return CHANNEL_ALIASES[explicit] || explicit;

    if (body?.action === "profile" || body?.action === "followers" || body?.username) return "social";
    return "";
}

export async function POST(request) {
    try {
        const gate = await requireFeature('allowExtraction', 'smart extraction');
        if (gate) return setCorsHeaders(gate);

        let body;
        try {
            body = await request.json();
        } catch (error) {
            return setCorsHeaders(NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }));
        }

        const channel = inferChannel(body);

        if (channel === "email") return handleEmailExtraction(body);
        if (channel === "social") return handleSocialExtraction(body);
        if (channel === "bank") return handleBankExtraction(body);

        return setCorsHeaders(NextResponse.json(
            { error: "Missing or unknown extraction channel" },
            { status: 400 }
        ));
    } catch (error) {
        logger.error(`[extraction] Error: ${error.message}`);
        return setCorsHeaders(NextResponse.json({ error: error.message }, { status: 500 }));
    }
}

export async function OPTIONS() {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
