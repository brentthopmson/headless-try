import logger from './logger.js';

// Share project rows across all route modules (engine, pooling-operator, api)
// even in Next.js dev mode where webpack may create separate module scopes.
// This is a read-only cache: rows are populated from successful projects-sheet
// reads and served on demand, so a quota failure never forces a re-read (and
// never drops the telegramGroupId needed for COMPLETED/FAILED notifications).
if (!globalThis.__projectCache) globalThis.__projectCache = new Map();
const projectCache = globalThis.__projectCache;

const PROJECT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Returns the cached row map for a projectId, with a `fresh` flag based on TTL.
 * @param {string} projectId
 * @returns {{ row: Object<string,string>, fresh: boolean } | null}
 */
export function getCachedProject(projectId) {
    const entry = projectCache.get(String(projectId).trim());
    if (!entry) return null;
    return {
        row: entry.row,
        fresh: Date.now() - entry.fetchedAt < PROJECT_CACHE_TTL_MS
    };
}

/**
 * Stores a full project row (header → value) in the cache. Never evicted on
 * read failure — a stale entry is always better than a null telegramGroupId.
 * @param {string} projectId
 * @param {Object<string, string>} rowMap
 */
export function setCachedProject(projectId, rowMap) {
    if (!rowMap || typeof rowMap !== 'object') return;
    projectCache.set(String(projectId).trim(), {
        row: { ...rowMap },
        fetchedAt: Date.now()
    });
}

/**
 * Removes a single project from the cache (e.g. after response-cell writes so
 * the next read sees the updated response).
 * @param {string} projectId
 */
export function invalidateCachedProject(projectId) {
    projectCache.delete(String(projectId).trim());
}

export function getProjectCacheStats() {
    return { size: projectCache.size };
}
