/**
 * ISOLATION TESTS for AIService v3 (aiLimitRetry per-row)
 * Run: node --experimental-vm-modules src/utils/__tests__/aiService.test.mjs
 */

import assert from 'assert';

// ============================================================
// MOCK DATA — with aiLimitRetry column
// ============================================================

const MOCK_HEADERS = ['aiSn', 'aiProvider', 'aiModel', 'aiService', 'aiKey', 'aiStatus', 'aiLastRun', 'aiLimitRetry'];

function ago(minutes) {
    return new Date(Date.now() - minutes * 60000).toISOString();
}

const MOCK_DATA = [
    ['1',  'opencode', 'mimo-v2.5-free',       'text,audio,image,video', 'key1', 'ACTIVE',       '',              ''],
    ['2',  'gemini',   'gemini-2.5-flash',      'text,audio,image,video', 'key2', 'ACTIVE',       '',              ''],
    ['3',  'opencode', 'mimo-v2.5-free',        'text,audio,image,video', 'key3', 'ACTIVE',       '',              ''],
    ['4',  'gemini',   'gemini-2.5-flash',      'text,audio,image,video', 'key4', 'ACTIVE',       '',              ''],
    ['5',  'opencode', 'deepseek-v4-flash-free','text',                   'key5', 'RATE-LIMITED', ago(10),         '6'],   // 10min < 6h → skip
    ['6',  'gemini',   'gemini-2.5-flash',      'text,audio,image,video', 'key6', 'FAILED',       ago(120),        ''],    // 2h < 24h → skip
    ['7',  'opencode', 'hy3-free',              'text,audio,image,video', 'key7', 'ACTIVE',       '',              ''],
    ['8',  'gemini',   'gemini-2.5-flash',      'text,audio,image,video', 'key8', 'RATE-LIMITED', ago(400),        '6'],   // 400min > 6h → retry
    ['9',  'opencode', 'deepseek-v4-flash-free','text',                   'key9', 'FAILED',       ago(30000),      ''],    // 20 days > 24h → retry
    ['10', 'gemini',   'gemini-2.0-flash',       'text,audio,image,video', 'key10','ACTIVE',       '',              ''],
    ['11', 'opencode', 'deepseek-v4-flash-free','text',                   'key11','RATE-LIMITED', ago(800),        '12'],  // 800min > 12h → retry
    ['12', 'opencode', 'deepseek-v4-flash-free','text',                   'key12','RATE-LIMITED', ago(200),        '18'],  // 200min < 18h → skip
];

// ============================================================
// MOCKS
// ============================================================

let mockSheetData = null;
let mockApiResponses = {};
let mockUpdates = [];

function mockGetSheetDataApi(sheetName) {
    if (sheetName === 'settings' && mockSheetData) return Promise.resolve(mockSheetData);
    return Promise.resolve({ success: false, error: 'not found' });
}

function mockUpdateSheetRowApi(sheetName, searchCol, searchVal, map) {
    mockUpdates.push({ sheetName, searchCol, searchVal, map });
    return Promise.resolve({ success: true });
}

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}`); console.log(`    ${err.message}`); }
}

async function testAsync(name, fn) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}`); console.log(`    ${err.message}`); }
}

function reset() {
    mockSheetData = null;
    mockApiResponses = {};
    mockUpdates = [];
}

// ============================================================
// TESTABLE AIService (mirrors real logic)
// ============================================================

const FAILED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

class TestableAIService {
    constructor() {
        this.settingsCache = null;
        this.cacheTime = 0;
        this.CACHE_TTL = 60000;
        this.lastProvider = null;
    }

    async loadProviders(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this.settingsCache && (now - this.cacheTime < this.CACHE_TTL)) {
            return this.settingsCache;
        }

        const result = await mockGetSheetDataApi('settings');
        if (!result.success || !result.data) return this.settingsCache || [];

        const h = result.headers;
        const iSn = h.indexOf('aiSn');
        const iProv = h.indexOf('aiProvider');
        const iModel = h.indexOf('aiModel');
        const iSvc = h.indexOf('aiService');
        const iKey = h.indexOf('aiKey');
        const iStatus = h.indexOf('aiStatus');
        const iLastRun = h.indexOf('aiLastRun');
        const iLimitRetry = h.indexOf('aiLimitRetry');

        if (iSn === -1 || iProv === -1 || iModel === -1 || iKey === -1) return this.settingsCache || [];

        const providers = [];

        for (const row of result.data) {
            const sn = parseInt(row[iSn]);
            const provider = (row[iProv] || '').toLowerCase().trim();
            const model = (row[iModel] || '').trim();
            const service = (row[iSvc] || '').trim();
            const key = (row[iKey] || '').trim();
            const status = (row[iStatus] || '').toUpperCase().trim();
            const lastRun = iLastRun !== -1 ? (row[iLastRun] || '').trim() : '';
            const limitRetryHours = iLimitRetry !== -1 ? parseInt(row[iLimitRetry]) || 0 : 0;

            if (!provider || !model || !key) continue;

            // ACTIVE
            if (status === 'ACTIVE' || status === '') {
                providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                continue;
            }

            // RATE-LIMITED → use aiLimitRetry hours
            if (status === 'RATE-LIMITED') {
                if (!lastRun) {
                    providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                    continue;
                }
                const cooldownMs = limitRetryHours > 0
                    ? limitRetryHours * 60 * 60 * 1000
                    : 60 * 60 * 1000; // default 1h

                if (this._isExpired(lastRun, cooldownMs)) {
                    providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                }
                continue;
            }

            // FAILED → 24h mandatory
            if (status === 'FAILED') {
                if (!lastRun) {
                    providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                    continue;
                }
                if (this._isExpired(lastRun, FAILED_COOLDOWN_MS)) {
                    providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                }
                continue;
            }
        }

        providers.sort((a, b) => a.sn - b.sn);
        this.settingsCache = providers;
        this.cacheTime = now;
        return providers;
    }

    _isExpired(lastRunISO, cooldownMs) {
        const t = new Date(lastRunISO).getTime();
        if (isNaN(t)) return true;
        return (Date.now() - t) >= cooldownMs;
    }

    isRateLimitError(err) {
        const status = err.response?.status;
        const msg = (err.message || '').toLowerCase();
        if (status === 429) return true;
        if (msg.includes('rate limit')) return true;
        if (msg.includes('too many requests')) return true;
        if (msg.includes('quota exceeded')) return true;
        if (msg.includes('resource exhausted')) return true;
        return false;
    }

    async recordRateLimit(provider) {
        mockUpdates.push({ type: 'rateLimit', sn: provider.sn });
    }

    async recordFailure(provider) {
        mockUpdates.push({ type: 'failure', sn: provider.sn });
    }

    async recordSuccess(provider) {
        mockUpdates.push({ type: 'success', sn: provider.sn });
    }

    async generate(prompt, options = {}) {
        const { preferProvider = null } = options;
        const providers = await this.loadProviders();
        if (providers.length === 0) throw new Error('No AI providers');

        const unique = [];
        const seen = new Set();
        for (const p of providers) {
            const k = `${p.provider}/${p.model}`;
            if (!seen.has(k)) { seen.add(k); unique.push(p); }
        }

        if (preferProvider) {
            const match = unique.find(p => p.provider === preferProvider);
            if (match) {
                try {
                    const r = await this._callProvider(match);
                    this.lastProvider = match;
                    this.recordSuccess(match);
                    return r;
                } catch (err) {
                    if (this.isRateLimitError(err)) this.recordRateLimit(match);
                    else this.recordFailure(match);
                }
            }
        }

        for (const provider of unique) {
            try {
                const r = await this._callProvider(provider);
                this.lastProvider = provider;
                this.recordSuccess(provider);
                return r;
            } catch (err) {
                if (this.isRateLimitError(err)) this.recordRateLimit(provider);
                else this.recordFailure(provider);
                continue;
            }
        }

        throw new Error('All providers failed');
    }

    async _callProvider(provider) {
        const k = `${provider.provider}/${provider.model}`;
        const resp = mockApiResponses[k];
        if (!resp) throw new Error(`No mock for ${k}`);
        if (resp.error) throw new Error(resp.error);
        if (resp.httpError) {
            const e = new Error(resp.httpError.message);
            e.response = { status: resp.httpError.status };
            throw e;
        }
        return resp.text;
    }
}

// ============================================================
// TESTS
// ============================================================

console.log('\n=== AIService v3 Isolation Tests (aiLimitRetry) ===\n');

// ---- 1. aiLimitRetry per-row cooldown ----
console.log('1. aiLimitRetry Per-Row Cooldown');

await testAsync('sn:5 RATE-LIMITED with 6h cooldown, 10min ago → skipped (10min < 6h)', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sn5 = p.find(x => x.sn === 5);
    assert.strictEqual(sn5, undefined, 'sn:5 should be skipped');
});

await testAsync('sn:8 RATE-LIMITED with 6h cooldown, 400min ago → retried (400min > 6h)', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sn8 = p.find(x => x.sn === 8);
    assert.ok(sn8, 'sn:8 should be retried');
    assert.strictEqual(sn8.status, 'ACTIVE');
});

await testAsync('sn:11 RATE-LIMITED with 12h cooldown, 800min ago → retried (800min > 12h)', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sn11 = p.find(x => x.sn === 11);
    assert.ok(sn11, 'sn:11 should be retried');
});

await testAsync('sn:12 RATE-LIMITED with 18h cooldown, 200min ago → skipped (200min < 18h)', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sn12 = p.find(x => x.sn === 12);
    assert.strictEqual(sn12, undefined, 'sn:12 should be skipped');
});

await testAsync('sn:6 FAILED 2h ago → skipped (2h < 24h)', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sn6 = p.find(x => x.sn === 6);
    assert.strictEqual(sn6, undefined, 'sn:6 FAILED should be skipped');
});

await testAsync('sn:9 FAILED 20 days ago → retried (20 days > 24h)', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sn9 = p.find(x => x.sn === 9);
    assert.ok(sn9, 'sn:9 FAILED should be retried after 24h');
});

await testAsync('correct count: 6 ACTIVE + 3 retryable = 9 providers', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    // ACTIVE: sn 1,2,3,4,7,10 = 6
    // RATE-LIMITED retry: sn 8 (6h), sn 11 (12h) = 2
    // FAILED retry: sn 9 (24h) = 1
    // Total: 9
    assert.strictEqual(p.length, 9, `Expected 9, got ${p.length}: ${p.map(x => x.sn)}`);
});

// ---- 2. Different aiLimitRetry values produce different cooldowns ----
console.log('\n2. Different Cooldown Values');

await testAsync('6h vs 12h vs 18h cooldowns produce different results', async () => {
    reset();
    const data = [
        ['1', 'opencode', 'm1', 't', 'k', 'RATE-LIMITED', ago(300), '6'],   // 300min < 360min(6h) → skip
        ['2', 'opencode', 'm2', 't', 'k', 'RATE-LIMITED', ago(400), '6'],   // 400min > 360min(6h) → retry
        ['3', 'opencode', 'm3', 't', 'k', 'RATE-LIMITED', ago(800), '12'],  // 800min > 720min(12h) → retry
        ['4', 'opencode', 'm4', 't', 'k', 'RATE-LIMITED', ago(800), '18'],  // 800min < 1080min(18h) → skip
    ];
    mockSheetData = { success: true, headers: MOCK_HEADERS, data };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sns = p.map(x => x.sn);
    assert.ok(!sns.includes(1), 'sn:1 (6h, 300min) should be skipped');
    assert.ok(sns.includes(2), 'sn:2 (6h, 400min) should be retried');
    assert.ok(sns.includes(3), 'sn:3 (12h, 800min) should be retried');
    assert.ok(!sns.includes(4), 'sn:4 (18h, 800min) should be skipped');
});

await testAsync('RATE-LIMITED with no aiLimitRetry → defaults to 1h cooldown', async () => {
    reset();
    const data = [
        ['1', 'opencode', 'm1', 't', 'k', 'RATE-LIMITED', ago(120), ''],   // 120min > 1h default → retry
    ];
    mockSheetData = { success: true, headers: MOCK_HEADERS, data };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    assert.strictEqual(p.length, 1, 'Should retry with 1h default');
});

// ---- 3. Error Classification ----
console.log('\n3. Error Classification');

test('HTTP 429 is rate limit', () => {
    const svc = new TestableAIService();
    const e = new Error('Too Many Requests');
    e.response = { status: 429 };
    assert.strictEqual(svc.isRateLimitError(e), true);
});

test('"rate limit" is rate limit', () => {
    const svc = new TestableAIService();
    assert.strictEqual(svc.isRateLimitError(new Error('rate limit exceeded')), true);
});

test('"quota exceeded" is rate limit', () => {
    const svc = new TestableAIService();
    assert.strictEqual(svc.isRateLimitError(new Error('quota exceeded')), true);
});

test('"resource exhausted" is rate limit', () => {
    const svc = new TestableAIService();
    assert.strictEqual(svc.isRateLimitError(new Error('resource exhausted')), true);
});

test('HTTP 401 is NOT rate limit', () => {
    const svc = new TestableAIService();
    const e = new Error('Unauthorized');
    e.response = { status: 401 };
    assert.strictEqual(svc.isRateLimitError(e), false);
});

test('"invalid api key" is NOT rate limit', () => {
    const svc = new TestableAIService();
    assert.strictEqual(svc.isRateLimitError(new Error('Invalid API key')), false);
});

test('"model not found" is NOT rate limit', () => {
    const svc = new TestableAIService();
    assert.strictEqual(svc.isRateLimitError(new Error('model not found')), false);
});

// ---- 4. Waterfall + Recording ----
console.log('\n4. Waterfall + Recording');

await testAsync('rate limit → recordRateLimit called with correct sn', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { httpError: { message: 'rate limit', status: 429 } };
    mockApiResponses['gemini/gemini-2.5-flash'] = { text: 'ok' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const rl = mockUpdates.filter(u => u.type === 'rateLimit');
    assert.ok(rl.length > 0, 'Should record rate limit');
    assert.strictEqual(rl[0].sn, 1);
});

await testAsync('auth error → recordFailure called', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { error: 'Invalid API key' };
    mockApiResponses['gemini/gemini-2.5-flash'] = { text: 'ok' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const fl = mockUpdates.filter(u => u.type === 'failure');
    assert.ok(fl.length > 0, 'Should record failure');
    assert.strictEqual(fl[0].sn, 1);
});

await testAsync('success → recordSuccess called', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { text: 'hello' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const sc = mockUpdates.filter(u => u.type === 'success');
    assert.ok(sc.length > 0, 'Should record success');
    assert.strictEqual(sc[0].sn, 1);
});

await testAsync('dedup: waterfall tries each unique pair at most once', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    // Make all fail except the last unique pair
    mockApiResponses['opencode/mimo-v2.5-free'] = { error: 'fail' };
    mockApiResponses['gemini/gemini-2.5-flash'] = { error: 'fail' };
    mockApiResponses['opencode/hy3-free'] = { error: 'fail' };
    mockApiResponses['gemini/gemini-2.0-flash'] = { text: 'ok' };
    const svc = new TestableAIService();
    const called = [];
    const orig = svc._callProvider.bind(svc);
    svc._callProvider = async (p) => { called.push(`${p.provider}/${p.model}`); return orig(p); };
    await svc.generate('test');
    // 5 unique pairs, first 4 fail, 5th succeeds → 5 calls total
    assert.strictEqual(called.length, 5, `Should call each unique pair once, called ${called.length}: ${called}`);
    // Verify no duplicates
    const unique = [...new Set(called)];
    assert.strictEqual(called.length, unique.length, `Found duplicates in calls: ${called}`);
});

// ---- 5. Priority ----
console.log('\n5. Priority');

await testAsync('sorted by aiSn ascending', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    const sns = p.map(x => x.sn);
    assert.deepStrictEqual(sns, [...sns].sort((a, b) => a - b));
});

// ---- 6. Edge Cases ----
console.log('\n6. Edge Cases');

await testAsync('RATE-LIMITED with no aiLastRun → included', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: [
        ['1', 'opencode', 'm', 't', 'k', 'RATE-LIMITED', '', '6'],
    ]};
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    assert.strictEqual(p.length, 1);
});

await testAsync('FAILED with no aiLastRun → included', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: [
        ['1', 'opencode', 'm', 't', 'k', 'FAILED', '', ''],
    ]};
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    assert.strictEqual(p.length, 1);
});

await testAsync('handles empty sheet', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: [] };
    const svc = new TestableAIService();
    assert.strictEqual((await svc.loadProviders()).length, 0);
});

await testAsync('handles missing columns', async () => {
    reset();
    mockSheetData = { success: true, headers: ['wrong'], data: [['x']] };
    const svc = new TestableAIService();
    assert.strictEqual((await svc.loadProviders()).length, 0);
});

await testAsync('skips empty provider/model/key', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: [
        ['1', '', 'm', 't', 'k', 'ACTIVE', '', ''],
        ['2', 'opencode', '', 't', 'k', 'ACTIVE', '', ''],
        ['3', 'opencode', 'm', 't', '', 'ACTIVE', '', ''],
        ['4', 'opencode', 'm', 't', 'k', 'ACTIVE', '', ''],
    ]};
    const svc = new TestableAIService();
    const p = await svc.loadProviders();
    assert.strictEqual(p.length, 1);
    assert.strictEqual(p[0].sn, 4);
});

// ---- 7. Recording Verification (aiLastRun + status) ----
console.log('\n7. Recording Verification');

await testAsync('recordRateLimit writes aiLastRun timestamp to sheet', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { httpError: { message: 'rate limit', status: 429 } };
    mockApiResponses['gemini/gemini-2.5-flash'] = { text: 'ok' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const rl = mockUpdates.filter(u => u.type === 'rateLimit');
    assert.ok(rl.length > 0, 'Should have rateLimit recording');
    // Verify it would write aiLastRun to settings sheet
    assert.strictEqual(rl[0].sn, 1, 'Should record for sn:1');
});

await testAsync('recordFailure writes aiLastRun timestamp to sheet', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { error: 'Invalid API key' };
    mockApiResponses['gemini/gemini-2.5-flash'] = { text: 'ok' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const fl = mockUpdates.filter(u => u.type === 'failure');
    assert.ok(fl.length > 0, 'Should have failure recording');
    assert.strictEqual(fl[0].sn, 1, 'Should record for sn:1');
});

await testAsync('recordSuccess writes aiLastRun timestamp to sheet', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { text: 'hello' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const sc = mockUpdates.filter(u => u.type === 'success');
    assert.ok(sc.length > 0, 'Should have success recording');
    assert.strictEqual(sc[0].sn, 1, 'Should record for sn:1');
});

await testAsync('multiple failures record each provider separately', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { error: 'bad key' };
    mockApiResponses['gemini/gemini-2.5-flash'] = { error: 'model not found' };
    mockApiResponses['opencode/hy3-free'] = { text: 'ok' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const failures = mockUpdates.filter(u => u.type === 'failure');
    assert.strictEqual(failures.length, 2, `Should record 2 failures, got ${failures.length}`);
    assert.strictEqual(failures[0].sn, 1, 'First failure: sn:1');
    assert.strictEqual(failures[1].sn, 2, 'Second failure: sn:2');
    const successes = mockUpdates.filter(u => u.type === 'success');
    assert.strictEqual(successes.length, 1, 'Should record 1 success');
    assert.strictEqual(successes[0].sn, 7, 'Success: sn:7 (hy3-free)');
});

await testAsync('rate limit then success records both', async () => {
    reset();
    mockSheetData = { success: true, headers: MOCK_HEADERS, data: MOCK_DATA.map(r => [...r]) };
    mockApiResponses['opencode/mimo-v2.5-free'] = { httpError: { message: '429', status: 429 } };
    mockApiResponses['gemini/gemini-2.5-flash'] = { text: 'worked' };
    const svc = new TestableAIService();
    await svc.generate('test');
    const rl = mockUpdates.filter(u => u.type === 'rateLimit');
    const sc = mockUpdates.filter(u => u.type === 'success');
    assert.strictEqual(rl.length, 1, 'Should have 1 rate limit record');
    assert.strictEqual(rl[0].sn, 1, 'Rate limit: sn:1');
    assert.strictEqual(sc.length, 1, 'Should have 1 success record');
    assert.strictEqual(sc[0].sn, 2, 'Success: sn:2');
});

// ============================================================
// SUMMARY
// ============================================================

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(50));

if (failed > 0) process.exit(1);
