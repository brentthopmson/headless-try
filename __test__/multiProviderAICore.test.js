// Regression tests for the MultiProviderAI retry decisions (pure logic — no
// network, no sheets, no logger). Guards two production bugs:
//   1. Gemini lite models answered 400 INVALID_ARGUMENT for
//      generationConfig.thinkingConfig → the row was recorded FAILED and
//      poisoned for 24h. Now the call is retried once with it stripped.
//   2. Google 503 "high demand" spikes outlasted a single 2s retry → the
//      whole waterfall gave up. Now 3 attempts with 2s/4s backoff.
const {
    TRANSIENT_MAX_ATTEMPTS,
    shouldRetryTransient,
    transientBackoffMs,
    shouldStripThinkingConfig,
    stripThinkingConfig,
} = require('../src/utils/multiProviderAICore.js');

describe('shouldStripThinkingConfig (Gemini 400 lite-model rejection)', () => {
    test('400 + thinkingConfig present → strip and retry', () => {
        expect(shouldStripThinkingConfig(400, { maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } })).toBe(true);
    });

    test('400 without thinkingConfig → rethrow (real bad request)', () => {
        expect(shouldStripThinkingConfig(400, { maxOutputTokens: 200 })).toBe(false);
        expect(shouldStripThinkingConfig(400, null)).toBe(false);
        expect(shouldStripThinkingConfig(400, undefined)).toBe(false);
    });

    test('non-400 status → never strip', () => {
        expect(shouldStripThinkingConfig(503, { thinkingConfig: { thinkingBudget: 0 } })).toBe(false);
        expect(shouldStripThinkingConfig(429, { thinkingConfig: { thinkingBudget: 0 } })).toBe(false);
        expect(shouldStripThinkingConfig(404, { thinkingConfig: { thinkingBudget: 0 } })).toBe(false);
        expect(shouldStripThinkingConfig(undefined, { thinkingConfig: { thinkingBudget: 0 } })).toBe(false);
    });

    test('thinkingConfig empty object still counts as present', () => {
        expect(shouldStripThinkingConfig(400, { thinkingConfig: {} })).toBe(true);
    });
});

describe('stripThinkingConfig', () => {
    test('removes only thinkingConfig, keeps the rest of generationConfig', () => {
        const gc = { maxOutputTokens: 200, temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } };
        stripThinkingConfig(gc);
        expect(gc).toEqual({ maxOutputTokens: 200, temperature: 0.7 });
        expect('thinkingConfig' in gc).toBe(false);
    });

    test('no-op when thinkingConfig absent', () => {
        const gc = { maxOutputTokens: 200 };
        expect(stripThinkingConfig(gc)).toEqual({ maxOutputTokens: 200 });
    });

    test('no-op on null/undefined', () => {
        expect(stripThinkingConfig(null)).toBeNull();
        expect(stripThinkingConfig(undefined)).toBeUndefined();
    });
});

describe('shouldRetryTransient (503 high-demand spikes)', () => {
    test('allows retries 1 and 2 of 3 total attempts', () => {
        expect(TRANSIENT_MAX_ATTEMPTS).toBe(3);
        expect(shouldRetryTransient(true, 0)).toBe(true);
        expect(shouldRetryTransient(true, 1)).toBe(true);
    });

    test('gives up after the final attempt', () => {
        expect(shouldRetryTransient(true, 2)).toBe(false);
        expect(shouldRetryTransient(true, 3)).toBe(false);
    });

    test('never retries a non-transient error (400/401/404/rate-limit)', () => {
        expect(shouldRetryTransient(false, 0)).toBe(false);
        expect(shouldRetryTransient(false, 1)).toBe(false);
    });

    test('respects a custom maxAttempts', () => {
        expect(shouldRetryTransient(true, 0, 1)).toBe(false);
        expect(shouldRetryTransient(true, 0, 2)).toBe(true);
        expect(shouldRetryTransient(true, 1, 2)).toBe(false);
    });
});

describe('transientBackoffMs (attempt → wait)', () => {
    test('first failure waits 2s, second waits 4s', () => {
        expect(transientBackoffMs(0)).toBe(0);
        expect(transientBackoffMs(1)).toBe(2000);
        expect(transientBackoffMs(2)).toBe(4000);
    });
});
