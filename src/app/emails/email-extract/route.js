import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { setCorsHeaders } from '../../socials/_shared/routeHelper.js';
import { runSmartExtract } from '../../../utils/smartExtract.js';
import { requireFeature } from '../../../utils/featureGate.js';
import { updateSheetRowApi } from '../../api/googlesheets.js';

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

export async function POST(request) {
    try {
        const gate = await requireFeature('allowExtraction', 'smart extraction');
        if (gate) return gate;
        const body = await request.json();
        const { browserId, cookies, platform, category } = body;

        logger.info(`[email-extract] browserId=${browserId} platform=${platform} category=${category}`);

        if (!browserId && !cookies) {
            return setCorsHeaders(NextResponse.json({ error: "Missing required fields: browserId (or cookies + platform)" }, { status: 400 }));
        }

        // Mark extraction as started in the HUB sheet
        try {
            await updateSheetRowApi('hub', 'submissionId', browserId, {
                extractStatus: 'started',
                extractStatusAt: new Date().toISOString(),
            });
        } catch (e) {
            logger.warn(`[email-extract] initial status update failed: ${e.message}`);
        }

        // Fire-and-forget: extraction runs in background
        setTimeout(() => {
            runSmartExtract(browserId, category || 'WIRE').catch(e => {
                logger.error(`[email-extract] background extraction failed: ${e.message}`);
            });
        }, 0);

        // Return immediately — frontend polls for extractStatus
        return setCorsHeaders(NextResponse.json({
            success: true,
            status: 'started',
            browserId,
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
