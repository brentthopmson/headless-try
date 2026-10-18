import axios from 'axios';
import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, stripFormulaColumns } from '../../api/googlesheets.js';
import { DOMHelpers, gateAndConsume, capturePostFrame, postCommentVerified } from '../_shared/routeHelper.js';
import { updateAccountStatus } from '../_shared/hubUpdater.js';
import { isTikTokCaptchaVisible, solveTikTokAudioCaptcha, isTikTokLoggedOut, navigateAndWait, ensureCommentsVisible, isPostLiked, readCommentsPanelCount } from './platformHelper/TikTokHelpers.js';

// Strip @handle mention tokens from typed text — an "@" opens TikTok's
// mention-autocomplete popup mid-type, which hijacks input (observed "@@"
// leak into the main composer) and its popup blocks all subsequent clicks.
// Also strips bare "@" runs left after token removal.
export function stripMentions(text) {
    return String(text || '')
        .replace(/@[A-Za-z0-9._-]+/g, ' ')
        .replace(/@+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

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

    // ---- D1b: digg API observer (like-commit ground truth, LOG-ONLY) ----
    // The like button's digg endpoint (/api/commit/item/digg/) is a TOGGLE —
    // a second call UNLIKES. The body carries is_digg (the resulting state).
    // USER DIRECTIVE: like is fire-and-forget. If TikTok toggles it back off
    // (is_digg=0), LEAVE IT ALONE and move on to commenting — never re-click
    // the heart (re-clicking a toggle is what caused the like/unlike flaps).
    // diggConfirmedLike is now informational only (logging); no code path
    // re-likes based on it.
    let diggConfirmedLike = false;   // informational: OUR digg ended in is_digg=1
    let diggPending = false;         // set true just before we click the heart
    const onDiggApiResponse = (res) => {
        try {
            const u = res.url();
            if (!/digg/i.test(u)) return;
            if (!diggPending) {
                logger.info(`[engage:${taskId}] digg-api (external): HTTP ${res.status()} ${u.substring(0, 140)}`);
                return;
            }
            res.text().then((t) => {
                try {
                    const j = JSON.parse(t);
                    const status = j.status_code ?? j?.status?.status_code ?? 'n/a';
                    const isDigg = j.is_digg ?? j?.data?.is_digg; // resulting state after the toggle
                    logger.info(`[engage:${taskId}] digg-api: HTTP ${res.status()}, status_code=${status}, is_digg=${isDigg}, bytes=${t.length} ${u.substring(0, 120)}`);
                    if (String(status) === '0' && (isDigg === 1 || isDigg === true)) {
                        diggConfirmedLike = true;
                    } else if (String(status) === '0') {
                        // Toggle succeeded but ended UNLIKED — TikTok refused/undid it.
                        // Per directive: leave it alone, proceed to commenting.
                        logger.info(`[engage:${taskId}] digg toggled off by TikTok (is_digg=${isDigg}) — leaving it (fire-and-forget per directive).`);
                    }
                } catch (e) {
                    logger.info(`[engage:${taskId}] digg-api body: non-JSON (${t.length} bytes)`);
                }
                diggPending = false;
            }).catch(() => { diggPending = false; });
        } catch (e) { /* ignore */ }
    };
    page.on('response', onDiggApiResponse);

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
                // Aweme id for URL-drift guard: if TikTok SPA-navigates to a
                // different post mid-processing, skip the comment/loop entirely.
                const awemeId = (String(video.url || '').match(/\/(\d{15,})/) || [])[1] || null;
                const stillOnTarget = () => {
                    if (!awemeId) return true; // can't verify — assume on-target
                    return String(page.url() || '').includes(awemeId);
                };
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
                    diggConfirmedLike = false; // reset per post
                    diggPending = false;
                    const preSig = await isPostLiked(page, s);
                    if (preSig && preSig.state === true) {
                        logger.info(`[engage:${taskId}] Post already liked (${preSig.why}) — skipping like click.`);
                        diggConfirmedLike = true; // already liked server-side; never toggle it off
                    } else {
                        diggPending = true; // next digg response is OUR click
                        const likeClicked = await DOMHelpers.humanClick(page, s.likeButton, { timeout: 5000 }).catch(() => false);
                        logger.info(`[engage:${taskId}] Like ${likeClicked ? 'clicked' : 'NOT found'} (quota consumed anyway per policy).`);
                    }
                    // ---- Like settle (fire-and-forget per user directive) ----
                    // USER DIRECTIVE: like once, wait briefly for the digg
                    // response, log the outcome, and MOVE ON — even if TikTok
                    // toggled it back off. Never re-click the heart (re-clicking
                    // a toggle is what caused the like/unlike flaps). The digg
                    // observer above logs is_digg as ground truth.
                    await pause(2000, 3000); // let the digg response land in the observer
                    const likeSig = await isPostLiked(page, s);
                    if (likeSig && likeSig.state === true) {
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: like settled (aria-pressed=true, why=${likeSig.why}).`);
                    } else if (diggConfirmedLike) {
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: digg-api confirmed like (DOM why=${likeSig?.why ?? 'unconfirmed'}) — proceeding.`);
                    } else {
                        logger.info(`[engage:${taskId}] Post ${rIdx + 1}: like state after settle: DOM=${likeSig?.why ?? 'missing'}, digg=${diggConfirmedLike} — fire-and-forget, proceeding to comments.`);
                    }

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
                    // Panel header is the reliable count once the tab is active
                    // (action-bar reads 0 on photo posts). Refill for logging/results.
                    if (ccRes.ok && !expectedComments) {
                        try {
                            expectedComments = await readCommentsPanelCount(page) || 0;
                            if (expectedComments) logger.info(`[engage:${taskId}] Panel header count = ${expectedComments} (action-bar was 0).`);
                        } catch (e) { /* non-fatal */ }
                    }
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

                    // Comments-tab switch re-renders the action bar and can
                    // reset the optimistic like to false. Fire-and-forget per
                    // directive: log only, NEVER re-click (digg is a toggle).
                    try {
                        await pause(2500, 3500); // let the action bar finish re-hydrating
                        const sig = await isPostLiked(page, s, `[engage:${taskId}] Post ${rIdx + 1} (post-tab settle):`);
                        if (sig && sig.state === true) {
                            logger.info(`[engage:${taskId}] Like still shown after Comments tab.`);
                        } else {
                            logger.info(`[engage:${taskId}] Like shown=false after Comments tab (digg=${diggConfirmedLike}) — leaving it (fire-and-forget).`);
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
                    if (!textGood && ai) {
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
                    } else if (!textGood) {
                        // No AI provider: capturing a frame would be discarded —
                        // and capturePostFrame used to force-play videos, which
                        // navigated photo posts away. Skip entirely.
                        logger.info(`[engage:${taskId}] Text analysis weak (${textResult.length} chars) — skipping vision fallback (no AI providers).`);
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
                        // Keyword must appear in the comment (user directive: like
                        // competing comments "Teamwork ifb" — carry the topic).
                        // AI weaves it in naturally; do not copy raw + random letters.
                        const genPrompt = `${platformConfig.aiPrompts?.generateComment || 'Write a natural comment.'}\n\n${socialStrategyPrompt ? 'Strategy: ' + socialStrategyPrompt + '\n' : ''}Topic/keyword that brought us here: "${keyword}" — work it into the comment naturally (related wording like teamwork, the product, etc. is fine); do NOT copy the raw string with random letters appended.\nPost analysis: ${analyzedVideo}${recentLines ? `\nExisting comments (so yours fits the conversation):\n${recentLines}` : ''}`;
                        generatedComment = ai ? await ai.generate(genPrompt) : '';
                        generatedComment = stripMentions(String(generatedComment || '').replace(/^["']|["']$/g, '').trim()).slice(0, 150);
                    } catch (e) {
                        logger.warn(`[engage:${taskId}] AI comment generation failed: ${e.message}`);
                        generatedComment = '';
                    }
                    // AI-off fallback (user directive): copy an existing comment
                    // verbatim instead of a generic "Nice share!". Pick the longest
                    // substantive comment already on the post. Strip @mentions —
                    // typing them opens the mention popup and hijacks input.
                    if (!generatedComment) {
                        const seed = aiComments
                            .filter(c => c.text && c.text.length >= 8 && c.text.length <= 150)
                            .map(c => stripMentions(String(c.text).trim()).slice(0, 150))
                            .filter(t => t.length >= 8)
                            .sort((a, b) => b.length - a.length)[0];
                        if (seed) {
                            generatedComment = seed;
                            logger.info(`[engage:${taskId}] AI-off: seeding post comment from existing comment: "${generatedComment.substring(0, 60)}..."`);
                        } else {
                            generatedComment = 'Nice share!';
                        }
                        // User directive: AI-off comment must carry an emoji.
                        const EMOJIS = ['🔥', '💯', '🙌', '😂', '👏', '😊', '😍', '🤯'];
                        generatedComment = `${generatedComment} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`.slice(0, 160);
                        logger.info(`[engage:${taskId}] AI-off: final comment with emoji: "${generatedComment.substring(0, 60)}..."`);
                    }
                    if (generatedComment) {
                        // URL-drift guard: never comment on a post the SPA
                        // silently navigated away from.
                        if (!stillOnTarget()) {
                            logger.warn(`[engage:${taskId}] Page drifted to a different post (${page.url()}) — skipping comment + per-comment phase.`);
                            results.push({
                                keyword,
                                url: video.url,
                                author: video.author,
                                caption: (video.caption || '').substring(0, 120),
                                comment: '',
                                commentsProcessed: 0,
                                status: 'page_navigated_away',
                            });
                            await page.goto(`${platformConfig.searchUrl}?q=${encodeURIComponent(keyword)}`, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
                            await pause(1200, 2000);
                            continue;
                        }
                        let postRes = await postCommentVerified(page, s, generatedComment, `[engage:${taskId}]`).catch(err => ({ posted: false, reason: err.message }));
                        // Composer-missing recovery (user directive): the panel
                        // can close between ensureCommentsVisible and the post
                        // (SPA re-render). Re-enter ensureCommentsVisible — its
                        // re-entry path clicks the Comments tab / action-rail
                        // comment icon to reopen, or the input container to
                        // mount the DraftEditor — then retry ONCE.
                        if (!postRes.posted && (postRes.reason === 'composer-not-found' || postRes.reason === 'composer-missing-after-type')) {
                            logger.warn(`[engage:${taskId}] Main composer missing (${postRes.reason}) — reopening comments panel and retrying once.`);
                            if (!stillOnTarget()) {
                                logger.warn(`[engage:${taskId}] Page drifted during retry — abandoning post.`);
                                postRes = { posted: false, reason: 'page_navigated_away' };
                            } else {
                                const reopen = await ensureCommentsVisible(page, `[engage:${taskId}] (re-open)`, null).catch(() => ({ ok: false }));
                                if (reopen.ok) {
                                    await pause(1500, 2500);
                                    postRes = await postCommentVerified(page, s, generatedComment, `[engage:${taskId}] (retry)`).catch(err => ({ posted: false, reason: err.message }));
                                } else {
                                    logger.warn(`[engage:${taskId}] Could not reopen comments panel (${reopen.reason}) — skipping comment.`);
                                }
                            }
                        }
                        if (postRes.posted) {
                            logger.info(`[engage:${taskId}] Comment posted: "${generatedComment.substring(0, 60)}..."`);
                        } else {
                            logger.warn(`[engage:${taskId}] Comment NOT posted (${postRes.reason}) — skipping comment.`);
                            generatedComment = '';
                        }
                    }
                    await pause(1500, 2500);

                    // ---- Per-comment like + reply (sequential, text-located) ----
                    // User directive: like comment → reply → close reply box →
                    // NEXT comment. Never re-extract mid-loop (virtualized list
                    // unmounts); use aiComments already scraped. Locate each
                    // container by TEXT match — indices go stale the moment a
                    // reply is inserted into the DOM (observed double-🙌).
                    // Dedupe by text first (extractor previously matched nested
                    // ObjectWrapper+ItemWrapper → every comment appeared twice).
                    const seenTexts = new Set();
                    const targetComments = aiComments
                        .filter(c => {
                            const t = String(c.text || '').trim();
                            if (!t || t.length < 2 || t === generatedComment) return false;
                            const key = t.substring(0, 60); // dedupe key
                            if (seenTexts.has(key)) return false;
                            seenTexts.add(key);
                            return true;
                        })
                        .slice(0, maxRepliesPerPost);
                    let processedCount = 0;
                    const repliedTexts = new Set(); // dedupe: never reply same text twice
                    logger.info(`[engage:${taskId}] Per-comment phase: ${targetComments.length} unique targets from AI-context list (no re-extract).`);

                    // ObjectWrapper ONLY — DivCommentItemWrapper is nested INSIDE
                    // it; matching both gave double indices + double extraction.
                    const CONTAINER_SEL = "div[class*='DivCommentObjectWrapper']";

                    // Locate a comment's live container by its text. Fuzzy: the
                    // extracted text can differ from the live DOM by whitespace /
                    // emoji rendering — compare the first 30 normalized chars.
                    // UNIQUE-MATCH: if several containers share the same 30-char
                    // prefix, return -1 rather than a possibly-wrong index (that
                    // was the multi-reply-on-one-comment bug). Virtualized lists
                    // unmount off-screen items — scroll once and retry. Returns
                    // index into CURRENT container list, or -1.
                    const locateByText = async (wantText) => {
                        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const needle = norm(wantText).substring(0, 30);
                        if (!needle) return -1;
                        const findIdx = async () => page.evaluate(({ sel, text }) => {
                            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            const items = document.querySelectorAll(sel);
                            const matches = [];
                            for (let i = 0; i < items.length; i++) {
                                const t = items[i].querySelector("span[data-e2e='comment-level-1'], p[data-e2e='comment-level-1']");
                                if (!t) continue;
                                const live = norm(t.textContent).substring(0, 30);
                                if (live === text || live.startsWith(text) || text.startsWith(live)) matches.push(i);
                            }
                            // Prefer a full-text (non-prefix) unique match; else
                            // require exactly one prefix match.
                            if (matches.length === 1) return matches[0];
                            if (matches.length > 1) {
                                const exact = matches.filter(i => {
                                    const t = items[i].querySelector("span[data-e2e='comment-level-1'], p[data-e2e='comment-level-1']");
                                    return t && norm(t.textContent) === text;
                                });
                                if (exact.length === 1) return exact[0];
                                return -1; // ambiguous — do not guess
                            }
                            return -1;
                        }, { sel: CONTAINER_SEL, text: needle });
                        let idx = await findIdx();
                        if (idx >= 0) return idx;
                        // Scroll the comments panel to load more (virtualization).
                        // Deliberately NOT div[class*='RightPanel'] — that can match
                        // the feed rail and scroll/advance to another post.
                        await DOMHelpers.humanScroll(page, "div[class*='DivCommentMain'], div[class*='DivTabContainer']", { totalPx: 400 }).catch(() => false);
                        await pause(600, 1000);
                        return findIdx();
                    };

                    // Count visible INLINE reply composers (contenteditable inside
                    // a comment container). The sticky bottom main composer is NOT
                    // inside a container, so it never counts.
                    const countInlineComposers = async () => page.evaluate((sel) => {
                        const items = document.querySelectorAll(sel);
                        let n = 0;
                        for (const item of items) {
                            const ed = item.querySelector("div[contenteditable='true']");
                            if (!ed) continue;
                            const r = ed.getBoundingClientRect();
                            if (r.width >= 1 && r.height >= 1) n++;
                        }
                        return n;
                    }, CONTAINER_SEL).catch(() => 0);

                    // Close the inline reply composer if it's open. Escape first
                    // (kills mention/emoji popups AND sometimes the box). The X
                    // is a PLAIN DIV (css-8blle4) containing an X svg — NOT a
                    // button — which is why the old button heuristic never found
                    // it. Target: inside the open reply editor's wrapper, click
                    // the div containing svg path d^='M38.7 12.12' (the X glyph),
                    // excluding the panel-level comment_close. VERIFY closure by
                    // polling for zero inline composers. Returns true only when
                    // zero remain.
                    const closeReplyBox = async () => {
                        for (let attempt = 0; attempt < 3; attempt++) {
                            if ((await countInlineComposers()) === 0) return true;
                            await page.keyboard.press('Escape').catch(() => {});
                            await pause(400, 650);
                            if ((await countInlineComposers()) === 0) return true;
                            // Click the reply X (plain div wrapping the X svg).
                            await page.evaluate((sel) => {
                                const items = document.querySelectorAll(sel);
                                for (const item of items) {
                                    const ed = item.querySelector("div[contenteditable='true']");
                                    if (!ed) continue;
                                    const r = ed.getBoundingClientRect();
                                    if (r.width < 1 || r.height < 1) continue;
                                    // The X div lives inside the reply editor wrapper
                                    // (DivReplyCommentEditorContainer > DivTextInputWithPostContainer);
                                    // it is a sibling AFTER the submit button.
                                    const wrapper = ed.closest("div[class*='DivTextInputWithPostContainer'], div[class*='DivReplyCommentEditorContainer']") || ed.parentElement;
                                    if (!wrapper) continue;
                                    // Find elements containing the X svg path (shared
                                    // glyph with the panel close — exclude that one).
                                    const svgs = wrapper.querySelectorAll("svg path[d^='M38.7 12.12']");
                                    for (const p of svgs) {
                                        const host = p.closest("div[class*='DivClose'], button, [role='button']") || p.closest("div");
                                        if (!host) continue;
                                        if (host.closest("[data-key-interaction='comment_close']")) continue; // panel close, not ours
                                        const hr = host.getBoundingClientRect();
                                        if (hr.width < 1 || hr.height < 1) continue;
                                        host.click();
                                    }
                                }
                            }, CONTAINER_SEL).catch(() => {});
                            await pause(400, 650);
                        }
                        return (await countInlineComposers()) === 0;
                    };

                    let consecutiveVerifyFailures = 0; // break loop only after 3 in a row

                    for (const comment of targetComments) {
                        if (stopType) break;
                        if (repliedTexts.has(comment.text)) continue; // dedupe
                        // URL-drift guard: if the SPA navigated to another post,
                        // every subsequent locate/type would hit the wrong page.
                        if (!stillOnTarget()) {
                            logger.warn(`[engage:${taskId}] Page drifted mid-loop (${page.url()}) — stopping per-comment loop.`);
                            break;
                        }

                        // ---- Locate the comment in the live DOM by text ----
                        const cIdx = await locateByText(comment.text);
                        if (cIdx < 0) {
                            logger.info(`[engage:${taskId}] Comment not found or ambiguous in DOM: "${comment.text.substring(0, 40)}..." — skipping.`);
                            continue;
                        }

                        // ---- 1. LIKE the comment ----
                        const likeCGate = await gateAndConsume(platform, profileId, 'likeComment');
                        if (!likeCGate.allowed) {
                            stopType = likeCGate.stopType;
                            stopReason = likeCGate.reason;
                            logger.info(`[engage:${taskId}] Comment-like blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        try {
                            const likeRect = await page.evaluate(({ sel, idx }) => {
                                const el = document.querySelectorAll(sel)[idx];
                                if (!el) return null;
                                // Live DOM: like is div[data-key-interaction='comment_like'][aria-pressed]
                                const likeIcon = el.querySelector("div[data-key-interaction='comment_like'], [data-key-interaction='comment_like'], [data-e2e='comment-like-icon']");
                                if (!likeIcon) return null;
                                const pressed = (likeIcon.getAttribute('aria-pressed') === 'true' ? likeIcon : null)
                                    || likeIcon.closest('[aria-pressed="true"]')
                                    || likeIcon.querySelector('[aria-pressed="true"]');
                                if (pressed) return null; // already liked
                                const r = likeIcon.getBoundingClientRect();
                                if (r.width < 1 || r.height < 1) return null;
                                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }, { sel: CONTAINER_SEL, idx: cIdx });
                            let likedC = false;
                            if (likeRect) {
                                likedC = await DOMHelpers.humanClickAt(page, likeRect.x, likeRect.y, { hoverMs: [120, 300] }).catch(() => false);
                            }
                            logger.info(`[engage:${taskId}] Comment like ${likedC ? 'clicked' : 'skipped (already liked or not found)'}: "${comment.text.substring(0, 40)}..."`);
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment like click failed: ${e.message}`);
                        }
                        await pause(800, 1500);

                        // ---- 2. REPLY to the comment ----
                        const replyGate = await gateAndConsume(platform, profileId, 'commentComment');
                        if (!replyGate.allowed) {
                            stopType = replyGate.stopType;
                            stopReason = replyGate.reason;
                            logger.info(`[engage:${taskId}] Comment reply blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        try {
                            // BEST-EFFORT close of any leftover reply box.
                            // Container-verified retarget below guarantees the
                            // next reply lands in the right box even if this fails
                            // (TikTok re-targets the open box on a new Reply click).
                            if ((await countInlineComposers()) > 0) {
                                logger.info(`[engage:${taskId}] Inline reply box still open before Reply — closing best-effort.`);
                                await closeReplyBox().catch(() => false);
                            }
                            // Reply trigger (real DOM): p[data-key-interaction='comment_reply']
                            // (aria-label='Reply', data-e2e='comment-reply-1').
                            const replyRect = await page.evaluate(({ sel, idx }) => {
                                const el = document.querySelectorAll(sel)[idx];
                                if (!el) return null;
                                const reply = el.querySelector("p[data-key-interaction='comment_reply'], p[aria-label='Reply'][data-e2e^='comment-reply-'], [data-e2e^='comment-reply-'], [aria-label='Reply']");
                                if (!reply) return null;
                                const r = reply.getBoundingClientRect();
                                if (r.width < 1 || r.height < 1) return null;
                                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                            }, { sel: CONTAINER_SEL, idx: cIdx });
                            const replyClicked = replyRect
                                ? await DOMHelpers.humanClickAt(page, replyRect.x, replyRect.y, { hoverMs: [120, 300] }).catch(() => false)
                                : false;
                            if (!replyClicked) {
                                logger.warn(`[engage:${taskId}] Reply button not found for "${comment.text.substring(0, 40)}..." — skipping.`);
                                continue;
                            }
                            await pause(800, 1500);
                            // ---- CONTAINER-VERIFIED RETARGET ----
                            // Verify the visible reply editor belongs to THIS
                            // container before typing — the leftover-box bug was
                            // typing into a stuck box from the previous comment.
                            const editorInTarget = async () => page.evaluate(({ sel, idx }) => {
                                const el = document.querySelectorAll(sel)[idx];
                                if (!el) return false;
                                const ed = el.querySelector("div[contenteditable='true']");
                                if (!ed) return false;
                                const r = ed.getBoundingClientRect();
                                return r.width >= 1 && r.height >= 1;
                            }, { sel: CONTAINER_SEL, idx: cIdx });
                            let verified = await editorInTarget();
                            if (!verified) {
                                // Scroll the container into view and re-click Reply once.
                                await page.evaluate(({ sel, idx }) => {
                                    const el = document.querySelectorAll(sel)[idx];
                                    if (el) el.scrollIntoView({ block: 'center' });
                                }, { sel: CONTAINER_SEL, idx: cIdx }).catch(() => {});
                                await pause(600, 1000);
                                const retryRect = await page.evaluate(({ sel, idx }) => {
                                    const el = document.querySelectorAll(sel)[idx];
                                    if (!el) return null;
                                    const reply = el.querySelector("p[data-key-interaction='comment_reply'], p[aria-label='Reply'][data-e2e^='comment-reply-'], [data-e2e^='comment-reply-'], [aria-label='Reply']");
                                    if (!reply) return null;
                                    const r = reply.getBoundingClientRect();
                                    if (r.width < 1 || r.height < 1) return null;
                                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                                }, { sel: CONTAINER_SEL, idx: cIdx });
                                if (retryRect) {
                                    await DOMHelpers.humanClickAt(page, retryRect.x, retryRect.y, { hoverMs: [120, 300] }).catch(() => false);
                                    await pause(800, 1500);
                                    verified = await editorInTarget();
                                }
                            }
                            if (!verified) {
                                consecutiveVerifyFailures++;
                                logger.warn(`[engage:${taskId}] Reply editor not verified in target container (${consecutiveVerifyFailures}/3) for "${comment.text.substring(0, 40)}..." — skipping comment.`);
                                if (consecutiveVerifyFailures >= 3) {
                                    logger.warn(`[engage:${taskId}] 3 consecutive container-verify failures — comment list state broken, stopping per-comment loop.`);
                                    break;
                                }
                                continue;
                            }
                            consecutiveVerifyFailures = 0;
                            let replyText = '';
                            try {
                                const replyPrompt = `${platformConfig.aiPrompts?.replyToComment || 'Reply briefly.'}\n\nVideo analysis: ${analyzedVideo}\nYour comment: ${generatedComment}\nComment to reply to: ${comment.text}`;
                                replyText = ai ? await ai.generate(replyPrompt) : '';
                                replyText = stripMentions(String(replyText || '').replace(/^["']|["']$/g, '').trim()).slice(0, 120);
                            } catch (e) {
                                replyText = '';
                            }
                            // AI-off fallback (user directive): seed from a
                            // DIFFERENT existing comment + emoji — never a bare
                            // constant. Pick the longest comment that is not the
                            // parent and not the seed we already posted as our
                            // main comment. Templates only if no seed exists.
                            if (!replyText) {
                                const parent = stripMentions(String(comment.text || '')).trim().substring(0, 150);
                                const EMOJIS = ['🔥', '💯', '🙌', '😂', '👏', '😊', '😍', '🤯'];
                                const seedReply = aiComments
                                    .map(c => stripMentions(String(c.text || '').trim()).slice(0, 150))
                                    .filter(t => t.length >= 8 && t.length <= 150 && t !== parent && t !== generatedComment)
                                    .sort((a, b) => b.length - a.length)[0];
                                if (seedReply) {
                                    replyText = `${seedReply} ${EMOJIS[Math.floor(Math.random() * EMOJIS.length)]}`.slice(0, 160);
                                    logger.info(`[engage:${taskId}] AI-off: seeded reply from existing comment: "${replyText.substring(0, 60)}..."`);
                                } else {
                                    const parentWords = parent.split(/\s+/).slice(0, 4).join(' ');
                                    const templates = [
                                        parentWords ? `So true — "${parentWords}..." 💯` : 'So true 💯',
                                        'Facts 🔥',
                                        "Right?! 😂",
                                        'Couldn\'t agree more 👏',
                                        parentWords ? `${parentWords}... this! 🙌` : 'This! 🙌',
                                    ];
                                    replyText = templates[Math.floor(Math.random() * templates.length)];
                                    logger.info(`[engage:${taskId}] AI-off: no seed available, fallback template: "${replyText}"`);
                                }
                            }
                            if (replyText) {
                                const replyRes = await postCommentVerified(page, s, replyText, `[engage:${taskId}]`, { mode: 'reply', containerIndex: cIdx, containerSel: CONTAINER_SEL }).catch(err => ({ posted: false, reason: err.message }));
                                if (replyRes.posted) {
                                    repliedTexts.add(comment.text);
                                    processedCount++;
                                    logger.info(`[engage:${taskId}] Replied to comment: "${comment.text.substring(0, 40)}..." → "${replyText.substring(0, 50)}"`);
                                } else {
                                    logger.warn(`[engage:${taskId}] Reply NOT posted for "${comment.text.substring(0, 40)}..." (${replyRes.reason}).`);
                                }
                            }
                            // ---- 3. CLOSE the reply box before next comment ----
                            // Best-effort — the container-verified retarget above
                            // makes a stuck box safe (next Reply re-targets it).
                            if (!(await closeReplyBox())) {
                                logger.warn(`[engage:${taskId}] Reply box still open after close attempts — will re-target on next Reply click (safe).`);
                            }
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment reply failed: ${e.message}`);
                            await closeReplyBox().catch(() => false);
                        }
                        await pause(1000, 2000);
                    }

                    // ---- Final like log (before leaving the post) ----
                    // Fire-and-forget per directive: log only, never re-like.
                    try {
                        const finalSig = await isPostLiked(page, s);
                        if (finalSig && finalSig.state === true) {
                            logger.info(`[engage:${taskId}] Like confirmed at post exit.`);
                        } else {
                            logger.info(`[engage:${taskId}] Like state at post exit: DOM=${finalSig?.why ?? 'missing'}, digg=${diggConfirmedLike} — leaving it (fire-and-forget).`);
                        }
                    } catch (e) { /* non-fatal */ }

                    results.push({
                        keyword,
                        url: video.url,
                        author: video.author,
                        caption: (video.caption || '').substring(0, 120),
                        comment: generatedComment,
                        commentsProcessed: processedCount,
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
    page.off('response', onDiggApiResponse);

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
