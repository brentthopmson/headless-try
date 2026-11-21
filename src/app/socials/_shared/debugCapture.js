// Centralized, failure-agnostic debug capture for all social flows.
// - Writes a capped HTML snapshot + reason/AI analysis to the GAS `debug` sheet.
// - Uploads the FULL HTML, a structured context file and a screenshot into a
//   per-task/browserId folder in Drive.
// - Uses MultiProviderAI to explain ANY failure page (not one specific error):
//   what view is shown, what error text exists, the likely cause, the relevant
//   element(s), and the next recovery action.
// Every step is best-effort — debugging must never break the caller's flow.

import axios from 'axios';
import logger from '../../../utils/logger.js';
import { uploadDebugSnapshot } from '../../api/googledrive.mjs';
import { MultiProviderAI } from '../search-interact/platforms.js';

const SHEET_HTML_CAP = parseInt(process.env.DEBUG_HTML_SHEET_CAP || '45000', 10);
const DEBUG_PARENT_FOLDER_ID = process.env.DEBUG_DRIVE_FOLDER_ID
  || process.env.DEBUG_DRIVE_PARENT_FOLDER
  || '1P6SUU07bp3TEYHtnDM3F7nOhXyeQz--7';
const DEFAULT_AI_TIMEOUT_MS = 45000;

function buildAiPrompt(html, ctx) {
  // Child frames are appended at the end of the snapshot, so include the tail.
  const full = String(html || '');
  const sample = full.length > 24000
    ? full.slice(0, 4000) + '\n...[truncated]...\n' + full.slice(-20000)
    : full;
  return [
    'You are analyzing the HTML of an automated social-media browser page captured at the moment a task FAILED.',
    'The snapshot contains the main frame plus any child frames appended at the end.',
    'Identify concisely:',
    '1) The exact page/view or heading currently displayed.',
    '2) Any visible ERROR, warning, challenge, captcha or rate-limit text (quote it).',
    '3) The most likely root cause of the failure given the context below.',
    '4) The relevant element(s) and CSS selector(s) involved, if any.',
    '5) One concrete next action that would let automation recover or continue.',
    'Context:',
    `- Platform: ${ctx.platform || 'unknown'}`,
    `- Operation/Stage: ${ctx.operation || ctx.stage || 'unknown'}`,
    `- Endpoint: ${ctx.endpoint || 'unknown'}`,
    `- Failure reason: ${ctx.reason || 'unknown'}`,
    ctx.error ? `- Error: ${ctx.error}` : '',
    ctx.details ? `- Details: ${ctx.details}` : '',
    '',
    'HTML (truncated):',
    sample,
  ].filter(Boolean).join('\n');
}

async function analyzeHtml(html, ctx = {}) {
  try {
    if (!html) return '';
    const response = await MultiProviderAI.generate(buildAiPrompt(html, ctx), {
      maxTokens: 500,
      timeoutMs: ctx.aiTimeoutMs || DEFAULT_AI_TIMEOUT_MS,
      maxTransientAttempts: 1,
    });
    return String(response || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  } catch (e) {
    logger.warn(`[captureDebug] AI analysis failed: ${e.message}`);
    return '';
  }
}

async function writeDebugSheet({ identifier, url, cappedHtml, reason, meta = {} }) {
  try {
    const appScriptUrl = process.env.SCRIPT_URL;
    if (!appScriptUrl) return false;
    const params = new URLSearchParams();
    params.append('action', 'saveDebugPage');
    params.append('key', process.env.SCRIPT_KEY || '');
    params.append('timestamp', new Date().toISOString());
    params.append('browserId', identifier || '');
    params.append('endpoint', url || '');
    params.append('status', 'FAILED');
    params.append('htmlContent', cappedHtml || '');
    params.append('reason', reason || '');
    // Extra sheet columns are additive; the GAS action ignores anything the
    // sheet does not define. Values are capped so a large details blob cannot
    // blow up the request.
    for (const [key, value] of Object.entries(meta || {})) {
      if (value === undefined || value === null || value === '') continue;
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
      params.append(key, text.slice(0, 2000));
    }
    const res = await axios.post(appScriptUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    });
    if (res.data?.success) {
      logger.info(`[captureDebug] Sheet row saved for ${identifier}`);
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
 * Capture a full debug snapshot for any failing social page/task.
 * @param {object} opts
 *   page           - live Puppeteer page (captured before it is closed)
 *   identifier     - folder/sheet key: browserId, taskId, profileId, ...
 *   reason         - short human-readable failure reason
 *   endpoint       - URL override (defaults to page.url())
 *   platform       - tiktok/youtube/... (optional)
 *   operation      - campaign operation (optional)
 *   stage          - pipeline stage (optional)
 *   campaignId     - campaign id (optional)
 *   taskId         - social task id (optional)
 *   profileId      - account profile id (optional)
 *   error          - error message (optional)
 *   details        - structured details object (optional)
 *   failedCount    - number of failed actions (optional)
 *   aiTimeoutMs    - AI analysis timeout override (optional)
 */
export async function captureFailureDebug(opts = {}) {
  const {
    page, identifier, browserId, reason, endpoint,
    platform, operation, stage, campaignId, taskId, profileId,
    error, details, failedCount, aiTimeoutMs, includeMeta,
  } = opts;
  try {
    if (!page || typeof page.isClosed !== 'function' || page.isClosed()) return null;
    if (typeof page.content !== 'function') return null;

    const id = identifier || browserId || taskId || profileId || 'debug';

    // Capture main frame + ALL child frames (identity/challenge UIs can live
    // in an iframe while the main frame only holds the login shell).
    let html = await page.content().catch(() => '');
    try {
      if (typeof page.frames === 'function') {
        const mainFrame = typeof page.mainFrame === 'function' ? page.mainFrame() : null;
        for (const frame of page.frames()) {
          if (mainFrame && frame === mainFrame) continue;
          try {
            const fUrl = typeof frame.url === 'function' ? frame.url() : '';
            const fHtml = await frame.content();
            if (fHtml) html += `\n\n<!-- ===== CHILD FRAME: ${fUrl} ===== -->\n${fHtml}\n<!-- ===== END CHILD FRAME ===== -->`;
          } catch (_) {}
        }
      }
    } catch (_) {}

    const url = endpoint || (typeof page.url === 'function' ? page.url() : 'unknown');
    const cappedHtml = String(html || '').slice(0, SHEET_HTML_CAP);
    const context = {
      platform: platform || '',
      operation: operation || stage || '',
      stage: stage || '',
      campaignId: campaignId || '',
      taskId: taskId || '',
      profileId: profileId || '',
      endpoint: url,
      reason: reason || '',
      error: error || '',
    };
    const aiText = await analyzeHtml(html, {
      ...context,
      details: details ? JSON.stringify(details).slice(0, 1200) : '',
      aiTimeoutMs,
    });
    const finalReason = [reason, aiText ? `AI: ${aiText}` : ''].filter(Boolean).join(' | ').slice(0, 4000);

    // `includeMeta: false` preserves the cookie-login sheet write exactly as it
    // was before generalization (base columns only). New call sites get the
    // structured columns; the GAS action ignores any column the sheet lacks.
    const meta = includeMeta === false ? {} : {
      campaignId: campaignId || '',
      stage: stage || operation || '',
      channelType: platform ? `social:${platform}` : '',
      failedCount: failedCount ?? 1,
      batchId: `dbg-${Date.now().toString(36)}`,
      details: JSON.stringify({ ...context, details: details || null }).slice(0, 2000),
    };
    // 1) Debug sheet (always).
    await writeDebugSheet({ identifier: id, url, cappedHtml, reason: finalReason, meta });

    // 2) Drive: identifier-named folder with full HTML, context and screenshot.
    const files = [
      { name: `${id}.html`, mimeType: 'text/html', body: Buffer.from(String(html || '')) },
      {
        name: `${id}.context.json`,
        mimeType: 'application/json',
        body: Buffer.from(JSON.stringify({
          ...context,
          details: details || null,
          aiAnalysis: aiText,
          timestamp: new Date().toISOString(),
        }, null, 2)),
      },
    ];
    if (typeof page.screenshot === 'function') {
      try {
        const shot = await page.screenshot({ type: 'png', fullPage: false });
        if (shot) files.push({ name: `${id}.png`, mimeType: 'image/png', body: Buffer.isBuffer(shot) ? shot : Buffer.from(shot) });
      } catch (e) {
        logger.warn(`[captureDebug] screenshot failed: ${e.message}`);
      }
    }
    const drive = await uploadDebugSnapshot({
      parentFolderId: DEBUG_PARENT_FOLDER_ID,
      folderName: String(id),
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

/**
 * Convenience for legacy flows that keep a global browser but no page handle.
 * Picks the first live page and captures; never throws.
 */
export async function captureBrowserDebug(browser, opts = {}) {
  try {
    if (!browser || typeof browser.pages !== 'function') return null;
    const pages = await browser.pages().catch(() => []);
    const page = pages.find(p => p && typeof p.isClosed === 'function' && !p.isClosed());
    if (!page) return null;
    return captureFailureDebug({ page, ...opts });
  } catch (_) {
    return null;
  }
}

/**
 * Backwards-compatible wrapper for the cookie-login call sites.
 * Keeps the original { page, browserId, reason, endpoint } signature so no
 * existing working flow has to change.
 */
export async function captureDebug(opts = {}) {
  return captureFailureDebug({
    ...opts,
    identifier: opts.identifier || opts.browserId,
    browserId: opts.browserId || opts.identifier,
    stage: opts.stage || 'cookie-login',
    includeMeta: false, // keep the original cookie-login sheet row shape intact
  });
}
