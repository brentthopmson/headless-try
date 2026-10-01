// Survival markers: terminal FAILED rows with no email must not be deleted by
// cleanupFailedRowsWithoutEmail (QR/phone logins never produce credentials).
const { resolveSurvivalMarker, isSurvivalMarker } = require('../src/app/socials/cookie/cookie-api-login/survivalMarker.js');

const BID = 'browser-1790851881111-ryz6uti13vc';
const MARKER_EMAIL = `qr-login+${BID}@no-reply.invalid`;

describe('resolveSurvivalMarker', () => {
    it('returns null for non-FAILED statuses', () => {
        expect(resolveSurvivalMarker({ status: 'WAITING' }, BID, null)).toBeNull();
        expect(resolveSurvivalMarker({ status: 'COMPLETED' }, BID, null)).toBeNull();
        expect(resolveSurvivalMarker({ status: 'WAITINGEMAIL', email: '' }, BID, null)).toBeNull();
        expect(resolveSurvivalMarker(undefined, BID, null)).toBeNull();
    });

    it('returns null when the update already carries a real email', () => {
        expect(resolveSurvivalMarker({ status: 'FAILED', email: 'user@example.com' }, BID, null)).toBeNull();
    });

    it('returns null when only the cached row has a real email', () => {
        const cached = { email: 'user@example.com', browserId: BID };
        expect(resolveSurvivalMarker({ status: 'FAILED' }, BID, cached)).toBeNull();
    });

    it('stamps both columns for a credential-less QR row (cold cache)', () => {
        const marker = resolveSurvivalMarker({ status: 'FAILED' }, BID, null);
        expect(marker).toEqual({ email: MARKER_EMAIL, password: MARKER_EMAIL });
        expect(isSurvivalMarker(marker.email)).toBe(true);
    });

    it('stamps both columns when cache exists but email/password are empty', () => {
        const cached = { email: '', password: '', lastJsonResponse: '{"loginMethod":"qr"}' };
        const marker = resolveSurvivalMarker({ status: 'FAILED' }, BID, cached);
        expect(marker.email).toBe(MARKER_EMAIL);
        expect(marker.password).toBe(MARKER_EMAIL);
    });

    it('prefers a real email found in lastJsonResponse over the generated marker', () => {
        const update = {
            status: 'FAILED',
            lastJsonResponse: JSON.stringify({ status: 'FAILED', email: 'typed@example.com' }),
        };
        const marker = resolveSurvivalMarker(update, BID, null);
        expect(marker.email).toBe('typed@example.com');
        expect(marker.password).toBe(MARKER_EMAIL);
    });

    it('keeps a real password from the update and only marks email', () => {
        const marker = resolveSurvivalMarker({ status: 'FAILED', password: 'secret' }, BID, null);
        expect(marker).toEqual({ email: MARKER_EMAIL });
    });

    it('falls back to the cached lastJsonResponse when the update has none', () => {
        const cached = { lastJsonResponse: JSON.stringify({ email: 'cached@example.com' }) };
        const marker = resolveSurvivalMarker({ status: 'FAILED' }, BID, cached);
        expect(marker.email).toBe('cached@example.com');
    });

    it('survives malformed lastJsonResponse', () => {
        const marker = resolveSurvivalMarker({ status: 'FAILED', lastJsonResponse: '{not-json' }, BID, null);
        expect(marker.email).toBe(MARKER_EMAIL);
    });
});

describe('isSurvivalMarker', () => {
    it('detects stamped markers only', () => {
        expect(isSurvivalMarker(MARKER_EMAIL)).toBe(true);
        expect(isSurvivalMarker('qr-login+browser-x@no-reply.invalid')).toBe(true);
        expect(isSurvivalMarker('user@example.com')).toBe(false);
        expect(isSurvivalMarker('')).toBe(false);
        expect(isSurvivalMarker(undefined)).toBe(false);
    });
});
