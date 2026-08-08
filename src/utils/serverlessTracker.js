import logger from './logger.js';

let selfServerlessId = null;
let selfRow = null;
let currentRph = 0;
let currentRpd = 0;
let lastRphReset = Date.now();
let lastRpdReset = Date.now();
let usageHistory = [];
let usageDirty = false;
let usageSyncRunning = false;
let usageSyncTimer = null;
let autoDetectAttempted = false;

export async function identifySelf() {
    const SELF_ID = process.env.SERVERLESS_ID;
    if (!SELF_ID) {
        logger.warn('[ServerlessTracker] SERVERLESS_ID not set. Will auto-detect from first incoming request.');
        return null;
    }

    const { getSheetDataApi } = await import('../app/api/googlesheets.js');
    const links = await getSheetDataApi('links');

    if (!links.success || !links.data) {
        logger.error('[ServerlessTracker] Failed to read links sheet.');
        return null;
    }

    selfRow = links.data
        .map(row => Object.fromEntries(links.headers.map((h, i) => [h, row[i]])))
        .find(r => r.severlessId === SELF_ID);

    if (!selfRow) {
        logger.error(`[ServerlessTracker] No row found for severlessId=${SELF_ID}`);
        return null;
    }

    selfServerlessId = SELF_ID;
    currentRph = parseInt(selfRow.serverlessRphUsage || '0');
    currentRpd = parseInt(selfRow.serverlessRpdUsage || '0');
    usageHistory = JSON.parse(selfRow.severlessHistory || '[]');

    if (usageHistory.length > 0) {
        const last = usageHistory[usageHistory.length - 1];
        lastRphReset = new Date(last.timestamp).getTime();
        lastRpdReset = new Date(last.timestamp).getTime();
    }

    logger.info(`[ServerlessTracker] Identified self: ${selfServerlessId} (${selfRow.severlessURL})`);
    return selfRow;
}

export async function identifySelfFromHost(hostHeader) {
    if (selfServerlessId) return selfRow;
    if (autoDetectAttempted) return selfRow;
    autoDetectAttempted = true;

    if (!hostHeader) {
        logger.warn('[ServerlessTracker] No Host header provided for auto-detection.');
        return null;
    }

    const { getSheetDataApi } = await import('../app/api/googlesheets.js');
    const links = await getSheetDataApi('links');

    if (!links.success || !links.data) {
        logger.error('[ServerlessTracker] Failed to read links sheet for auto-detection.');
        return null;
    }

    const rows = links.data.map(row => Object.fromEntries(links.headers.map((h, i) => [h, row[i]])));
    const requestHost = hostHeader.split(':')[0].toLowerCase();
    const requestPort = hostHeader.includes(':') ? hostHeader.split(':')[1] : null;

    for (const row of rows) {
        if (!row.severlessURL) continue;
        const url = row.severlessURL.replace(/\/+$/, '').toLowerCase();
        const urlHost = new URL(url).hostname;
        if (urlHost === requestHost) {
            selfServerlessId = row.severlessId;
            selfRow = row;
            currentRph = parseInt(row.serverlessRphUsage || '0');
            currentRpd = parseInt(row.serverlessRpdUsage || '0');
            usageHistory = JSON.parse(row.severlessHistory || '[]');
            if (usageHistory.length > 0) {
                const last = usageHistory[usageHistory.length - 1];
                lastRphReset = new Date(last.timestamp).getTime();
                lastRpdReset = new Date(last.timestamp).getTime();
            }
            logger.info(`[ServerlessTracker] Auto-identified self: ${selfServerlessId} (${url}) via Host header`);
            return selfRow;
        }
    }

    logger.info('[ServerlessTracker] Host header did not match any registered server. Running in local/dev mode — will process all rows.');
    return null;
}

export function getSelfId() {
    return selfServerlessId;
}

export function getSelfUrl() {
    const url = selfRow?.severlessURL;
    return url ? url.replace(/\/+$/, '') : null;
}

/**
 * Re-reads our own row from the links sheet so URL / limits / status edits
 * made by the operator take effect WITHOUT a server restart. Called lazily:
 * first resolution on the next call, then again only when the sheet timestamp
 * or a secondary hint indicates the row changed.
 */
export async function refreshSelfRow() {
    if (!selfServerlessId) return selfRow;

    try {
        const { getSheetDataApi } = await import('../app/api/googlesheets.js');
        const links = await getSheetDataApi('links');
        if (!links?.success || !links.data || !links.headers) return selfRow;

        const idIdx = links.headers.indexOf('severlessId');
        if (idIdx === -1) return selfRow;

        const fresh = links.data
            .map(row => Object.fromEntries(links.headers.map((h, i) => [h, row[i]])))
            .find(r => r.severlessId === selfServerlessId);

        if (!fresh) {
            logger.warn(`[ServerlessTracker] refreshSelfRow: no row found for ${selfServerlessId} — keeping last known.`);
            return selfRow;
        }

        const changed = JSON.stringify(selfRow) !== JSON.stringify(fresh);
        selfRow = fresh;
        if (changed) {
            logger.info(`[ServerlessTracker] Self row refreshed: ${selfServerlessId} (${selfRow.severlessURL})`);
        }
    } catch (e) {
        logger.error(`[ServerlessRefresh] Failed to refresh self row: ${e.message}`);
    }

    return selfRow;
}

export function incrementUsage() {
    if (!selfServerlessId) return;

    const now = Date.now();

    if (now - lastRphReset > 3600000) {
        currentRph = 0;
        lastRphReset = now;
    }

    if (now - lastRpdReset > 86400000) {
        currentRpd = 0;
        lastRpdReset = now;
    }

    currentRph++;
    currentRpd++;

    usageHistory.push({
        timestamp: new Date().toISOString(),
        rph: currentRph,
        rpd: currentRpd
    });
    if (usageHistory.length > 24) usageHistory.shift();

    usageDirty = true;
    startUsageSyncIfNeeded();
}

export function getUsage() {
    return { rph: currentRph, rpd: currentRpd, history: usageHistory };
}

function startUsageSyncIfNeeded() {
    if (usageSyncRunning || !usageDirty) return;
    usageSyncRunning = true;
    logger.info('[ServerlessTracker] Starting usage sync.');
    usageSyncTimer = setInterval(flushUsageToSheet, 60000);
    flushUsageToSheet();
}

async function flushUsageToSheet() {
    if (!usageDirty || !selfServerlessId) {
        clearInterval(usageSyncTimer);
        usageSyncTimer = null;
        usageSyncRunning = false;
        return;
    }

    try {
        const { updateSheetRowApi } = await import('../app/api/googlesheets.js');

        const updates = {
            serverlessRpdUsage: String(currentRpd),
            serverlessRphUsage: String(currentRph),
            severlessHistory: JSON.stringify(usageHistory),
        };

        const rphLimit = parseInt(selfRow?.serverlessRph || '999');
        const rpdLimit = parseInt(selfRow?.serverlessRpd || '999999');
        const overLimit = currentRph > rphLimit || currentRpd > rpdLimit;

        // severlessStatus is 100% operator-controlled. The engine may only self-manage
        // into RATE-LIMITED when over budget, and must never resurrect a row the operator
        // marked FAILED (or any other manual status) back to ACTIVE.
        if (overLimit) {
            // Pull fresh status first so a rate-limit write respects a manual FAILED.
            await refreshSelfRow();
            const currentStatus = String(selfRow?.severlessStatus || '').trim().toUpperCase();
            if (currentStatus === 'FAILED') {
                logger.info('[ServerlessTracker] Row is operator-marked FAILED — preserving status, not downgrading to RATE-LIMITED.');
            } else {
                updates.severlessStatus = 'RATE-LIMITED';
            }
        }

        await updateSheetRowApi('links', 'severlessId', selfServerlessId, updates);

        usageDirty = false;

        if (!usageDirty) {
            clearInterval(usageSyncTimer);
            usageSyncTimer = null;
            usageSyncRunning = false;
            logger.info('[ServerlessTracker] Usage sync stopped — clean.');
        }
    } catch (e) {
        logger.error(`[ServerlessTracker] Failed to sync usage: ${e.message}`);
    }
}
