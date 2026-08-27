/**
 * ISOLATION TESTS — EMAIL Campaign Flow
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/email-campaign-flow.test.mjs
 *
 * Tests all pure functions and AI-dependent functions used in the email campaign pipeline:
 * validate -> enrich -> personalize -> execute -> interact
 */

import assert from 'assert';

// ============================================================
// RE-IMPLEMENT functions from source for isolated testing
// ============================================================

// --- validate-campaign/route.js ---

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
  LASTNAME: ['LAST', 'LAST NAME', 'LNAME', 'SURNAME', 'FAMILY'],
  BUSINESSNAME: ['BUSINESS', 'BUSINESS NAME', 'COMPANY', 'ORGANIZATION', 'ORG'],
  SOCIALPLATFORM: ['SOCIAL', 'SOCIAL PLATFORM', 'PLATFORM'],
  SOCIALUSERNAME: ['SOCIAL USERNAME', 'USERNAME', 'HANDLE', 'SOCIAL HANDLE'],
  URL: ['URL', 'LINK', 'WEBSITE', 'WEB', 'REFERENCE'],
};

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

const EMAIL_PLATFORM_CONFIGS = {
  gmail: { mxKeywords: ['google', 'gmail'] },
  outlook: { mxKeywords: ['outlook', 'hotmail', 'live', 'microsoft'] },
  yahoo: { mxKeywords: ['yahoo'] },
  aol: { mxKeywords: ['aol'] },
};

function detectPlatform(domain) {
  for (const [name, config] of Object.entries(EMAIL_PLATFORM_CONFIGS)) {
    if (config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw))) {
      return name;
    }
  }
  return null;
}

// --- enrich-campaign/route.js ---

const GENERIC_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "mail.com", "zoho.com", "yandex.com", "protonmail.com", "proton.me", "gmx.com",
  "mail.ru", "live.com", "msn.com", "googlemail.com"
]);

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function inferFirstName(email) {
  if (!email) return "";
  const username = email.split("@")[0];
  const parts = username.split(/[\._\-0-9]+/);
  for (const part of parts) {
    if (part.length > 1) return capitalize(part);
  }
  return username ? capitalize(username) : "";
}

function inferCompany(email) {
  if (!email) return "";
  const parts = email.split("@");
  if (parts.length !== 2) return "";
  const domain = parts[1].toLowerCase().trim();
  if (GENERIC_DOMAINS.has(domain)) return "Personal";
  return capitalize(domain.split(".")[0]);
}

// --- execute-campaign/route.js ---

function embedCampaignIdentifier(subject, body, campaignId) {
  const identifier = `[${campaignId}]`;
  const taggedSubject = subject.includes(identifier) ? subject : `${subject} ${identifier}`;
  const identifierComment = `<!-- campaign:${campaignId} -->`;
  const taggedBody = body.includes(identifierComment) ? body : `${body}\n\n${identifierComment}`;
  return { subject: taggedSubject, body: taggedBody };
}

function columnIndexToLetter(index) {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

// --- smtpSender.js ---

function getNextSmtpConfig(smtpSettings, currentIndex) {
  if (!smtpSettings || smtpSettings.length === 0) return null;
  const idx = currentIndex % smtpSettings.length;
  return { config: smtpSettings[idx], index: idx };
}

// --- wireSender.js ---

function detectProvider(email) {
  const domain = email.split("@")[1]?.toLowerCase() || "";
  if (domain.includes("gmail")) return "gmail";
  if (domain.includes("outlook") || domain.includes("hotmail") || domain.includes("live")) return "outlook";
  if (domain.includes("yahoo")) return "yahoo";
  if (domain.includes("aol")) return "aol";
  return null;
}

// --- interact-campaign/route.js (AI functions) ---

class MockMultiProviderAI {
  constructor(response) { this._response = response; }
  async generate(prompt) { return this._response; }
}

async function classifyReply(replyBody, mockAI) {
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
  const prompt = `Generate a brief, professional auto-reply for an email campaign response.

Response type: ${replyType}
Campaign context: ${campaignContext || "General outreach"}
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
    const ai = mockAI || new MockMultiProviderAI(null);
    const text = await ai.generate(prompt);
    return text ? text.trim() : null;
  } catch {
    return null;
  }
}

// --- enrich-campaign/route.js (AI function) ---

async function analyzeBatchWithAI(scrapeResults, mockAI) {
  if (!scrapeResults || scrapeResults.length === 0) return [];

  const batchDescription = scrapeResults.map((r, i) =>
    `${i + 1}. URL: ${r.url || "N/A"}\nTitle: ${r.title || "N/A"}\nContent: ${(r.bodyText || r.description || "").slice(0, 500)}`
  ).join("\n\n");

  const prompt = `Analyze these ${scrapeResults.length} webpage contents and extract useful information for cold outreach.

Contents:
${batchDescription}

Return a JSON array with one object per webpage:
[{"summary": "brief summary", "industry": "detected industry", "services": "key services/products"}]

Return ONLY the JSON array, no markdown or explanations.`;

  try {
    const ai = mockAI || new MockMultiProviderAI('[]');
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) return parsed;
    }
    return [];
  } catch {
    return [];
  }
}

// --- personalize-campaign/route.js (AI functions) ---

async function personalizeBatch(batch, personalizationPrompt, headers, mockAI) {
  if (batch.length === 0) return batch.map(() => null);

  const batchDescription = batch.map((contact, i) =>
    `${i + 1}. Name: ${contact.firstName}, Company: ${contact.company}, Email: ${contact.email}${contact.context ? `, Context: ${contact.context.slice(0, 200)}` : ""}`
  ).join("\n");

  const prompt = `You are an expert personalized outreach copywriter. Generate highly tailored cold email subject lines and email bodies for these ${batch.length} recipients:

${batchDescription}

Context and Instructions:
"${personalizationPrompt}"

Return a JSON array with one object per recipient (same order):
[{"subject": "Tailored subject line", "body": "Tailored email body"}, ...]

Rules:
1. Each subject must be unique and engaging
2. Each body must be professional, natural, concise, with clear CTA
3. Reference the recipient's name and company
4. Keep body under 150 words
5. Return ONLY the JSON array, no markdown or explanations`;

  try {
    const ai = mockAI || new MockMultiProviderAI('[]');
    const text = await ai.generate(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.map(r => ({
          subject: r.subject || null,
          body: r.body || null
        }));
      }
    }
    return batch.map(() => ({ subject: null, body: null }));
  } catch {
    return batch.map(() => ({ subject: null, body: null }));
  }
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
// STAGE 1: VALIDATE — normalizeAndMapCSV
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 1 — validate (normalizeAndMapCSV) ===');

test('maps exact headers to 88-column schema', () => {
  const csv = 'SN,FIRSTNAME,EMAIL,BUSINESSNAME\n1,John,john@test.com,Acme';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[1][3], 'john@test.com');
  assert.strictEqual(result[1][1], 'John');
  assert.strictEqual(result[1][11], 'Acme');
});

test('maps fuzzy headers (MAIL -> EMAIL)', () => {
  const csv = 'FIRST,MAIL,COMPANY\nJohn,john@test.com,Acme';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][3], 'john@test.com');
  assert.strictEqual(result[1][1], 'John');
  assert.strictEqual(result[1][11], 'Acme');
});

test('maps HANDLE -> SOCIALUSERNAME', () => {
  const csv = 'HANDLE,PLATFORM\njohndoe,twitter';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][20], 'johndoe');
  assert.strictEqual(result[1][19], 'twitter');
});

test('auto-numbers SN when not in source', () => {
  const csv = 'EMAIL\na@b.com\nc@d.com';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][0], '1');
  assert.strictEqual(result[2][0], '2');
});

test('preserves SN when present in source', () => {
  const csv = 'SN,EMAIL\n5,a@b.com';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][0], '5');
});

test('empty cells remain empty string', () => {
  const csv = 'FIRSTNAME,EMAIL\n,';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][1], '');
});

// ============================================================
// STAGE 1: VALIDATE — detectPlatform
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 1 — validate (detectPlatform) ===');

test('detects gmail from domain', () => {
  assert.strictEqual(detectPlatform('gmail.com'), 'gmail');
  assert.strictEqual(detectPlatform('googlemail.com'), 'gmail');
});

test('detects outlook from domain', () => {
  assert.strictEqual(detectPlatform('outlook.com'), 'outlook');
  assert.strictEqual(detectPlatform('hotmail.com'), 'outlook');
  assert.strictEqual(detectPlatform('live.com'), 'outlook');
});

test('detects yahoo from domain', () => {
  assert.strictEqual(detectPlatform('yahoo.com'), 'yahoo');
});

test('detects aol from domain', () => {
  assert.strictEqual(detectPlatform('aol.com'), 'aol');
});

test('returns null for unknown domain', () => {
  assert.strictEqual(detectPlatform('protonmail.com'), null);
  assert.strictEqual(detectPlatform('custom-domain.com'), null);
});

// ============================================================
// STAGE 2: ENRICH — inferFirstName, inferCompany, capitalize
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 2 — enrich (inferFirstName) ===');

test('infers first name from simple email', () => {
  assert.strictEqual(inferFirstName('john@test.com'), 'John');
});

test('infers first name from dotted email', () => {
  assert.strictEqual(inferFirstName('john.doe@test.com'), 'John');
});

test('infers first name from underscored email', () => {
  assert.strictEqual(inferFirstName('john_doe@test.com'), 'John');
});

test('infers first name from hyphenated email', () => {
  assert.strictEqual(inferFirstName('john-doe@test.com'), 'John');
});

test('infers first name from numbered email', () => {
  assert.strictEqual(inferFirstName('john123@test.com'), 'John');
});

test('returns empty for empty input', () => {
  assert.strictEqual(inferFirstName(''), '');
  assert.strictEqual(inferFirstName(null), '');
});

test('capitalizes single char username', () => {
  assert.strictEqual(inferFirstName('j@test.com'), 'J');
});

console.log('\n=== EMAIL FLOW: Stage 2 — enrich (inferCompany) ===');

test('infers company from custom domain', () => {
  assert.strictEqual(inferCompany('john@acme.com'), 'Acme');
});

test('returns Personal for generic domains', () => {
  assert.strictEqual(inferCompany('john@gmail.com'), 'Personal');
  assert.strictEqual(inferCompany('john@yahoo.com'), 'Personal');
  assert.strictEqual(inferCompany('john@hotmail.com'), 'Personal');
  assert.strictEqual(inferCompany('john@outlook.com'), 'Personal');
});

test('handles multi-part domain', () => {
  assert.strictEqual(inferCompany('john@mail.acme.com'), 'Mail');
});

test('returns empty for invalid email', () => {
  assert.strictEqual(inferCompany(''), '');
  assert.strictEqual(inferCompany('no-at-sign'), '');
});

// ============================================================
// STAGE 3: PERSONALIZE — personalizeBatch (AI)
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 3 — personalize (personalizeBatch) ===');

test('returns subject+body per recipient', async () => {
  const mockAI = new MockMultiProviderAI('[{"subject":"Hi John","body":"Hello John from Acme"}]');
  const batch = [{ firstName: 'John', company: 'Acme', email: 'john@acme.com' }];
  const result = await personalizeBatch(batch, 'Write professional email', [], mockAI);
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].subject, 'Hi John');
  assert.strictEqual(result[0].body, 'Hello John from Acme');
});

test('returns nulls for empty batch', async () => {
  const result = await personalizeBatch([], 'prompt', []);
  assert.deepStrictEqual(result, []);
});

test('returns nulls on AI failure', async () => {
  const mockAI = new MockMultiProviderAI('not json');
  const batch = [{ firstName: 'John', company: 'Acme', email: 'j@x.com' }];
  const result = await personalizeBatch(batch, 'prompt', [], mockAI);
  assert.strictEqual(result[0].subject, null);
  assert.strictEqual(result[0].body, null);
});

test('handles multiple recipients', async () => {
  const mockAI = new MockMultiProviderAI('[{"subject":"S1","body":"B1"},{"subject":"S2","body":"B2"}]');
  const batch = [
    { firstName: 'John', company: 'A', email: 'j@a.com' },
    { firstName: 'Jane', company: 'B', email: 'j@b.com' }
  ];
  const result = await personalizeBatch(batch, 'prompt', [], mockAI);
  assert.strictEqual(result.length, 2);
  assert.strictEqual(result[0].subject, 'S1');
  assert.strictEqual(result[1].subject, 'S2');
});

test('prompt includes recipient names and companies', async () => {
  let capturedPrompt = '';
  const mockAI = {
    async generate(prompt) { capturedPrompt = prompt; return '[]'; }
  };
  const batch = [{ firstName: 'John', company: 'Acme', email: 'j@a.com', context: 'CEO' }];
  await personalizeBatch(batch, 'Write email', [], mockAI);
  assert.ok(capturedPrompt.includes('John'));
  assert.ok(capturedPrompt.includes('Acme'));
  assert.ok(capturedPrompt.includes('CEO'));
});

// ============================================================
// STAGE 4: EXECUTE — embedCampaignIdentifier
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 4 — execute (embedCampaignIdentifier) ===');

test('appends campaign ID to subject', () => {
  const result = embedCampaignIdentifier('Hello', 'Body', 'camp-123');
  assert.strictEqual(result.subject, 'Hello [camp-123]');
  assert.ok(result.body.includes('<!-- campaign:camp-123 -->'));
});

test('does not duplicate campaign ID in subject', () => {
  const result = embedCampaignIdentifier('Hello [camp-123]', 'Body', 'camp-123');
  assert.strictEqual(result.subject, 'Hello [camp-123]');
});

test('does not duplicate campaign comment in body', () => {
  const result = embedCampaignIdentifier('Hello', 'Body <!-- campaign:camp-123 -->', 'camp-123');
  assert.ok(!result.body.includes('<!-- campaign:camp-123 --><!-- campaign:camp-123 -->'));
});

test('handles empty subject and body', () => {
  const result = embedCampaignIdentifier('', '', 'camp-1');
  assert.strictEqual(result.subject, ' [camp-1]');
  assert.ok(result.body.includes('<!-- campaign:camp-1 -->'));
});

// ============================================================
// STAGE 4: EXECUTE — columnIndexToLetter
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 4 — execute (columnIndexToLetter) ===');

test('converts 0 to A', () => {
  assert.strictEqual(columnIndexToLetter(0), 'A');
});

test('converts 25 to Z', () => {
  assert.strictEqual(columnIndexToLetter(25), 'Z');
});

test('converts 26 to AA', () => {
  assert.strictEqual(columnIndexToLetter(26), 'AA');
});

// ============================================================
// STAGE 4: EXECUTE — getNextSmtpConfig
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 4 — execute (getNextSmtpConfig) ===');

test('returns first config at index 0', () => {
  const settings = [{ host: 'a.com' }, { host: 'b.com' }];
  const result = getNextSmtpConfig(settings, 0);
  assert.strictEqual(result.config.host, 'a.com');
  assert.strictEqual(result.index, 0);
});

test('round-robins across configs', () => {
  const settings = [{ host: 'a.com' }, { host: 'b.com' }, { host: 'c.com' }];
  assert.strictEqual(getNextSmtpConfig(settings, 0).config.host, 'a.com');
  assert.strictEqual(getNextSmtpConfig(settings, 1).config.host, 'b.com');
  assert.strictEqual(getNextSmtpConfig(settings, 2).config.host, 'c.com');
  assert.strictEqual(getNextSmtpConfig(settings, 3).config.host, 'a.com');
});

test('returns null for empty settings', () => {
  assert.strictEqual(getNextSmtpConfig([], 0), null);
  assert.strictEqual(getNextSmtpConfig(null, 0), null);
});

// ============================================================
// STAGE 4: EXECUTE — detectProvider (wireSender)
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 4 — execute (detectProvider) ===');

test('detects gmail', () => {
  assert.strictEqual(detectProvider('user@gmail.com'), 'gmail');
});

test('detects outlook', () => {
  assert.strictEqual(detectProvider('user@outlook.com'), 'outlook');
  assert.strictEqual(detectProvider('user@hotmail.com'), 'outlook');
  assert.strictEqual(detectProvider('user@live.com'), 'outlook');
});

test('detects yahoo', () => {
  assert.strictEqual(detectProvider('user@yahoo.com'), 'yahoo');
});

test('detects aol', () => {
  assert.strictEqual(detectProvider('user@aol.com'), 'aol');
});

test('returns null for unknown provider', () => {
  assert.strictEqual(detectProvider('user@protonmail.com'), null);
  assert.strictEqual(detectProvider('user@custom.com'), null);
});

// ============================================================
// STAGE 5: INTERACT — classifyReply (AI)
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 5 — interact (classifyReply) ===');

test('classifies positive reply', async () => {
  const mockAI = new MockMultiProviderAI('{"type":"positive","confidence":0.95}');
  const result = await classifyReply('Yes, I would love to schedule a meeting!', mockAI);
  assert.strictEqual(result.type, 'positive');
  assert.strictEqual(result.confidence, 0.95);
});

test('classifies negative reply', async () => {
  const mockAI = new MockMultiProviderAI('{"type":"negative","confidence":0.9}');
  const result = await classifyReply('Please remove me from your list.', mockAI);
  assert.strictEqual(result.type, 'negative');
});

test('classifies neutral reply', async () => {
  const mockAI = new MockMultiProviderAI('{"type":"neutral","confidence":0.7}');
  const result = await classifyReply('Can you send me more information?', mockAI);
  assert.strictEqual(result.type, 'neutral');
});

test('returns neutral default on AI failure', async () => {
  const mockAI = new MockMultiProviderAI('not json');
  const result = await classifyReply('test', mockAI);
  assert.strictEqual(result.type, 'neutral');
  assert.strictEqual(result.confidence, 0.5);
});

test('truncates long reply body to 1000 chars', async () => {
  let capturedPrompt = '';
  const mockAI = {
    async generate(prompt) { capturedPrompt = prompt; return '{"type":"neutral","confidence":0.5}'; }
  };
  const longReply = 'x'.repeat(2000);
  await classifyReply(longReply, mockAI);
  const replySection = capturedPrompt.split('Reply body:')[1]?.split('Return ONLY')[0] || '';
  assert.ok(replySection.length <= 1010);
});

// ============================================================
// STAGE 5: INTERACT — generateAutoReply (AI)
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 5 — interact (generateAutoReply) ===');

test('returns reply text', async () => {
  const mockAI = new MockMultiProviderAI('Thank you for your interest! Let us schedule a call.');
  const result = await generateAutoReply('positive', 'SaaS demo', 'user@test.com', mockAI);
  assert.strictEqual(result, 'Thank you for your interest! Let us schedule a call.');
});

test('returns null on AI failure', async () => {
  const mockAI = new MockMultiProviderAI(null);
  const result = await generateAutoReply('positive', null, 'user@test.com', mockAI);
  assert.strictEqual(result, null);
});

test('prompt includes reply type and context', async () => {
  let capturedPrompt = '';
  const mockAI = {
    async generate(prompt) { capturedPrompt = prompt; return 'reply'; }
  };
  await generateAutoReply('negative', 'Product demo', 'j@x.com', mockAI);
  assert.ok(capturedPrompt.includes('negative'));
  assert.ok(capturedPrompt.includes('Product demo'));
  assert.ok(capturedPrompt.includes('j@x.com'));
});

// ============================================================
// STAGE 3: ENRICH — analyzeBatchWithAI
// ============================================================

console.log('\n=== EMAIL FLOW: Stage 2 — enrich (analyzeBatchWithAI) ===');

test('returns parsed JSON from AI response', async () => {
  const mockAI = new MockMultiProviderAI('[{"summary":"Tech company","industry":"SaaS","services":"CRM"}]');
  const results = [{ url: 'https://example.com', title: 'Example', bodyText: 'Content' }];
  const output = await analyzeBatchWithAI(results, mockAI);
  assert.strictEqual(output.length, 1);
  assert.strictEqual(output[0].summary, 'Tech company');
});

test('returns empty array for empty input', async () => {
  const output = await analyzeBatchWithAI([], null);
  assert.deepStrictEqual(output, []);
});

test('returns empty array on AI failure', async () => {
  const mockAI = new MockMultiProviderAI('not json');
  const output = await analyzeBatchWithAI([{ url: 'x' }], mockAI);
  assert.deepStrictEqual(output, []);
});

test('handles multiple scrape results', async () => {
  const mockAI = new MockMultiProviderAI('[{"summary":"A"},{"summary":"B"}]');
  const results = [{ url: 'a.com' }, { url: 'b.com' }];
  const output = await analyzeBatchWithAI(results, mockAI);
  assert.strictEqual(output.length, 2);
});

test('prompt includes count and content', async () => {
  let capturedPrompt = '';
  const mockAI = {
    async generate(prompt) { capturedPrompt = prompt; return '[]'; }
  };
  const results = [{ url: 'a.com', title: 'Title A', bodyText: 'Body A' }];
  await analyzeBatchWithAI(results, mockAI);
  assert.ok(capturedPrompt.includes('1 webpage'));
  assert.ok(capturedPrompt.includes('Title A'));
  assert.ok(capturedPrompt.includes('Body A'));
});

// ============================================================
// CSV roundtrip
// ============================================================

console.log('\n=== EMAIL FLOW: Shared — CSV roundtrip ===');

test('parseCSV → stringifyCSV roundtrip preserves data', () => {
  const original = [['Name', 'Email,with,commas', 'Quote"test'], ['John', 'j@a.com', 'ok']];
  const csv = stringifyCSV(original);
  const parsed = parseCSV(csv);
  assert.deepStrictEqual(parsed, original);
});

// ============================================================
// RESULTS
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
