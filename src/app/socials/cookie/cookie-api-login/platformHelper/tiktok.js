// TikTok-specific facts for the socials login helper — CJS so jest can require() it.

const TIKTOK_PLATFORM_KEY = 'tiktok';
const TIKTOK_LOGIN_URL = 'https://tiktok.com/login';

const LOGIN_METHODS = ['qr', 'email', 'phone'];
const DEFAULT_LOGIN_METHOD = 'email';

function isTiktokPlatform(key) {
    return String(key == null ? '' : key).trim().toLowerCase() === TIKTOK_PLATFORM_KEY;
}

function normalizeLoginMethod(value) {
    const method = String(value == null ? '' : value).trim().toLowerCase();
    return LOGIN_METHODS.includes(method) ? method : '';
}

// ==================== POST-QR CHALLENGE OPTIONS ====================
// div[class*="pc-home-item"] also matches wrapper divs (textContent of BOTH
// rows concatenated, e.g. "Emails***6@instaddr.chPassword") and nested
// title divs (e.g. "Email"). Filtering/dedupe lives here so jest can test
// it; the browser snippets in platforms.js/route.js only gather texts.

const CHALLENGE_KEYWORDS = ['email', 'password'];

function buildTikTokChallengeOptions(rawTexts) {
    const best = new Map(); // keyword -> { raw, detail } (first-seen order)
    (Array.isArray(rawTexts) ? rawTexts : []).forEach((entry) => {
        const text = String(entry == null ? '' : entry).replace(/\s+/g, ' ').trim();
        if (!text) return;
        const lower = text.toLowerCase();
        const hits = CHALLENGE_KEYWORDS.filter((keyword) => lower.includes(keyword));
        if (hits.length !== 1) return; // wrapper spanning 2+ options, or unrelated row
        const keyword = hits[0];
        if (!lower.startsWith(keyword)) return; // option rows begin with the keyword
        const detail = text.slice(keyword.length).trim();
        const prev = best.get(keyword);
        // >= : on equal text the later node wins — descendants (the actual
        // row/inner div) come after their wrapper ancestor in document order.
        if (!prev || text.length >= prev.raw.length) {
            best.set(keyword, { raw: text, detail });
        }
    });
    return Array.from(best.entries()).map(([keyword, entry], index) => {
        const masked = /[@*]/.test(entry.detail);
        const option = {
            label: masked ? keyword.charAt(0).toUpperCase() + keyword.slice(1) : entry.raw,
            method: keyword,
            choiceIndex: String(index + 1),
            type: 'tap_option',
            requiresInput: false,
        };
        if (masked) option.maskedDetail = entry.detail;
        return option;
    });
}

module.exports = {
    TIKTOK_PLATFORM_KEY,
    TIKTOK_LOGIN_URL,
    LOGIN_METHODS,
    DEFAULT_LOGIN_METHOD,
    CHALLENGE_KEYWORDS,
    isTiktokPlatform,
    normalizeLoginMethod,
    buildTikTokChallengeOptions,
};
