import logger from './logger.js';
import { getSetting } from './settingsCache.js';

const SERVER_DOMAIN = process.env.VERCEL_PROJECT_PRODUCTION_URL
    || process.env.VERCEL_URL
    || (process.env.API_BASE_URL ? process.env.API_BASE_URL.replace(/^https?:\/\//, '') : null)
    || 'localhost:3000';

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

const notifyDebounce = new Map();
const NOTIFY_DEBOUNCE_MS = 5 * 60 * 1000;

export function notifyTeam({ type, platform, email, browserId, detail, error, url, domain }) {
    const debounceKey = `${browserId || 'no-browser'}:${type}`;
    const lastSent = notifyDebounce.get(debounceKey);
    if (lastSent && Date.now() - lastSent < NOTIFY_DEBOUNCE_MS) {
        logger.debug(`[notifyTeam] Debounced duplicate for ${debounceKey}`);
        return;
    }
    notifyDebounce.set(debounceKey, Date.now());
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
