import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import { updateSheetRowApi, ensureSheetColumns } from '../../api/googlesheets.js';

export const maxDuration = 30;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const HUB_SHEET = 'hub';

export async function POST(request) {
    try {
        const body = await request.json();
        const { browserId, memo } = body;

        logger.info(`[save-memo] browserId=${browserId}`);

        if (!browserId) {
            return NextResponse.json({ error: "Missing required field: browserId" }, { status: 400 });
        }

        const memoText = typeof memo === 'string' ? memo : JSON.stringify(memo || '');

        await ensureSheetColumns(HUB_SHEET, ['memo']);
        const result = await updateSheetRowApi(HUB_SHEET, 'submissionId', browserId, { memo: memoText });

        if (!result.success) {
            logger.error(`[save-memo] Hub write failed: ${result.error}`);
            return NextResponse.json({ error: result.error }, { status: 500 });
        }

        return NextResponse.json({ success: true, memo: memoText });
    } catch (e) {
        logger.error(`[save-memo] Error: ${e.message}`);
        return NextResponse.json({ error: e.message }, { status: 500 });
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
