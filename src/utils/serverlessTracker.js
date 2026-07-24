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

export async function identifySelf() {
    const SELF_ID = process.env.SERVERLESS_ID;
    if (!SELF_ID) {
        logger.warn('[ServerlessTracker] SERVERLESS_ID not set. Self-identification disabled.');
        return null;
    }

    const { getSheetDataApi } = await import('../app/api/googlesheets.js');
    const links = await getSheetDataApi('links');

    if (!links.success || !links.data) {
        logger.error('[ServerlessTracker] Failed to read links sheet.');
        return null;
    }

    selfRow = links.data.find(r => r.severlessId === SELF_ID);

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

export function getSelfId() {
    return selfServerlessId;
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

        const rphLimit = parseInt(selfRow?.serverlessRph || '999');
        const rpdLimit = parseInt(selfRow?.serverlessRpd || '999999');
        let status = 'ACTIVE';
        if (currentRph > rphLimit || currentRpd > rpdLimit) status = 'RATE-LIMITED';

        await updateSheetRowApi('links', 'severlessId', selfServerlessId, {
            serverlessRphUsage: String(currentRph),
            serverlessRpdUsage: String(currentRpd),
            severlessStatus: status,
            severlessHistory: JSON.stringify(usageHistory),
        });

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
