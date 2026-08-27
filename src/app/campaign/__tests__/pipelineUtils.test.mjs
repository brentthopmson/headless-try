/**
 * ISOLATION TESTS for _shared/pipelineUtils.js
 * Run: node --experimental-vm-modules src/app/campaign/__tests__/pipelineUtils.test.mjs
 *
 * Tests pure functions by re-implementing them locally
 * (the source module has side-effect imports that make direct testing difficult).
 */

import assert from 'assert';

// ============================================================
// RE-IMPLEMENT pure functions for isolated testing
// ============================================================

function extractFileId(url) {
  if (!url) return null;
  if (!url.startsWith("http")) return url;
  const matches = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  return matches ? matches[1] : null;
}

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
// extractFileId tests
// ============================================================

console.log('\n=== pipelineUtils: extractFileId ===');

test('extracts file ID from Google Drive URL', () => {
  const result = extractFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view');
  assert.strictEqual(result, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
});

test('extracts file ID from URL with extra path', () => {
  const result = extractFileId('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit?usp=sharing');
  assert.strictEqual(result, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
});

test('returns raw ID if not a URL', () => {
  const result = extractFileId('1AbCdEfGhIjKlMnOpQrStUvWxYz');
  assert.strictEqual(result, '1AbCdEfGhIjKlMnOpQrStUvWxYz');
});

test('returns null for empty input', () => {
  assert.strictEqual(extractFileId(''), null);
  assert.strictEqual(extractFileId(null), null);
  assert.strictEqual(extractFileId(undefined), null);
});

test('returns null for non-Drive URL', () => {
  assert.strictEqual(extractFileId('https://example.com/file/123'), null);
});

// ============================================================
// parseCSV tests
// ============================================================

console.log('\n=== pipelineUtils: parseCSV ===');

test('parses simple CSV', () => {
  const result = parseCSV('a,b,c\n1,2,3');
  assert.deepStrictEqual(result, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('handles quoted values with commas', () => {
  const result = parseCSV('a,"b,c",d\n1,2,3');
  assert.deepStrictEqual(result, [['a', 'b,c', 'd'], ['1', '2', '3']]);
});

test('handles escaped quotes', () => {
  const result = parseCSV('a,"b""c",d');
  assert.deepStrictEqual(result, [['a', 'b"c', 'd']]);
});

test('handles CRLF line endings', () => {
  const result = parseCSV('a,b\r\n1,2');
  assert.deepStrictEqual(result, [['a', 'b'], ['1', '2']]);
});

test('handles empty input', () => {
  const result = parseCSV('');
  assert.deepStrictEqual(result, []);
});

test('handles single row without newline', () => {
  const result = parseCSV('a,b,c');
  assert.deepStrictEqual(result, [['a', 'b', 'c']]);
});

test('handles empty cells', () => {
  const result = parseCSV('a,,c');
  assert.deepStrictEqual(result, [['a', '', 'c']]);
});

test('handles BOM character', () => {
  const result = parseCSV('\uFEFFa,b\n1,2');
  assert.deepStrictEqual(result, [['\uFEFFa', 'b'], ['1', '2']]);
});

// ============================================================
// stringifyCSV tests
// ============================================================

console.log('\n=== pipelineUtils: stringifyCSV ===');

test('stringifyCSV with simple values', () => {
  const result = stringifyCSV([['a', 'b', 'c'], ['1', '2', '3']]);
  assert.strictEqual(result, 'a,b,c\n1,2,3');
});

test('stringifyCSV escapes commas', () => {
  const result = stringifyCSV([['a,b', 'c']]);
  assert.strictEqual(result, '"a,b",c');
});

test('stringifyCSV escapes quotes', () => {
  const result = stringifyCSV([['a"b', 'c']]);
  assert.strictEqual(result, '"a""b",c');
});

test('stringifyCSV handles null/undefined', () => {
  const result = stringifyCSV([[null, undefined, '']]);
  assert.strictEqual(result, ',,');
});

test('stringifyCSV handles newlines in values', () => {
  const result = stringifyCSV([['a\nb', 'c']]);
  assert.strictEqual(result, '"a\nb",c');
});

test('roundtrips parseCSV → stringifyCSV', () => {
  const original = [['a', 'b,c', 'd"e'], ['f', 'g', 'h']];
  const csv = stringifyCSV(original);
  const parsed = parseCSV(csv);
  assert.deepStrictEqual(parsed, original);
});

test('stringifyCSV handles empty array', () => {
  const result = stringifyCSV([]);
  assert.strictEqual(result, '');
});

test('stringifyCSV handles single empty row', () => {
  const result = stringifyCSV([[]]);
  assert.strictEqual(result, '');
});

// ============================================================
// RESULTS
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
