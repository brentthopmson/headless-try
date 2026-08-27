/**
 * ISOLATION TESTS for personalization prompt truncation
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/personalize-prompt.test.mjs
 */

import assert from 'assert';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { failed++; console.log(`  ✗ ${name}`); console.log(`    ${err.message}`); }
}

function truncatePrompt(prompt, maxChars) {
    if (!prompt) return prompt;
    if (prompt.length > maxChars) {
        return prompt.slice(0, maxChars);
    }
    return prompt;
}

console.log('\n=== Personalization Prompt Truncation Tests ===\n');

test('truncatePrompt: empty string returns empty', () => {
    assert.strictEqual(truncatePrompt('', 500), '');
});

test('truncatePrompt: null returns null', () => {
    assert.strictEqual(truncatePrompt(null, 500), null);
});

test('truncatePrompt: undefined returns undefined', () => {
    assert.strictEqual(truncatePrompt(undefined, 500), undefined);
});

test('truncatePrompt: short prompt unchanged', () => {
    const prompt = 'Write a professional email';
    assert.strictEqual(truncatePrompt(prompt, 500), prompt);
});

test('truncatePrompt: exact limit unchanged', () => {
    const prompt = 'x'.repeat(500);
    assert.strictEqual(truncatePrompt(prompt, 500), prompt);
});

test('truncatePrompt: over limit truncated', () => {
    const prompt = 'x'.repeat(600);
    const result = truncatePrompt(prompt, 500);
    assert.strictEqual(result.length, 500);
    assert.strictEqual(result, 'x'.repeat(500));
});

test('truncatePrompt: preserves start of prompt', () => {
    const prompt = 'Write a professional cold outreach email. ' + 'x'.repeat(500);
    const result = truncatePrompt(prompt, 50);
    assert.ok(result.startsWith('Write a professional cold outreach email'));
    assert.strictEqual(result.length, 50);
});

test('truncatePrompt: maxChars=1 returns first char', () => {
    const prompt = 'Hello';
    assert.strictEqual(truncatePrompt(prompt, 1), 'H');
});

test('truncatePrompt: maxChars=0 returns empty string', () => {
    const prompt = 'Hello';
    assert.strictEqual(truncatePrompt(prompt, 0), '');
});

test('truncatePrompt: realistic long prompt', () => {
    const prompt = 'You are an expert personalized outreach copywriter. Generate highly tailored cold email subject lines and email bodies. ' +
        'Rules: 1. Each subject must be unique. 2. Each body must be professional. 3. Reference the recipient. 4. Keep under 150 words.';
    const result = truncatePrompt(prompt, 100);
    assert.strictEqual(result.length, 100);
    assert.ok(result.startsWith('You are an expert'));
});

// ============================================================
// SUMMARY
// ============================================================

console.log('\n' + '='.repeat(50));
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('='.repeat(50));

if (failed > 0) process.exit(1);
