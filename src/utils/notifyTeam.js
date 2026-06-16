import logger from './logger.js';
import { getSheetDataApi } from '../app/api/googlesheets.js';

const SERVER_DOMAIN = process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || (process.env.API_BASE_URL ? process.env.API_BASE_URL.replace(/^https?:\/\//, '') : null)
    || 'localhost:3000';

let settingsCache = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

async function getSetting(key) {
    const now = Date.now();
    if (settingsCache && now - cacheTime < CACHE_TTL) {
        return settingsCache[key];
    }
    try {
        const result = await getSheetDataApi('settings');
        if (result.success && result.data && result.headers) {
            const keyIdx = result.headers.indexOf('settingsKey');
            const val1Idx = result.headers.indexOf('settingsValue1');
            const val2Idx = result.headers.indexOf('settingsValue2');
            if (keyIdx === -1) {
                logger.warn('[notifyTeam] SETTINGS sheet missing settingsKey column');
                return null;
            }
            settingsCache = {};
            for (const row of result.data) {
                const k = row[keyIdx];
                if (k) {
                    settingsCache[k] = {
                        value1: val1Idx !== -1 ? row[val1Idx] : null,
                        value2: val2Idx !== -1 ? row[val2Idx] : null
                    };
                }
            }
            cacheTime = now;
            return settingsCache[key];
        }
    } catch (err) {
        logger.error(`[notifyTeam] Failed to read SETTINGS sheet: ${err.message}`);
    }
    return null;
}

async function sendTelegram(token, chatId, text) {
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger.warn(`[notifyTeam] Telegram responded ${res.status}: ${body}`);
        }
    } catch (err) {
        logger.error(`[notifyTeam] Telegram send failed: ${err.message}`);
    }
}

async function sendDiscord(webhookUrl, text) {
    try {
        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text })
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            logger.warn(`[notifyTeam] Discord responded ${res.status}: ${body}`);
        }
    } catch (err) {
        logger.error(`[notifyTeam] Discord send failed: ${err.message}`);
    }
}

export function notifyTeam({ type, platform, email, browserId, detail, error, url, domain }) {
    _notify({ type, platform, email, browserId, detail, error, url, domain }).catch(() => {});
}

async function _notify({ type, platform, email, browserId, detail, error, url, domain }) {
    const botSetting = await getSetting('webFixxTelegramBot');
    const chatSetting = await getSetting('webFixxTelegramChatId');
    const discordSetting = await getSetting('discordWebhookURL');

    const targetDomain = domain || (url ? url.replace(/^https?:\/\//, '').split('/')[0] : '');
    const time = new Date().toISOString();

    const message = [
        `[${type}] ${platform || 'Unknown'}`,
        email ? `Email: ${email}` : '',
        targetDomain ? `Target: ${targetDomain}` : '',
        `Server: ${SERVER_DOMAIN}`,
        browserId ? `Browser: ${browserId}` : '',
        detail ? `Detail: ${detail}` : '',
        error ? `Error: ${error}` : '',
        `Time: ${time}`
    ].filter(Boolean).join('\n');

    const botToken = botSetting?.value1 || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = chatSetting?.value1;

    if (botToken && chatId) {
        sendTelegram(botToken, chatId, message);
    } else {
        logger.debug(`[notifyTeam] Telegram skipped - missing botToken=${!!botToken} chatId=${!!chatId}`);
    }

    if (discordSetting?.value1) {
        sendDiscord(discordSetting.value1, message);
    } else {
        logger.debug('[notifyTeam] Discord skipped - no webhook URL configured');
    }
}
