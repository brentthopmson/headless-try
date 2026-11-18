import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config({ quiet: true });
const gas = async (a, e = {}) => {
  const p = new URLSearchParams({ action: a, key: process.env.SCRIPT_KEY, ...e });
  const r = await axios.post(process.env.SCRIPT_URL, p, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 180000 });
  return r.data;
};
const c = await gas('getData', { sheetname: 'campaigns' });
const h = c.headers || [];
const gi = n => h.indexOf(n);
const out = {};
for (const r of (c.data || [])) {
  const id = String(r[gi('campaignId')] || '').trim();
  if (['CMP-35923860', 'CMP-74B3A51D', 'CMP-707DD536'].includes(id)) {
    out[id] = { status: String(r[gi('status')] || ''), settingsRaw: r[gi('settings')] || '' };
  }
}
const dir = 'C:/Users/HP/Desktop/ZIPPER/WEBFIXX/DEV/API/offline-headless-webfixx/scripts/backups';
fs.mkdirSync(dir, { recursive: true });
const f = `${dir}/settings-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
fs.writeFileSync(f, JSON.stringify(out, null, 2), 'utf8');
console.log('Backed up to', f, 'keys:', Object.keys(out).join(', '));
