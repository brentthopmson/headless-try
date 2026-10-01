// tools/minify.js — HTML template minifier for sheet deployment (code column,
// Google Sheets 50,000-char cell limit).
//   node tools/minify.js <file.html>  ->  <file>.min.html
// Pipeline: extract <script> blocks (all) -> strip HTML comments -> collapse
// whitespace in HTML/CSS -> terser-minify plain <script> JS -> restore.
const fs = require('fs');
const path = require('path');

const p = process.argv[2];
if (!p) { console.error('Usage: node tools/minify.js <file.html>'); process.exit(1); }

(async () => {
    let s = fs.readFileSync(p, 'utf8');

    // 1. Extract ALL script blocks first so comment-stripping/whitespace
    //    collapsing never touches JS (strings, // comments, ASI).
    //    Placeholder must NOT look like an HTML comment (step 2 would eat it).
    const scripts = [];
    s = s.replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs, js) => {
        const idx = scripts.length;
        scripts.push({ attrs: attrs || '', js });
        return `__SCRIPT_PLACEHOLDER_${idx}__`;
    });

    // 2. Strip HTML comments (naive but effective for templates; DOCTYPE kept).
    s = s.replace(/<!--([\s\S]*?)-->/g, '');

    // 3. Collapse whitespace between tags and normalize runs of whitespace
    //    (this also compacts <style> content — semantically safe).
    s = s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

    // 4. Terser-minify plain inline scripts; restore with placeholder.
    const { minify } = require('terser');
    for (let i = 0; i < scripts.length; i++) {
        const { attrs, js } = scripts[i];
        const typeMatch = attrs.match(/type\s*=\s*["']([^"']+)["']/i);
        const isPlain = !/\bsrc\s*=/i.test(attrs)
            && (!typeMatch || /^(text\/javascript|module)$/i.test(typeMatch[1]));
        let out = js;
        if (isPlain) {
            try {
                const result = await minify(js, {
                    compress: { dead_code: true, drop_console: false },
                    mangle: true,
                    format: { comments: false },
                });
                if (result && result.code) out = result.code;
            } catch (e) {
                console.warn(`  script #${i}: terser failed (${e.message}) — keeping original`);
            }
        }
        s = s.replace(`__SCRIPT_PLACEHOLDER_${i}__`, `<script${attrs}>${out}</script>`);
    }

    const dest = path.join(path.dirname(p), path.basename(p).replace(/(\.html?)$/i, '.min.html'));
    fs.writeFileSync(dest, s, 'utf8');
    const limit = 50000;
    console.log(`Wrote ${dest} (${s.length} chars)${s.length > limit ? ` — OVER ${limit} limit!` : ` — ${limit - s.length} chars under ${limit} limit`}`);
    if (s.length > limit) process.exit(2);
})();
