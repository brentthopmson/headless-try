import 'dotenv/config';
import axios from 'axios';
import { google } from 'googleapis';
import JSON5 from 'json5';
import fs from 'fs';

// Resolve refresh token exactly like googleTokenSource: SETTINGS sheet > env fallback.
async function resolveToken() {
  try {
    const p = new URLSearchParams({
      action: 'getData',
      key: process.env.SCRIPT_KEY,
      sheetname: 'SETTINGS',
    });
    const r = await axios.post(process.env.SCRIPT_URL, p, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 60000,
      maxBodyLength: Infinity,
    });
    const headers = r.data.headers || [];
    const data = r.data.data || [];
    const ki = headers.indexOf('settingsKey');
    const vi = headers.indexOf('settingsValue1');
    for (const row of data) {
      if (ki >= 0 && vi >= 0 && String(row[ki] || '').trim() === 'googleRefreshToken') {
        const v = String(row[vi] || '').trim();
        if (v) return v;
      }
    }
  } catch (e) {
    console.log('sheet token read failed:', e.message);
  }
  return process.env.GOOGLE_DRIVE_REFRESH_TOKEN || process.env.GOOGLE_REFRESH_TOKEN || null;
}

const token = await resolveToken();
console.log('resolved refresh token len =', token && token.length);

const creds = JSON5.parse(process.env.GOOGLE_OAUTH2_JSON);
const { client_id, client_secret, redirect_uris } = creds.web;
const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
auth.setCredentials({ refresh_token: token });
const { credentials } = await auth.refreshAccessToken();
auth.setCredentials(credentials);
const drive = google.drive({ version: 'v3', auth });

const FILE_ID = '1sY-gd04S179CjNpdklTuNd-lhdsr8YGb';
const meta = await drive.files.get({ fileId: FILE_ID, fields: 'id,name,mimeType,size' });
console.log('META:', JSON.stringify(meta.data));

const res = await drive.files.get({ fileId: FILE_ID, alt: 'media' }, { responseType: 'arraybuffer' });
const buf = Buffer.from(res.data);
const outPath = 'C:/Users/HP/AppData/Local/Temp/opencode/debug_captured_screenshot';
fs.writeFileSync(outPath, buf);
console.log('SAVED', buf.length, 'bytes to', outPath);

