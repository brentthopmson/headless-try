// tools/split.js
const fs = require('fs');
const path = require('path');
const p = process.argv[2];
if (!p) { console.error('Usage: node tools/split.js <file.min.html> [chunkSize]'); process.exit(1); }
const CHUNK = parseInt(process.argv[3] || '49000', 10);
const s = fs.readFileSync(p, 'utf8');
let idx = 0, part = 1;
const base = p + '.part.';
while (idx < s.length) {
  const piece = s.slice(idx, idx + CHUNK);
  const name = `${base}${String(part).padStart(2,'0')}.txt`;
  fs.writeFileSync(name, piece, 'utf8');
  console.log(`Wrote ${name} (${piece.length} chars)`);
  idx += CHUNK; part++;
}
