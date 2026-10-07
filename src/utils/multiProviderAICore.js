// Pure decision helpers for MultiProviderAI (no axios, no logger, no side
// effects) so jest can require them directly — same pattern as
// googleTokenSourceCore.js / limitsCore.js.

// 503 "high demand" spikes from Gemini regularly outlast a single 2s retry.
// 3 total attempts → backoff 2s (attempt 1), then 4s (attempt 2).
const TRANSIENT_MAX_ATTEMPTS = 3;

/**
 * Whether another attempt is allowed after a transient (5xx/timeout) failure.
 * Non-transient errors never retry here — they go straight to status recording.
 * @param {boolean} isTransient
 * @param {number} attempt - 0-based attempt that just failed
 * @param {number} [maxAttempts]
 * @returns {boolean}
 */
function shouldRetryTransient(isTransient, attempt, maxAttempts = TRANSIENT_MAX_ATTEMPTS) {
    return isTransient && attempt < maxAttempts - 1;
}

/**
 * Backoff before the next attempt. attempt 0 → 0ms (first try), 1 → 2000ms, 2 → 4000ms.
 * @param {number} attempt - 0-based attempt that just failed
 * @returns {number} milliseconds to wait
 */
function transientBackoffMs(attempt) {
    return 2000 * attempt;
}

/**
 * Gemini lite models (gemini-3.5-flash-lite, flash-lite-latest) reject
 * generationConfig.thinkingConfig with 400 INVALID_ARGUMENT — which is a
 * NON-recoverable status that would poison the sheet row FAILED for 24h.
 * When the request carried thinkingConfig and came back 400, retry once
 * with the config stripped instead of recording a hard failure.
 * @param {number} status - HTTP status of the failed request
 * @param {{thinkingConfig?: object}|null} generationConfig
 * @returns {boolean}
 */
function shouldStripThinkingConfig(status, generationConfig) {
    return status === 400 && !!(generationConfig && generationConfig.thinkingConfig);
}

/**
 * Removes thinkingConfig from generationConfig in place.
 * @param {object} generationConfig
 * @returns {object} the same object (for chaining/asserts)
 */
function stripThinkingConfig(generationConfig) {
    if (generationConfig && generationConfig.thinkingConfig) {
        delete generationConfig.thinkingConfig;
    }
    return generationConfig;
}

module.exports = {
    TRANSIENT_MAX_ATTEMPTS,
    shouldRetryTransient,
    transientBackoffMs,
    shouldStripThinkingConfig,
    stripThinkingConfig,
};
