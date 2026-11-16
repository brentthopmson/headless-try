#!/usr/bin/env node
/**
 * Isolation tests for AI-first enrichment normalization.
 *
 * These run against src/app/campaign/_shared/enrichmentCore.mjs only:
 * no Sheets/Drive, no network, no AI provider, no browser.
 *
 * Run: node scripts/test-enrichment-core.mjs
 */
import assert from 'node:assert/strict';
import {
  validateAndApplyPatches,
  planEnrichmentWaves,
  hygieneRow,
  getCell,
  setCell,
  ensureColumn,
  buildColumnStats,
  resolveHeaderIndex,
  isSystemHeader,
  isPlaceholder,
} from '../src/app/campaign/_shared/enrichmentCore.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function makeRow(headers, values = {}) {
  const row = headers.map(() => '');
  for (const [k, v] of Object.entries(values)) {
    const idx = resolveHeaderIndex(headers, k);
    if (idx === -1) throw new Error(`unknown header in test: ${k}`);
    row[idx] = v;
  }
  return row;
}
function schemaOf(headers, spec = {}) {
  return new Map(headers.map((h) => {
    const s = spec[h] || {};
    return [h, { header: h, role: s.role || 'unknown', write_policy: s.write_policy || 'fill_if_empty' }];
  }));
}
function acceptAll(patches) {
  return { decisions: patches.map((p) => ({ header: p.header, decision: 'accept' })) };
}

// ---------------------------------------------------------------------------
// 1. Bounded concurrency planner: N rows per AI call, N calls per wave.
// ---------------------------------------------------------------------------
test('planner: N=3 -> waves of up to 3 calls x 3 rows, full coverage', () => {
  const pending = Array.from({ length: 10 }, (_, i) => i);
  const waves = planEnrichmentWaves(pending, 3);
  assert.deepEqual(waves.map((w) => w.map((g) => g.length)), [[3, 3, 3], [1]]);
  assert.equal(waves.flat(2).length, 10);
  for (const wave of waves) {
    assert.ok(wave.length <= 3, 'max concurrent AI calls must not exceed limit');
    for (const group of wave) assert.ok(group.length <= 3, 'rows per AI call must not exceed limit');
  }
});

test('planner: N=1 -> one row per call, one call per wave', () => {
  const waves = planEnrichmentWaves([0, 1, 2], 1);
  assert.deepEqual(waves, [[[0]], [[1]], [[2]]]);
});

test('planner: invalid/zero limit coerces to 1 (never zero concurrency)', () => {
  const waves = planEnrichmentWaves([0, 1], 0);
  assert.deepEqual(waves, [[[0]], [[1]]]);
});

// ---------------------------------------------------------------------------
// 2. Verifier gating (no unverified patches ever land)
// ---------------------------------------------------------------------------
const baseHeaders = ['EMAIL', 'FULLNAME', 'FIRSTNAME', 'LASTNAME', 'BUSINESSNAME', 'JOBTITLE', 'PHONE', 'URL', 'ENRICHMENTSTATUS'];

test('verifier failure defers row and applies nothing', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { EMAIL: 'a@b.com', FULLNAME: 'Ada Lovelace', JOBTITLE: 'CTO' });
  const schema = schemaOf(headers, { JOBTITLE: { role: 'job_title', write_policy: 'fill_if_empty' } });
  const proposed = { patches: [{ header: 'JOBTITLE', value: 'CTO', basis: 'inferred', confidence: 0.9 }], status: 'enriched' };
  const res = validateAndApplyPatches(row, headers, schema, proposed, null, false);
  assert.equal(res.failed, true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'JOBTITLE'), 'CTO');
});

test('verifier rejection blocks otherwise-valid inferred patch', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { EMAIL: 'a@b.com' });
  const schema = schemaOf(headers, { JOBTITLE: { role: 'job_title', write_policy: 'fill_if_empty' } });
  const proposed = { patches: [{ header: 'JOBTITLE', value: 'Head of Sales', basis: 'inferred', confidence: 0.9 }] };
  const res = validateAndApplyPatches(row, headers, schema, proposed, { decisions: [{ header: 'JOBTITLE', decision: 'reject' }] }, true);
  assert.equal(res.failed, false);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'JOBTITLE'), '');
});

test('verifier acceptance lands inferred descriptive fill', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { EMAIL: 'ada@analytical.engine', BUSINESSNAME: 'Analytical Engines' });
  const schema = schemaOf(headers, { JOBTITLE: { role: 'job_title', write_policy: 'fill_if_empty' } });
  const patch = { header: 'JOBTITLE', value: 'CTO', basis: 'inferred', confidence: 0.8 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, true);
  assert.equal(res.status, 'enriched');
  assert.equal(getCell(row, headers, 'JOBTITLE'), 'CTO');
});

// ---------------------------------------------------------------------------
// 3. Write policies
// ---------------------------------------------------------------------------
test('fill_if_empty never overwrites an existing value', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { BUSINESSNAME: 'Original Co' });
  const schema = schemaOf(headers, { BUSINESSNAME: { role: 'company', write_policy: 'fill_if_empty' } });
  const patch = { header: 'BUSINESSNAME', value: 'Other Co', basis: 'inferred', confidence: 0.9 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'BUSINESSNAME'), 'Original Co');
});

test('overwrite_if_clearly_misfilled corrects a misfilled identity column', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { FIRSTNAME: 'Ada Lovelace', LASTNAME: 'Lovelace' });
  const schema = schemaOf(headers, {
    FIRSTNAME: { role: 'first_name', write_policy: 'overwrite_if_clearly_misfilled' },
    LASTNAME: { role: 'last_name', write_policy: 'overwrite_if_clearly_misfilled' },
  });
  const patches = [
    { header: 'FIRSTNAME', value: 'Ada', basis: 'derived', confidence: 0.9 },
    { header: 'LASTNAME', value: 'Lovelace', basis: 'derived', confidence: 0.9 },
  ];
  const res = validateAndApplyPatches(row, headers, schema, { patches }, acceptAll(patches), true);
  assert.equal(res.changed, true);
  assert.equal(getCell(row, headers, 'FIRSTNAME'), 'Ada');
  assert.equal(getCell(row, headers, 'LASTNAME'), 'Lovelace');
});

test('never_touch rejects every patch', () => {
  const headers = [...baseHeaders, 'PASSWORD'];
  const row = makeRow(headers, { PASSWORD: 'secret' });
  const schema = schemaOf(headers, { PASSWORD: { role: 'ignore_system', write_policy: 'never_touch' } });
  const patch = { header: 'PASSWORD', value: 'hacked', basis: 'restructure', confidence: 1 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'PASSWORD'), 'secret');
});

// ---------------------------------------------------------------------------
// 4. Identifier safety: never fabricate email/phone/url
// ---------------------------------------------------------------------------
test('inferred email is rejected', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { FULLNAME: 'Ada Lovelace' });
  const schema = schemaOf(headers, { EMAIL: { role: 'email', write_policy: 'fill_if_empty' } });
  const patch = { header: 'EMAIL', value: 'ada@guess.com', basis: 'inferred', confidence: 0.9 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'EMAIL'), '');
});

test('derived email present in row text is accepted and normalized', () => {
  const headers = [...baseHeaders, 'NOTES'];
  const row = makeRow(headers, { NOTES: 'Reach me at Ada@Analytical.Engine' });
  const schema = schemaOf(headers, {
    NOTES: { role: 'context_notes', write_policy: 'never_touch' },
    EMAIL: { role: 'email', write_policy: 'fill_if_empty' },
  });
  const patch = { header: 'EMAIL', value: 'Ada@Analytical.Engine', basis: 'derived', confidence: 0.9 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, true);
  assert.equal(getCell(row, headers, 'EMAIL'), 'ada@analytical.engine');
});

test('inferred phone and url are rejected', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, {});
  const schema = schemaOf(headers, {
    PHONE: { role: 'phone', write_policy: 'fill_if_empty' },
    URL: { role: 'url', write_policy: 'fill_if_empty' },
  });
  const patches = [
    { header: 'PHONE', value: '+1 555 010 9999', basis: 'inferred', confidence: 0.9 },
    { header: 'URL', value: 'https://guessed.example', basis: 'inferred', confidence: 0.9 },
  ];
  const res = validateAndApplyPatches(row, headers, schema, { patches }, acceptAll(patches), true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'PHONE'), '');
  assert.equal(getCell(row, headers, 'URL'), '');
});

// ---------------------------------------------------------------------------
// 5. Schema-agnostic rows (no name columns, mononym, non-Latin)
// ---------------------------------------------------------------------------
test('schema without any name columns can still fill descriptive fields', () => {
  const headers = ['EMAIL', 'COMPANY', 'TITLE'];
  const row = makeRow(headers, { EMAIL: 'ops@acme.test', COMPANY: 'Acme' });
  const schema = schemaOf(headers, {
    TITLE: { role: 'job_title', write_policy: 'fill_if_empty' },
    EMAIL: { role: 'email', write_policy: 'fill_if_empty' },
  });
  const patch = { header: 'TITLE', value: 'Operations', basis: 'inferred', confidence: 0.7 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.status, 'enriched');
  assert.equal(getCell(row, headers, 'TITLE'), 'Operations');
});

test('mononym is preserved as a single token (no invented split)', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { FIRSTNAME: 'Prince' });
  const schema = schemaOf(headers, {
    FIRSTNAME: { role: 'first_name', write_policy: 'overwrite_if_clearly_misfilled' },
    LASTNAME: { role: 'last_name', write_policy: 'fill_if_empty' },
  });
  const patch = { header: 'LASTNAME', value: '', basis: 'derived', confidence: 0.9 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'FIRSTNAME'), 'Prince');
  assert.equal(getCell(row, headers, 'LASTNAME'), '');
});

test('non-Latin/compound identity derives without adding tokens', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { FULLNAME: 'María de la Cruz' });
  const schema = schemaOf(headers, {
    FIRSTNAME: { role: 'first_name', write_policy: 'fill_if_empty' },
    LASTNAME: { role: 'last_name', write_policy: 'fill_if_empty' },
  });
  const patches = [
    { header: 'FIRSTNAME', value: 'María', basis: 'derived', confidence: 0.9 },
    { header: 'LASTNAME', value: 'de la Cruz', basis: 'derived', confidence: 0.9 },
  ];
  const res = validateAndApplyPatches(row, headers, schema, { patches }, acceptAll(patches), true);
  assert.equal(res.changed, true);
  assert.equal(getCell(row, headers, 'FIRSTNAME'), 'María');
  assert.equal(getCell(row, headers, 'LASTNAME'), 'de la Cruz');
});

// ---------------------------------------------------------------------------
// 6. Hygiene / headers / stats
// ---------------------------------------------------------------------------
test('hygiene collapses whitespace and clears placeholders only', () => {
  const headers = ['EMAIL', 'FULLNAME', 'JOBTITLE'];
  const row = makeRow(headers, { EMAIL: 'a@b.com', FULLNAME: '  Ada   Lovelace ', JOBTITLE: 'N/A' });
  hygieneRow(row);
  assert.equal(getCell(row, headers, 'FULLNAME'), 'Ada Lovelace');
  assert.equal(getCell(row, headers, 'JOBTITLE'), '');
  assert.equal(getCell(row, headers, 'EMAIL'), 'a@b.com');
});

test('engine columns resolve case-insensitively and are added once', () => {
  const headers = ['EMAIL', 'ENRICHMENTSTATUS'];
  const rows = [headers, ['a@b.com', '']];
  const idx = ensureColumn(headers, rows, 'enrichmentStatus');
  assert.equal(idx, 1);
  assert.equal(headers.length, 2);
  setCell(rows[1], headers, 'enrichmentStatus', 'enriched');
  assert.equal(getCell(rows[1], headers, 'ENRICHMENTSTATUS'), 'enriched');
  assert.equal(headers[0], 'EMAIL');
});

test('column stats expose fill rate, distinct count, hint and samples', () => {
  const headers = ['EMAIL', 'FULLNAME'];
  const rows = [headers, ['a@x.com', 'Ada'], ['b@x.com', 'Grace'], ['', '']];
  const stats = buildColumnStats(rows, headers);
  const email = stats.find((s) => s.header === 'EMAIL');
  const name = stats.find((s) => s.header === 'FULLNAME');
  assert.ok(Math.abs(email.fillRate - 0.6667) < 0.01);
  assert.equal(email.distinct, 2);
  assert.equal(email.hint, 'email');
  assert.equal(name.hint, 'full_name');
  assert.deepEqual(name.samples, ['Ada', 'Grace']);
});

test('engine/system headers are identified case- and punctuation-insensitively', () => {
  for (const h of ['VALIDATION', 'providerMXResult', 'ENRICHMENTSTATUS', 'enhancedSubject',
    'personalizationStatus', 'executionStatus', 'sendDate', 'oAuth2RefreshToken', 'SMTP', 'LINK']) {
    assert.equal(isSystemHeader(h), true, `${h} must be system`);
  }
  for (const h of ['EMAIL', 'FIRSTNAME', 'BUSINESSNAME', 'JOBTITLE', 'CONTEXT', 'PHONE', 'URL']) {
    assert.equal(isSystemHeader(h), false, `${h} must be enrichable`);
  }
});

// ---------------------------------------------------------------------------
// 7. Placeholder / company / URL hygiene (Personal is not an employer)
// ---------------------------------------------------------------------------
test('Personal and similar labels are placeholders and are cleared by hygiene', () => {
  assert.equal(isPlaceholder('Personal'), true);
  assert.equal(isPlaceholder('self'), true);
  assert.equal(isPlaceholder('Acme Inc'), false);
  const headers = ['BUSINESSNAME', 'URL'];
  const row = makeRow(headers, { BUSINESSNAME: 'Personal', URL: 'Personal' });
  hygieneRow(row);
  assert.equal(getCell(row, headers, 'BUSINESSNAME'), '');
  assert.equal(getCell(row, headers, 'URL'), '');
});

test('company may never be inferred, even with verifier acceptance', () => {
  const headers = [...baseHeaders, 'CONTEXT'];
  const row = makeRow(headers, { EMAIL: 'jane@gmail.com', CONTEXT: 'Personal contact: Jane Doe (jane@gmail.com).' });
  const schema = schemaOf(headers, { BUSINESSNAME: { role: 'company', write_policy: 'fill_if_empty' } });
  const patch = { header: 'BUSINESSNAME', value: 'Jane Doe', basis: 'inferred', confidence: 0.9 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, false);
  assert.equal(res.status, 'no_data');
  assert.equal(getCell(row, headers, 'BUSINESSNAME'), '');
});

test('company patch with placeholder value Personal is rejected', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { EMAIL: 'jane@gmail.com' });
  const schema = schemaOf(headers, { BUSINESSNAME: { role: 'company', write_policy: 'fill_if_empty' } });
  const patch = { header: 'BUSINESSNAME', value: 'Personal', basis: 'restructure', confidence: 0.9 };
  const res = validateAndApplyPatches(row, headers, schema, { patches: [patch] }, acceptAll([patch]), true);
  assert.equal(res.changed, false);
  assert.equal(getCell(row, headers, 'BUSINESSNAME'), '');
});

test('URL label is rejected; a real domain is normalized with https', () => {
  const headers = [...baseHeaders];
  const row = makeRow(headers, { EMAIL: 'sam@acme.com' });
  const schema = schemaOf(headers, { URL: { role: 'url', write_policy: 'fill_if_empty' } });
  const bad = { header: 'URL', value: 'Personal', basis: 'restructure', confidence: 0.9 };
  const resBad = validateAndApplyPatches(row, headers, schema, { patches: [bad] }, acceptAll([bad]), true);
  assert.equal(resBad.changed, false);
  assert.equal(getCell(row, headers, 'URL'), '');
  const good = { header: 'URL', value: 'www.acme.com/about', basis: 'restructure', confidence: 0.9 };
  const resGood = validateAndApplyPatches(row, headers, schema, { patches: [good] }, acceptAll([good]), true);
  assert.equal(resGood.changed, true);
  assert.equal(getCell(row, headers, 'URL'), 'https://www.acme.com/about');
});

console.log(`\n${passed} isolation test(s) passed.`);
