const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const jsonMatch = envContent.match(/GOOGLE_OAUTH2_JSON=(\{.*\})/s);
if (!jsonMatch) { console.error('no json'); process.exit(1); }
const creds = JSON.parse(jsonMatch[1]);
const { client_id, client_secret } = creds.web;
const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
const dbMatch = envContent.match(/DB_ID=(.*)/);
const SPREADSHEET_ID = dbMatch ? dbMatch[1].trim().split(/\s/)[0] : '';
const refreshMatch = envContent.match(/GOOGLE_REFRESH_TOKEN=(.*)/);
const refreshToken = refreshMatch ? refreshMatch[1].trim() : null;

if (!refreshToken) {
  console.error('no refresh token');
  process.exit(1);
}

oauth2Client.setCredentials({ refresh_token: refreshToken });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

async function run() {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'AI_SETTINGS',
    });
    const values = res.data.values || [];
    const headers = values[0];
    const keyIdx = headers.findIndex(h => String(h).toLowerCase().trim() === 'aikey');
    const urlIdx = headers.findIndex(h => String(h).toLowerCase().trim() === 'aibaseurl');
    const statusIdx = headers.findIndex(h => String(h).toLowerCase().trim() === 'aistatus');
    const provIdx = headers.findIndex(h => String(h).toLowerCase().trim() === 'aiprovider');

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][provIdx] || '').toLowerCase() === 'opencode') {
        const row = i + 1;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `AI_SETTINGS!${String.fromCharCode(65 + keyIdx)}${row}`,
          valueInputOption: 'RAW',
          resource: { values: [['WUyaw1mAlqNc5b2d']] }
        });
        if (urlIdx >= 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `AI_SETTINGS!${String.fromCharCode(65 + urlIdx)}${row}`,
            valueInputOption: 'RAW',
            resource: { values: [['https://strength-nuts-mount-telephone.trycloudflare.com']] }
          });
        }
        if (statusIdx >= 0) {
          await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `AI_SETTINGS!${String.fromCharCode(65 + statusIdx)}${row}`,
            valueInputOption: 'RAW',
            resource: { values: [['ACTIVE']] }
          });
        }
        console.log('Updated opencode row', row);
        break;
      }
    }
  } catch (e) {
    console.error('err', e.message);
  }
}
run();
