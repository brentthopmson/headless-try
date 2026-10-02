// checkVerification screen matching: all-elements iteration + text
// normalization + rendered-text fallback (platformHelper/verificationMatch.js).
const { matchVerificationView } = require('../src/app/socials/cookie/cookie-api-login/platformHelper/verificationMatch.js');

function el(textContent, sels) {
    return { textContent, _sels: sels || [] };
}

// Fake Document: querySelectorAll returns elements listing the selector,
// body.innerText is the rendered-text fallback surface.
function root(elements, bodyText) {
    return {
        querySelectorAll(sel) { return elements.filter((e) => e._sels.indexOf(sel) !== -1); },
        body: { innerText: bodyText == null ? '' : bodyText },
    };
}

const IDENTITY_VIEW = {
    name: 'TikTok Identity Challenge',
    match: {
        selector: ['h1[data-testid="tux-web-text"]', 'h1', 'h2', 'div[role="heading"]', '[data-testid="tux-web-text"]'],
        text: "Verify it's really you",
    },
};

describe('matchVerificationView', () => {
    test('regression: QR page h1 precedes modal h1 — later match still found', () => {
        const doc = root([
            el('Log in with QR code', ['h1', 'h1[data-testid="tux-web-text"]']),
            el("Verify it's really you", ['h1']),
        ], '');
        expect(matchVerificationView(IDENTITY_VIEW, doc)).toBe(true);
    });

    test('curly apostrophe in DOM vs straight quote in view text', () => {
        const doc = root([
            el('Verify it\u2019s really you', ['h1']),
        ], '');
        expect(matchVerificationView(IDENTITY_VIEW, doc)).toBe(true);
    });

    test('heading as plain div matches via body.innerText fallback', () => {
        const doc = root(
            [el('Something else', ['h1'])],
            'Log in with QR code\nVerify it\u2019s really you\nPassword'
        );
        expect(matchVerificationView(IDENTITY_VIEW, doc)).toBe(true);
    });

    test('whitespace/newlines are normalized', () => {
        const doc = root([el("  Verify it's \n really you  ", ['h2'])], '');
        expect(matchVerificationView(IDENTITY_VIEW, doc)).toBe(true);
    });

    test('phrase absent → no match', () => {
        const doc = root([
            el('Log in with QR code', ['h1', 'h1[data-testid="tux-web-text"]']),
        ], 'Log in with QR code Password');
        expect(matchVerificationView(IDENTITY_VIEW, doc)).toBe(false);
    });

    test('case-insensitive match', () => {
        const doc = root([el('VERIFY IT\u2019S REALLY YOU', ['div[role="heading"]'])], '');
        expect(matchVerificationView(IDENTITY_VIEW, doc)).toBe(true);
    });

    test('view without text criterion: any selector hit matches', () => {
        const view = { name: 'X', match: { selector: 'h2' } };
        expect(matchVerificationView(view, root([el('whatever', ['h2'])], ''))).toBe(true);
        expect(matchVerificationView(view, root([el('whatever', ['h1'])], 'whatever'))).toBe(false);
    });

    test('non-string selector is skipped without throwing', () => {
        const view = { name: 'X', match: { selector: [null, 'h1'], text: 'Verify it\'s really you' } };
        const doc = root([el("Verify it's really you", ['h1'])], '');
        expect(matchVerificationView(view, doc)).toBe(true);
        expect(matchVerificationView({ name: 'Y', match: { selector: [42], text: 'Verify it\'s really you' } }, doc)).toBe(false);
    });

    test('invalid view/root inputs → false', () => {
        expect(matchVerificationView(null, root([], ''))).toBe(false);
        expect(matchVerificationView({}, root([], ''))).toBe(false);
        expect(matchVerificationView(IDENTITY_VIEW, null)).toBe(false);
        expect(matchVerificationView(IDENTITY_VIEW, { querySelectorAll: 'nope' })).toBe(false);
    });

    test('root without body skips the fallback instead of crashing', () => {
        const bare = { querySelectorAll: (sel) => (sel === 'h1' ? [el('Log in with QR code', [])] : []) };
        expect(matchVerificationView(IDENTITY_VIEW, bare)).toBe(false);
    });

    // THE production bug: page.evaluate(fn, view) invokes fn(view) with no
    // root argument — the matcher must fall back to the evaluate realm's
    // global document, or every checkVerification call returns false.
    test('production path: omitted root defaults to global document', () => {
        const fakeDoc = root([el("Verify it's really you", ['h1'])], '');
        const prev = global.document;
        global.document = fakeDoc;
        try {
            expect(matchVerificationView(IDENTITY_VIEW)).toBe(true);
        } finally {
            if (prev === undefined) delete global.document;
            else global.document = prev;
        }
    });

    test('omitted root with no document available → false (Node safety)', () => {
        const prev = global.document;
        try { delete global.document; } catch (e) { global.document = undefined; }
        try {
            expect(matchVerificationView(IDENTITY_VIEW)).toBe(false);
        } finally {
            if (prev !== undefined) global.document = prev;
        }
    });
});
