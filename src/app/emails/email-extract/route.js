import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { setCorsHeaders } from '../../socials/_shared/routeHelper.js';
import { runSmartExtract } from '../../../utils/smartExtract.js';

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

export async function POST(request) {
    try {
        const body = await request.json();
        const { browserId, cookies, platform, category } = body;

        logger.info(`[email-extract] browserId=${browserId} platform=${platform} category=${category}`);

        if (!browserId && !cookies) {
            return setCorsHeaders(NextResponse.json({ error: "Missing required fields: browserId (or cookies + platform)" }, { status: 400 }));
        }

        const result = await runSmartExtract(browserId, category || 'WIRE');

        return setCorsHeaders(NextResponse.json({
            success: true,
            platform: result.data.platform || platform,
            category: result.category,
            data: result.data,
        }));

    } catch (e) {
        logger.error(`[email-extract] Error: ${e.message}`);
        return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
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
