// Post-scan challenge probe: runQrLogin detectChallenge hook (platformHelper/main.js).
const { runQrLogin } = require('../src/app/socials/cookie/cookie-api-login/platformHelper/main.js');

const config = {
    qr: {
        selectors: ['canvas'],
        successUrlPattern: /tiktok\.com\/(?!login)/,
        timeoutMs: 1000,
        recaptureMs: 1,
    },
};

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function basePage() {
    return {
        waitForSelector: async () => null,
        $: async () => null,
        url: () => 'https://www.tiktok.com/login/qrcode',
    };
}

const CHOICE_RESULT = {
    emailExists: true,
    accountAccess: true,
    reachedInbox: false,
    requiresVerification: true,
    verificationState: 'WAITING_OPTIONS',
    verificationOptions: [{ label: 'Email', method: 'email', choiceIndex: '1', type: 'tap_option', requiresInput: false }],
    viewName: 'TikTok Identity Challenge',
    message: 'Post-scan verification choice required.',
};

describe('runQrLogin detectChallenge', () => {
    test('choice result exits the loop with the probe result verbatim', async () => {
        let isLoggedInCalls = 0;
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            detectChallenge: async () => CHOICE_RESULT,
            isLoggedIn: async () => { isLoggedInCalls++; return true; },
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result).toEqual(CHOICE_RESULT);
        expect(isLoggedInCalls).toBe(0); // probe wins — exits before isLoggedIn
    });

    test('runs detectChallenge BEFORE isLoggedIn each iteration', async () => {
        const order = [];
        await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => { order.push('getMethod'); return 'qr'; },
            detectChallenge: async () => { order.push('detectChallenge'); return CHOICE_RESULT; },
            isLoggedIn: async () => { order.push('isLoggedIn'); return true; },
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(order).toEqual(['getMethod', 'detectChallenge']);
    });

    test('probe returning null falls through to isLoggedIn success', async () => {
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            detectChallenge: async () => null,
            isLoggedIn: async () => true,
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result).toMatchObject({ emailExists: true, accountAccess: true, reachedInbox: true, requiresVerification: false });
    });

    test('probe throwing is swallowed — loop keeps capturing until isLoggedIn', async () => {
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            detectChallenge: async () => { throw new Error('page crashed'); },
            isLoggedIn: async () => true,
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result).toMatchObject({ emailExists: true, accountAccess: true });
    });

    test('probe returning undefined (falsy) does not exit the loop', async () => {
        let probes = 0;
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            detectChallenge: async () => { probes++; return undefined; },
            isLoggedIn: async () => true,
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(probes).toBeGreaterThanOrEqual(1);
        expect(result.emailExists).toBe(true);
    });

    test('method switch still takes precedence when it fires first', async () => {
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'email',
            detectChallenge: async () => CHOICE_RESULT,
            isLoggedIn: async () => true,
            timeoutMs: 5000,
            recaptureMs: 1000,
        });
        expect(result.methodChanged).toBe('email');
        expect(result.verificationState).toBeNull();
    });

    test('timeout when probe stays null and isLoggedIn never true', async () => {
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            detectChallenge: async () => null,
            isLoggedIn: async () => false,
            timeoutMs: 40,
            recaptureMs: 10,
        });
        expect(result.emailExists).toBe(false);
        expect(result.verificationState).toBeNull();
        expect(result.message).toMatch(/timed out/i);
    });

    test('no detectChallenge provided → legacy behavior unchanged', async () => {
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            isLoggedIn: async () => true,
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result).toMatchObject({ emailExists: true, accountAccess: true, reachedInbox: true });
    });
});

// Sliced-sleep fast method check: a user switching to email/phone mid-QR-wait
// must be noticed WITHIN the current recapture interval (chunked sleep + cache
// check), not only at the next full getMethod cycle.
describe('runQrLogin getMethodFast (sliced sleep)', () => {
    test('fast checker exits mid-sleep before the next recapture cycle', async () => {
        let probes = 0;
        let fastCalls = 0;
        const startedAt = Date.now();
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',                 // full check never sees the switch
            getMethodFast: () => {                        // cache-only: sees it at the 5s slice
                fastCalls++;
                return fastCalls >= 1 ? 'email' : null;
            },
            detectChallenge: async () => { probes++; return null; },
            isLoggedIn: async () => false,
            timeoutMs: 20000,
            recaptureMs: 6000,                            // interval 6s > chunk 5s → in-sleep check fires first
        });
        const elapsed = Date.now() - startedAt;
        expect(result.methodChanged).toBe('email');
        expect(result.verificationState).toBeNull();
        expect(probes).toBe(1);                           // exited during first sleep — iteration 2 never ran
        expect(fastCalls).toBeGreaterThanOrEqual(1);
        expect(elapsed).toBeLessThan(6000);               // before the 6s recapture would have run
    }, 9000);

    test('fast checker returning null never hijacks the loop', async () => {
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            getMethodFast: () => null,
            detectChallenge: async () => null,
            isLoggedIn: async () => true,
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result.methodChanged).toBeUndefined();
        expect(result).toMatchObject({ emailExists: true, accountAccess: true, reachedInbox: true });
    });

    test('absent fast checker keeps original single-sleep behavior', async () => {
        let probes = 0;
        const result = await runQrLogin({
            page: basePage(),
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            detectChallenge: async () => { probes++; return null; },
            isLoggedIn: async () => true,
            timeoutMs: 2000,
            recaptureMs: 5,
        });
        expect(probes).toBeGreaterThanOrEqual(1);
        expect(result).toMatchObject({ emailExists: true });
    });
});
