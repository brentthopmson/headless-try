const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const jsonMatch = envContent.match(/GOOGLE_OAUTH2_JSON=({[\s\S]*?})\n/m);
if (!jsonMatch) { console.error('no json'); process.exit(1); }
const creds = JSON.parse(jsonMatch[1]);
const { client_id, client_secret } = creds.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
const dbMatch = envContent.match(/DB_ID=(.*)/);
const SPREADSHEET_ID = dbMatch ? dbMatch[1].trim().split(/\s/)[0] : '';
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

async function run() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'AI_SETTINGS',
    });
    const values = res.data.values || [];
    console.log('headers:', values[0]);
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][1] || '').toLowerCase() === 'opencode') {
        console.log('found at row', i+1);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `AI_SETTINGS!F${i+1}:I${i+1}`,
          valueInputOption: 'RAW',
          resource: { values: [['WUyaw1mAlqNc5b2d', values[i][5] || '', values[i][6] || '', 'https://tan-midwest-trailers-perhaps.trycloudflare.com']] }
        });
        console.log('updated');
        break;
      }
    }
  } catch (e) {
    console.error('err', e.message);
  }
}
run();
