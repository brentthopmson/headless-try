import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { setCorsHeaders } from '../../socials/_shared/routeHelper.js';
import { runSmartExtract } from '../engine.js';
import { updateSheetRowApi } from '../../api/googlesheets.js';

export async function handleEmailExtraction(body) {
    try {
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
