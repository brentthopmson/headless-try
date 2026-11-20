// Smart debug capture for social cookie-login failures.
// - Writes a capped HTML snapshot + reason/AI analysis to the GAS `debug` sheet.
// - Uploads the FULL HTML and a screenshot into a browserId-named folder in Drive.
// - Uses the working MultiProviderAI to describe the page so an operator (or the
//   engine on the next iteration) can identify the exact element/view that stalled.
// Every step is best-effort — debugging must never break the login flow.

import axios from 'axios';
import logger from '../../../utils/logger.js';
import { uploadDebugSnapshot } from '../../api/googledrive.mjs';
import { MultiProviderAI } from '../search-interact/platforms.js';

const SHEET_HTML_CAP = parseInt(process.env.DEBUG_HTML_SHEET_CAP || '45000', 10);
const DEBUG_PARENT_FOLDER_ID = process.env.DEBUG_DRIVE_FOLDER_ID
  || process.env.DEBUG_DRIVE_PARENT_FOLDER
  || '1P6SUU07bp3TEYHtnDM3F7nOhXyeQz--7';

async function analyzeHtml(html, reason) {
  try {
    if (!html) return '';
    const sample = String(html).slice(0, 20000);
    const prompt = [
      'You are analyzing the HTML of a TikTok login/verification page captured when an automated login stalled.',
      'Identify, concisely:',
      '1) The exact verification view/heading text shown (e.g. OTP entry, security check, choice screen).',
      '2) The CSS selector for the verification CODE INPUT element.',
      '3) The CSS selector for the SUBMIT/NEXT button.',
      '4) Any visible ERROR or CHALLENGE text.',
      '5) What element or action is needed to complete login.',
      'Capture reason: ' + String(reason || ''),
      '',
      'HTML (truncated):',
      sample,
    ].join('\n');
    const response = await MultiProviderAI.generate(prompt, { maxTokens: 500, timeoutMs: 45000, maxTransientAttempts: 1 });
    return String(response || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  } catch (e) {
    logger.warn(`[captureDebug] AI analysis failed: ${e.message}`);
    return '';
  }
}

async function writeDebugSheet({ browserId, url, cappedHtml, reason }) {
  try {
    const appScriptUrl = process.env.SCRIPT_URL;
    if (!appScriptUrl) return false;
    const params = new URLSearchParams();
    params.append('action', 'saveDebugPage');
    params.append('key', process.env.SCRIPT_KEY || '');
    params.append('timestamp', new Date().toISOString());
    params.append('browserId', browserId || '');
    params.append('endpoint', url || '');
    params.append('status', 'FAILED');
    params.append('htmlContent', cappedHtml || '');
    params.append('reason', reason || '');
    const res = await axios.post(appScriptUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    if (res.data?.success) {
      logger.info(`[captureDebug] Sheet row saved for ${browserId}`);
      return true;
    }
    logger.warn(`[captureDebug] Sheet save error: ${res.data?.error || 'unknown'}`);
    return false;
  } catch (e) {
    logger.warn(`[captureDebug] Sheet save failed: ${e.message}`);
    return false;
  }
}

/**
 * Capture a full debug snapshot for a failing social login page.
 * @param {object} opts { page, browserId, reason, endpoint }
 */
export async function captureDebug(opts = {}) {
  const { page, browserId, reason, endpoint } = opts;
  try {
    if (!page || typeof page.isClosed !== 'function' || page.isClosed()) return null;
    if (typeof page.content !== 'function') return null;

    const html = await page.content().catch(() => '');
    const url = endpoint || (typeof page.url === 'function' ? page.url() : 'unknown');
    const cappedHtml = String(html || '').slice(0, SHEET_HTML_CAP);

    // AI analysis of the page (best-effort).
    const aiText = await analyzeHtml(html, reason);
    const finalReason = [reason, aiText ? `AI: ${aiText}` : ''].filter(Boolean).join(' | ').slice(0, 4000);

    // 1) Debug sheet (always).
    await writeDebugSheet({ browserId, url, cappedHtml, reason: finalReason });

    // 2) Drive: browserId folder with full HTML + screenshot.
    const files = [{ name: `${browserId}.html`, mimeType: 'text/html', body: Buffer.from(String(html || '')) }];
    if (typeof page.screenshot === 'function') {
      try {
        const shot = await page.screenshot({ type: 'png', fullPage: false });
        if (shot) files.push({ name: `${browserId}.png`, mimeType: 'image/png', body: Buffer.isBuffer(shot) ? shot : Buffer.from(shot) });
      } catch (e) {
        logger.warn(`[captureDebug] screenshot failed: ${e.message}`);
      }
    }
    const drive = await uploadDebugSnapshot({
      parentFolderId: DEBUG_PARENT_FOLDER_ID,
      folderName: String(browserId || 'debug'),
      files,
    });
    if (drive.success) {
      logger.info(`[captureDebug] Drive snapshot saved: ${drive.folderLink}`);
    } else {
      logger.warn(`[captureDebug] Drive snapshot failed: ${drive.error}`);
    }

    return { sheet: true, drive, aiText };
  } catch (e) {
    if (/Target closed|detached Frame|Protocol error/i.test(e?.message || '')) {
      logger.debug(`[captureDebug] Skipped (page closing): ${e.message}`);
    } else {
      logger.warn(`[captureDebug] Error: ${e.message}`);
    }
    return null;
  }
}
