/**
 * ISOLATION TESTS for pipeline-orchestrator/route.js
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/pipeline-orchestrator.test.mjs
 *
 * Tests the resolveCurrentStage logic by re-implementing it locally
 * (the route module has side-effect imports that make direct testing difficult).
 */

import assert from 'assert';

// ============================================================
// RE-IMPLEMENT resolveCurrentStage for isolated testing
// ============================================================

const STAGE_ORDER = ["validate", "enrich", "personalize", "execute", "interact"];

const STAGE_CONFIG = {
  validate: {
    stagedField: "validationStaged",
    statusField: "validationStatus",
    route: "/campaign/validate-campaign",
    label: "Validation",
  },
  enrich: {
    stagedField: "enrichmentStaged",
    statusField: "enrichmentStatus",
    route: "/campaign/enrich-campaign",
    label: "Enrichment",
  },
  personalize: {
    stagedField: "aiPersonalizationStaged",
    statusField: "personalizationStatus",
    route: "/campaign/personalize-campaign",
    label: "AI Personalization",
  },
  execute: {
    stagedField: "executeStaged",
    statusField: null,
    route: "/campaign/execute-campaign",
    label: "Execute",
  },
  interact: {
    stagedField: "interactionStaged",
    statusField: "interactionStatus",
    route: "/campaign/interact-campaign",
    label: "Interaction",
  },
};

function resolveCurrentStage(settings) {
  for (const stage of STAGE_ORDER) {
    const config = STAGE_CONFIG[stage];
    const isStaged = settings[config.stagedField] === true;
    if (!isStaged) continue;

    if (config.statusField) {
      const status = settings[config.statusField];
      if (status === "completed") continue;
      if (status === "processing") return { stage, action: "wait" };
      if (status === "failed") return { stage, action: "fail" };
    }

    if (stage === "execute") {
      const campaignStatus = settings._campaignStatus;
      if (campaignStatus === "completed" || campaignStatus === "Limit Reached") continue;
    }

    return { stage, action: "run" };
  }
  return null;
}

// ============================================================
// TESTS
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

// ============================================================
// resolveCurrentStage: basic stage ordering
// ============================================================

console.log('\n=== pipeline-orchestrator: resolveCurrentStage — stage ordering ===');

test('returns validate first when all stages are staged and idle', () => {
  const settings = {
    validationStaged: true, validationStatus: 'idle',
    enrichmentStaged: true, enrichmentStatus: 'idle',
    aiPersonalizationStaged: true, personalizationStatus: 'idle',
    executeStaged: true,
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'validate', action: 'run' });
});

test('skips validate when completed, returns enrich', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'idle',
    aiPersonalizationStaged: true, personalizationStatus: 'idle',
    executeStaged: true,
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'enrich', action: 'run' });
});

test('skips through validate+enrich+personalize, returns execute', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'completed',
    executeStaged: true,
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'execute', action: 'run' });
});

test('returns null when all stages are completed', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'completed',
    executeStaged: true, _campaignStatus: 'completed',
    interactionStaged: true, interactionStatus: 'completed',
  };
  const result = resolveCurrentStage(settings);
  assert.strictEqual(result, null);
});

test('returns null when no stages are staged', () => {
  const settings = {};
  const result = resolveCurrentStage(settings);
  assert.strictEqual(result, null);
});

// ============================================================
// resolveCurrentStage: status-based actions
// ============================================================

console.log('\n=== pipeline-orchestrator: resolveCurrentStage — status actions ===');

test('returns wait when validate is processing', () => {
  const settings = {
    validationStaged: true, validationStatus: 'processing',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'validate', action: 'wait' });
});

test('returns fail when validate has failed', () => {
  const settings = {
    validationStaged: true, validationStatus: 'failed',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'validate', action: 'fail' });
});

test('returns wait when enrich is processing (validate completed)', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'processing',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'enrich', action: 'wait' });
});

test('returns fail when personalize has failed (earlier stages completed)', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'failed',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'personalize', action: 'fail' });
});

// ============================================================
// resolveCurrentStage: execute stage special handling
// ============================================================

console.log('\n=== pipeline-orchestrator: resolveCurrentStage — execute stage ===');

test('execute stage runs when _campaignStatus is idle', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'completed',
    executeStaged: true, _campaignStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'execute', action: 'run' });
});

test('execute stage skips when _campaignStatus is completed', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'completed',
    executeStaged: true, _campaignStatus: 'completed',
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'interact', action: 'run' });
});

test('execute stage skips when _campaignStatus is Limit Reached', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    executeStaged: true, _campaignStatus: 'Limit Reached',
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'interact', action: 'run' });
});

// ============================================================
// resolveCurrentStage: unstaged stages are skipped
// ============================================================

console.log('\n=== pipeline-orchestrator: resolveCurrentStage — unstaged stages ===');

test('skips unstaged validate, returns enrich', () => {
  const settings = {
    validationStaged: false,
    enrichmentStaged: true, enrichmentStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'enrich', action: 'run' });
});

test('skips unstaged stages, returns first staged one', () => {
  const settings = {
    validationStaged: false,
    enrichmentStaged: false,
    aiPersonalizationStaged: true, personalizationStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'personalize', action: 'run' });
});

test('only execute staged — returns execute', () => {
  const settings = {
    validationStaged: false,
    enrichmentStaged: false,
    aiPersonalizationStaged: false,
    executeStaged: true,
    interactionStaged: false,
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'execute', action: 'run' });
});

test('only interact staged — returns interact', () => {
  const settings = {
    validationStaged: false,
    enrichmentStaged: false,
    aiPersonalizationStaged: false,
    executeStaged: false,
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'interact', action: 'run' });
});

// ============================================================
// resolveCurrentStage: mixed scenarios
// ============================================================

console.log('\n=== pipeline-orchestrator: resolveCurrentStage — mixed scenarios ===');

test('validate completed, enrich processing → returns wait for enrich', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'processing',
    executeStaged: true,
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'enrich', action: 'wait' });
});

test('validate+enrich completed, personalize completed, execute not staged → returns null (no interact staged)', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'completed',
    executeStaged: false,
    interactionStaged: false,
  };
  const result = resolveCurrentStage(settings);
  assert.strictEqual(result, null);
});

test('validate completed, enrich completed, personalize idle, execute staged → returns personalize', () => {
  const settings = {
    validationStaged: true, validationStatus: 'completed',
    enrichmentStaged: true, enrichmentStatus: 'completed',
    aiPersonalizationStaged: true, personalizationStatus: 'idle',
    executeStaged: true,
    interactionStaged: true, interactionStatus: 'idle',
  };
  const result = resolveCurrentStage(settings);
  assert.deepStrictEqual(result, { stage: 'personalize', action: 'run' });
});

// ============================================================
// STAGE_ORDER and STAGE_CONFIG consistency
// ============================================================

console.log('\n=== pipeline-orchestrator: STAGE_ORDER and STAGE_CONFIG ===');

test('STAGE_ORDER has 5 stages', () => {
  assert.strictEqual(STAGE_ORDER.length, 5);
});

test('STAGE_ORDER is in correct sequence', () => {
  assert.deepStrictEqual(STAGE_ORDER, ['validate', 'enrich', 'personalize', 'execute', 'interact']);
});

test('STAGE_CONFIG has entry for each stage in STAGE_ORDER', () => {
  for (const stage of STAGE_ORDER) {
    assert.ok(STAGE_CONFIG[stage], `Missing config for stage: ${stage}`);
    assert.ok(STAGE_CONFIG[stage].stagedField, `Missing stagedField for stage: ${stage}`);
    assert.ok(STAGE_CONFIG[stage].route, `Missing route for stage: ${stage}`);
    assert.ok(STAGE_CONFIG[stage].label, `Missing label for stage: ${stage}`);
  }
});

test('execute stage has null statusField (uses _campaignStatus)', () => {
  assert.strictEqual(STAGE_CONFIG.execute.statusField, null);
});

test('all other stages have statusField defined', () => {
  for (const stage of STAGE_ORDER) {
    if (stage === 'execute') continue;
    assert.ok(STAGE_CONFIG[stage].statusField, `Missing statusField for stage: ${stage}`);
  }
});

// ============================================================
// RESULTS
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
