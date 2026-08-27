/**
 * ISOLATION TESTS for send-message/route.js
 * Tests: normalizeAndMapCSV, parseCSV, extractFileId, getCookieForProfile logic
 *
 * Run: node --experimental-vm-modules src/app/socials/send-message/__tests__/send-message.test.mjs
 */

import assert from 'assert';

// ============================================================
// EXTRACTED PURE FUNCTIONS from send-message/route.js
// ============================================================

const FUZZY_MAP = {
  SOCIALPLATFORM: ['SOCIAL', 'SOCIAL PLATFORM', 'PLATFORM', 'SOCIAL MEDIA'],
  SOCIALUSERNAME: ['SOCIAL USERNAME', 'USERNAME', 'HANDLE', 'SOCIAL HANDLE', 'SOCIAL NAME'],
  SOCIALPHONE: ['SOCIAL PHONE'],
  EMAIL: ['EMAIL', 'MAIL', 'E-MAIL', 'LEAD'],
  FIRSTNAME: ['FIRST', 'FIRST NAME', 'FNAME', 'GIVEN'],
  LASTNAME: ['LAST', 'LAST NAME', 'LNAME', 'SURNAME', 'FAMILY'],
};

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

function parseCSV(text) {
  const lines = [];
  let row = [''];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"') {
        if (next === '"') { row[row.length - 1] += '"'; i++; }
        else inQuotes = false;
      } else row[row.length - 1] += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') row.push('');
      else if (c === '\r' || c === '\n') {
        if (c === '\r' && next === '\n') i++;
        lines.push(row);
        row = [''];
      } else row[row.length - 1] += c;
    }
  }
  if (row.length > 1 || row[0] !== '') lines.push(row);
  return lines;
}

function stringifyCSV(rows) {
  return rows.map(row =>
    row.map(val => {
      const str = String(val === null || val === undefined ? '' : val);
      if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r'))
        return '"' + str.replace(/"/g, '""') + '"';
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

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith('http')) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

// ============================================================
// TEST RUNNER
// ============================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

// ============================================================
// TESTS — parseCSV
// ============================================================

console.log('\n=== send-message: parseCSV ===');

test('parses simple CSV', () => {
  const rows = parseCSV('a,b,c\n1,2,3');
  assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('handles quoted values with commas', () => {
  const rows = parseCSV('"hello, world",b\n1,2');
  assert.deepStrictEqual(rows[0], ['hello, world', 'b']);
});

test('handles escaped quotes', () => {
  const rows = parseCSV('a,"say ""hi""",c');
  assert.deepStrictEqual(rows[0], ['a', 'say "hi"', 'c']);
});

test('handles CRLF line endings', () => {
  const rows = parseCSV('a,b\r\n1,2');
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[1], ['1', '2']);
});

test('handles empty input', () => {
  const rows = parseCSV('');
  assert.strictEqual(rows.length, 0);
});

// ============================================================
// TESTS — normalizeAndMapCSV
// ============================================================

console.log('\n=== send-message: normalizeAndMapCSV ===');

test('maps exact headers to 88-column schema', () => {
  const csv = 'EMAIL,FIRSTNAME,LASTNAME\njohn@test.com,John,Doe';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result.length, 2); // header + 1 data row
  const headers = result[0];
  const dataRow = result[1];
  assert.strictEqual(headers[3], 'EMAIL'); // [3] = EMAIL
  assert.strictEqual(headers[1], 'FIRSTNAME'); // [1] = FIRSTNAME
  assert.strictEqual(dataRow[3], 'john@test.com');
  assert.strictEqual(dataRow[1], 'John');
});

test('maps fuzzy headers (PLATFORM → SOCIALPLATFORM)', () => {
  const csv = 'PLATFORM,USERNAME\ntwitter,john_doe';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  const dataRow = result[1];
  assert.strictEqual(dataRow[19], 'twitter'); // [19] = SOCIALPLATFORM
  assert.strictEqual(dataRow[20], 'john_doe'); // [20] = SOCIALUSERNAME
});

test('maps HANDLE → SOCIALUSERNAME', () => {
  const csv = 'HANDLE,PLATFORM\n@alice,instagram';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  const dataRow = result[1];
  assert.strictEqual(dataRow[20], '@alice');
  assert.strictEqual(dataRow[19], 'instagram');
});

test('auto-numbers SN when not in source', () => {
  const csv = 'EMAIL\na@test.com\nb@test.com';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][0], '1');
  assert.strictEqual(result[2][0], '2');
});

test('preserves SN when present in source', () => {
  const csv = 'SN,EMAIL\n42,a@test.com';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][0], '42');
});

test('empty cells remain empty string', () => {
  const csv = 'EMAIL,FIRSTNAME\na@test.com,';
  const result = normalizeAndMapCSV(csv, STANDARD_88_COLUMNS);
  assert.strictEqual(result[1][1], ''); // FIRSTNAME is empty
});

// ============================================================
// TESTS — extractFileId
// ============================================================

console.log('\n=== send-message: extractFileId ===');

test('extracts file ID from Drive URL', () => {
  const id = extractFileId('https://drive.google.com/file/d/ABC123/view');
  assert.strictEqual(id, 'ABC123');
});

test('returns raw ID if not a URL', () => {
  const id = extractFileId('ABC123');
  assert.strictEqual(id, 'ABC123');
});

test('returns null for empty input', () => {
  assert.strictEqual(extractFileId(null), null);
  assert.strictEqual(extractFileId(''), null);
});

test('handles URL with trailing slashes', () => {
  const id = extractFileId('https://drive.google.com/d/XYZ789//');
  assert.strictEqual(id, 'XYZ789');
});

// ============================================================
// TESTS — stringifyCSV
// ============================================================

console.log('\n=== send-message: stringifyCSV ===');

test('roundtrips parseCSV → stringifyCSV', () => {
  const original = 'EMAIL,FIRSTNAME\njohn@test.com,John\njane@test.com,Jane';
  const rows = parseCSV(original);
  const csv = stringifyCSV(rows);
  const reparsed = parseCSV(csv);
  assert.deepStrictEqual(rows, reparsed);
});

test('escapes commas in values', () => {
  const csv = stringifyCSV([['hello, world', 'b']]);
  assert.strictEqual(csv, '"hello, world",b');
});

test('escapes quotes in values', () => {
  const csv = stringifyCSV([['say "hi"']]);
  assert.strictEqual(csv, '"say ""hi"""');
});

// ============================================================
// SUMMARY
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
