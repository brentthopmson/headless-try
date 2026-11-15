/**
 * ISOLATION TESTS — Campaign Keyword Unification
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/campaign-keyword-unification.test.mjs
 */
import assert from 'assert';

function embedCampaignIdentifier(subject, body, keyword) {
    const identifier = `[${keyword}]`;
    const taggedSubject = subject.includes(identifier) ? subject : `${subject} ${identifier}`;
    const identifierComment = `<!-- campaign:${keyword} -->`;
    const taggedBody = body.includes(identifierComment) ? body : `${body}\n\n${identifierComment}`;
    return { subject: taggedSubject, body: taggedBody };
}

function resolveKeyword(settings, campaignId) {
    return String(settings?.campaignKeyword || '').trim() || campaignId;
}

function defaultHelperKeyword(settings, keyword) {
    if (!String(settings?.helperKeyword || '').trim()) return keyword;
    return settings.helperKeyword;
}

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n=== KEYWORD UNIFICATION ===');

test('embedCampaignIdentifier stamps keyword (not campaignId) into subject', () => {
    const r = embedCampaignIdentifier('Hello', 'Body', '5R1234899');
    assert.strictEqual(r.subject, 'Hello [5R1234899]');
    assert.ok(r.body.includes('<!-- campaign:5R1234899 -->'));
});

test('embedCampaignIdentifier does not duplicate keyword in subject', () => {
    const r = embedCampaignIdentifier('Hello [5R1234899]', 'Body', '5R1234899');
    assert.strictEqual(r.subject, 'Hello [5R1234899]');
});

test('resolveKeyword uses campaignKeyword when set', () => {
    assert.strictEqual(resolveKeyword({ campaignKeyword: '5R1234899' }, 'CMP-1'), '5R1234899');
});

test('resolveKeyword falls back to campaignId when blank', () => {
    assert.strictEqual(resolveKeyword({ campaignKeyword: '' }, 'CMP-1'), 'CMP-1');
    assert.strictEqual(resolveKeyword({}, 'CMP-1'), 'CMP-1');
    assert.strictEqual(resolveKeyword({ campaignKeyword: '   ' }, 'CMP-1'), 'CMP-1');
});

test('defaultHelperKeyword copies campaignKeyword when helperKeyword blank', () => {
    assert.strictEqual(defaultHelperKeyword({}, '5R1234899'), '5R1234899');
    assert.strictEqual(defaultHelperKeyword({ helperKeyword: '' }, '5R1234899'), '5R1234899');
});

test('defaultHelperKeyword preserves explicit helperKeyword override', () => {
    assert.strictEqual(defaultHelperKeyword({ helperKeyword: 'custom' }, '5R1234899'), 'custom');
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);