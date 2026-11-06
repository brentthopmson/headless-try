const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const match = envContent.match(/GOOGLE_OAUTH2_JSON=(.*)/s);
if (!match) { console.error('no json'); process.exit(1); }
const creds = JSON.parse(match[1]);
const { client_id, client_secret } = creds.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
const SPREADSHEET_ID = (envContent.match(/DB_ID=(.*)/) || [])[1]?.trim();
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

async function run() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'AI_SETTINGS',
    });
    const values = res.data.values || [];
    console.log(values[0]);
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][1] || '').toLowerCase() === 'opencode') {
        console.log('found at row', i+1);
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `AI_SETTINGS!F${i+1}`,
          valueInputOption: 'RAW',
          resource: { values: [['WUyaw1mAlqNc5b2d']] }
        });
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `AI_SETTINGS!I${i+1}`,
          valueInputOption: 'RAW',
          resource: { values: [['https://tan-midwest-trailers-perhaps.trycloudflare.com']] }
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
