import axios from 'axios';
import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, stripFormulaColumns } from '../../api/googlesheets.js';
import { DOMHelpers, gateAndConsume, capturePostFrame, postCommentVerified } from '../_shared/routeHelper.js';
import { updateAccountStatus } from '../_shared/hubUpdater.js';
import { isTikTokCaptchaVisible, solveTikTokAudioCaptcha, isTikTokLoggedOut, navigateAndWait, ensureCommentsVisible, isPostLiked, isConfidentlyUnliked } from './platformHelper/TikTokHelpers.js';

// ==================== Data Fetching & Caching ====================

let appScriptDataCache = null;
let lastCacheUpdateTime = 0;
const cacheUpdateInterval = 4000;
const SHEETS_API_MIN_INTERVAL = 5000;
let isUpdatingCache = false;
let currentUpdatePromise = null;

async function _fetchAndCacheAppScriptData(retries = 3, timeout = 120000, forceRefresh = false) {
  const now = Date.now();

  if (isUpdatingCache && currentUpdatePromise) {
    return await currentUpdatePromise;
  }

  if (!forceRefresh && appScriptDataCache && (now - lastCacheUpdateTime < SHEETS_API_MIN_INTERVAL)) {
    logger.debug("[_fetchAndCacheAppScriptData] Returning cached data (Sheets API rate limit active).");
    return appScriptDataCache;
  }

  isUpdatingCache = true;
  const fetchPromise = (async () => {
    try {
      try {
        const sheetsApiResult = await getSheetDataApi("social-tasks");
        if (sheetsApiResult.success) {
          logger.info("[_fetchAndCacheAppScriptData] Sheets API data fetched successfully.");
          appScriptDataCache = [sheetsApiResult.headers, ...sheetsApiResult.data];
          lastCacheUpdateTime = Date.now();
          return appScriptDataCache;
        } else {
          logger.warn(`[_fetchAndCacheAppScriptData] Sheets API fetch failed: ${sheetsApiResult.error}. Falling back to App Script.`);
        }
      } catch (sheetsApiError) {
        logger.error(`[_fetchAndCacheAppScriptData] Error with Sheets API fetch: ${sheetsApiError.message}. Falling back to App Script.`);
      }

      // Fallback to App Script
      const appScriptUrl = process.env.SCRIPT_URL;
      const params = new URLSearchParams({
        action: 'getSearchInteractData',
        key: process.env.SCRIPT_KEY,
      });

      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const response = await axios.post(appScriptUrl, params, {
            timeout: timeout,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          });

          if (!response.data || !response.data.success) {
            throw new Error(`Invalid response: ${JSON.stringify(response.data)}`);
          }

          appScriptDataCache = [response.data.headers, ...response.data.data];
          lastCacheUpdateTime = Date.now();
          logger.info("[_fetchAndCacheAppScriptData] App Script data cache updated successfully.");
          return appScriptDataCache;
        } catch (error) {
          logger.error(`[_fetchAndCacheAppScriptData] Attempt ${attempt} failed: ${error.message}`);
          if (attempt === retries) {
            throw new Error(`Failed to fetch data after ${retries} attempts.`);
          }
        }
      }
    } finally {
      isUpdatingCache = false;
      currentUpdatePromise = null;
    }
  })();

  currentUpdatePromise = fetchPromise;
  return await fetchPromise;
}

export async function fetchTaskData(forceRefresh = false) {
  return await _fetchAndCacheAppScriptData(3, 120000, forceRefresh);
}

// ==================== Column Index Management ====================

export function getColumnIndexes(headers) {
  const columnIndexes = headers.reduce((acc, header, index) => {
    acc[header] = index;
    return acc;
  }, {});
  return columnIndexes;
}

// ==================== Row Update Operations ====================

export async function updateTaskRow(taskId, updateObject) {
  if (!taskId) {
    throw new Error("Missing taskId for updateTaskRow");
  }

  const sheetName = "social-tasks";
  const now = new Date();
  const lastRunTimestamp = now.toISOString();

  const sheetsApiUpdateMap = {
    taskId: taskId,
    lastRun: lastRunTimestamp,
    updatedAt: new Date().toISOString(),
    ...stripFormulaColumns(updateObject)
  };

  try {
    const sheetsApiResult = await updateSheetRowApi(sheetName, "taskId", taskId, sheetsApiUpdateMap);
    if (sheetsApiResult.success) {
      logger.info(`[updateTaskRow][${taskId}] Row updated successfully via Sheets API.`);
      return sheetsApiResult;
    } else {
      logger.warn(`[updateTaskRow][${taskId}] Sheets API update failed: ${sheetsApiResult.error}. Attempting App Script fallback.`);
      throw new Error(`Sheets API update failed: ${sheetsApiResult.error}`);
    }
  } catch (sheetsApiError) {
    logger.error(`[updateTaskRow][${taskId}] Error with Sheets API: ${sheetsApiError.message}. Attempting App Script fallback.`);
    
    // Fallback to App Script
    const appScriptUrl = process.env.SCRIPT_URL;
    const params = new URLSearchParams({
      action: 'updateSearchInteractTask',
      taskId: taskId,
      key: process.env.SCRIPT_KEY,
      lastRun: lastRunTimestamp,
      ...stripFormulaColumns(updateObject)
    });

    try {
      const response = await axios.post(appScriptUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 60000,
      });

      if (!response.data || !response.data.success) {
        throw new Error(`App Script update failed: ${response.data?.error || 'Unknown error'}`);
      }

      logger.info(`[updateTaskRow][${taskId}] Sheet updated successfully via App Script.`);
      return { success: true };
    } catch (error) {
      logger.error(`[updateTaskRow][${taskId}] Failed to update sheet via App Script: ${error.message}`);
      throw error;
    }
  }
}

// ==================== Main Engagement Runner ====================
// Runs inside ONE browser session. For each search keyword → scrape results
// (capped by maxResultsPerKeyword) → for each result: like → comment →
// per-comment like+reply. Per-action quota checks; hourly limit stops the
// whole run (account marked RATE_LIMITED, resume next hour); daily/monthly/
// cap stops permanently for this run.

export async function runSearchInteractEngagement(page, opts) {
    const {
        platform,
        platformConfig,
        ai,
        profileId,
        keywords,
        maxResultsPerKeyword = 5,
        maxRepliesPerPost = 3,
        stopAfterHours = 0,
        socialStrategyPrompt,
        taskId = 'session',
    } = opts;

    const s = platformConfig.selectors || {};
    const results = [];
    let stopType = null;          // 'hourly' | 'daily' | 'monthly' | 'cap'
    let stopReason = null;
    let captchaFailed = false;
    const startedAt = Date.now();

    const checkTimeStop = () => {
        if (stopAfterHours > 0) {
            const elapsedHours = (Date.now() - startedAt) / (1000 * 60 * 60);
            if (elapsedHours >= stopAfterHours) {
                stopType = 'time';
                stopReason = `interaction_stop_after_hours: ${elapsedHours.toFixed(2)}/${stopAfterHours}`;
                logger.info(`[engage:${taskId}] Time stop hit: ${stopReason}`);
                return true;
            }
        }
        return false;
    };

    const ensureCaptchaSolved = async (where) => {
        const visible = await isTikTokCaptchaVisible(page);
        if (!visible) return true;
        logger.info(`[engage:${taskId}] Captcha detected at ${where} — solving...`);
        const ok = await solveTikTokAudioCaptcha(page, `[engage:${taskId}]`);
        if (!ok) {
            captchaFailed = true;
            if (profileId) await updateAccountStatus(profileId, 'WAITING');
            stopType = 'captcha';
            stopReason = 'captcha_failed';
            return false;
        }
        return true;
    };

    // Logged-out detection: when the login modal appears the session is dead.
    // Skip the account immediately (no quota burn, no retries). Surfaced as
    // stopType='logged_out' so the task result shows LOGGED_OUT, not 0-scraped.
    const ensureLoggedIn = async (where) => {
        if (!(await isTikTokLoggedOut(page))) return true;
        logger.warn(`[engage:${taskId}] ACCOUNT_LOGGED_OUT: ${profileId || 'unknown'} at ${where} (${page.url()}) — skipping account.`);
        if (profileId) await updateAccountStatus(profileId, 'LOGGED_OUT');
        stopType = 'logged_out';
        stopReason = `logged_out_at_${where}`;
        return false;
    };

    // ---- D1: comment-list API observer (diagnostics) ----
    // Under automation the comment list sometimes never renders even though the
    // action bar shows a comment count. Log the raw comment API responses
    // (HTTP status + TikTok status_code + item count) so we can see whether the
    // request fired and what TikTok answered. Removed at run end.
    const onCommentApiResponse = (res) => {
        try {
            const u = res.url();
            if (!/comment/i.test(u)) return;
            if (!/list|feed|reply|detail/i.test(u)) return;
            logger.info(`[engage:${taskId}] comment-api: HTTP ${res.status()} ${u.substring(0, 140)}`);
            res.text().then((t) => {
                try {
                    const j = JSON.parse(t);
                    const list = j.comments || j?.data?.comments || j?.data?.comment_list || j?.data?.list || [];
                    const status = j.status_code ?? j?.status?.status_code ?? j?.statusMsg ?? 'n/a';
                    logger.info(`[engage:${taskId}] comment-api body: status_code=${status}, items=${Array.isArray(list) ? list.length : 'n/a'}, bytes=${t.length}`);
                } catch (e) {
                    logger.info(`[engage:${taskId}] comment-api body: non-JSON (${t.length} bytes)`);
                }
            }).catch(() => {});
        } catch (e) { /* ignore */ }
    };
    page.on('response', onCommentApiResponse);

    const pause = (min, max) => DOMHelpers.randomDelay(min, max);

    for (const keyword of keywords) {
        if (stopType) break;
        if (checkTimeStop()) break;
        try {
            // ---- Search ----
            logger.info(`[engage:${taskId}] Searching: "${keyword}"`);
            const searchUrl = `${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`;
            // Wait for a settled page (readyState complete + results/login/captcha
            // signal) instead of racing past domcontentloaded. ~20s budget.
            const nav = await navigateAndWait(page, searchUrl, s, {
                label: `search "${keyword}"`,
                logPrefix: `[engage:${taskId}]`,
            });
            if (!nav.ok) {
                logger.warn(`[engage:${taskId}] Keyword "${keyword}": navigation failed (${nav.error}) — skipping keyword.`);
                continue;
            }
            if (nav.state === 'captcha' && !(await ensureCaptchaSolved('search page'))) break;
            if (nav.state === 'logged_out' && !(await ensureLoggedIn('search page'))) break;
            // Re-verify (modal/captcha can render between poll and now).
            if (!(await ensureCaptchaSolved('search results'))) break;
            if (!(await ensureLoggedIn('search results'))) break;
            if (nav.state === 'unknown') {
                logger.warn(`[engage:${taskId}] Keyword "${keyword}": page never reached a settled state — skipping keyword (no silent 0-scrape).`);
                continue;
            }

            const extractor = platformConfig.extractors?.videos;
            let scraped = [];
            if (extractor) {
                try {
                    const parseFunc = new Function('items', 'return (' + extractor.parseFunction + '\n)(items);');
                    scraped = await page.$$eval(extractor.selector, parseFunc) || [];
                } catch (e) {
                    logger.warn(`[engage:${taskId}] Result extraction failed: ${e.message}`);
                }
            }
            // Prefer results with a URL; dedupe by URL so the same post is
            // never engaged twice (TikTok search often repeats items).
            const seenUrls = new Set();
            const resultsWithUrl = scraped.filter(v => v.url && !seenUrls.has(v.url) && seenUrls.add(v.url));
            logger.info(`[engage:${taskId}] Keyword "${keyword}": ${scraped.length} scraped, ${resultsWithUrl.length} unique with URLs. Cap=${maxResultsPerKeyword}`);

            const toProcess = resultsWithUrl.slice(0, maxResultsPerKeyword);
            for (let rIdx = 0; rIdx < toProcess.length; rIdx++) {
                if (stopType) break;
                if (checkTimeStop()) break;
                const video = toProcess[rIdx];
                try {
                    // ---- Open post ----
                    logger.info(`[engage:${taskId}] Opening post ${rIdx + 1}/${toProcess.length}: ${video.url}`);
                    // Wait for the post page to fully load + settle before engaging.
                    const postNav = await navigateAndWait(page, video.url, s, {
                        label: `post ${video.url}`,
                        logPrefix: `[engage:${taskId}]`,
                    });
                    if (!postNav.ok) {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: navigation failed (${postNav.error}) — skipping post.`);
                        results.push({ keyword, url: video.url, status: 'failed', error: `nav_failed: ${postNav.error}` });
                        continue;
                    }
                    if (postNav.state === 'captcha' && !(await ensureCaptchaSolved('post page'))) break;
                    if (postNav.state === 'logged_out' && !(await ensureLoggedIn('post page'))) break;
                    if (!(await ensureCaptchaSolved('post page'))) break;
                    if (!(await ensureLoggedIn('post page'))) break;
                    if (postNav.state === 'unknown') {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: page never reached a settled state — skipping post.`);
                        results.push({ keyword, url: video.url, status: 'failed', error: 'page_unsettled' });
                        continue;
                    }

                    // ---- Wait for the post action bar to hydrate before engaging ----
                    // navigateAndWait can return 'post' from the URL alone, before the
                    // action bar (Like/Comments) actually renders. Photo posts hydrate
                    // slowly (~20-30s observed). If the bar never renders the page is
                    // unusable — skip WITHOUT consuming like quota (a click against a
                    // missing button used to burn quota for nothing).
                    try {
                        await page.waitForSelector(s.likeButton, { visible: true, timeout: 30000 });
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: action bar rendered.`);
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: action bar not rendered within 30s — skipping post (no quota consumed).`);
                        results.push({ keyword, url: video.url, status: 'failed', error: 'action_bar_missing' });
                        await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                        await pause(1200, 2000);
                        continue;
                    }

                    // ---- Like the post ----
                    // (Action-bar comment count is read AFTER the like settles —
                    // see below. Reading it here raced slow photo-post hydration
                    // and misread 0, flipping ensureCommentsVisible into lenient
                    // mode and bypassing the comments_not_loaded guard.)
                    const likeGate = await gateAndConsume(platform, profileId, 'like');
                    if (!likeGate.allowed) {
                        stopType = likeGate.stopType;
                        stopReason = likeGate.reason;
                        logger.info(`[engage:${taskId}] Like blocked (${stopReason}) — stopping run.`);
                        break;
                    }
                    // Pre-check: clicking a heart that is ALREADY liked would
                    // unlike it (cross-run re-engagement of the same post).
                    const preSig = await isPostLiked(page, s);
                    if (preSig && preSig.state === true) {
                        logger.info(`[engage:${taskId}] Post already liked (${preSig.why}) — skipping like click.`);
                    } else {
                        const likeClicked = await DOMHelpers.humanClick(page, s.likeButton, { timeout: 5000 }).catch(() => false);
                        logger.info(`[engage:${taskId}] Like ${likeClicked ? 'clicked' : 'NOT found'} (quota consumed anyway per policy).`);
                    }
                    // ---- Like-commit verification ----
                    // Poll until the like PERSISTS (aria-pressed=true / red heart).
                    // A click that never flips the button means TikTok rejected it
                    // server-side (shadow flag) — the old blind pause let a
                    // rejected like fall through as "clicked". Retry ONCE with a
                    // human click, and only on a confident "not liked" signal
                    // (never re-click a weak reading — that's how flaps start).
                    let likeSig = await isPostLiked(page, s);
                    if (!(likeSig && likeSig.state === true)) {
                        const likeDeadline = Date.now() + 6000;
                        while (!(likeSig && likeSig.state === true) && Date.now() < likeDeadline) {
                            await pause(700, 1100);
                            likeSig = await isPostLiked(page, s);
                        }
                    }
                    if (!(likeSig && likeSig.state === true)) {
                        if (isConfidentlyUnliked(likeSig)) {
                            logger.warn(`[engage:${taskId}] Like not committed after click (why=${likeSig.why}) — human re-like once.`);
                            await DOMHelpers.humanClick(page, s.likeButton, { timeout: 4000 }).catch(() => {});
                            const retryDeadline = Date.now() + 4000;
                            likeSig = await isPostLiked(page, s);
                            while (!(likeSig && likeSig.state === true) && Date.now() < retryDeadline) {
                                await pause(700, 1100);
                                likeSig = await isPostLiked(page, s);
                            }
                        } else {
                            logger.warn(`[engage:${taskId}] Like state unconfirmed (why=${likeSig?.why ?? 'missing'}) — not re-clicking (flap guard).`);
                        }
                    }
                    if (likeSig && likeSig.state === true) {
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: like committed (aria-pressed=${likeSig.ariaPressed ?? 'none'}, why=${likeSig.why}).`);
                    } else {
                        logger.warn(`[engage:${taskId}] Post ${rIdx + 1}: like NOT committed (shadow-reject?) — continuing without retry loop.`);
                    }
                    // Short settle before switching tabs (commit already verified above).
                    await pause(1500, 2200);

                    // ---- Action-bar comment count (read AFTER the like settles) ----
                    // Photo posts hydrate the count late; reading it with the
                    // action bar raced to 0 and flipped ensureCommentsVisible into
                    // lenient mode (composer accepted, empty panel treated as OK).
                    // Retry briefly — the bar is guaranteed present (like click
                    // just used it).
                    let expectedComments = 0;
                    for (let cntAttempt = 0; cntAttempt < 3 && !expectedComments; cntAttempt++) {
                        try {
                            const cntText = await page.evaluate((sel) => {
                                const el = document.querySelector(sel);
                                return el ? (el.textContent || '') : '';
                            }, s.commentCount).catch(() => '');
                            const m = String(cntText || '').replace(/,/g, '').match(/(\d+)/);
                            if (m) expectedComments = parseInt(m[1], 10);
                        } catch (e) { /* retry */ }
                        if (!expectedComments) await pause(1200, 1800);
                    }
                    logger.info(`[engage:${taskId}] Post ${rIdx + 1}: action bar comment count = ${expectedComments}.`);

                    // ---- Switch to Comments tab (composer + list live here) ----
                    // Post pages open on "You may like"; the comment box and
                    // comment list only render after the Comments tab is active.
                    // When count > 0 but the list never renders, the comment
                    // phase is skipped entirely (user decision: no comment
                    // without seeing the thread first).
                    const ccRes = await ensureCommentsVisible(page, `[engage:${taskId}]`, expectedComments);
                    if (!ccRes.ok) {
                        const skipStatus = ccRes.reason === 'comments_not_loaded' ? 'comments_not_loaded' : 'engaged_no_comments_tab';
                        logger.warn(`[engage:${taskId}] Comments unavailable (${ccRes.reason}) — skipping comment + per-comment phase.`);
                        results.push({
                            keyword,
                            url: video.url,
                            author: video.author,
                            caption: (video.caption || '').substring(0, 120),
                            comment: '',
                            commentsProcessed: 0,
                            status: skipStatus,
                            expectedComments,
                        });
                        // Return to search results (no overlay close on direct URLs).
                        await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                        await pause(1200, 2000);
                        continue;
                    }

                    // Defensive: the Comments-tab switch can re-render the action bar
                    // and reset an optimistic like. Re-like ONLY on a confident
                    // "not liked" signal (aria-pressed=false or white heart) —
                    // a false negative here would click a liked post and UNLIKE
                    // it (the observed like/unlike flap). Verify after; never
                    // toggle more than once.
                    try {
                        const sig = await isPostLiked(page, s, `[engage:${taskId}] Post ${rIdx + 1}:`);
                        if (isConfidentlyUnliked(sig)) {
                            logger.warn(`[engage:${taskId}] Like reverted after Comments tab (why=${sig.why}) — re-liking once.`);
                            await DOMHelpers.humanClick(page, s.likeButton, { timeout: 4000 }).catch(() => {});
                            await pause(1200, 2000);
                            const after = await isPostLiked(page, s);
                            if (after && after.state === true) {
                                logger.info(`[engage:${taskId}] Re-like confirmed (aria-pressed=${after.ariaPressed ?? 'none'}).`);
                            } else {
                                logger.warn(`[engage:${taskId}] Re-like NOT confirmed (why=${after?.why ?? 'missing'}) — moving on (no retry).`);
                            }
                        }
                    } catch (e) { /* non-fatal */ }

                    // ---- AI understanding of the post (AFTER comments loaded) ----
                    // Comments + caption are what actually explain a post (photo
                    // posts have no readable caption element), so we analyze them
                    // together AFTER the comments panel has hydrated. This analysis
                    // feeds both the comment we post and the replies.
                    // Pass 1 (primary): text — caption + author + top-10 comments.
                    // Fallback: only if Pass 1 gives a bad result → vision on a
                    // post frame (video/photo) + caption. Replies reuse whichever
                    // result landed — no second vision pass.
                    let analyzedVideo = '';
                    let aiComments = [];   // pre-existing comments (AI context + tone fit)
                    let analysisMode = 'text';
                    let caption = '';
                    try {
                        const descText = await page.evaluate((sel) => {
                            const el = document.querySelector(sel);
                            return el ? el.textContent.trim() : '';
                        }, s.browseDesc || '[data-e2e="browse-desc"]').catch(() => '');
                        caption = video.caption || descText || '';

                        // Let the comment list finish populating, then extract for AI.
                        await pause(1500, 2500);
                        const cExtractor = platformConfig.extractors?.comments;
                        if (cExtractor) {
                            const parseFunc = new Function('items', 'return (' + cExtractor.parseFunction + '\n)(items);');
                            aiComments = await page.$$eval(cExtractor.selector, parseFunc).catch(() => []) || [];
                        }
                        const commentLines = aiComments
                            .filter(c => c.text)
                            .slice(0, 10)
                            .map(c => `- ${c.username ? c.username + ': ' : ''}${c.text}`)
                            .join('\n');

                        const postContext = [
                            `Caption: ${caption || 'n/a'}`,
                            `Author: ${video.author || 'unknown'}`,
                            commentLines
                                ? `Existing comments (what people are saying):\n${commentLines}`
                                : 'Existing comments: none yet',
                        ].join('\n');
                        const analyzePrompt = `${platformConfig.aiPrompts?.analyzeVideo || 'Summarize this post.'}\n\nUnderstand this post from its caption and the existing comments — the comments reveal what the post is about.\n\nPost:\n${postContext}`;
                        analyzedVideo = ai ? await ai.generate(analyzePrompt) : postContext;
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI text analysis failed: ${e.message}`);
                        analyzedVideo = video.caption || '';
                        analysisMode = 'text_failed';
                    }

                    // Quality gate: Pass 1 must return a usable description. Weak
                    // or failed text → single vision fallback (frame + caption).
                    const textResult = String(analyzedVideo || '').trim();
                    const weakResult = (v) => v.length < 40
                        || /^(could not analyze|ai not available|no ai providers)/i.test(v);
                    const textGood = analysisMode !== 'text_failed' && !weakResult(textResult);
                    if (!textGood) {
                        logger.info(`[engage:${taskId}] Text analysis weak (${textResult.length} chars, ${analysisMode}) — trying vision fallback (frame + caption).`);
                        try {
                            const frame = await capturePostFrame(page);
                            if (frame && ai) {
                                const visionPrompt = `${platformConfig.aiPrompts?.analyzeVideo || 'Summarize this post.'}\n\nThis is a screenshot of the post itself (a video frame or a photo). Describe what is actually shown in it. Use the caption for context.\n\nCaption: ${caption || 'n/a'}\nAuthor: ${video.author || 'unknown'}`;
                                const visionResult = String(await ai.generate(visionPrompt, { imageBase64: frame }) || '').trim();
                                if (!weakResult(visionResult)) {
                                    analyzedVideo = visionResult;
                                    analysisMode = 'vision';
                                } else {
                                    logger.warn(`[engage:${taskId}] Vision result weak — keeping text/caption fallback.`);
                                }
                            } else if (!frame) {
                                logger.warn(`[engage:${taskId}] No post frame captured — keeping text/caption fallback.`);
                            }
                        } catch (ve) {
                            logger.warn(`[engage:${taskId}] Vision fallback failed: ${ve.message}`);
                        }
                    }
                    if (!String(analyzedVideo || '').trim()) {
                        analyzedVideo = video.caption || '';
                    }
                    logger.info(`[engage:${taskId}] AI analysis ready (mode=${analysisMode}, caption ${caption ? 'yes' : 'no'}, ${aiComments.length} comments in context).`);

                    // ---- Generate + post contextual comment ----
                    let generatedComment = '';
                    const commentGate = await gateAndConsume(platform, profileId, 'comment');
                    if (!commentGate.allowed) {
                        stopType = commentGate.stopType;
                        stopReason = commentGate.reason;
                        logger.info(`[engage:${taskId}] Comment blocked (${stopReason}) — stopping run.`);
                        break;
                    }
                    try {
                        const recentLines = aiComments.filter(c => c.text).slice(0, 5).map(c => `- ${c.text}`).join('\n');
                        const genPrompt = `${platformConfig.aiPrompts?.generateComment || 'Write a natural comment.'}\n\n${socialStrategyPrompt ? 'Strategy: ' + socialStrategyPrompt + '\n' : ''}Post analysis: ${analyzedVideo}${recentLines ? `\nExisting comments (so yours fits the conversation):\n${recentLines}` : ''}`;
                        generatedComment = ai ? await ai.generate(genPrompt) : 'Great post!';
                        generatedComment = String(generatedComment).replace(/^["']|["']$/g, '').trim().slice(0, 150);
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI comment generation failed: ${e.message}`);
                        generatedComment = 'Nice share!';
                    }
                    if (generatedComment) {
                        const postRes = await postCommentVerified(page, s, generatedComment, `[engage:${taskId}]`).catch(err => ({ posted: false, reason: err.message }));
                        if (postRes.posted) {
                            logger.info(`[engage:${taskId}] Comment posted: "${generatedComment.substring(0, 60)}..."`);
                        } else {
                            logger.warn(`[engage:${taskId}] Comment NOT posted (${postRes.reason}) — skipping comment.`);
                            generatedComment = '';
                        }
                    }
                    await pause(1500, 2500);

                    // ---- Per-comment like + reply ----
                    let comments = [];
                    try {
                        const cExtractor = platformConfig.extractors?.comments;
                        if (cExtractor) {
                            const parseFunc = new Function('items', 'return (' + cExtractor.parseFunction + '\n)(items);');
                            comments = await page.$$eval(cExtractor.selector, parseFunc) || [];
                        }
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] Comment extraction failed: ${e.message}`);
                    }
                    // Exclude our own just-posted comment if identifiable; bound by maxRepliesPerPost.
                    const targetComments = comments.filter(c => c.text && c.text !== generatedComment).slice(0, maxRepliesPerPost);
                    logger.info(`[engage:${taskId}] ${comments.length} comments extracted, processing ${targetComments.length}.`);

                    for (const comment of targetComments) {
                        if (stopType) break;
                        // Like the comment
                        const likeCGate = await gateAndConsume(platform, profileId, 'likeComment');
                        if (!likeCGate.allowed) {
                            stopType = likeCGate.stopType;
                            stopReason = likeCGate.reason;
                            logger.info(`[engage:${taskId}] Comment-like blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        // Click the like icon within this comment's container by index.
                        // Real-mouse click: evaluate el.click() fired isTrusted=false
                        // events which TikTok's anti-bot ignores.
                        try {
                            const likeRect = await page.evaluate((cIdx) => {
                                const containers = document.querySelectorAll("div[class*='DivCommentItemContainer']");
                                const el = containers[cIdx];
                                if (!el) return null;
                                const likeIcon = el.querySelector("div[data-e2e='comment-like-icon'], [data-e2e='comment-like-icon']");
                                if (!likeIcon) return null;
                                // Don't double-like: parent aria-pressed or the icon's active state.
                                const pressed = likeIcon.closest('[aria-pressed="true"]') || likeIcon.querySelector('[aria-pressed="true"]');
                                if (pressed) return null;
                                const r = likeIcon.getBoundingClientRect();
                                if (r.width < 1 || r.height < 1) return null;
                                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }, comment.index);
                            let likedC = false;
                            if (likeRect) {
                                likedC = await DOMHelpers.humanClickAt(page, likeRect.x, likeRect.y, { hoverMs: [120, 300] }).catch(() => false);
                            }
                            logger.info(`[engage:${taskId}] Comment like ${likedC ? 'clicked' : 'skipped (already liked or not found)'}.`);
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment like click failed: ${e.message}`);
                        }
                        await pause(800, 1500);

                        // Reply to the comment via commentComment
                        const replyGate = await gateAndConsume(platform, profileId, 'commentComment');
                        if (!replyGate.allowed) {
                            stopType = replyGate.stopType;
                            stopReason = replyGate.reason;
                            logger.info(`[engage:${taskId}] Comment reply blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        try {
                            // Click the Reply button in this comment's container
                            // with the real mouse (isTrusted events).
                            const replyRect = await page.evaluate((cIdx) => {
                                const containers = document.querySelectorAll("div[class*='DivCommentItemContainer']");
                                const el = containers[cIdx];
                                if (!el) return null;
                                const reply = el.querySelector("span[data-e2e='comment-reply-1'], span[data-e2e^='comment-reply-'], [aria-label='Reply']");
                                if (!reply) return null;
                                const r = reply.getBoundingClientRect();
                                if (r.width < 1 || r.height < 1) return null;
                                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }, comment.index);
                            const replyClicked = replyRect
                                ? await DOMHelpers.humanClickAt(page, replyRect.x, replyRect.y, { hoverMs: [120, 300] }).catch(() => false)
                                : false;
                            if (replyClicked) {
                                await pause(800, 1500);
                                let replyText = '';
                                try {
                                    // Reply reuses the already-loaded analysis — no new
                                    // video/vision capture here (post knowledge is in analyzedVideo).
                                    const replyPrompt = `${platformConfig.aiPrompts?.replyToComment || 'Reply briefly.'}\n\nVideo analysis: ${analyzedVideo}\nYour comment: ${generatedComment}\nComment to reply to: ${comment.text}`;
                                    replyText = ai ? await ai.generate(replyPrompt) : '🙏';
                                    replyText = String(replyText).replace(/^["']|["']$/g, '').trim().slice(0, 120);
                                } catch (e) {
                                    replyText = '🙌';
                                }
                                if (replyText) {
                                    const replyRes = await postCommentVerified(page, s, replyText, `[engage:${taskId}]`).catch(err => ({ posted: false, reason: err.message }));
                                    if (replyRes.posted) {
                                        logger.info(`[engage:${taskId}] Replied to comment ${comment.index}: "${replyText.substring(0, 50)}..."`);
                                    } else {
                                        logger.warn(`[engage:${taskId}] Reply NOT posted for comment ${comment.index} (${replyRes.reason}).`);
                                    }
                                }
                            } else {
                                logger.warn(`[engage:${taskId}] Reply button not found for comment ${comment.index}.`);
                            }
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment reply failed: ${e.message}`);
                        }
                        await pause(1000, 2000);
                    }

                    results.push({
                        keyword,
                        url: video.url,
                        author: video.author,
                        caption: (video.caption || '').substring(0, 120),
                        comment: generatedComment,
                        commentsProcessed: targetComments.length,
                        status: 'engaged',
                    });
                    logger.info(`[engage:${taskId}] Post ${rIdx + 1} engaged successfully.`);

                    // Close overlay / return to results. Direct /photo/ URLs
                    // have no overlay close button — fall back to navigating
                    // back to the search page instead of timing out.
                    const closed = await DOMHelpers.humanClick(page, s.browseClose, { timeout: 3000 }).catch(() => false);
                    if (!closed) {
                        await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                    }
                    await pause(1200, 2000);

                } catch (postErr) {
                    logger.warn(`[engage:${taskId}] Post ${rIdx + 1} failed: ${postErr.message}`);
                    results.push({ keyword, url: video.url, status: 'failed', error: postErr.message });
                    // Try to recover: navigate back to search.
                    await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                    await pause(1500, 2500);
                }
            }
        } catch (kwErr) {
            logger.warn(`[engage:${taskId}] Keyword "${keyword}" failed: ${kwErr.message}`);
        }
    }

    page.off('response', onCommentApiResponse);

    if (stopType === 'hourly' && profileId) {
        await updateAccountStatus(profileId, 'RATE_LIMITED');
        logger.info(`[engage:${taskId}] Hourly limit hit — account ${profileId} marked RATE_LIMITED. Resume next hour-cycle.`);
    } else if (stopType === 'logged_out') {
        logger.warn(`[engage:${taskId}] Account ${profileId} was logged out — skipped immediately (${stopReason}).`);
    } else if ((stopType === 'daily' || stopType === 'monthly' || stopType === 'cap') && profileId) {
        logger.info(`[engage:${taskId}] Permanent limit hit (${stopType}: ${stopReason}) — stopping run for account ${profileId}.`);
    } else if (captchaFailed) {
        logger.warn(`[engage:${taskId}] Captcha solve failed — account ${profileId} set WAITING.`);
    }

    return {
        results,
        stopType,
        stopReason,
        captchaFailed,
        engaged: results.filter(r => r.status === 'engaged').length,
        failed: results.filter(r => r.status === 'failed').length,
    };
}
