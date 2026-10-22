import logger from '../../utils/logger.js';
import { updateSheetRowApi, ensureSheetColumns } from '../api/googlesheets.js';
import { createOrUpdateJsonFile } from '../api/googledrive.mjs';
import { checkActionAllowed, checkUserQuota } from '../socials/_shared/limits.js';
import { resolveAccountGate, accountGateError } from '../socials/_shared/accountGate.js';
import { getAccountUsage, updateAccountUsage, updateUserUsage } from '../socials/_shared/hubUpdater.js';
import { EXTRACT_COLUMN, HUB_SHEET, HUB_FOLDER_ID } from './shared/constants.js';
import { resolveSession } from './shared/session.js';
import {
    updateExtractStatus,
    extractionHasUpdates,
    compactExtractForCell,
    saveExtractViaAppScript,
    writeHubViaAppScript,
} from './shared/persistence.js';
import { extractWire } from './email/engine.js';
import { extractSocial } from './social/engine.js';
import { extractBank } from './bank/engine.js';

// Per-browserId in-flight guard so auto-extract and manual extract never race.
if (!globalThis.__extractInFlight) globalThis.__extractInFlight = new Set();
const getInFlight = () => globalThis.__extractInFlight;

export function isExtractInFlight(browserId) {
    return getInFlight().has(browserId);
}

export async function runSmartExtract(browserId, category, username, platform) {
    const cat = String(category || 'wire').toUpperCase();
    const key = cat === 'BANK' ? 'bank' : cat === 'SOCIAL' ? 'social' : 'wire';
    const column = EXTRACT_COLUMN[key];
    const inFlight = getInFlight();

    if (inFlight.has(browserId)) {
        throw new Error(`Extraction already in progress for browserId: ${browserId}`);
    }
    inFlight.add(browserId);
    logger.info(`[smartExtract] EXTRACT START browserId=${browserId} category=${cat} platform=${platform || 'auto'}`);
    const start = Date.now();

    try {
        await updateExtractStatus(browserId, 'started');
        const session = await resolveSession(browserId);

        // Limits gating BEFORE any browser launch:
        //  ACCOUNT tier — RATE_LIMITED/CANCELLED accounts never extract
        //    (RATE_LIMITED auto-recovers when platform windows have rolled);
        //  PLATFORM tier — per-platform 'extract' action column (0/missing = unlimited);
        //  USER tier — monthly extractionUsage budget (plan-row quota).
        const extractPlatform = String(platform || session.platform || session.domain || '').trim();
        const gateUserId = session.userId || null;
        if (extractPlatform) {
            const statusGate = await resolveAccountGate(browserId, extractPlatform);
            if (statusGate.blocked) throw accountGateError(browserId, statusGate);
            const usageData = await getAccountUsage(browserId);
            const extractCheck = await checkActionAllowed(extractPlatform, 'extract', (usageData && usageData.interactionUsage) || {});
            if (!extractCheck.allowed) {
                throw new Error(`Extraction limit reached (extract): ${extractCheck.reason}`);
            }
        }
        if (gateUserId) {
            const userQuota = await checkUserQuota(gateUserId, { keys: ["extractionUsage"] });
            if (!userQuota.allowed) {
                throw new Error(`Extraction blocked by user limits: ${userQuota.reason}`);
            }
        }

        let data;
        if (key === 'social') {
            await updateExtractStatus(browserId, 'extracting');
            data = await extractSocial(session, username || session.socialUsername || session.email, platform, browserId);
        } else if (key === 'bank') {
            await updateExtractStatus(browserId, 'extracting');
            data = await extractBank(session, platform, browserId);
        } else {
            data = await extractWire(session, browserId);
        }

        // Tier accounting: the run consumed a browser + platform resources
        // regardless of whether the payload had meaningful content.
        if (extractPlatform) {
            try { await updateAccountUsage(browserId, 'extract'); } catch (e) { logger.warn(`[smartExtract] extract usage increment failed: ${e.message}`); }
        }
        if (gateUserId) {
            try { await updateUserUsage(gateUserId, 'extractionUsage'); } catch (e) { logger.warn(`[smartExtract] user usage increment failed: ${e.message}`); }
        }

        // Guard: a run with NO meaningful content (dead session → sign-in
        // redirects, selectors missed everything) must never clobber a previous
        // good extract — retain the existing hub cell AND Drive JSON as-is.
        if (!extractionHasUpdates(data)) {
            logger.warn(`[smartExtract] No meaningful updates in ${column} for ${browserId} (empty or dead-session run) — retaining existing cell + Drive data`);
            await updateExtractStatus(browserId, 'completed-no-data');
            return { success: true, empty: true, retainedPrevious: true, category: cat, column };
        }

        await updateExtractStatus(browserId, 'saving');

        // Save full extract JSON to Google Drive folder: HUB_FOLDER_ID/browserId/(wire|social|bank)Extract.json
        let driveRef = null;
        try {
            const fileName = `${column}.json`;
            const driveResult = await createOrUpdateJsonFile(HUB_FOLDER_ID, browserId, fileName, data);
            if (driveResult.success) {
                driveRef = { fileId: driveResult.fileId, fileName };
                logger.info(`[smartExtract] Saved ${column} to Drive: ${driveResult.fileId}`);
            } else {
                logger.warn(`[smartExtract] Drive save failed: ${driveResult.error}, falling back to cell storage`);
            }
        } catch (e) {
            logger.warn(`[smartExtract] Drive save error: ${e.message}, falling back to cell storage`);
        }

        // Ensure the hub column exists before writing.
        await ensureSheetColumns(HUB_SHEET, ['submissionId', column, `${column}At`]);

        // Write to hub: if Drive save succeeded, store reference; otherwise store full JSON.
        // Sheets cells cap at 50k chars and large urlencoded App Script writes fail, so
        // oversized payloads go through the App Script Drive upload (its own auth) and
        // only a small reference cell is written.
        let cellValue = driveRef
            ? JSON.stringify({ ...driveRef, size: JSON.stringify(data).length })
            : JSON.stringify(data);

        if (!driveRef && cellValue.length > 36000) {
            const gasDrive = await saveExtractViaAppScript(browserId, column, data);
            if (gasDrive.success) {
                driveRef = { fileId: gasDrive.fileId, fileName: gasDrive.fileName };
                const refBase = { ...driveRef, size: gasDrive.size };
                const emails = (data.contacts || []).map(c => c && c.email).filter(Boolean);
                const minimalContacts = (data.contacts || []).map(c => ({ name: c.name, email: c.email, type: c.type, source: c.source }));
                // Tiered reference: full ref, then shed contacts, then emails, so the
                // cell itself always stays under the ~48KB transport cap no matter
                // how many contacts were extracted.
                cellValue = JSON.stringify({ ...refBase, emails, contacts: minimalContacts });
                if (cellValue.length > 36000) cellValue = JSON.stringify({ ...refBase, emails });
                if (cellValue.length > 36000) cellValue = JSON.stringify(refBase);
                logger.info(`[smartExtract] Saved ${column} to Drive via App Script: ${gasDrive.fileId} (cell ref ${cellValue.length} chars)`);
            } else {
                logger.warn(`[smartExtract] App Script Drive save failed: ${gasDrive.error}; writing compacted cell payload`);
                cellValue = compactExtractForCell(data);
            }
        }

        const hubWriteMap = {
            [column]: cellValue,
            [`${column}At`]: new Date().toISOString(),
        };

        let writeResult = await updateSheetRowApi(HUB_SHEET, 'submissionId', browserId, hubWriteMap);

        // App Script fallback when Sheets API fails (e.g. invalid_grant)
        if (!writeResult.success) {
            logger.warn(`[smartExtract] Sheets API hub write failed for ${browserId}: ${writeResult.error}. Trying App Script fallback.`);
            const asResult = await writeHubViaAppScript(browserId, hubWriteMap);
            if (!asResult.success) {
                logger.error(`[smartExtract] App Script hub write also failed for ${browserId}: ${asResult.error}`);
                throw new Error(`Failed to persist extract to hub: ${writeResult.error}`);
            }
            logger.info(`[smartExtract] Hub write succeeded via App Script fallback for ${browserId}`);
        }

        await updateExtractStatus(browserId, 'completed');
        logger.info(`[smartExtract] EXTRACT DONE browserId=${browserId} category=${cat} -> ${column} in ${Date.now() - start}ms`);
        return { success: true, category: cat, data, column };
    } catch (e) {
        await updateExtractStatus(browserId, 'failed').catch(() => {});
        logger.error(`[smartExtract] EXTRACT FAILED browserId=${browserId} category=${cat}: ${e.message}`);
        throw e;
    } finally {
        inFlight.delete(browserId);
    }
}
