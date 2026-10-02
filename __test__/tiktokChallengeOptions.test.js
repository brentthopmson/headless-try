// Post-QR challenge option extraction: wrapper/title filtering, dedupe, labels.
const { buildTikTokChallengeOptions } = require('../src/app/socials/cookie/cookie-api-login/platformHelper/tiktok.js');

// Exact div[class*="pc-home-item"] textContent sequence observed on the real
// TikTok "Verify it's really you" modal (screenshot): a wrapper containing
// both rows, two identical full email rows, a title-only div, three password
// matches. The old extractor turned this into 7 garbage options.
const SCREENSHOT_TEXTS = [
    'Emails***6@instaddr.chPassword', // wrapper (both rows concatenated)
    'Emails***6@instaddr.ch',         // email row (outer)
    'Emails***6@instaddr.ch',         // email row (inner duplicate)
    'Email',                          // title-only div
    'Password',                       // password row
    'Password',                       // duplicate
    'Password',                       // duplicate
];

describe('buildTikTokChallengeOptions', () => {
    test('screenshot fixture collapses to 2 clean options with masked detail', () => {
        expect(buildTikTokChallengeOptions(SCREENSHOT_TEXTS)).toEqual([
            { label: 'Email', maskedDetail: 's***6@instaddr.ch', method: 'email', choiceIndex: '1', type: 'tap_option', requiresInput: false },
            { label: 'Password', method: 'password', choiceIndex: '2', type: 'tap_option', requiresInput: false },
        ]);
    });

    test('wrapper-only input yields no options', () => {
        expect(buildTikTokChallengeOptions(['Emails***6@instaddr.chPassword'])).toEqual([]);
    });

    test('title-only rows (no masked detail) keep the raw text as label', () => {
        const options = buildTikTokChallengeOptions(['Email', 'Password']);
        expect(options).toEqual([
            { label: 'Email', method: 'email', choiceIndex: '1', type: 'tap_option', requiresInput: false },
            { label: 'Password', method: 'password', choiceIndex: '2', type: 'tap_option', requiresInput: false },
        ]);
    });

    test('full title longer than the keyword becomes the label verbatim', () => {
        const options = buildTikTokChallengeOptions(['Email or username', 'Password']);
        expect(options[0].label).toBe('Email or username');
        expect(options[0].maskedDetail).toBeUndefined();
        expect(options[0].method).toBe('email');
    });

    test('whitespace/newlines are normalized before matching', () => {
        const options = buildTikTokChallengeOptions(['\n  Emails***6@instaddr.ch \n', ' Password\n']);
        expect(options[0].label).toBe('Email');
        expect(options[0].maskedDetail).toBe('s***6@instaddr.ch');
        expect(options[1].label).toBe('Password');
    });

    test('page order decides choiceIndex (password listed first)', () => {
        const options = buildTikTokChallengeOptions(['Password', 'Emails***6@instaddr.ch']);
        expect(options.map((o) => o.choiceIndex)).toEqual(['1', '2']);
        expect(options[0].method).toBe('password');
        expect(options[1].method).toBe('email');
    });

    test('equal-length duplicates: the later (inner) node wins the tie', () => {
        const options = buildTikTokChallengeOptions(['Emails***6@instaddr.ch', 'Emails***6@instaddr.ch']);
        expect(options).toHaveLength(1);
        expect(options[0].maskedDetail).toBe('s***6@instaddr.ch');
    });

    test('empty, null and junk entries are ignored', () => {
        expect(buildTikTokChallengeOptions([])).toEqual([]);
        expect(buildTikTokChallengeOptions(null)).toEqual([]);
        expect(buildTikTokChallengeOptions(['', null, '   ', 'Sign in with Google', '  Password '])).toEqual([
            { label: 'Password', method: 'password', choiceIndex: '1', type: 'tap_option', requiresInput: false },
        ]);
    });
});
