// Pure-logic tests for the SETTINGS-sheet refresh-token source.
// No network, no logger: extraction + expiry hint + source precedence only.
const {
    SETTINGS_KEY,
    extractRefreshToken,
    parseExpiryFromValue2,
    chooseRefreshToken,
} = require('../src/utils/googleTokenSourceCore.js');

const HEADERS = ['settingsKey', 'settingsValue1', 'settingsValue2', 'note'];
const TOKEN = 'TEST_REFRESH_TOKEN_not_a_secret_x8Qw7Rm2';

describe('extractRefreshToken (SETTINGS row -> token)', () => {
    test('settingsKey constant is googleRefreshToken', () => {
        expect(SETTINGS_KEY).toBe('googleRefreshToken');
    });

    test('extracts the token from the googleRefreshToken row', () => {
        const data = [
            ['multiServerEnabled', 'true', '', ''],
            ['googleRefreshToken', TOKEN, 'rotated 2026-10-06', ''],
            ['webFixxTelegramChatId', '-100', '', ''],
        ];
        expect(extractRefreshToken(HEADERS, data)).toBe(TOKEN);
    });

    test('trims surrounding whitespace', () => {
        const data = [['googleRefreshToken', `  ${TOKEN}\n`, '', '']];
        expect(extractRefreshToken(HEADERS, data)).toBe(TOKEN);
    });

    test('missing row -> null', () => {
        const data = [['multiServerEnabled', 'true', '', '']];
        expect(extractRefreshToken(HEADERS, data)).toBeNull();
    });

    test('empty/whitespace value -> null (falls back to stale/env)', () => {
        const data = [['googleRefreshToken', '   ', '', '']];
        expect(extractRefreshToken(HEADERS, data)).toBeNull();
    });

    test('missing settingsValue1 column -> null', () => {
        expect(extractRefreshToken(['settingsKey', 'settingsValue2'], [['googleRefreshToken', 'x']])).toBeNull();
    });

    test('missing settingsKey column -> null', () => {
        expect(extractRefreshToken(['settingsValue1', 'settingsValue2'], [[TOKEN, '']])).toBeNull();
    });

    test('non-array inputs -> null', () => {
        expect(extractRefreshToken(null, null)).toBeNull();
        expect(extractRefreshToken('settingsKey', [])).toBeNull();
        expect(extractRefreshToken(HEADERS, undefined)).toBeNull();
    });

    test('similar key names do not match (exact equality)', () => {
        const data = [['googleRefreshTokenOld', TOKEN, '', '']];
        expect(extractRefreshToken(HEADERS, data)).toBeNull();
    });

    test('skips null/short rows without throwing', () => {
        const data = [null, [], ['googleRefreshToken', TOKEN]];
        expect(extractRefreshToken(HEADERS, data)).toBe(TOKEN);
    });
});

describe('parseExpiryFromValue2 (rotation expiry hint)', () => {
    test('expires=<epoch-seconds> -> epoch ms', () => {
        expect(parseExpiryFromValue2('expires=1760000000')).toBe(1760000000 * 1000);
    });

    test('expires=<epoch-ms> -> unchanged', () => {
        expect(parseExpiryFromValue2('expires=1760000000000')).toBe(1760000000000);
    });

    test('hint embedded in a free-form note', () => {
        expect(parseExpiryFromValue2('rotated 2026-10-06 (expires=1760000000)')).toBe(1760000000 * 1000);
    });

    test('free-form note without hint -> null', () => {
        expect(parseExpiryFromValue2('rotated 2026-10-06 (exp ~2026-10-13)')).toBeNull();
    });

    test('garbage / empty / null -> null', () => {
        expect(parseExpiryFromValue2('expires=abc')).toBeNull();
        expect(parseExpiryFromValue2('')).toBeNull();
        expect(parseExpiryFromValue2(null)).toBeNull();
        expect(parseExpiryFromValue2(undefined)).toBeNull();
    });
});

describe('chooseRefreshToken (sheet > stale > env)', () => {
    test('sheet wins over stale and env', () => {
        expect(chooseRefreshToken({ sheet: 'sheet-token', stale: 'stale-token', env: 'env-token' })).toBe('sheet-token');
    });

    test('empty sheet falls back to stale, then env', () => {
        expect(chooseRefreshToken({ sheet: '  ', stale: 'stale-token', env: 'env-token' })).toBe('stale-token');
        expect(chooseRefreshToken({ sheet: null, stale: '', env: 'env-token' })).toBe('env-token');
    });

    test('all sources empty -> null', () => {
        expect(chooseRefreshToken({ sheet: '', stale: '  ', env: null })).toBeNull();
        expect(chooseRefreshToken()).toBeNull();
    });

    test('candidates are trimmed before comparison', () => {
        expect(chooseRefreshToken({ sheet: undefined, stale: '  padded  ', env: 'env' })).toBe('padded');
    });
});
