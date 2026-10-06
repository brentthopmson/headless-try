// Pure helpers for the SETTINGS-sheet refresh-token source (CJS so the jest
// suite can require() it directly — same pattern as socials/_shared/
// limitsCore.js). No axios, no logger, no side effects.

const SETTINGS_SHEET_NAME = 'SETTINGS';
const SETTINGS_KEY = 'googleRefreshToken';

/**
 * Pulls the refresh token for SETTINGS_KEY out of a SETTINGS sheet dump.
 * @param {string[]} headers
 * @param {Array<Array<any>>} data
 * @returns {string|null} trimmed token, or null when row/column/empty
 */
function extractRefreshToken(headers, data) {
    if (!Array.isArray(headers) || !Array.isArray(data)) return null;
    const keyIdx = headers.indexOf('settingsKey');
    const valIdx = headers.indexOf('settingsValue1');
    if (keyIdx === -1 || valIdx === -1) return null;
    for (const row of data) {
        if (!row) continue;
        const key = row[keyIdx] == null ? '' : String(row[keyIdx]).trim();
        if (key === SETTINGS_KEY) {
            const value = row[valIdx] == null ? '' : String(row[valIdx]).trim();
            return value || null;
        }
    }
    return null;
}

/**
 * Optional expiry hint in settingsValue2 (`expires=<epoch-seconds>` or
 * `expires=<epoch-ms>`). Log-only — never blocks a rotation.
 * @param {string|null|undefined} value2
 * @returns {number|null} epoch milliseconds, or null when absent/unparseable
 */
function parseExpiryFromValue2(value2) {
    const match = /expires=(\d{9,13})/.exec(String(value2 || ''));
    if (!match) return null;
    const n = parseInt(match[1], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? n * 1000 : n; // seconds -> ms
}

/**
 * Source precedence — sheet row > last-known (stale) > env fallback.
 * Empty strings count as absent. Null only when every source is empty.
 * @returns {string|null}
 */
function chooseRefreshToken({ sheet = null, stale = null, env = null } = {}) {
    for (const candidate of [sheet, stale, env]) {
        const value = candidate == null ? '' : String(candidate).trim();
        if (value) return value;
    }
    return null;
}

module.exports = {
    SETTINGS_SHEET_NAME,
    SETTINGS_KEY,
    extractRefreshToken,
    parseExpiryFromValue2,
    chooseRefreshToken,
};
