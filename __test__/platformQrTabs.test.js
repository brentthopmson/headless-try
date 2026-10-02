// Phase 2Q: warm tabs + QR login runtime (platformHelper/main.js).
const {
    warmTabUrls,
    normalizeWarmUrl,
    matchWarmEntry,
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

describe('normalizeWarmUrl / matchWarmEntry', () => {
    test('normalizes www, query, hash, trailing slash, port case', () => {
        expect(normalizeWarmUrl('https://WWW.TikTok.com/login/qrcode/?x=1#y')).toBe('https://tiktok.com/login/qrcode');
        expect(normalizeWarmUrl('about:blank')).toBe('');
        expect(normalizeWarmUrl('')).toBe('');
        expect(normalizeWarmUrl(null)).toBe('');
    });

    test('exact match beats prefix; longest prefix wins; null for non-warm', () => {
        const entries = warmTabUrls(config);
        expect(matchWarmEntry('https://www.tiktok.com/login/qrcode?lang=en', entries).method).toBe('qr');
        expect(matchWarmEntry('https://tiktok.com/login/phone-or-email/email', entries).method).toBe('email');
        expect(matchWarmEntry('https://tiktok.com/login/phone-or-email/phone', entries).method).toBe('phone');
        expect(matchWarmEntry('https://tiktok.com/feed', entries)).toBeNull();
        expect(matchWarmEntry('about:blank', entries)).toBeNull();
    });
});

describe('openWarmTabs adoption (session reuse)', () => {
    test('adopts existing warm tabs: 0 new pages, duplicates closed, no re-navigation', async () => {
        const primary = fakePage('https://www.tiktok.com/login/phone-or-email/email');
        const qrTab = fakePage('https://www.tiktok.com/login/qrcode');
        const phoneTab = fakePage('https://www.tiktok.com/login/phone-or-email/phone');
        const dupQr = fakePage('https://www.tiktok.com/login/qrcode');
        const browser = fakeBrowser();
        browser._pages.push(primary, qrTab, phoneTab, dupQr);

        const tabs = await openWarmTabs({ browser, primaryPage: primary, config, logger: noopLogger });

        expect(browser.newPageCount).toBe(0);
        expect(tabs.qr).toBe(qrTab);
        expect(tabs.email).toBe(primary);
        expect(tabs.phone).toBe(phoneTab);
        expect(dupQr.closed).toBe(true);   // duplicate warm tab cleaned up
        expect(qrTab.closed).toBe(false);
        expect(primary.gotos).toEqual([]); // adopted by URL match — not reloaded
        expect(Object.keys(tabs)).toHaveLength(3);
    });

    test('primary on about:blank with all warm tabs open → primary anchors first slot, still 3 tabs', async () => {
        const primary = fakePage('about:blank');
        const qrTab = fakePage('https://www.tiktok.com/login');
        const emailTab = fakePage('https://www.tiktok.com/login/phone-or-email/email');
        const phoneTab = fakePage('https://www.tiktok.com/login/phone-or-email/phone');
        const browser = fakeBrowser();
        browser._pages.push(primary, qrTab, emailTab, phoneTab);

        const tabs = await openWarmTabs({ browser, primaryPage: primary, config, logger: noopLogger });

        expect(browser.newPageCount).toBe(0);
        expect(tabs.qr).toBe(primary);
        expect(primary.gotos).toEqual(['https://www.tiktok.com/login']);
        expect(tabs.email).toBe(emailTab);
        expect(tabs.phone).toBe(phoneTab);
        expect(qrTab.closed).toBe(true); // displaced duplicate closed
        expect(Object.keys(tabs)).toHaveLength(3);
    });

    test('partial reuse: only email tab exists → primary anchors qr, phone created', async () => {
        const primary = fakePage('about:blank');
        const emailTab = fakePage('https://www.tiktok.com/login/phone-or-email/email');
        const browser = fakeBrowser();
        browser._pages.push(primary, emailTab);

        const tabs = await openWarmTabs({ browser, primaryPage: primary, config, logger: noopLogger });

        expect(browser.newPageCount).toBe(1);
        expect(tabs.qr).toBe(primary);
        expect(primary.gotos).toEqual(['https://www.tiktok.com/login']);
        expect(tabs.email).toBe(emailTab);
        expect(tabs.phone).toBeDefined();
        expect(tabs.phone.closed).toBe(false);
        expect(Object.keys(tabs)).toHaveLength(3);
    });

    test('closed pages are ignored during adoption', async () => {
        const primary = fakePage('https://www.tiktok.com/login');
        const deadEmail = fakePage('https://www.tiktok.com/login/phone-or-email/email');
        deadEmail.closed = true;
        const browser = fakeBrowser();
        browser._pages.push(deadEmail);

        const tabs = await openWarmTabs({ browser, primaryPage: primary, config, logger: noopLogger });

        expect(tabs.qr).toBe(primary);
        expect(tabs.email).toBeDefined();
        expect(tabs.email).not.toBe(deadEmail);
        expect(browser.newPageCount).toBe(2); // dead page not adopted
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

describe('openWarmTabs foregroundMethods', () => {
    function deferred() {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
    }

    function gatedNewPage(browser, gateFor) {
        browser.newPage = async () => {
            const p = fakePage();
            p.goto = async u => {
                p.gotos.push(u);
                const gate = gateFor();
                if (gate) await gate.promise;
                p._url = u;
            };
            browser._pages.push(p);
            return p;
        };
        return browser;
    }

    test('control: without foregroundMethods the call waits for every tab', async () => {
        const gate = deferred();
        let created = 0;
        const browser = fakeBrowser();
        gatedNewPage(browser, () => (created++ === 0 ? gate : null));

        const pending = openWarmTabs({ browser, primaryPage: fakePage('about:blank'), config, logger: noopLogger });
        const settled = await Promise.race([
            pending.then(() => true),
            new Promise(r => setTimeout(() => r(false), 150)),
        ]);
        expect(settled).toBe(false); // still blocked on the gated email goto

        gate.resolve();
        const tabs = await pending;
        expect(tabs.email.gotos).toEqual(['https://www.tiktok.com/login/phone-or-email/email']);
    });

    test('foreground qr: resolves while email/phone gotos still in flight, then they complete', async () => {
        const emailGate = deferred();
        const phoneGate = deferred();
        let created = 0;
        const browser = fakeBrowser();
        gatedNewPage(browser, () => (created === 0 ? (created++, emailGate) : (created++, phoneGate)));
        const primary = fakePage('about:blank');

        const pending = openWarmTabs({
            browser,
            primaryPage: primary,
            config,
            logger: noopLogger,
            foregroundMethods: ['qr'],
        });
        const settled = await Promise.race([
            pending.then(() => true),
            new Promise(r => setTimeout(() => r(false), 150)),
        ]);
        expect(settled).toBe(true); // QR tab ready — did not wait for gated tabs

        const tabs = await pending;
        expect(tabs.qr).toBe(primary);
        expect(primary.gotos).toEqual(['https://www.tiktok.com/login']); // foreground nav done
        expect(tabs.email).toBeDefined();
        expect(tabs.phone).toBeDefined();
        expect(isWarmOpening()).toBe(false); // flag released even with floating gotos

        emailGate.resolve();
        phoneGate.resolve();
        await new Promise(r => setTimeout(r, 10));
        expect(tabs.email.gotos).toEqual(['https://www.tiktok.com/login/phone-or-email/email']);
        expect(tabs.phone.gotos).toEqual(['https://www.tiktok.com/login/phone-or-email/phone']);
    });

    test('foreground email: primary QR nav floats, email nav awaited', async () => {
        const qrGate = deferred();
        const primary = fakePage('about:blank');
        primary.goto = async u => { primary.gotos.push(u); await qrGate.promise; primary._url = u; };
        const browser = fakeBrowser();

        const pending = openWarmTabs({
            browser,
            primaryPage: primary,
            config,
            logger: noopLogger,
            foregroundMethods: ['email'],
        });
        const settled = await Promise.race([
            pending.then(() => true),
            new Promise(r => setTimeout(() => r(false), 150)),
        ]);
        expect(settled).toBe(true); // did not wait for the primary's gated goto

        const tabs = await pending;
        expect(tabs.email.gotos).toEqual(['https://www.tiktok.com/login/phone-or-email/email']);

        qrGate.resolve();
        await new Promise(r => setTimeout(r, 10));
        expect(primary.gotos).toEqual(['https://www.tiktok.com/login']); // floated nav still ran
    });

    test('floating goto failure closes its own tab (no zombie)', async () => {
        const browser = fakeBrowser();
        let created = 0;
        browser.newPage = async () => {
            const p = fakePage();
            p.goto = async u => {
                p.gotos.push(u);
                if (created++ === 0) throw new Error('net::ERR_NAME_NOT_RESOLVED');
                p._url = u;
            };
            browser._pages.push(p);
            return p;
        };

        const tabs = await openWarmTabs({
            browser,
            primaryPage: fakePage('https://www.tiktok.com/login'), // anchors qr without nav
            config: { loginMethods: { qr: { url: 'https://www.tiktok.com/login' }, email: { url: 'https://www.tiktok.com/login/phone-or-email/email' } } },
            logger: noopLogger,
            foregroundMethods: ['qr'],
        });

        expect(tabs.qr).toBeDefined();
        expect(tabs.email).toBeDefined();
        await new Promise(r => setTimeout(r, 10));
        expect(browser._pages[0].closed).toBe(true); // failed floated tab cleaned up
    });
});
