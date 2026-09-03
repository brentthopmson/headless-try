import logger from './logger.js';
import { getSetting } from './settingsCache.js';
import { appendSheetRowApi } from '../app/api/googlesheets.js';
import { sendTelegramMessage } from '../app/api/telegram.js';

// Sheet used to record campaign failures for post-mortem debugging. Mirrors the
// engine's existing DEBUG/debug-snapshot convention (saveDebugSnapshot posts to the
// GAS saveDebugPage action); this helper appends a structured row directly.
const DEBUG_SHEET_NAME = 'DEBUG';

/**
 * Records a campaign failure to the DEBUG sheet and (opt-in) notifies the admin
 * Telegram chat `webFixxTelegramChatId`. Gated by the SETTINGS row
 * `allowNotifyCampaignFail` (TRUE/on = enabled; blank/missing = enabled to be safe).
 * Non-blocking in spirit: failures here are logged, never thrown to the caller.
 *
 * @param {Object} payload
 * @param {string} payload.campaignId
 * @param {string} [payload.stage]
 * @param {string} [payload.channelType]
 * @param {number} [payload.failedCount]
 * @param {string} [payload.reason]
 * @param {string} [payload.error]
 * @param {*} [payload.details]
 */
export async function notifyCampaignFailure({ campaignId, stage, channelType, failedCount, reason, error, details }) {
    const timestamp = new Date().toISOString();
    const batchId = Date.now().toString(36);
    const safeReason = String(reason || error || 'Unknown campaign failure').slice(0, 500);

    // Always record a structured DEBUG row so failures are recoverable even if
    // the Telegram alert is disabled or the target chat is misconfigured.
    try {
        const res = await appendSheetRowApi(DEBUG_SHEET_NAME, {
            campaignId,
            status: 'FAILED',
            stage: stage || '',
            channelType: channelType || '',
            failedCount: failedCount ?? 1,
            reason: safeReason,
            batchId,
            timestamp,
            details: JSON.stringify(details ?? {}).slice(0, 2000),
        });
        if (res.success) {
            logger.info(`[notifyCampaignFailure][${campaignId}] DEBUG row appended.`);
        } else {
            logger.error(`[notifyCampaignFailure][${campaignId}] DEBUG sheet append failed: ${res.error}`);
        }
    } catch (err) {
        logger.error(`[notifyCampaignFailure][${campaignId}] DEBUG sheet append error: ${err.message}`);
    }

    // Telegram alert — admin-controlled via the allowNotifyCampaignFail setting.
    try {
        const flag = await getSetting('allowNotifyCampaignFail');
        const enabled = flag
            ? ['TRUE', 'YES', '1', 'ON'].includes(String(flag.value1 ?? '').trim().toUpperCase())
            : true;
        if (!enabled) {
            logger.info(`[notifyCampaignFailure][${campaignId}] Telegram alert skipped (allowNotifyCampaignFail off).`);
            return;
        }

        const chatSetting = await getSetting('webFixxTelegramChatId');
        const chatId = chatSetting?.value1;
        if (!chatId) {
            logger.warn(`[notifyCampaignFailure][${campaignId}] webFixxTelegramChatId not set; skipping Telegram.`);
            return;
        }

        const message = [
            '*[Campaign Failed]*',
            `*Campaign:* ${campaignId}`,
            stage ? `*Stage:* ${stage}` : '',
            channelType ? `*Type:* ${channelType}` : '',
            `*Failed count:* ${failedCount ?? 1}`,
            `*Reason:* ${safeReason}`,
            `*Time:* ${timestamp}`,
        ].filter(Boolean).join('\n');

        await sendTelegramMessage(chatId, message);
        logger.info(`[notifyCampaignFailure][${campaignId}] Telegram alert sent.`);
    } catch (err) {
        logger.error(`[notifyCampaignFailure][${campaignId}] Telegram send error: ${err.message}`);
    }
}