/**
 * ISOLATION TEST for the Cloudinary fallback upload logic in googledrive.mjs.
 *
 * Exercises the REAL exported path (uploadBrowserDataRaw) with Google Drive
 * deliberately disabled, so Cloudinary is the only provider. Verifies:
 *   - the profile dir zips cleanly,
 *   - the zip uploads to Cloudinary as a raw public asset (secure_url),
 *   - the returned URL is publicly downloadable and carries zip magic bytes (PK),
 *   - the local zip is cleaned up after upload,
 *   - missing CLOUDINARY_* config yields a permanent failure (no retry loop).
 *
 * Run from the engine root (so .env + node_modules resolve):
 *   node --experimental-default-type=module src/utils/__tests__/cloudinaryUpload.test.mjs
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_ENV_KEYS = ['GOOGLE_OAUTH2_JSON', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'];
const CLOUDINARY_ENV_KEYS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_FOLDER'];

function makeFakeProfileDir(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cloudinary-it-${tag}-`));
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ profile: 'fake' }));
    fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ account: 'fake' }));
    fs.writeFileSync(path.join(dir, 'Cookies'), 'fake-cookie-db-bytes');
    return dir;
}

async function assertZipUrlIsValidZip(url) {
    const res = await fetch(url);
    assert.ok(res.ok, `Download of ${url} failed with HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, 'Downloaded asset is empty');
    assert.strictEqual(buf[0], 0x50, `Byte[0] != 'P' (got ${buf[0].toString(16)})`);
    assert.strictEqual(buf[1], 0x4b, `Byte[1] != 'K' (got ${buf[1].toString(16)})`);
}

async function runCase1() {
    console.log('\n=== CASE 1: Cloudinary upload succeeds (Drive disabled) ===');
    for (const k of GOOGLE_ENV_KEYS) delete process.env[k];

    const { uploadBrowserDataRaw } = await import('../../app/api/googledrive.mjs');
    const browserId = `isolation-test-${Date.now()}`;
    const profileDir = makeFakeProfileDir('ok');
    const zipFilePath = `${profileDir}.zip`;

    try {
        const result = await uploadBrowserDataRaw(browserId, {}, profileDir);
        console.log(`Result: ${JSON.stringify(result, null, 2)}`);
        assert.strictEqual(result.ok, true, `Expected ok=true, got ${JSON.stringify(result)}`);
        assert.ok(String(result.url).startsWith('https://res.cloudinary.com'),
            `Expected Cloudinary secure_url, got ${result.url}`);

        await assertZipUrlIsValidZip(result.url);
        console.log(`PASS: secure_url is a valid zip: ${result.url}`);

        assert.ok(!fs.existsSync(zipFilePath), `Local zip not cleaned up: ${zipFilePath}`);
        console.log('PASS: local zip cleaned up after upload');
    } finally {
        fs.rmSync(profileDir, { recursive: true, force: true });
        if (fs.existsSync(zipFilePath)) fs.rmSync(zipFilePath, { force: true });
    }
    console.log('CASE 1: PASS');
}

async function runCase2() {
    console.log('\n=== CASE 2: Missing Cloudinary config -> permanent failure ===');
    for (const k of GOOGLE_ENV_KEYS) delete process.env[k];
    for (const k of CLOUDINARY_ENV_KEYS) delete process.env[k];

    // Query-string cache-buster forces a fresh module instance so the module-level
    // CLOUDINARY_* consts re-read the now-blanked env.
    const fresh = await import(`../../app/api/googledrive.mjs?nocfg=${Date.now()}`);
    const browserId = `isolation-test-nocfg-${Date.now()}`;
    const profileDir = makeFakeProfileDir('nocfg');
    const zipFilePath = `${profileDir}.zip`;

    try {
        const result = await fresh.uploadBrowserDataRaw(browserId, {}, profileDir);
        console.log(`Result: ${JSON.stringify(result, null, 2)}`);
        assert.strictEqual(result.ok, false, `Expected ok=false, got ${JSON.stringify(result)}`);
        assert.strictEqual(result.permanent, true, `Expected permanent=true, got ${JSON.stringify(result)}`);
        assert.match(result.reason || '', /(Missing Cloudinary config|No upload provider configured)/i,
            `Expected a no-provider reason, got ${result.reason}`);
        assert.ok(!fs.existsSync(zipFilePath), `Local zip should not exist after config-fail, found ${zipFilePath}`);
        console.log('PASS: permanent failure returned without retry');
    } finally {
        fs.rmSync(profileDir, { recursive: true, force: true });
        if (fs.existsSync(zipFilePath)) fs.rmSync(zipFilePath, { force: true });
    }
    console.log('CASE 2: PASS');
}

let failed = false;
try {
    await runCase1();
    await runCase2();
} catch (err) {
    failed = true;
    console.error(`\nFAIL: ${err.message}`);
    if (err.stack) console.error(err.stack);
} finally {
    console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
    process.exit(failed ? 1 : 0);
}