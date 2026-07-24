import logger from './logger.js';

const cookieCache = new Map();
const pendingSync = new Map();
let syncRunning = false;
let syncTimer = null;

const ACTIVE_STATUSES = new Set([
    'WAITING', 'WAITINGEMAIL', 'WAITINGPASSWORD', 'WAITINGPASSWORDERROR',
    'WAITINGOPTIONS', 'WAITINGCODE', 'WAITINGRECOVERYEMAIL', 'WAITINGCAPTCHA',
    'PROCESSING'
]);

export function getCachedRow(browserId) {
    return cookieCache.get(browserId) || null;
}

export function setCachedRow(browserId, updates) {
    const existing = cookieCache.get(browserId) || {};
    const merged = { ...existing, ...updates };

    if (!ACTIVE_STATUSES.has(merged.status)) {
        evictRow(browserId);
        pendingSync.set(browserId, merged);
        startSyncIfNeeded();
        return;
    }

    cookieCache.set(browserId, merged);
    pendingSync.set(browserId, merged);
    startSyncIfNeeded();
}

export function populateCache(browserId, fullRow) {
    if (ACTIVE_STATUSES.has(fullRow.status)) {
        cookieCache.set(browserId, fullRow);
    }
}

export function evictRow(browserId) {
    cookieCache.delete(browserId);
}

export function getCacheSize() {
    return cookieCache.size;
}

export function getPendingSyncSize() {
    return pendingSync.size;
}

function startSyncIfNeeded() {
    if (syncRunning || pendingSync.size === 0) return;
    syncRunning = true;
    logger.info(`[CookieCache] Starting sync. ${pendingSync.size} dirty rows.`);
    syncTimer = setInterval(flushToSheets, 5000);
}

async function flushToSheets() {
    if (pendingSync.size === 0) {
        clearInterval(syncTimer);
        syncTimer = null;
        syncRunning = false;
        logger.info('[CookieCache] Sync stopped — no dirty rows.');
        return;
    }

    const { updateSheetRowApi } = await import('../app/api/googlesheets.js');

    for (const [browserId, rowData] of pendingSync) {
        try {
            await updateSheetRowApi('cookie', 'browserId', browserId, rowData);
            pendingSync.delete(browserId);
            if (!ACTIVE_STATUSES.has(rowData.status)) {
                cookieCache.delete(browserId);
            }
        } catch (e) {
            logger.error(`[CookieCache] Failed to sync ${browserId}: ${e.message}`);
        }
    }

    if (pendingSync.size === 0) {
        clearInterval(syncTimer);
        syncTimer = null;
        syncRunning = false;
        logger.info('[CookieCache] Sync stopped — all rows flushed.');
    }
}
