/**
 * TESTS for utils/campaignConcurrency.js — the per-user concurrent campaign
 * guardrail (SETTINGS campaignConcurrentLimit) shared by pipeline-orchestrator
 * and execute-campaign.
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/campaign-concurrency.test.mjs
 *
 * Unlike the other suites (which re-implement logic locally), this loads the
 * REAL production module via vm.SourceTextModule, stubbing only its four
 * imports (logger, settingsCache, limits, googlesheets) so the actual
 * counting/fail-open code runs unmodified against fixture sheet data.
 * Engine wiring + GAS/frontend parity are asserted by reading sources;
 * cross-repo files are skipped when not present on this machine.
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath, pathToFileURL } from 'url';

if (typeof vm.SourceTextModule !== 'function') {
  console.error('vm.SourceTextModule unavailable — run with: node --experimental-vm-modules <this file>');
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../../../utils/campaignConcurrency.js');
const ORCHESTRATOR_SRC = path.resolve(HERE, '../pipeline-orchestrator/route.js');
const EXECUTE_SRC = path.resolve(HERE, '../execute-campaign/route.js');
// Sibling repos (skipped when absent — this test must still pass if the
// engine repo is checked out on its own).
const GAS_SRC = path.resolve(HERE, '../../../../../../Extra Tools/WebFixx-Hoo/google-apps-script/CAMPAIGN.js');
const FLAGS_SRC = path.resolve(HERE, '../../../../../../Extra Tools/WebFixx/utils/featureFlags.ts');
const LIST_PAGE_SRC = path.resolve(HERE, '../../../../../../Extra Tools/WebFixx/app/campaign/page.tsx');
const DETAIL_PAGE_SRC = path.resolve(HERE, '../../../../../../Extra Tools/WebFixx/app/campaign/[campaignId]/page.tsx');
const MODAL_SRC = path.resolve(HERE, '../../../../../../Extra Tools/WebFixx/app/components/admin/campaign/CampaignModal.tsx');

const ACTIVE_STATUSES = ['running', 'processing', 'staged', 'resting'];
const ERROR_SUFFIX = ' running). Pause or complete a campaign to free a slot.';

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function testOptional(name, available, fn) {
  if (!available) {
    console.log(`  ⚠ ${name} (skipped — cross-repo file not found)`);
    skipped++;
    return Promise.resolve();
  }
  return test(name, fn);
}

function readIfPresent(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// ============================================================
// Load the REAL campaignConcurrency.js with stubbed imports
// ============================================================

async function loadCampaignConcurrency({ campaignLimits = {}, sheet = null, sheetThrows = false } = {}) {
  const context = vm.createContext({ process: { env: {} } });

  const loggerMod = new vm.SyntheticModule(['default'], function () {
    this.setExport('default', { info() {}, warn() {}, error() {}, debug() {} });
  }, { context });

  const settingsMod = new vm.SyntheticModule(['getSetting'], function () {
    this.setExport('getSetting', async () => null);
  }, { context });

  const limitsMod = new vm.SyntheticModule(['getCampaignLimits'], function () {
    this.setExport('getCampaignLimits', async () => ({ ...campaignLimits }));
  }, { context });

  const sheetsMod = new vm.SyntheticModule(['getSheetDataApi'], function () {
    this.setExport('getSheetDataApi', async () => {
      if (sheetThrows) throw new Error('simulated sheet failure');
      if (!sheet) return { success: false, error: 'offline fixture' };
      return { success: true, headers: sheet.headers, data: sheet.data, count: sheet.data.length };
    });
  }, { context });

  const mod = new vm.SourceTextModule(fs.readFileSync(SRC, 'utf8'), {
    context,
    identifier: pathToFileURL(SRC).href,
  });
  await mod.link((specifier) => {
    if (specifier.endsWith('logger.js')) return loggerMod;
    if (specifier.endsWith('settingsCache.js')) return settingsMod;
    if (specifier.endsWith('limits.js')) return limitsMod;
    if (specifier.endsWith('googlesheets.js')) return sheetsMod;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await mod.evaluate();
  return mod.namespace;
}

const HEADERS = ['campaignId', 'userId', 'status', 'name'];

// Mixed fixture: active + inactive statuses, another user, whitespace userId.
const MIXED_SHEET = {
  headers: HEADERS,
  data: [
    ['c1', 'user-1', 'running', 'Active A'],
    ['c2', 'user-1', 'Resting', 'Resting B (case)'],
    ['c3', 'user-1', 'staged', 'Staged C'],
    ['c4', 'user-1', 'processing', 'Processing D'],
    ['c5', 'user-1', 'paused', 'Paused E'],
    ['c6', 'user-1', 'draft', 'Draft F'],
    ['c7', 'user-2', 'running', 'Other user G'],
    ['c8', 'user-1', 'completed', 'Done H'],
    ['c9', ' user-1 ', 'running', 'Whitespace I'],
  ],
};

const ONE_ACTIVE_SHEET = {
  headers: HEADERS,
  data: [
    ['c1', 'user-1', 'running', 'Active A'],
    ['c2', 'user-1', 'paused', 'Paused B'],
  ],
};

// ============================================================
// A. Real-module behavior
// ============================================================

console.log('\n=== campaign-concurrency: checkUserConcurrentCampaigns (real module) ===');

await test('counts active statuses (running/processing/staged/resting), case-insensitively, own user only', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 2 }, sheet: MIXED_SHEET });
  const r = await m.checkUserConcurrentCampaigns('user-1');
  // c1 running, c2 Resting, c3 staged, c4 processing, c9 ' user-1 ' running = 5.
  // Not counted: paused, draft, completed, other user's running.
  assert.strictEqual(r.current, 5);
  assert.strictEqual(r.limit, 2);
  assert.strictEqual(r.allowed, false);
});

await test("excludes the campaign being started (excludeCampaignId) so limit=1 can't self-block", async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 2 }, sheet: MIXED_SHEET });
  const r = await m.checkUserConcurrentCampaigns('user-1', 'c1');
  assert.strictEqual(r.current, 4);
  assert.strictEqual(r.allowed, false);
});

await test('allows when current < limit', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 2 }, sheet: ONE_ACTIVE_SHEET });
  const r = await m.checkUserConcurrentCampaigns('user-1', 'c2');
  assert.strictEqual(r.current, 1);
  assert.strictEqual(r.limit, 2);
  assert.strictEqual(r.allowed, true);
});

await test('blocks exactly at the limit (limit=1 + 1 running → blocked)', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 1 }, sheet: ONE_ACTIVE_SHEET });
  const r = await m.checkUserConcurrentCampaigns('user-1', 'c2');
  assert.strictEqual(r.current, 1);
  assert.strictEqual(r.limit, 1);
  assert.strictEqual(r.allowed, false);
});

await test("a 'resting' campaign holds its slot (cooldown wakes via TRIGGERS)", async () => {
  const sheet = { headers: HEADERS, data: [['c1', 'user-1', 'resting', 'Cooling']] };
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 1 }, sheet });
  const r = await m.checkUserConcurrentCampaigns('user-1', 'c2');
  assert.strictEqual(r.current, 1);
  assert.strictEqual(r.allowed, false);
});

await test('falls back to limit 1 when the SETTINGS value is missing/0 (safety valve)', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 0 }, sheet: ONE_ACTIVE_SHEET });
  const r = await m.checkUserConcurrentCampaigns('user-1', 'c2');
  assert.strictEqual(r.limit, 1);
  assert.strictEqual(r.allowed, false); // 1 active vs limit 1
});

await test('fail-open (allowed) when the campaigns sheet read fails', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 1 }, sheet: null });
  const r = await m.checkUserConcurrentCampaigns('user-1');
  // Field asserts — objects cross the vm realm boundary, so deepStrictEqual
  // would fail on prototype identity.
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.current, 0);
  assert.strictEqual(r.limit, 1);
});

await test('fail-open (allowed) when getSheetDataApi throws', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 1 }, sheetThrows: true });
  const r = await m.checkUserConcurrentCampaigns('user-1');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.current, 0);
  assert.strictEqual(r.limit, 1);
});

await test('fail-open (allowed) when the sheet has no userId column', async () => {
  const sheet = { headers: ['campaignId', 'status'], data: [['c1', 'running']] };
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 1 }, sheet });
  const r = await m.checkUserConcurrentCampaigns('user-1');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.limit, 1);
});

await test('no userId supplied → allowed (legacy/anonymous rows never brick)', async () => {
  const m = await loadCampaignConcurrency({ campaignLimits: { campaignConcurrentLimit: 1 }, sheet: MIXED_SHEET });
  const r = await m.checkUserConcurrentCampaigns('');
  assert.strictEqual(r.allowed, true);
  assert.strictEqual(r.current, 0);
});

// ============================================================
// B. Engine wiring invariants (hard — same repo)
// ============================================================

console.log('\n=== campaign-concurrency: engine wiring ===');

const engineHelperSrc = fs.readFileSync(SRC, 'utf8');
const orchestratorSrc = fs.readFileSync(ORCHESTRATOR_SRC, 'utf8');
const executeSrc = fs.readFileSync(EXECUTE_SRC, 'utf8');

function sliceBetween(src, startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, `${label}: start marker not found: ${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  assert.ok(e !== -1, `${label}: end marker not found: ${endMarker}`);
  return src.slice(s, e);
}

await test('helper declares the 4 active statuses incl. resting', () => {
  assert.ok(engineHelperSrc.includes("const ACTIVE_CAMPAIGN_STATUSES = ['running', 'processing', 'staged', 'resting'];"));
});

await test('orchestrator uses the shared helper (no local checkConcurrentLimit)', () => {
  assert.ok(orchestratorSrc.includes('checkUserConcurrentCampaigns('), 'missing shared-helper call');
  assert.ok(!/async function checkConcurrentLimit\(/.test(orchestratorSrc), 'local duplicate still defined');
});

await test('orchestrator reverts running → paused and returns 429 payload on rejection', () => {
  assert.ok(orchestratorSrc.includes('concurrentLimit: true'), 'missing concurrentLimit flag');
  assert.ok(orchestratorSrc.includes('status: "paused"'), 'missing revert-to-paused');
  assert.ok(orchestratorSrc.includes('Concurrent campaign limit reached ('), 'missing user-facing message');
});

await test('execute-campaign enforces the shared guard (defense-in-depth)', () => {
  assert.ok(executeSrc.includes('checkUserConcurrentCampaigns('), 'missing shared-helper call');
  assert.ok(!/async function checkConcurrentLimit\(/.test(executeSrc), 'local duplicate still defined');
  assert.ok(executeSrc.includes('concurrentLimit: true'), 'missing concurrentLimit flag');
  assert.ok(executeSrc.includes('status: "paused"'), 'missing revert-to-paused');
});

// ============================================================
// C. GAS parity (skipped when the sibling repo is absent)
// ============================================================

console.log('\n=== campaign-concurrency: GAS parity ===');

const gasSrc = readIfPresent(GAS_SRC);

await testOptional('GAS counts the same 4 active statuses', !!gasSrc, () => {
  assert.ok(gasSrc.includes('var activeStatuses = ["running", "processing", "staged", "resting"];'));
});

await testOptional('GAS rejection message matches the engine wording', !!gasSrc, () => {
  assert.ok(gasSrc.includes(`" running). Pause or complete a campaign to free a slot."`), 'GAS message diverged');
  assert.ok(orchestratorSrc.includes(ERROR_SUFFIX), 'engine message diverged');
  assert.ok(executeSrc.includes(ERROR_SUFFIX), 'execute-campaign message diverged');
});

await testOptional('GAS runCampaignPipeline: pre-check → mark running → dispatch (in that order)', !!gasSrc, () => {
  const fn = sliceBetween(gasSrc, 'function runCampaignPipeline(', 'function updateCampaign(', 'runCampaignPipeline');
  const preIdx = fn.indexOf('checkConcurrentCampaignsForUser(');
  const markIdx = fn.indexOf('status: "running"');
  const dispatchIdx = fn.indexOf('dispatchCampaignToServers(');
  assert.ok(preIdx !== -1, 'missing pre-check');
  assert.ok(markIdx !== -1, 'missing mark-running');
  assert.ok(dispatchIdx !== -1, 'missing dispatch');
  assert.ok(preIdx < markIdx, 'pre-check must run before marking running');
  assert.ok(markIdx < dispatchIdx, 'mark running must run before dispatch (race fix)');
});

await testOptional('GAS resumeCampaign pre-checks before flipping to running', !!gasSrc, () => {
  const fn = sliceBetween(gasSrc, 'function resumeCampaign(', 'function getCampaign(', 'resumeCampaign');
  assert.ok(fn.includes('checkConcurrentCampaignsForUser('), 'missing pre-check');
  const preIdx = fn.indexOf('checkConcurrentCampaignsForUser(');
  const flipIdx = fn.indexOf('status: "running"');
  assert.ok(preIdx !== -1 && flipIdx !== -1 && preIdx < flipIdx, 'pre-check must precede the status flip');
});

// ============================================================
// D. Frontend parity (skipped when the sibling repo is absent)
// ============================================================

console.log('\n=== campaign-concurrency: frontend parity ===');

const flagsSrc = readIfPresent(FLAGS_SRC);
const listSrc = readIfPresent(LIST_PAGE_SRC);
const detailSrc = readIfPresent(DETAIL_PAGE_SRC);
const modalSrc = readIfPresent(MODAL_SRC);

await testOptional('featureFlags mirrors the 4 statuses + limit fallback 1', !!flagsSrc, () => {
  assert.ok(flagsSrc.includes("const ACTIVE_CAMPAIGN_STATUSES = ['running', 'processing', 'staged', 'resting'];"));
  assert.ok(flagsSrc.includes("getSettingValueFromAppData(appData, 'campaignConcurrentLimit', '1')"));
});

await testOptional('list page hides Execute + Resume at limit (≥2 gates) + shows notice', !!listSrc, () => {
  const gates = listSrc.split('!concurrentState.atLimit').length - 1;
  assert.ok(gates >= 2, `expected ≥2 button gates, found ${gates}`);
  assert.ok(listSrc.includes('Concurrent campaign limit —'), 'missing notice');
});

await testOptional('detail page hides Execute/Retry/Resume at limit (≥3 gates) + shows notice', !!detailSrc, () => {
  const gates = detailSrc.split('!concurrentState.atLimit').length - 1;
  assert.ok(gates >= 3, `expected ≥3 button gates, found ${gates}`);
  assert.ok(detailSrc.includes('Concurrent campaign limit —'), 'missing notice');
});

await testOptional('modal replaces Execute Pipeline with an inline note at limit', !!modalSrc, () => {
  assert.ok(modalSrc.includes('concurrentState.atLimit ?'), 'missing atLimit ternary');
  assert.ok(modalSrc.includes('slots in use'), 'missing inline note');
});

// ============================================================
// RESULTS
// ============================================================

const skipNote = skipped > 0 ? `, ${skipped} skipped` : '';
console.log(`\n=== Results: ${passed} passed, ${failed} failed${skipNote} ===`);
process.exit(failed > 0 ? 1 : 0);
