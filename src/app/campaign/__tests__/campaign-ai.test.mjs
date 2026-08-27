/**
 * ISOLATION TESTS for campaign AI functions
 * Tests the prompt-building and response-parsing logic used in:
 *   - enrich-campaign/route.js (analyzeBatchWithGemini)
 *   - personalize-campaign/route.js (personalizeBatch, personalizeSocialBatch)
 *   - interact-campaign/route.js (classifyReply, generateAutoReply)
 *
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/campaign-ai.test.mjs
 */

import assert from 'assert';

// ============================================================
// MOCK AI PROVIDER
// ============================================================

let mockAIResponse = null;
let mockAICallCount = 0;
let mockAILastPrompt = null;

class MockMultiProviderAI {
  constructor() {
    mockAICallCount++;
  }
  async generate(prompt, options = {}) {
    mockAILastPrompt = prompt;
    if (mockAIResponse === null) throw new Error('AI provider failed');
    return mockAIResponse;
  }
}

// Inject mock into globalThis so routes can pick it up
globalThis.__MockMultiProviderAI = MockMultiProviderAI;

// ============================================================
// EXTRACTED LOGIC FROM ROUTE FILES
// (test the prompt building + response parsing without full route import)
// ============================================================

// --- enrich-campaign: analyzeBatchWithGemini ---
async function analyzeBatchWithAI(scrapeResults) {
  if (scrapeResults.length === 0) return [];

  const batchContent = scrapeResults.map((r, i) => {
    const parts = [r.title, r.description, r.bodyText?.slice(0, 800)].filter(Boolean).join('. ');
    return `[${i + 1}] ${parts}`;
  }).join('\n\n');

  const prompt = `Analyze these ${scrapeResults.length} webpage contents and extract useful information for cold outreach.

${batchContent}

Return a JSON array with one object per webpage (same order):
[{"summary": "2-3 sentence summary", "industry": "detected industry", "services": "key services/products"}, ...]`;

  try {
    const ai = new MockMultiProviderAI();
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    // silent
  }
  return [];
}

// --- personalize-campaign: personalizeBatch ---
async function personalizeBatch(batch, personalizationPrompt) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Company: ${contact.company}, Email: ${contact.email}${contact.context ? `, Context: ${contact.context.slice(0, 200)}` : ''}`
  ).join('\n');

  const prompt = `You are an expert personalized outreach copywriter. Generate highly tailored cold email subject lines and email bodies for these ${batch.length} recipients:

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per recipient (same order):
[{"subject": "Tailored subject line", "body": "Tailored email body"}, ...]`;

  try {
    const ai = new MockMultiProviderAI();
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    // silent
  }
  return batch.map(() => null);
}

// --- personalize-campaign: personalizeSocialBatch ---
async function personalizeSocialBatch(batch, personalizationPrompt) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Platform: ${contact.platform}, Username: ${contact.username}${contact.context ? `, About: ${contact.context.slice(0, 200)}` : ''}`
  ).join('\n');

  const prompt = `You are an expert social media outreach copywriter. Generate personalized DM messages for these ${batch.length} social media contacts:

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per contact (same order):
[{"message": "Personalized DM message"}, ...]`;

  try {
    const ai = new MockMultiProviderAI();
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    // silent
  }
  return batch.map(() => null);
}

// --- interact-campaign: classifyReply ---
async function classifyReply(replyBody) {
  const prompt = `Classify this email reply into one of these categories:
- positive: interested, wants to connect, scheduling meeting
- negative: not interested, rejection, do not contact
- neutral: questions, information request, acknowledgment
- out_of_office: auto-reply, vacation, away message
- unsubscribe: wants to be removed from mailing list

Reply body:
${replyBody.slice(0, 1000)}

Return ONLY a JSON object: {"type": "category", "confidence": 0.0-1.0}`;

  try {
    const ai = new MockMultiProviderAI();
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (err) {
    // silent
  }
  return { type: 'neutral', confidence: 0.5 };
}

// --- interact-campaign: generateAutoReply ---
async function generateAutoReply(replyType, campaignContext, senderEmail) {
  const prompt = `Generate a brief, professional auto-reply for an email campaign response.

Response type: ${replyType}
Campaign context: ${campaignContext || 'General outreach'}
Sender: ${senderEmail}

Rules:
- Keep it under 50 words
- Be professional and courteous
- For positive: express enthusiasm and suggest next steps
- For neutral: provide helpful information
- For negative: acknowledge and respect their decision
- For out_of_office: no reply needed

Return ONLY the reply text, no JSON or formatting.`;

  try {
    const ai = new MockMultiProviderAI();
    const text = await ai.generate(prompt);
    return text.trim();
  } catch (err) {
    // silent
  }
  return null;
}

// ============================================================
// TEST RUNNER
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    mockAIResponse = null;
    mockAICallCount = 0;
    mockAILastPrompt = null;
    const result = fn();
    if (result && typeof result.then === 'object' && typeof result.then === 'function') {
      return result.then(() => {
        console.log(`  ✅ ${name}`);
        passed++;
      }).catch(err => {
        console.log(`  ❌ ${name}: ${err.message}`);
        failed++;
      });
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

function testAsync(name, fn) {
  mockAIResponse = null;
  mockAICallCount = 0;
  mockAILastPrompt = null;
  return fn().then(() => {
    console.log(`  ✅ ${name}`);
    passed++;
  }).catch(err => {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  });
}

// ============================================================
// TESTS — analyzeBatchWithAI
// ============================================================

console.log('\n=== enrich-campaign: analyzeBatchWithAI ===');

await testAsync('returns parsed JSON from AI response', async () => {
  mockAIResponse = '[{"summary": "Tech company", "industry": "SaaS", "services": "Cloud platform"}]';
  const results = await analyzeBatchWithAI([
    { title: 'Acme Corp', description: 'Cloud platform', bodyText: 'We build clouds' }
  ]);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].industry, 'SaaS');
});

await testAsync('returns empty array for empty input', async () => {
  const results = await analyzeBatchWithAI([]);
  assert.strictEqual(results.length, 0);
});

await testAsync('returns empty array on AI failure', async () => {
  mockAIResponse = null; // will throw
  const results = await analyzeBatchWithAI([
    { title: 'Test', description: 'Desc', bodyText: 'Body' }
  ]);
  assert.strictEqual(results.length, 0);
});

await testAsync('returns empty array on malformed JSON', async () => {
  mockAIResponse = 'This is not JSON at all';
  const results = await analyzeBatchWithAI([
    { title: 'Test', description: 'Desc', bodyText: 'Body' }
  ]);
  assert.strictEqual(results.length, 0);
});

await testAsync('handles multiple scrape results', async () => {
  mockAIResponse = '[{"summary": "A"}, {"summary": "B"}, {"summary": "C"}]';
  const results = await analyzeBatchWithAI([
    { title: 'A', description: 'A', bodyText: 'A' },
    { title: 'B', description: 'B', bodyText: 'B' },
    { title: 'C', description: 'C', bodyText: 'C' },
  ]);
  assert.strictEqual(results.length, 3);
});

await testAsync('prompt includes count and content', async () => {
  mockAIResponse = '[]';
  await analyzeBatchWithAI([{ title: 'X', description: 'Y', bodyText: 'Z' }]);
  assert(mockAILastPrompt.includes('1 webpage contents'));
  assert(mockAILastPrompt.includes('[1] X. Y. Z'));
});

// ============================================================
// TESTS — personalizeBatch
// ============================================================

console.log('\n=== personalize-campaign: personalizeBatch ===');

await testAsync('returns subject+body per recipient', async () => {
  mockAIResponse = '[{"subject": "Hi there", "body": "Let us connect"}]';
  const results = await personalizeBatch([
    { firstName: 'John', company: 'Acme', email: 'john@acme.com', context: '' }
  ], 'Be friendly');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].subject, 'Hi there');
  assert.strictEqual(results[0].body, 'Let us connect');
});

await testAsync('returns nulls for empty batch', async () => {
  const results = await personalizeBatch([], 'prompt');
  assert.strictEqual(results.length, 0);
});

await testAsync('returns nulls on AI failure', async () => {
  mockAIResponse = null;
  const results = await personalizeBatch([
    { firstName: 'Jane', company: 'B', email: 'j@b.com', context: '' }
  ], 'prompt');
  assert.deepStrictEqual(results, [null]);
});

await testAsync('handles multiple recipients', async () => {
  mockAIResponse = '[{"subject": "S1", "body": "B1"}, {"subject": "S2", "body": "B2"}]';
  const results = await personalizeBatch([
    { firstName: 'A', company: 'X', email: 'a@x.com', context: '' },
    { firstName: 'B', company: 'Y', email: 'b@y.com', context: '' },
  ], 'Be concise');
  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].subject, 'S1');
  assert.strictEqual(results[1].subject, 'S2');
});

await testAsync('prompt includes recipient names and companies', async () => {
  mockAIResponse = '[]';
  await personalizeBatch([
    { firstName: 'Alice', company: 'TechCo', email: 'alice@tech.com', context: 'CTO' }
  ], 'Be professional');
  assert(mockAILastPrompt.includes('Alice'));
  assert(mockAILastPrompt.includes('TechCo'));
  assert(mockAILastPrompt.includes('Be professional'));
});

// ============================================================
// TESTS — personalizeSocialBatch
// ============================================================

console.log('\n=== personalize-campaign: personalizeSocialBatch ===');

await testAsync('returns DM message per contact', async () => {
  mockAIResponse = '[{"message": "Hey! Love your work on Twitter"}]';
  const results = await personalizeSocialBatch([
    { firstName: 'Bob', platform: 'twitter', username: '@bob', context: '' }
  ], 'Be casual');
  assert.strictEqual(results.length, 1);
  assert(results[0].message.includes('Hey'));
});

await testAsync('returns nulls for empty batch', async () => {
  const results = await personalizeSocialBatch([], 'prompt');
  assert.strictEqual(results.length, 0);
});

await testAsync('returns nulls on AI failure', async () => {
  mockAIResponse = null;
  const results = await personalizeSocialBatch([
    { firstName: 'X', platform: 'twitter', username: '@x', context: '' }
  ], 'prompt');
  assert.deepStrictEqual(results, [null]);
});

await testAsync('prompt includes platform and username', async () => {
  mockAIResponse = '[]';
  await personalizeSocialBatch([
    { firstName: 'Carol', platform: 'instagram', username: '@carol', context: 'Photographer' }
  ], 'Be creative');
  assert(mockAILastPrompt.includes('carol'));
  assert(mockAILastPrompt.includes('instagram'));
});

// ============================================================
// TESTS — classifyReply
// ============================================================

console.log('\n=== interact-campaign: classifyReply ===');

await testAsync('classifies positive reply', async () => {
  mockAIResponse = '{"type": "positive", "confidence": 0.9}';
  const result = await classifyReply('I am interested! Let us schedule a meeting.');
  assert.strictEqual(result.type, 'positive');
  assert.strictEqual(result.confidence, 0.9);
});

await testAsync('classifies negative reply', async () => {
  mockAIResponse = '{"type": "negative", "confidence": 0.85}';
  const result = await classifyReply('Please remove me from your list.');
  assert.strictEqual(result.type, 'negative');
});

await testAsync('returns neutral default on AI failure', async () => {
  mockAIResponse = null;
  const result = await classifyReply('Some reply');
  assert.strictEqual(result.type, 'neutral');
  assert.strictEqual(result.confidence, 0.5);
});

await testAsync('returns neutral default on malformed response', async () => {
  mockAIResponse = 'not json';
  const result = await classifyReply('Some reply');
  assert.strictEqual(result.type, 'neutral');
});

await testAsync('truncates long reply body to 1000 chars', async () => {
  mockAIResponse = '{"type": "neutral", "confidence": 0.5}';
  const longReply = 'x'.repeat(2000);
  await classifyReply(longReply);
  assert(mockAILastPrompt.includes('x'.repeat(1000)));
  assert(!mockAILastPrompt.includes('x'.repeat(1001)));
});

// ============================================================
// TESTS — generateAutoReply
// ============================================================

console.log('\n=== interact-campaign: generateAutoReply ===');

await testAsync('returns reply text', async () => {
  mockAIResponse = 'Thank you for your interest! Let me send you more details.';
  const result = await generateAutoReply('positive', 'SaaS demo', 'lead@co.com');
  assert(result.includes('Thank you'));
});

await testAsync('returns null on AI failure', async () => {
  mockAIResponse = null;
  const result = await generateAutoReply('positive', 'context', 'sender@co.com');
  assert.strictEqual(result, null);
});

await testAsync('prompt includes reply type and context', async () => {
  mockAIResponse = 'OK';
  await generateAutoReply('negative', 'Product demo', 'user@test.com');
  assert(mockAILastPrompt.includes('negative'));
  assert(mockAILastPrompt.includes('Product demo'));
  assert(mockAILastPrompt.includes('user@test.com'));
});

// ============================================================
// SUMMARY
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
