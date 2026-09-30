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

module.exports = {
    TIKTOK_PLATFORM_KEY,
    TIKTOK_LOGIN_URL,
    LOGIN_METHODS,
    DEFAULT_LOGIN_METHOD,
    isTiktokPlatform,
    normalizeLoginMethod,
};
