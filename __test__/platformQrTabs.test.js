// Phase 2Q: warm tabs + QR login runtime (platformHelper/main.js).
const {
    warmTabUrls,
    markWarmUrl,
    isWarmUrl,
    setWarmOpening,
    isWarmOpening,
    __resetWarmState,
    openWarmTabs,
    activateWarmTab,
    closeOtherTabs,
    captureQrDataUrl,
    runQrLogin,
} = require('../src/app/socials/cookie/cookie-api-login/platformHelper/main.js');

const config = {
    loginMethods: {
        qr: { url: 'https://www.tiktok.com/login' },
        email: { url: 'https://www.tiktok.com/login/phone-or-email/email' },
        phone: { url: 'https://www.tiktok.com/login/phone-or-email/phone' },
    },
    qr: {
        selectors: ['canvas', "img[src*='qr' i]"],
        successUrlPattern: /tiktok\.com\/(?!login)/,
        timeoutMs: 1000,
        recaptureMs: 5,
    },
};

function fakePage(url = 'about:blank') {
    const p = {
        _url: url,
        closed: false,
        frontCount: 0,
        gotos: [],
        isClosed: () => p.closed,
        url: () => p._url,
        goto: async u => { p.gotos.push(u); p._url = u; },
        bringToFront: async () => { p.frontCount++; },
        close: async () => { p.closed = true; },
        $: async () => null,
    };
    return p;
}

function fakeBrowser() {
    const b = {
        _pages: [],
        newPageCount: 0,
        newPage: async () => {
            b.newPageCount++;
            const p = fakePage();
            b._pages.push(p);
            return p;
        },
        pages: async () => b._pages,
    };
    return b;
}

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

beforeEach(() => __resetWarmState());

describe('warmTabUrls / warm URL + opening flags', () => {
    test('warmTabUrls returns entries in declared order', () => {
        expect(warmTabUrls(config).map(e => e.method)).toEqual(['qr', 'email', 'phone']);
        expect(warmTabUrls(config)[1].url).toBe('https://www.tiktok.com/login/phone-or-email/email');
    });

    test('warmTabUrls with no loginMethods returns []', () => {
        expect(warmTabUrls({})).toEqual([]);
        expect(warmTabUrls(undefined)).toEqual([]);
    });

    test('isWarmUrl: exact + prefix match, rejects about:blank and unknown', () => {
        markWarmUrl('https://www.tiktok.com/login');
        expect(isWarmUrl('https://www.tiktok.com/login')).toBe(true);
        expect(isWarmUrl('https://www.tiktok.com/login/phone-or-email/email')).toBe(true);
        expect(isWarmUrl('https://www.tiktok.com/feed')).toBe(false);
        expect(isWarmUrl('about:blank')).toBe(false);
        expect(isWarmUrl('')).toBe(false);
        expect(isWarmUrl(null)).toBe(false);
    });

    test('setWarmOpening toggles isWarmOpening', () => {
        expect(isWarmOpening()).toBe(false);
        setWarmOpening(true);
        expect(isWarmOpening()).toBe(true);
        setWarmOpening(false);
        expect(isWarmOpening()).toBe(false);
    });
});

describe('openWarmTabs', () => {
    test('reuses primary for first method, creates 2 tabs, calls setupPage, marks URLs', async () => {
        const primary = fakePage('https://example.com/elsewhere');
        const browser = fakeBrowser();
        const setupCalls = [];

        const tabs = await openWarmTabs({
            browser,
            primaryPage: primary,
            config,
            logger: noopLogger,
            setupPage: async p => { setupCalls.push(p); },
        });

        expect(Object.keys(tabs)).toEqual(['qr', 'email', 'phone']);
        expect(tabs.qr).toBe(primary);
        expect(primary.gotos).toEqual(['https://www.tiktok.com/login']);
        expect(browser.newPageCount).toBe(2);
        expect(setupCalls).toHaveLength(2);
        expect(tabs.email.gotos).toEqual(['https://www.tiktok.com/login/phone-or-email/email']);
        expect(isWarmUrl('https://www.tiktok.com/login/phone-or-email/phone')).toBe(true);
        expect(isWarmOpening()).toBe(false); // restored after call
    });

    test('no loginMethods config → {} and no tabs created', async () => {
        const browser = fakeBrowser();
        const tabs = await openWarmTabs({ browser, primaryPage: fakePage(), config: {}, logger: noopLogger });
        expect(tabs).toEqual({});
        expect(browser.newPageCount).toBe(0);
    });

    test('failed new tab is closed (no zombie)', async () => {
        const browser = fakeBrowser();
        browser.newPage = async () => {
            const p = fakePage();
            p.goto = async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); };
            browser._pages.push(p);
            return p;
        };
        const tabs = await openWarmTabs({
            browser,
            primaryPage: fakePage('https://www.tiktok.com/login'),
            config: { loginMethods: { qr: { url: 'https://www.tiktok.com/login' }, email: { url: 'https://www.tiktok.com/login/phone-or-email/email' } } },
            logger: noopLogger,
        });
        expect(tabs.qr).toBeDefined();
        expect(tabs.email).toBeUndefined();
        expect(browser._pages[0].closed).toBe(true);
    });
});

describe('activateWarmTab / closeOtherTabs', () => {
    test('activateWarmTab returns page and brings it to front', async () => {
        const a = fakePage(); const b = fakePage();
        const tabs = { qr: a, email: b };
        const got = await activateWarmTab(tabs, 'email');
        expect(got).toBe(b);
        expect(b.frontCount).toBe(1);
        expect(await activateWarmTab(tabs, 'phone')).toBeNull();
        b.closed = true;
        expect(await activateWarmTab(tabs, 'email')).toBeNull();
    });

    test('closeOtherTabs closes everything except keepPage', async () => {
        const keep = fakePage(); const other = fakePage(); const third = fakePage();
        const browser = { pages: async () => [keep, other, third] };
        await closeOtherTabs(browser, keep, noopLogger);
        expect(keep.closed).toBe(false);
        expect(other.closed).toBe(true);
        expect(third.closed).toBe(true);
    });
});

describe('captureQrDataUrl', () => {
    test('returns null when no selector matches', async () => {
        expect(await captureQrDataUrl({ $: async () => null }, ['canvas'], noopLogger)).toBeNull();
        expect(await captureQrDataUrl(null, ['canvas'], noopLogger)).toBeNull();
    });

    test('uses inline dataUrl from evaluate', async () => {
        const el = { evaluate: async () => 'data:image/png;base64,QUJD', screenshot: async () => { throw new Error('should not screenshot'); } };
        const page = { $: async sel => (sel === 'canvas' ? el : null) };
        expect(await captureQrDataUrl(page, ['canvas'], noopLogger)).toBe('data:image/png;base64,QUJD');
    });

    test('falls back to element screenshot', async () => {
        const el = { evaluate: async () => null, screenshot: async () => Buffer.from('pngbytes') };
        const page = { $: async () => el };
        expect(await captureQrDataUrl(page, ['canvas'], noopLogger)).toBe('data:image/png;base64,' + Buffer.from('pngbytes').toString('base64'));
    });
});

describe('runQrLogin', () => {
    test('success: isLoggedIn true on later iteration → COMPLETED-shaped result', async () => {
        let calls = 0;
        const result = await runQrLogin({
            page: { $: async () => null },
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            isLoggedIn: async () => { calls++; return calls >= 2; },
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result).toMatchObject({ emailExists: true, accountAccess: true, reachedInbox: true, requiresVerification: false, verificationState: null });
        expect(calls).toBeGreaterThanOrEqual(2);
    });

    test('methodChanged: getMethod returns non-qr → exits early without waiting', async () => {
        const result = await runQrLogin({
            page: { $: async () => null },
            config,
            logger: noopLogger,
            getMethod: async () => 'email',
            isLoggedIn: async () => false,
            timeoutMs: 5000,
            recaptureMs: 1000,
        });
        expect(result.methodChanged).toBe('email');
        expect(result.emailExists).toBe(false);
        expect(result.verificationState).toBeNull();
    });

    test('timeout → failure result with credential-fallback message', async () => {
        const result = await runQrLogin({
            page: { $: async () => null },
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            isLoggedIn: async () => false,
            timeoutMs: 30,
            recaptureMs: 10,
        });
        expect(result.emailExists).toBe(false);
        expect(result.accountAccess).toBe(false);
        expect(result.verificationState).toBeNull();
        expect(result.message).toMatch(/timed out/i);
    });

    test('captures QR data and forwards to onQrData each iteration', async () => {
        const seen = [];
        const el = { evaluate: async () => 'data:image/png;base64,QRDATA', screenshot: async () => Buffer.from('x') };
        let isLoggedCalls = 0;
        const result = await runQrLogin({
            page: { $: async () => el },
            config,
            logger: noopLogger,
            getMethod: async () => 'qr',
            isLoggedIn: async () => { isLoggedCalls++; return isLoggedCalls >= 3; },
            onQrData: async d => { seen.push(d); },
            timeoutMs: 2000,
            recaptureMs: 1,
        });
        expect(result.emailExists).toBe(true);
        expect(seen.length).toBeGreaterThanOrEqual(2);
        expect(seen[0]).toBe('data:image/png;base64,QRDATA');
    });

    test('getMethod throwing does not crash the loop', async () => {
        const result = await runQrLogin({
            page: { $: async () => null },
            config,
            logger: noopLogger,
            getMethod: async () => { throw new Error('sheet quota'); },
            isLoggedIn: async () => true,
            timeoutMs: 1000,
            recaptureMs: 1,
        });
        expect(result.emailExists).toBe(true);
    });
});
