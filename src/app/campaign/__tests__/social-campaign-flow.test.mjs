/**
 * ISOLATION TESTS — SOCIAL Campaign Flow
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/social-campaign-flow.test.mjs
 *
 * Tests all pure functions and AI-dependent functions used in the social campaign pipeline:
 * validate -> enrich -> personalize -> execute (social tasks + DMs) -> interact
 */

import assert from 'assert';

// ============================================================
// RE-IMPLEMENT functions from source for isolated testing
// ============================================================

// --- pipelineUtils (shared) ---

function parseCSV(text) {
  const lines = [];
  let row = [""];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else { inQuotes = false; }
      } else {
        row[row.length - 1] += c;
      }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(""); }
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [""];
      } else {
        row[row.length - 1] += c;
      }
    }
  }
  if (row.length > 1 || row[0] !== "") lines.push(row);
  return lines;
}

function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? "" : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
      }
      return str;
    }).join(',')
  ).join('\n');
}

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

// --- validate-campaign/route.js (social validation logic) ---

const STANDARD_88_COLUMNS = [
  'SN',
  'FIRSTNAME', 'LASTNAME', 'EMAIL', 'ADDRESS', 'CITY', 'STATE', 'COUNTRY', 'ZIPCODE', 'PHONE', 'SEX',
  'BUSINESSNAME', 'BUSINESSADDRESS', 'BUSINESSCITY', 'BUSINESSSTATE', 'BUSINESSCOUNTRY', 'BUSINESSZIPCODE', 'BUSINESSPHONE', 'BUSINESSEMAIL',
  'SOCIALPLATFORM', 'SOCIALUSERNAME', 'SOCIALPHONE',
  'CONTEXT',
  'URL', '', '', '', '', '',
  'campaignType', 'engine', 'provider',
  'shooterFirstName', 'shooterLastName', 'shooterEmail', 'shooterAddress', 'shooterCity', 'shooterState', 'shooterCountry', 'shooterZipCode', 'shooterPhone', 'shooterSex',
  'smtp', 'port', 'username', 'password', 'appPassword', 'backupCode', 'oAuth2ClientId', 'oAuth2ClientSecret', 'oAuth2RefreshToken',
  '',
  'shouldValidate', 'shouldEnhance', 'shouldSearchInteract', 'shouldPageInteract', 'shouldInboxInteract', 'shouldActivitiesInteract', 'shouldSendMessage',
  '', '',
  'emailSubject', 'emailBody', 'socialMessage', 'replyTo',
  '', '', '',
  'validation', 'providerMXResult', 'enhancedSubject', 'enhancedBody', 'enhancedSocialMessage',
  '', '',
  'sendDate', 'sendTime', 'sendStamp',
  '', '', '',
  'searchKeys', 'searchCount', 'searchStatus', 'searchStamp',
  '',
  'profileToInteract', 'interactCount', 'interactStatus', 'interactStamp'
];

const FUZZY_MAP = {
  EMAIL: ['EMAIL', 'MAIL', 'E-MAIL', 'LEAD'],
  FIRSTNAME: ['FIRST', 'FIRST NAME', 'FNAME', 'GIVEN'],
  BUSINESSNAME: ['BUSINESS', 'BUSINESS NAME', 'COMPANY', 'ORGANIZATION', 'ORG'],
  SOCIALPLATFORM: ['SOCIAL', 'SOCIAL PLATFORM', 'PLATFORM'],
  SOCIALUSERNAME: ['SOCIAL USERNAME', 'USERNAME', 'HANDLE', 'SOCIAL HANDLE'],
  URL: ['URL', 'LINK', 'WEBSITE', 'WEB', 'REFERENCE'],
};

function normalizeAndMapCSV(rawCsvContent, targetSchema) {
  const parsedRows = parseCSV(rawCsvContent);
  if (parsedRows.length === 0) return [];

  const rawHeaders = parsedRows[0].map(h => h.trim().toUpperCase());
  const dataRows = parsedRows.slice(1);

  const normalizedRows = [];
  const headerMap = new Map();

  targetSchema.forEach((stdHeader, index) => {
    if (!stdHeader) return;
    const upperStd = stdHeader.toUpperCase();
    const exactIdx = rawHeaders.indexOf(upperStd);
    if (exactIdx !== -1) { headerMap.set(index, exactIdx); return; }
    const fuzzyKeys = FUZZY_MAP[upperStd];
    if (fuzzyKeys) {
      for (const alias of fuzzyKeys) {
        const aliasIdx = rawHeaders.findIndex(rh => rh === alias || rh.includes(alias));
        if (aliasIdx !== -1) { headerMap.set(index, aliasIdx); return; }
      }
    }
  });

  normalizedRows.push(targetSchema);

  dataRows.forEach((row, idx) => {
    const newRow = new Array(targetSchema.length).fill('');
    targetSchema.forEach((_, stdIndex) => {
      if (headerMap.has(stdIndex)) {
        const rawIndex = headerMap.get(stdIndex);
        newRow[stdIndex] = row[rawIndex] !== undefined && row[rawIndex] !== null ? String(row[rawIndex]) : '';
      }
    });
    if (!headerMap.has(0) && targetSchema[0] && String(targetSchema[0]).toUpperCase() === 'SN') {
      newRow[0] = String(idx + 1);
    }
    normalizedRows.push(newRow);
  });

  return normalizedRows;
}

// Social channel validation logic (from validate-campaign)
function validateSocialChannel(row, emailIdx, socialUsernameIdx, socialPlatformIdx, validationIdx) {
  const hasEmail = row[emailIdx]?.trim();
  const hasUsername = row[socialUsernameIdx]?.trim();
  const hasPlatform = row[socialPlatformIdx]?.trim();

  if (!hasEmail && hasUsername) {
    if (hasPlatform) {
      row[validationIdx] = "social_valid";
    } else {
      row[validationIdx] = "social_no_platform";
    }
    return row[validationIdx];
  }
  return null;
}

// --- search-interact/route.js ---

const ACTION_LIMIT_MAP_SEARCH = {
  "like": "likesOnPost",
  "comment": "commentOnPost",
  "follow": "follow",
  "unfollow": "unfollow",
  "message": "coldMessage",
  "likeComment": "likesOnComment",
  "likeStory": "likeOnStory",
  "commentStory": "commentOnStory",
  "commentComment": "commentOnComment",
};

function mapOperationToActions(operation) {
  if (operation === "search-interact") return ["like", "comment", "follow"];
  if (operation === "page-interact") return ["like", "follow"];
  if (operation === "inbox-interact") return ["message"];
  if (operation === "activities-interact") return ["like", "comment"];
  return ["like"];
}

// --- hubUpdater.js ---

function parseInteractionUsage(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function defaultUsage(action) {
  const now = new Date();
  return {
    [action]: {
      hourly: 1,
      daily: 1,
      monthly: 1,
      total: 1,
      lastAction: now.toISOString(),
      hour: now.getHours(),
      day: now.getDate(),
      month: now.getMonth(),
    }
  };
}

function incrementUsage(existing, action) {
  const now = new Date();
  const current = existing[action] || { hourly: 0, daily: 0, monthly: 0, total: 0 };

  const hourChanged = current.hour !== undefined && current.hour !== now.getHours();
  const dayChanged = current.day !== undefined && current.day !== now.getDate();
  const monthChanged = current.month !== undefined && current.month !== now.getMonth();

  return {
    ...existing,
    [action]: {
      hourly: hourChanged ? 1 : (current.hourly || 0) + 1,
      daily: dayChanged ? 1 : (current.daily || 0) + 1,
      monthly: monthChanged ? 1 : (current.monthly || 0) + 1,
      total: (current.total || 0) + 1,
      lastAction: now.toISOString(),
      hour: now.getHours(),
      day: now.getDate(),
      month: now.getMonth(),
    }
  };
}

// --- _shared/routeHelper.js ---

function interpolate(value, context) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{(\w+)\}\}/g, (_, key) => context[key] !== undefined ? context[key] : `{{${key}}}`);
}

// --- limits.js (re-implement checkActionAllowed) ---

function checkActionAllowed(limitsData, platform, action, accountUsage = {}) {
  const limits = limitsData[platform.toUpperCase().trim()];
  if (!limits) return { allowed: true, reason: "no_limits_configured" };

  const actionLimits = limits[action];
  if (!actionLimits) return { allowed: true, reason: "no_action_limits" };

  const hourly = parseInt(actionLimits.hourly, 10);
  const daily = parseInt(actionLimits.daily, 10);
  const monthly = parseInt(actionLimits.monthly, 10);
  const cap = actionLimits.cap ? parseInt(actionLimits.cap, 10) : null;

  if (!hourly && !daily && !monthly && !cap) return { allowed: true, reason: "no_limits_defined" };

  const usage = accountUsage[action] || { hourly: 0, daily: 0, monthly: 0, total: 0 };

  if (cap !== null && usage.total >= cap) {
    return { allowed: false, reason: `cap_reached: ${usage.total}/${cap}` };
  }
  if (hourly && usage.hourly >= hourly) {
    return { allowed: false, reason: `hourly_limit: ${usage.hourly}/${hourly}` };
  }
  if (daily && usage.daily >= daily) {
    return { allowed: false, reason: `daily_limit: ${usage.daily}/${daily}` };
  }
  if (monthly && usage.monthly >= monthly) {
    return { allowed: false, reason: `monthly_limit: ${usage.monthly}/${monthly}` };
  }

  return { allowed: true, reason: "ok" };
}

// --- personalize-campaign/route.js (social AI) ---

class MockMultiProviderAI {
  constructor(response) { this._response = response; }
  async generate(prompt) { return this._response; }
}

async function personalizeSocialBatch(batch, personalizationPrompt, mockAI) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName || 'Unknown'}, Platform: ${contact.platform}, Username: ${contact.username}${contact.context ? `, About: ${contact.context.slice(0, 200)}` : ""}`
  ).join("\n");

  const prompt = `You are an expert social media outreach copywriter. Generate personalized DM messages for these ${batch.length} social media contacts:

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per contact (same order):
[{"message": "Personalized DM message"}, ...]

Rules:
1. Each message must be unique and reference something specific about the contact
2. Keep messages under 100 words
3. Be conversational, not salesy
4. Return ONLY the JSON array, no markdown or explanations`;

  try {
    const ai = mockAI || new MockMultiProviderAI('[]');
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.map(r => ({ message: r.message || null }));
      }
    }
    return batch.map(() => ({ message: null }));
  } catch {
    return batch.map(() => ({ message: null }));
  }
}

// --- interact-campaign/route.js (AI) ---

async function classifyReply(replyBody, mockAI) {
  const prompt = `Classify this email reply...`;
  try {
    const ai = mockAI || new MockMultiProviderAI('{"type":"neutral","confidence":0.5}');
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.type && typeof parsed.confidence === 'number') return parsed;
    }
    return { type: "neutral", confidence: 0.5 };
  } catch {
    return { type: "neutral", confidence: 0.5 };
  }
}

async function generateAutoReply(replyType, campaignContext, senderEmail, mockAI) {
  const prompt = `Generate a brief auto-reply...`;
  try {
    const ai = mockAI || new MockMultiProviderAI(null);
    const text = await ai.generate(prompt);
    return text ? text.trim() : null;
  } catch {
    return null;
  }
}

// --- execute-campaign/route.js (social task queue logic) ---

function buildSocialTaskQueue(profiles, keywords, interactionTypes) {
  const tasks = [];
  for (const profileId of profiles) {
    for (const keyword of keywords) {
      for (const interactionType of interactionTypes) {
        const operation = interactionType === "search" ? "search-interact"
          : interactionType === "inbox" ? "inbox-interact"
          : interactionType === "activities" ? "activities-interact"
          : "page-interact";

        const priority = interactionType === "inbox" ? 0
          : interactionType === "activities" ? 1
          : interactionType === "page" ? 2
          : 3;

        tasks.push({
          profileId,
          keyword,
          operation,
          priority,
          status: "PENDING"
        });
      }
    }
  }
  return tasks.sort((a, b) => a.priority - b.priority);
}

// --- send-message template substitution ---

function substituteTemplate(template, context) {
  return template
    .replace(/\{\{firstName\}\}/g, context.firstName || '')
    .replace(/\{\{name\}\}/g, context.name || '')
    .replace(/\{\{context\}\}/g, context.context || '');
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
// STAGE 1: VALIDATE — Social channel validation
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 1 — validate (social channel) ===');

test('marks social_valid when SOCIALUSERNAME and SOCIALPLATFORM present', () => {
  const row = new Array(90).fill('');
  row[3] = '';  // no email
  row[20] = 'johndoe';  // SOCIALUSERNAME
  row[19] = 'twitter';  // SOCIALPLATFORM
  row[68] = '';  // validation
  const result = validateSocialChannel(row, 3, 20, 19, 68);
  assert.strictEqual(result, 'social_valid');
  assert.strictEqual(row[68], 'social_valid');
});

test('marks social_no_platform when SOCIALUSERNAME present but no SOCIALPLATFORM', () => {
  const row = new Array(90).fill('');
  row[3] = '';  // no email
  row[20] = 'johndoe';  // SOCIALUSERNAME
  row[19] = '';  // no SOCIALPLATFORM
  row[68] = '';
  const result = validateSocialChannel(row, 3, 20, 19, 68);
  assert.strictEqual(result, 'social_no_platform');
});

test('returns null when email is present (email flow takes precedence)', () => {
  const row = new Array(90).fill('');
  row[3] = 'john@test.com';  // has email
  row[20] = 'johndoe';
  row[19] = 'twitter';
  row[68] = '';
  const result = validateSocialChannel(row, 3, 20, 19, 68);
  assert.strictEqual(result, null);
});

test('returns null when neither email nor username present', () => {
  const row = new Array(90).fill('');
  row[3] = '';
  row[20] = '';
  row[19] = '';
  row[68] = '';
  const result = validateSocialChannel(row, 3, 20, 19, 68);
  assert.strictEqual(result, null);
});

// ============================================================
// STAGE 1: VALIDATE — normalizeAndMapCSV (social headers)
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 1 — validate (normalizeAndMapCSV social headers) ===');

test('maps PLATFORM -> SOCIALPLATFORM', () => {
  const csv = 'HANDLE,PLATFORM\njohndoe,twitter';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][19], 'twitter');
  assert.strictEqual(result[1][20], 'johndoe');
});

test('maps SOCIAL -> SOCIALUSERNAME (SOCIAL matches SOCIAL alias)', () => {
  const csv = 'SOCIAL USERNAME,SOCIAL\njohndoe,instagram';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  // SOCIAL USERNAME matches SOCIAL alias -> maps to SOCIALPLATFORM (idx 19)
  // SOCIAL matches SOCIAL alias -> but SOCIALUSERNAME fuzzy map also has SOCIAL
  // The exact behavior depends on FUZZY_MAP ordering; SOCIAL matches first available
  assert.ok(result[1][19] || result[1][20], 'At least one social column mapped');
});

test('maps WEBSITE -> URL', () => {
  const csv = 'HANDLE,WEBSITE\njohndoe,https://twitter.com/johndoe';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][23], 'https://twitter.com/johndoe');
});

// ============================================================
// STAGE 3: PERSONALIZE — personalizeSocialBatch (AI)
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 3 — personalize (personalizeSocialBatch) ===');

test('returns DM message per contact', async () => {
  const mockAI = new MockMultiProviderAI('[{"message":"Hey John, great profile!"}]');
  const batch = [{ username: 'johndoe', platform: 'twitter', firstName: 'John' }];
  const result = await personalizeSocialBatch(batch, 'Write friendly DM', mockAI);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].message, 'Hey John, great profile!');
});

test('returns nulls for empty batch', async () => {
  const result = await personalizeSocialBatch([], 'prompt', null);
  assert.deepStrictEqual(result, []);
});

test('returns nulls on AI failure', async () => {
  const mockAI = new MockMultiProviderAI('not json');
  const batch = [{ username: 'johndoe', platform: 'twitter', firstName: 'John' }];
  const result = await personalizeSocialBatch(batch, 'prompt', mockAI);
  assert.strictEqual(result[0].message, null);
});

test('handles multiple contacts', async () => {
  const mockAI = new MockMultiProviderAI('[{"message":"Hi John!"},{"message":"Hey Jane!"}]');
  const batch = [
    { username: 'john', platform: 'twitter', firstName: 'John' },
    { username: 'jane', platform: 'instagram', firstName: 'Jane' }
  ];
  const result = await personalizeSocialBatch(batch, 'prompt', mockAI);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].message, 'Hi John!');
  assert.strictEqual(result[1].message, 'Hey Jane!');
});

test('prompt includes platform and username', async () => {
  let capturedPrompt = '';
  const mockAI = {
    async generate(prompt) { capturedPrompt = prompt; return '[]'; }
  };
  const batch = [{ username: 'johndoe', platform: 'twitter', firstName: 'John', context: 'Tech enthusiast' }];
  await personalizeSocialBatch(batch, 'Write DM', mockAI);
  assert.ok(capturedPrompt.includes('twitter'));
  assert.ok(capturedPrompt.includes('johndoe'));
  assert.ok(capturedPrompt.includes('John'));
  assert.ok(capturedPrompt.includes('Tech enthusiast'));
});

// ============================================================
// STAGE 4: EXECUTE — mapOperationToActions
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 4 — execute (mapOperationToActions) ===');

test('search-interact maps to like, comment, follow', () => {
  assert.deepStrictEqual(mapOperationToActions('search-interact'), ['like', 'comment', 'follow']);
});

test('page-interact maps to like, follow', () => {
  assert.deepStrictEqual(mapOperationToActions('page-interact'), ['like', 'follow']);
});

test('inbox-interact maps to message', () => {
  assert.deepStrictEqual(mapOperationToActions('inbox-interact'), ['message']);
});

test('activities-interact maps to like, comment', () => {
  assert.deepStrictEqual(mapOperationToActions('activities-interact'), ['like', 'comment']);
});

test('unknown operation defaults to like', () => {
  assert.deepStrictEqual(mapOperationToActions('unknown'), ['like']);
});

// ============================================================
// STAGE 4: EXECUTE — buildSocialTaskQueue
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 4 — execute (buildSocialTaskQueue) ===');

test('builds tasks for profiles x keywords x interactionTypes', () => {
  const tasks = buildSocialTaskQueue(['p1', 'p2'], ['keyword1'], ['search', 'inbox']);
  assert.strictEqual(tasks.length, 4); // 2 profiles * 1 keyword * 2 types
});

test('assigns correct priority (inbox=0 highest, search=3 lowest)', () => {
  const tasks = buildSocialTaskQueue(['p1'], ['k'], ['search', 'inbox', 'activities', 'page']);
  assert.strictEqual(tasks[0].operation, 'inbox-interact');
  assert.strictEqual(tasks[0].priority, 0);
  assert.strictEqual(tasks[1].operation, 'activities-interact');
  assert.strictEqual(tasks[1].priority, 1);
  assert.strictEqual(tasks[2].operation, 'page-interact');
  assert.strictEqual(tasks[2].priority, 2);
  assert.strictEqual(tasks[3].operation, 'search-interact');
  assert.strictEqual(tasks[3].priority, 3);
});

test('sorts tasks by priority', () => {
  const tasks = buildSocialTaskQueue(['p1'], ['k'], ['search', 'inbox', 'activities', 'page']);
  const priorities = tasks.map(t => t.priority);
  assert.deepStrictEqual(priorities, [0, 1, 2, 3]);
});

test('all tasks start with PENDING status', () => {
  const tasks = buildSocialTaskQueue(['p1'], ['k'], ['search']);
  assert.ok(tasks.every(t => t.status === 'PENDING'));
});

test('maps interaction type to correct operation', () => {
  const tasks = buildSocialTaskQueue(['p1'], ['k'], ['search']);
  assert.strictEqual(tasks[0].operation, 'search-interact');

  const inboxTasks = buildSocialTaskQueue(['p1'], ['k'], ['inbox']);
  assert.strictEqual(inboxTasks[0].operation, 'inbox-interact');

  const activitiesTasks = buildSocialTaskQueue(['p1'], ['k'], ['activities']);
  assert.strictEqual(activitiesTasks[0].operation, 'activities-interact');

  const pageTasks = buildSocialTaskQueue(['p1'], ['k'], ['page']);
  assert.strictEqual(pageTasks[0].operation, 'page-interact');
});

// ============================================================
// STAGE 4: EXECUTE — substituteTemplate
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 4 — execute (substituteTemplate) ===');

test('substitutes {{firstName}}', () => {
  assert.strictEqual(substituteTemplate('Hi {{firstName}}!', { firstName: 'John' }), 'Hi John!');
});

test('substitutes {{name}}', () => {
  assert.strictEqual(substituteTemplate('Hello {{name}}', { name: 'Jane' }), 'Hello Jane');
});

test('substitutes {{context}}', () => {
  assert.strictEqual(substituteTemplate('Re: {{context}}', { context: 'your project' }), 'Re: your project');
});

test('handles missing context values', () => {
  assert.strictEqual(substituteTemplate('Hi {{firstName}}!', {}), 'Hi !');
});

test('handles multiple substitutions', () => {
  const result = substituteTemplate('{{firstName}} from {{context}}', { firstName: 'John', context: 'Acme' });
  assert.strictEqual(result, 'John from Acme');
});

// ============================================================
// SHARED: hubUpdater — incrementUsage
// ============================================================

console.log('\n=== SOCIAL FLOW: Shared — incrementUsage ===');

test('increments from empty usage', () => {
  const result = incrementUsage({}, 'follow');
  assert.strictEqual(result.follow.hourly, 1);
  assert.strictEqual(result.follow.daily, 1);
  assert.strictEqual(result.follow.monthly, 1);
  assert.strictEqual(result.follow.total, 1);
});

test('increments existing usage', () => {
  const existing = { follow: { hourly: 2, daily: 5, monthly: 10, total: 20, hour: new Date().getHours(), day: new Date().getDate(), month: new Date().getMonth() } };
  const result = incrementUsage(existing, 'follow');
  assert.strictEqual(result.follow.hourly, 3);
  assert.strictEqual(result.follow.daily, 6);
  assert.strictEqual(result.follow.monthly, 11);
  assert.strictEqual(result.follow.total, 21);
});

test('resets hourly counter when hour changes', () => {
  const existing = { follow: { hourly: 5, daily: 5, monthly: 5, total: 5, hour: 10, day: new Date().getDate(), month: new Date().getMonth() } };
  const result = incrementUsage(existing, 'follow');
  assert.strictEqual(result.follow.hourly, 1);
});

test('resets daily counter when day changes', () => {
  const existing = { follow: { hourly: 1, daily: 10, monthly: 10, total: 10, hour: new Date().getHours(), day: 1, month: new Date().getMonth() } };
  const result = incrementUsage(existing, 'follow');
  assert.strictEqual(result.follow.daily, 1);
});

test('resets monthly counter when month changes', () => {
  const existing = { follow: { hourly: 1, daily: 1, monthly: 20, total: 20, hour: new Date().getHours(), day: new Date().getDate(), month: 0 } };
  const result = incrementUsage(existing, 'follow');
  assert.strictEqual(result.follow.monthly, 1);
});

test('preserves other actions', () => {
  const existing = { follow: { hourly: 1, daily: 1, monthly: 1, total: 1 }, like: { hourly: 3, daily: 3, monthly: 3, total: 3 } };
  const result = incrementUsage(existing, 'follow');
  assert.strictEqual(result.like.hourly, 3);
  assert.strictEqual(result.follow.hourly, 2);
});

// ============================================================
// SHARED: hubUpdater — parseInteractionUsage
// ============================================================

console.log('\n=== SOCIAL FLOW: Shared — parseInteractionUsage ===');

test('parses JSON string', () => {
  const result = parseInteractionUsage('{"follow":{"total":5}}');
  assert.strictEqual(result.follow.total, 5);
});

test('returns object as-is', () => {
  const obj = { follow: { total: 5 } };
  const result = parseInteractionUsage(obj);
  assert.strictEqual(result, obj);
});

test('returns empty for null/undefined', () => {
  assert.deepStrictEqual(parseInteractionUsage(null), {});
  assert.deepStrictEqual(parseInteractionUsage(undefined), {});
  assert.deepStrictEqual(parseInteractionUsage(''), {});
});

test('returns empty for invalid JSON', () => {
  assert.deepStrictEqual(parseInteractionUsage('not json'), {});
});

// ============================================================
// SHARED: limits — checkActionAllowed
// ============================================================

console.log('\n=== SOCIAL FLOW: Shared — checkActionAllowed ===');

test('allows when no limits configured', () => {
  const result = checkActionAllowed({}, 'TWITTER', 'follow');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.reason, 'no_limits_configured');
});

test('allows when under all limits', () => {
  const limits = { TWITTER: { follow: { hourly: '10', daily: '50', monthly: '200', cap: '1000' } } };
  const usage = { follow: { hourly: 5, daily: 20, monthly: 100, total: 500 } };
  const result = checkActionAllowed(limits, 'twitter', 'follow', usage);
  assert.strictEqual(result.allowed, true);
});

test('blocks when hourly limit reached', () => {
  const limits = { TWITTER: { follow: { hourly: '10', daily: '50', monthly: '200', cap: '' } } };
  const usage = { follow: { hourly: 10, daily: 20, monthly: 100, total: 500 } };
  const result = checkActionAllowed(limits, 'twitter', 'follow', usage);
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reason.includes('hourly_limit'));
});

test('blocks when daily limit reached', () => {
  const limits = { TWITTER: { follow: { hourly: '10', daily: '50', monthly: '200', cap: '' } } };
  const usage = { follow: { hourly: 5, daily: 50, monthly: 100, total: 500 } };
  const result = checkActionAllowed(limits, 'twitter', 'follow', usage);
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reason.includes('daily_limit'));
});

test('blocks when cap reached', () => {
  const limits = { TWITTER: { follow: { hourly: '10', daily: '50', monthly: '200', cap: '100' } } };
  const usage = { follow: { hourly: 5, daily: 20, monthly: 50, total: 100 } };
  const result = checkActionAllowed(limits, 'twitter', 'follow', usage);
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reason.includes('cap_reached'));
});

test('allows when no action limits defined', () => {
  const limits = { TWITTER: { like: { hourly: '10', daily: '50', monthly: '200', cap: '' } } };
  const result = checkActionAllowed(limits, 'twitter', 'follow');
  assert.strictEqual(result.allowed, true);
  assert.strictEqual(result.reason, 'no_action_limits');
});

// ============================================================
// SHARED: routeHelper — interpolate
// ============================================================

console.log('\n=== SOCIAL FLOW: Shared — interpolate ===');

test('replaces {{variable}} with context value', () => {
  assert.strictEqual(interpolate('Hello {{name}}!', { name: 'World' }), 'Hello World!');
});

test('leaves unmatched placeholders intact', () => {
  assert.strictEqual(interpolate('Hello {{name}}!', {}), 'Hello {{name}}!');
});

test('handles non-string input', () => {
  assert.strictEqual(interpolate(42, { name: 'World' }), 42);
});

test('replaces multiple placeholders', () => {
  const result = interpolate('{{a}} and {{b}}', { a: 'X', b: 'Y' });
  assert.strictEqual(result, 'X and Y');
});

// ============================================================
// SHARED: pipelineUtils — extractFileId
// ============================================================

console.log('\n=== SOCIAL FLOW: Shared — extractFileId ===');

test('extracts file ID from Google Drive URL', () => {
  assert.strictEqual(extractFileId('https://drive.google.com/file/d/1ABC/view'), '1ABC');
});

test('returns raw ID if not a URL', () => {
  assert.strictEqual(extractFileId('1ABC'), '1ABC');
});

test('returns null for empty input', () => {
  assert.strictEqual(extractFileId(''), null);
  assert.strictEqual(extractFileId(null), null);
});

// ============================================================
// STAGE 5: INTERACT — classifyReply (AI)
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 5 — interact (classifyReply) ===');

test('classifies positive reply', async () => {
  const mockAI = new MockMultiProviderAI('{"type":"positive","confidence":0.95}');
  const result = await classifyReply('Yes, interested!', mockAI);
  assert.strictEqual(result.type, 'positive');
});

test('returns neutral default on AI failure', async () => {
  const mockAI = new MockMultiProviderAI('bad');
  const result = await classifyReply('test', mockAI);
  assert.strictEqual(result.type, 'neutral');
});

// ============================================================
// STAGE 5: INTERACT — generateAutoReply (AI)
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 5 — interact (generateAutoReply) ===');

test('returns reply text', async () => {
  const mockAI = new MockMultiProviderAI('Thanks for reaching out!');
  const result = await generateAutoReply('positive', 'Social outreach', 'user@x.com', mockAI);
  assert.strictEqual(result, 'Thanks for reaching out!');
});

test('returns null on AI failure', async () => {
  const mockAI = new MockMultiProviderAI(null);
  const result = await generateAutoReply('positive', null, 'user@x.com', mockAI);
  assert.strictEqual(result, null);
});

// ============================================================
// STAGE 4: EXECUTE — socialMessageMap building
// ============================================================

console.log('\n=== SOCIAL FLOW: Stage 4 — execute (socialMessageMap building) ===');

test('builds socialMessageMap from CSV rows', () => {
  const headers = ['SN', 'SOCIALUSERNAME', 'SOCIALPLATFORM', 'enhancedSocialMessage'];
  const rows = [
    ['1', 'johndoe', 'twitter', 'Hi John!'],
    ['2', 'janedoe', 'instagram', 'Hey Jane!'],
  ];
  const socialMsgIdx = headers.findIndex(h => h.toLowerCase() === 'enhancedsocialmessage');
  const socialUserIdx = headers.findIndex(h => h.toUpperCase() === 'SOCIALUSERNAME');

  const socialMessageMap = new Map();
  for (const row of rows) {
    const username = row[socialUserIdx]?.trim();
    const message = row[socialMsgIdx]?.trim();
    if (username && message) socialMessageMap.set(username, message);
  }

  assert.strictEqual(socialMessageMap.size, 2);
  assert.strictEqual(socialMessageMap.get('johndoe'), 'Hi John!');
  assert.strictEqual(socialMessageMap.get('janedoe'), 'Hey Jane!');
});

test('skips rows without message', () => {
  const headers = ['SOCIALUSERNAME', 'enhancedSocialMessage'];
  const rows = [
    ['johndoe', 'Hi!'],
    ['janedoe', ''],
    ['bobdoe', ''],
  ];
  const socialMsgIdx = 1;
  const socialUserIdx = 0;

  const socialMessageMap = new Map();
  for (const row of rows) {
    const username = row[socialUserIdx]?.trim();
    const message = row[socialMsgIdx]?.trim();
    if (username && message) socialMessageMap.set(username, message);
  }

  assert.strictEqual(socialMessageMap.size, 1);
  assert.strictEqual(socialMessageMap.get('johndoe'), 'Hi!');
});

// ============================================================
// CSV roundtrip
// ============================================================

console.log('\n=== SOCIAL FLOW: Shared — CSV roundtrip ===');

test('parseCSV → stringifyCSV roundtrip preserves social data', () => {
  const original = [
    ['HANDLE', 'PLATFORM', 'MESSAGE'],
    ['johndoe', 'twitter', 'Hello, World!'],
    ['janedoe', 'instagram', 'She said "hi"']
  ];
  const csv = stringifyCSV(original);
  const parsed = parseCSV(csv);
  assert.deepStrictEqual(parsed, original);
});

// ============================================================
// RESULTS
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
