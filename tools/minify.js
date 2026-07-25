// tools/minify.js
const fs = require('fs');
const path = require('path');
const p = process.argv[2];
if (!p) { console.error('Usage: node tools/minify.js <file.html>'); process.exit(1); }
let s = fs.readFileSync(p, 'utf8');
// remove HTML comments (naive but effective for templates)
s = s.replace(/<!--([\s\S]*?)-->/g, '');
// collapse whitespace between tags and normalize runs of whitespace
s = s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
// write minified file next to original with .min.html suffix
const dest = path.join(path.dirname(p), path.basename(p).replace(/(\.html?)$/i, '.min.html'));
fs.writeFileSync(dest, s, 'utf8');
console.log(`Wrote ${dest} (${s.length} chars)`);
