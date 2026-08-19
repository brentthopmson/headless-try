/**
 * ISOLATION TEST for the R2/B2 fallback layer in the profile-upload waterfall
 * (Drive -> R2 -> B2 -> Cloudinary) in googledrive.mjs.
 *
 * R2/B2 credentials are NOT set in .env, so this verifies:
 *   - Case 1: R2/B2 unconfigured do NOT break the chain — Drive disabled still
 *     waterfalls to Cloudinary (live upload, zip magic bytes, local zip cleanup).
 *   - Case 2: with NO provider configured at all (Drive + R2 + B2 + Cloudinary),
 *     the extended availability gate returns a permanent failure (no retry loop).
 *   - Case 3: isS3PermanentError classifies auth/config errors as permanent and
 *     network/timeout errors as transient.
 *   - Case 4/5 (env-gated, SKIPPED by default): if R2/B2 creds ARE present, the
 *     live upload against each provider is exercised end to end.
 *
 * Run from the engine root (so .env + node_modules resolve):
 *   node --experimental-default-type=module src/utils/__tests__/s3Waterfall.test.mjs
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_ENV_KEYS = ['GOOGLE_OAUTH2_JSON', 'GOOGLE_DRIVE_REFRESH_TOKEN', 'GOOGLE_DRIVE_FOLDER_ID'];
const CLOUDINARY_ENV_KEYS = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'CLOUDINARY_FOLDER'];
const R2_ENV_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_BASE_URL'];
const B2_ENV_KEYS = ['B2_ACCOUNT_ID', 'B2_APPLICATION_KEY', 'B2_BUCKET', 'B2_ENDPOINT', 'B2_REGION', 'B2_PUBLIC_BASE_URL'];

const R2_PRESENT = R2_ENV_KEYS.every((k) => process.env[k]);
const B2_PRESENT = B2_ENV_KEYS.every((k) => process.env[k]);

function makeFakeProfileDir(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `s3-waterfall-${tag}-`));
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
    console.log('\n=== CASE 1: R2/B2 unset, Drive disabled -> waterfalls to Cloudinary ===');
    for (const k of GOOGLE_ENV_KEYS) delete process.env[k];
    // Keep Cloudinary keys so the chain has a working last provider. R2/B2 keys are
    // already absent (that is the point: middle providers must not break the fallback).

    const { uploadBrowserDataRaw } = await import(`../../app/api/googledrive.mjs?case1=${Date.now()}`);
    const browserId = `s3-waterfall-c1-${Date.now()}`;
    const profileDir = makeFakeProfileDir('c1');
    const zipFilePath = `${profileDir}.zip`;

    try {
        const result = await uploadBrowserDataRaw(browserId, {}, profileDir);
        console.log(`Result: ${JSON.stringify(result, null, 2)}`);
        assert.strictEqual(result.ok, true, `Expected ok=true, got ${JSON.stringify(result)}`);
        assert.ok(String(result.url).startsWith('https://res.cloudinary.com'),
            `Expected Cloudinary secure_url (waterfall fell through), got ${result.url}`);

        await assertZipUrlIsValidZip(result.url);
        console.log(`PASS: waterfall reached Cloudinary and URL is a valid zip: ${result.url}`);

        assert.ok(!fs.existsSync(zipFilePath), `Local zip not cleaned up: ${zipFilePath}`);
        console.log('PASS: local zip cleaned up after upload');
    } finally {
        fs.rmSync(profileDir, { recursive: true, force: true });
        if (fs.existsSync(zipFilePath)) fs.rmSync(zipFilePath, { force: true });
    }
    console.log('CASE 1: PASS');
}

async function runCase2() {
    console.log('\n=== CASE 2: No provider at all -> permanent failure (gate includes R2/B2) ===');
    for (const k of [...GOOGLE_ENV_KEYS, ...CLOUDINARY_ENV_KEYS]) delete process.env[k];

    const fresh = await import(`../../app/api/googledrive.mjs?nocfg=${Date.now()}`);
    const browserId = `s3-waterfall-c2-${Date.now()}`;
    const profileDir = makeFakeProfileDir('c2');
    const zipFilePath = `${profileDir}.zip`;

    try {
        const result = await fresh.uploadBrowserDataRaw(browserId, {}, profileDir);
        console.log(`Result: ${JSON.stringify(result, null, 2)}`);
        assert.strictEqual(result.ok, false, `Expected ok=false, got ${JSON.stringify(result)}`);
        assert.strictEqual(result.permanent, true, `Expected permanent=true, got ${JSON.stringify(result)}`);
        assert.match(result.reason || '', /No upload provider configured/i,
            `Expected no-provider reason, got ${result.reason}`);
        assert.ok(!fs.existsSync(zipFilePath), `Local zip should not exist after config-fail, found ${zipFilePath}`);
        console.log('PASS: permanent failure returned without retry');
    } finally {
        fs.rmSync(profileDir, { recursive: true, force: true });
        if (fs.existsSync(zipFilePath)) fs.rmSync(zipFilePath, { force: true });
    }
    console.log('CASE 2: PASS');
}

async function runCase3() {
    console.log('\n=== CASE 3: isS3PermanentError classification ===');
    const fresh = await import(`../../app/api/googledrive.mjs?case3=${Date.now()}`);
    const { isS3PermanentError } = fresh;

    const authErrors = [
        'The AWS Access Key Id you provided does not exist in our records. (Status: 403, Error Code: InvalidAccessKeyId)',
        'The request signature we calculated does not match the signature you provided. (Error Code: SignatureDoesNotMatch)',
        'Access Denied (Status: 403, Error Code: AccessDenied)',
        'UnknownError: 403',
        'The specified bucket does not exist (Error Code: NoSuchBucket)',
    ];
    for (const msg of authErrors) {
        assert.strictEqual(isS3PermanentError(msg), true, `Expected permanent for: ${msg}`);
    }

    const transientErrors = [
        'Network failure: socket hang up',
        'connect ECONNREFUSED 127.0.0.1:443',
        'Request timeout after 3000ms',
        'Service Unavailable (Status: 503)',
        'Internal Server Error (Status: 500)',
    ];
    for (const msg of transientErrors) {
        assert.strictEqual(isS3PermanentError(msg), false, `Expected transient for: ${msg}`);
    }

    console.log('PASS: auth/config errors permanent, network/timeout errors transient');
    console.log('CASE 3: PASS');
}

async function runLiveProvider(tag, keys, expectedPrefix) {
    console.log(`\n=== CASE ${tag}: live upload to ${keys[0]} provider (env-gated) ===`);
    if (!keys.every((k) => process.env[k])) {
        console.log(`SKIPPED: ${keys[0].split('_')[0]} credentials not set in .env`);
        return;
    }
    for (const k of [...GOOGLE_ENV_KEYS, ...CLOUDINARY_ENV_KEYS]) delete process.env[k];

    const fresh = await import(`../../app/api/googledrive.mjs?${tag.toLowerCase()}=${Date.now()}`);
    const browserId = `s3-waterfall-${tag.toLowerCase()}-${Date.now()}`;
    const profileDir = makeFakeProfileDir(tag.toLowerCase());
    const zipFilePath = `${profileDir}.zip`;

    try {
        const result = await fresh.uploadBrowserDataRaw(browserId, {}, profileDir);
        console.log(`Result: ${JSON.stringify(result, null, 2)}`);
        assert.strictEqual(result.ok, true, `Expected ok=true, got ${JSON.stringify(result)}`);
        assert.ok(String(result.url).startsWith(expectedPrefix),
            `Expected URL starting with ${expectedPrefix}, got ${result.url}`);

        await assertZipUrlIsValidZip(result.url);
        console.log(`PASS: ${keys[0].split('_')[0]} upload is a valid public zip: ${result.url}`);

        assert.ok(!fs.existsSync(zipFilePath), `Local zip not cleaned up: ${zipFilePath}`);
        console.log('PASS: local zip cleaned up after upload');
    } finally {
        fs.rmSync(profileDir, { recursive: true, force: true });
        if (fs.existsSync(zipFilePath)) fs.rmSync(zipFilePath, { force: true });
    }
    console.log(`CASE ${tag}: PASS`);
}

let failed = false;
try {
    await runCase1();
    await runCase2();
    await runCase3();
    await runLiveProvider(4, R2_ENV_KEYS, R2_PRESENT ? process.env.R2_PUBLIC_BASE_URL : 'https://');
    await runLiveProvider(5, B2_ENV_KEYS, B2_PRESENT ? process.env.B2_PUBLIC_BASE_URL : 'https://');
} catch (err) {
    failed = true;
    console.error(`\nFAIL: ${err.message}`);
    if (err.stack) console.error(err.stack);
} finally {
    console.log(failed ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
    process.exit(failed ? 1 : 0);
}