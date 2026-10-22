import axios from 'axios';
import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, stripFormulaColumns } from '../../api/googlesheets.js';
import { DOMHelpers, checkGate, consumeAction, capturePostFrame, postCommentVerified } from '../_shared/routeHelper.js';
import { updateAccountStatus } from '../_shared/hubUpdater.js';
import limitsCore from '../_shared/limitsCore.js';
import { isTikTokCaptchaVisible, solveTikTokAudioCaptcha, isTikTokLoggedOut, navigateAndWait, ensureCommentsVisible, isPostLiked, isConfidentlyUnliked, readCommentsPanelCount, dismissCookieBanner } from './platformHelper/TikTokHelpers.js';

// Re-like the POST after this many successful comment replies (only when the
// heart is confidently unliked — never toggle a liked post off).
const POST_LIKE_RETRY_EVERY = 10;
// Max locate/reply attempts per comment across waves (virtualized lists can
// unmount an item before we reach it; give it a second wave).
const MAX_COMMENT_ATTEMPTS = 3;
// Comment panel scroll candidates (the most-overflowing visible one is used).
const COMMENT_SCROLL_SELECTORS = "div[class*='DivCommentMain'], div[class*='DivCommentListContainer'], div[class*='DivTabContainer']";

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
        stopAfterHours = 0,
        socialStrategyPrompt,
        taskId = 'session',
    } = opts;

    const { canonicalAction } = limitsCore;
    const s = platformConfig.selectors || {};
    const results = [];
    // Success-only quota accounting: only verified actions are written to the
    // hub, tallied under canonical Limits-column keys for the campaign's
    // user-level monthly interaction quota.
    const quotaTally = {};
    const countAction = async (baseAction, count = 1) => {
        const key = canonicalAction(baseAction);
        const ok = await consumeAction(profileId, baseAction, count).catch(() => false);
        if (ok) {
            quotaTally[key] = (quotaTally[key] || 0) + count;
            logger.info(`[engage:${taskId}] quota: ${key} +${count} (run total ${quotaTally[key]})`);
        } else if (profileId) {
            logger.warn(`[engage:${taskId}] quota: ${key} x${count} verified but NOT counted (hub write failed)`);
        }
        return ok;
    };
    let stopType = null;          // 'hourly' | 'daily' | 'monthly' | 'cap'
    let stopReason = null;
    let captchaFailed = false;
    const startedAt = Date.now();
    // Tags fully iterated this run (no stop hit mid-keyword). The caller marks
    // these 'done' so a resumed run only processes still-pending tags.
    const completedKeywords = [];

    // ---- Single-tab guard ----
    // --disable-popup-blocking is enabled engine-wide (login flows depend on it),
    // so ads/link targets inside TikTok can open extra tabs and steal focus.
    // Close anything that is not the working page and refocus it. The listener
    // catches popups immediately; enforceSingleTab() sweeps tabs restored from
    // the persistent profile or any popup that slipped through.
    const runnerBrowser = page.browser();
    const onNewTarget = async (target) => {
        try {
            if (!target || target.type() !== 'page') return;
            const p = await target.page();
            if (!p || p === page) return;
            await new Promise(r => setTimeout(r, 400));
            try { await p.close(); } catch (e) { /* already gone */ }
            try { await page.bringToFront(); } catch (e) { /* best effort */ }
            logger.info(`[engage:${taskId}] Popup tab detected and closed — refocused working tab.`);
        } catch (e) { /* non-fatal */ }
    };
    if (runnerBrowser) runnerBrowser.on('targetcreated', onNewTarget);

    const enforceSingleTab = async (label = '') => {
        try {
            if (!runnerBrowser) return;
            const pages = await runnerBrowser.pages().catch(() => []);
            let closed = 0;
            for (const p of pages) {
                if (p === page) continue;
                try { if (p.target && page.target && p.target() === page.target()) continue; } catch (e) { /* compare failed */ }
                try { await p.close(); closed++; } catch (e) { /* already gone */ }
            }
            try { await page.bringToFront(); } catch (e) { /* best effort */ }
            if (closed > 0) logger.info(`[engage:${taskId}] Closed ${closed} extra tab(s)${label ? ` (${label})` : ''} — refocused working tab.`);
        } catch (e) { /* non-fatal */ }
    };
    await enforceSingleTab('at start');

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

    // ---- D1: comment-list API observer (diagnostics + scroll signal) ----
    // Under automation the comment list sometimes never renders even though the
    // action bar shows a comment count. Log the raw comment API responses
    // (HTTP status + TikTok status_code + item count) so we can see whether the
    // request fired and what TikTok answered. Removed at run end.
    // The sequence counter also lets the wave loop wait for the NEXT list
    // response after a scroll instead of sleeping a fixed 1.5-3.5s.
    let commentApiSeq = 0;
    let commentApiWaiters = [];
    const signalCommentApi = () => {
        commentApiSeq++;
        const waiters = commentApiWaiters;
        commentApiWaiters = [];
        waiters.forEach((resolve) => { try { resolve(); } catch (e) { /* noop */ } });
    };
    const waitForNextCommentApi = (sinceSeq, capMs) => new Promise((resolve) => {
        if (commentApiSeq > sinceSeq) return resolve(true);
        const onApi = () => { clearTimeout(timer); resolve(true); };
        const timer = setTimeout(() => {
            commentApiWaiters = commentApiWaiters.filter((w) => w !== onApi);
            resolve(false);
        }, capMs);
        commentApiWaiters.push(onApi);
    });
    const onCommentApiResponse = (res) => {
        try {
            const u = res.url();
            if (!/comment/i.test(u)) return;
            if (!/list|feed|reply|detail/i.test(u)) return;
            if (/comment\/list/i.test(u)) signalCommentApi();
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

    // Re-like the POST only when the heart is confidently unliked. TikTok
    // sometimes drops the initial like after navigation/comment interactions.
    // Never re-click when it might already be liked (that would unlike it).
    const retryPostLikeIfNeeded = async (label = '') => {
        try {
            const sig = await isPostLiked(page, s);
            if (!isConfidentlyUnliked(sig)) return false;
            logger.info(`[engage:${taskId}] ${label}Post like not sticking (${sig && sig.why}) — retrying like click.`);
            await DOMHelpers.humanClick(page, s.likeButton, { timeout: 5000 }).catch(() => false);
            await pause(800, 1400);
            const after = await isPostLiked(page, s);
            const ok = !!(after && after.state === true);
            logger.info(`[engage:${taskId}] Post like retry ${ok ? 'succeeded' : 'still failing'} (${after ? after.why : 'missing'}).`);
            // The retry itself is a real platform action — count it.
            if (ok) await countAction('like');
            return ok;
        } catch (e) {
            logger.warn(`[engage:${taskId}] Post like retry failed: ${e.message}`);
            return false;
        }
    };

    // Comment panel scroll probe/scroll (picks the most-overflowing visible
    // candidate). TikTok virtualizes long lists, so we only trust the union of
    // every extraction rather than a single snapshot.
    const probeCommentScroll = (sels) => {
        const list = Array.from(document.querySelectorAll(sels));
        let best = null, bestOverflow = 0;
        for (const el of list) {
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) continue;
            const overflow = el.scrollHeight - el.clientHeight;
            if (overflow > bestOverflow) { bestOverflow = overflow; best = el; }
        }
        const target = best || list[0];
        if (!target) return null;
        const r = target.getBoundingClientRect();
        return {
            x: r.x + r.width / 2,
            y: r.y + Math.min(r.height / 2, 320),
            scrollTop: target.scrollTop,
            scrollHeight: target.scrollHeight,
            clientHeight: target.clientHeight,
        };
    };
    const readCommentScroll = () => page.evaluate(probeCommentScroll, COMMENT_SCROLL_SELECTORS).catch(() => null);
    const scrollComments = async (totalPx) => {
        const info = await readCommentScroll();
        if (!info) {
            await DOMHelpers.humanScroll(page, "div[class*='DivCommentMain'], div[class*='DivTabContainer']", { totalPx }).catch(() => false);
            return;
        }
        await DOMHelpers.humanScroll(page, null, { totalPx, point: { x: info.x, y: info.y } }).catch(() => false);
    };

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
            await enforceSingleTab('after search navigation');
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
                    await enforceSingleTab('after post navigation');
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

                    // TikTok renders a cookie-consent banner that overlays the
                    // composer and silently swallows replies — dismiss it up front.
                    await dismissCookieBanner(page, `[engage:${taskId}]`);

                    // ---- Like the post ----
                    // (Action-bar comment count is read AFTER the like settles —
                    // see below. Reading it here raced slow photo-post hydration
                    // and misread 0, flipping ensureCommentsVisible into lenient
                    // mode and bypassing the comments_not_loaded guard.)
                    const likeGate = await checkGate(platform, profileId, 'like');
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
                    let postLikePerformed = false;
                    let postLikeAlready = false;
                    const preSig = await isPostLiked(page, s);
                    if (preSig && preSig.state === true) {
                        logger.info(`[engage:${taskId}] Post already liked (${preSig.why}) — skipping like click.`);
                        diggConfirmedLike = true; // already liked server-side; never toggle it off
                        postLikeAlready = true;
                    } else {
                        diggPending = true; // next digg response is OUR click
                        const likeClicked = await DOMHelpers.humanClick(page, s.likeButton, { timeout: 5000 }).catch(() => false);
                        postLikePerformed = likeClicked;
                        logger.info(`[engage:${taskId}] Like ${likeClicked ? 'clicked' : 'NOT found'}.`);
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
                    // Success-only accounting: count the post like only when our
                    // click was confirmed (DOM or digg API). Already-liked posts
                    // are not a new action.
                    const likeConfirmed = (likeSig && likeSig.state === true) || diggConfirmedLike;
                    if (!postLikeAlready && postLikePerformed && likeConfirmed) {
                        await countAction('like');
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
                    const commentGate = await checkGate(platform, profileId, 'comment');
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
                            await countAction('comment');
                        } else {
                            logger.warn(`[engage:${taskId}] Comment NOT posted (${postRes.reason}) — skipping comment.`);
                            generatedComment = '';
                        }
                    }
                    await pause(1500, 2500);

                    // ---- Per-comment like + reply (WAVE-based, text-located) ----
                    // User directive: like comment → reply → close reply box →
                    // NEXT comment. Instead of a single static snapshot (which
                    // capped the post at the ~first 20 scraped comments), we
                    // process the comments currently rendered, then SCROLL the
                    // panel to load the next page and repeat — so one post can
                    // consume its full platform quota (likeOnComment /
                    // commentOnComment) before the next post opens. STOP only on
                    // a platform-gate denial (quota exhausted), comment-list
                    // exhaustion, time/captcha, or SPA drift. Locate each
                    // container by TEXT match — indices go stale the moment a
                    // reply is inserted into the DOM (observed double-🙌).
                    let processedCount = 0;
                    const repliedKeys = new Set();      // keys we successfully replied to
                    const commentsByKey = new Map();    // UNION of every extraction (id-first)
                    const attemptsByKey = new Map();    // locate/reply failures per key

                    // Stable identity: TikTok gives each comment an `id` (data
                    // attribute), so identical-text comments (e.g. four "😂😂😂")
                    // are distinct. Fall back to username+text when id is absent.
                    const commentKey = (c) => {
                        if (c && c.id) return `id:${String(c.id)}`;
                        const t = String((c && c.text) || '').replace(/\s+/g, ' ').trim().toLowerCase().substring(0, 80);
                        const u = String((c && c.username) || '').replace(/^@+/, '').replace(/\s+/g, ' ').trim().toLowerCase();
                        return `tu:${u}|${t}`;
                    };
                    // Never replace the union — virtualized lists unmount items,
                    // and each scroll only exposes a window of comments.
                    const mergeComments = (list) => {
                        (list || []).forEach((c) => {
                            const t = String((c && c.text) || '').trim();
                            if (!t) return;
                            const key = commentKey(c);
                            if (!commentsByKey.has(key)) commentsByKey.set(key, c);
                        });
                    };
                    mergeComments(aiComments); // seed with the AI-context snapshot

                    // Pending target list: union minus replied, minus exhausted
                    // (MAX_COMMENT_ATTEMPTS locate/reply failures).
                    const buildTargets = () => {
                        const out = [];
                        for (const [key, c] of commentsByKey) {
                            if (String(c.text || '').trim() === generatedComment) continue;
                            if (repliedKeys.has(key)) continue;
                            if ((attemptsByKey.get(key) || 0) >= MAX_COMMENT_ATTEMPTS) continue;
                            out.push(Object.assign({}, c, { key }));
                        }
                        return out;
                    };

                    // ObjectWrapper ONLY — DivCommentItemWrapper is nested INSIDE
                    // it; matching both gave double indices + double extraction.
                    const CONTAINER_SEL = "div[class*='DivCommentObjectWrapper']";

                    // Locate a comment's live container: ID-first (stable), then
                    // username + text. ID makes identical-text comments reliable;
                    // text stays for older snapshots without an id. UNIQUE-MATCH:
                    // if several containers match, return -1 rather than guess
                    // (that was the multi-reply-on-one-comment bug). Virtualized
                    // lists unmount off-screen items — scroll once and retry.
                    const locateComment = async (comment) => {
                        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                        const needle = norm(comment && comment.text).substring(0, 60);
                        const user = norm(comment && comment.username).replace(/^@+/, '');
                        const id = comment && comment.id ? String(comment.id) : '';
                        if (!needle && !id) return -1;
                        const findIdx = async () => page.evaluate(({ sel, text, user, id }) => {
                            const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            const items = document.querySelectorAll(sel);
                            if (id) {
                                for (let i = 0; i < items.length; i++) {
                                    if (items[i].id && items[i].id === id) return i;
                                }
                            }
                            const matches = [];
                            for (let i = 0; i < items.length; i++) {
                                const t = items[i].querySelector("span[data-e2e='comment-level-1'], p[data-e2e='comment-level-1']");
                                if (!t) continue;
                                if (user) {
                                    const uEl = items[i].querySelector("[data-e2e^='comment-username-']");
                                    if (norm(uEl ? uEl.textContent : '').replace(/^@+/, '') !== user) continue;
                                }
                                const live = norm(t.textContent).substring(0, 60);
                                if (live === text || live.startsWith(text) || text.startsWith(live)) matches.push(i);
                            }
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
                        }, { sel: CONTAINER_SEL, text: needle, user, id });
                        let idx = await findIdx();
                        if (idx >= 0) return idx;
                        await scrollComments(400);
                        await pause(250, 450);
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
                    // is a PLAIN DIV (class ~'css-8blle4') containing an X svg —
                    // NOT a button — which is why button heuristics never found
                    // it. Live DOM: <div class="css-8blle4"><svg ...><path
                    // d="M38.7 12.12..."></path></svg></div>. It sits BESIDE the
                    // input wrapper, so a wrapper-scoped query missed it. Locate
                    // it GLOBALLY by the X glyph path and click the nearest div
                    // with a REAL mouse click (synthetic .click() is ignored by
                    // TikTok). Exclude the panel-level comment_close. VERIFY
                    // closure by polling for zero inline composers.
                    const findReplyCloseRects = () => page.evaluate(() => {
                        const out = [];
                        const paths = document.querySelectorAll("svg path");
                        for (const p of paths) {
                            const d = p.getAttribute('d') || '';
                            if (!d.startsWith('M38.7 12.12')) continue;
                            // Nearest div host (the plain X div), else the svg itself.
                            const host = p.closest('div') || p.closest('svg');
                            if (!host) continue;
                            if (host.closest("[data-key-interaction='comment_close']")) continue; // panel close, not ours
                            // Skip if this X belongs to a hidden/closed item.
                            const r = host.getBoundingClientRect();
                            if (r.width < 1 || r.height < 1) continue;
                            out.push({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
                        }
                        return out;
                    }).catch(() => []);

                    const closeReplyBox = async () => {
                        for (let attempt = 0; attempt < 2; attempt++) {
                            if ((await countInlineComposers()) === 0) return true;
                            await page.keyboard.press('Escape').catch(() => {});
                            await pause(180, 320);
                            if ((await countInlineComposers()) === 0) return true;
                            // Real-mouse click every visible reply X (normally one).
                            const rects = await findReplyCloseRects();
                            for (const rc of rects) {
                                await DOMHelpers.humanClickAt(page, rc.x, rc.y, { hoverMs: [100, 250] }).catch(() => false);
                                await pause(150, 280);
                            }
                            await pause(180, 320);
                        }
                        return (await countInlineComposers()) === 0;
                    };

                    let consecutiveVerifyFailures = 0; // reset on any successful reply/verify
                    // After a reply-AI failure (timeout / all providers down) skip
                    // further AI calls for a short window and use the emoji
                    // fallback — otherwise every comment pays the full timeout.
                    let aiReplyCooldownUntil = 0;

                    const reextractComments = async () => {
                        try {
                            const cEx = platformConfig.extractors?.comments;
                            if (!cEx) return;
                            const pf = new Function('items', 'return (' + cEx.parseFunction + '\n)(items);');
                            const items = await page.$$eval(cEx.selector, pf).catch(() => []) || [];
                            mergeComments(items);
                        } catch (e) { /* keep the union we already have */ }
                    };

                    // Wave loop: process pending comments, then scroll to load
                    // more. TikTok lazy-loads comments as the panel scrolls and
                    // virtualizes (unmounts) off-screen items, so KEEP a union of
                    // every extraction and stop only when 3 consecutive scroll
                    // attempts produce neither new comments nor list movement.
                    let wave = 0;
                    let stagnantWaves = 0;
                    let sweptUp = false;
                    let lastScroll = await readCommentScroll();
                    let queue = buildTargets();
                    wave++;
                    logger.info(`[engage:${taskId}] Wave ${wave}: ${queue.length} pending (${commentsByKey.size} unique so far, ${processedCount} engaged).`);
                    let qi = 0;

                    while (true) {
                        if (qi >= queue.length) {
                            // Wave fully consumed → try to load more comments.
                            if (stopType) break;
                            if (checkTimeStop()) break;
                            if (!stillOnTarget()) {
                                logger.warn(`[engage:${taskId}] Page drifted (${page.url()}) while reloading comments — stopping per-comment loop.`);
                                break;
                            }
                            // Already swept the whole list up and down — anything
                            // still pending failed its attempts; don't re-scroll.
                            if (sweptUp) {
                                logger.info(`[engage:${taskId}] Comment list exhausted after ${wave} wave(s) (${commentsByKey.size} unique, ${processedCount} engaged).`);
                                break;
                            }
                            const beforeUnique = commentsByKey.size;
                            const scrollSeq = commentApiSeq;
                            await scrollComments(900);
                            // Lazy fetch lags the scroll. Wait for the NEXT
                            // /api/comment/list/ response (typically a few hundred
                            // ms) instead of a blind 1.5-3.5s sleep; if TikTok
                            // serves it from cache, fall back to a short second
                            // chance after the 1.2s cap.
                            const apiFired = await waitForNextCommentApi(scrollSeq, 1200);
                            await pause(220, 400);
                            await reextractComments();
                            if (commentsByKey.size === beforeUnique) {
                                if (apiFired) await pause(350, 600);
                                else await pause(600, 900);
                                await reextractComments();
                            }
                            const scrollNow = await readCommentScroll();
                            const moved = !(scrollNow && lastScroll)
                                ? true
                                : (scrollNow.scrollTop !== lastScroll.scrollTop || scrollNow.scrollHeight !== lastScroll.scrollHeight);
                            lastScroll = scrollNow || lastScroll;
                            const grew = commentsByKey.size > beforeUnique;
                            if (!grew && !moved) stagnantWaves++; else stagnantWaves = 0;
                            if (stagnantWaves >= 3) {
                                // Comments seen early but unmounted near the bottom
                                // (virtualization) are still pending — sweep back
                                // up once so they get their turn.
                                const pending = buildTargets();
                                if (pending.length > 0 && !sweptUp) {
                                    sweptUp = true;
                                    stagnantWaves = 0;
                                    logger.info(`[engage:${taskId}] Backlog sweep: ${pending.length} unresolved comment(s) — scrolling up through the list.`);
                                    for (let i = 0; i < 6; i++) {
                                        await scrollComments(-900);
                                        await pause(250, 400);
                                    }
                                    await pause(800, 1200);
                                    await reextractComments();
                                    queue = buildTargets();
                                    wave++;
                                    qi = 0;
                                    lastScroll = await readCommentScroll();
                                    logger.info(`[engage:${taskId}] Wave ${wave} (backlog): ${queue.length} pending (${commentsByKey.size} unique so far, ${processedCount} engaged).`);
                                    continue;
                                }
                                logger.info(`[engage:${taskId}] Comment list exhausted after ${wave} wave(s) (${commentsByKey.size} unique, ${processedCount} engaged).`);
                                break;
                            }
                            queue = buildTargets();
                            wave++;
                            qi = 0;
                            logger.info(`[engage:${taskId}] Wave ${wave}: ${queue.length} pending (${commentsByKey.size} unique so far, ${processedCount} engaged).`);
                            continue;
                        }
                        const comment = queue[qi++];
                        if (stopType) break;
                        // URL-drift guard: if the SPA navigated to another post,
                        // every subsequent locate/type would hit the wrong page.
                        if (!stillOnTarget()) {
                            logger.warn(`[engage:${taskId}] Page drifted mid-loop (${page.url()}) — stopping per-comment loop.`);
                            break;
                        }

                        // ---- Locate the comment in the live DOM (id-first) ----
                        // mutable: the like poll may scroll/re-render the list, so
                        // refresh before the reply so it targets the right box.
                        let cIdx = await locateComment(comment);
                        if (cIdx < 0) {
                            const fails = (attemptsByKey.get(comment.key) || 0) + 1;
                            attemptsByKey.set(comment.key, fails);
                            logger.info(`[engage:${taskId}] Comment not found / ambiguous (attempt ${fails}/${MAX_COMMENT_ATTEMPTS}): "${comment.text.substring(0, 40)}..." — ${fails >= MAX_COMMENT_ATTEMPTS ? 'giving up' : 'will retry next wave'}.`);
                            continue;
                        }

                        // ---- 1. LIKE the comment ----
                        const likeCGate = await checkGate(platform, profileId, 'likeComment');
                        if (!likeCGate.allowed) {
                            stopType = likeCGate.stopType;
                            stopReason = likeCGate.reason;
                            logger.info(`[engage:${taskId}] Comment-like blocked (${stopReason}) — stopping run.`);
                            break;
                        }
                        try {
                            // Resolve the like button + its pressed state for a
                            // given container index. Live DOM: like is
                            // div[data-key-interaction='comment_like'][aria-pressed].
                            const resolveLike = (idx) => page.evaluate(({ sel, idx }) => {
                                const el = document.querySelectorAll(sel)[idx];
                                if (!el) return { state: 'no-container' };
                                const likeIcon = el.querySelector("div[data-key-interaction='comment_like'], [data-key-interaction='comment_like'], [data-e2e='comment-like-icon']");
                                if (!likeIcon) return { state: 'no-icon' };
                                const pressed = (likeIcon.getAttribute('aria-pressed') === 'true')
                                    || !!(likeIcon.closest('[aria-pressed="true"]'))
                                    || !!(likeIcon.querySelector('[aria-pressed="true"]'));
                                if (pressed) return { state: 'liked' };
                                const r = likeIcon.getBoundingClientRect();
                                if (r.width < 1 || r.height < 1) return { state: 'not-visible' };
                                const x = r.x + r.width / 2, y = r.y + r.height / 2;
                                // elementFromPoint coverage: a stale/scrolled rect
                                // can point at an overlay instead of the heart.
                                const hit = document.elementFromPoint(x, y);
                                const covered = !!hit && (likeIcon === hit || likeIcon.contains(hit) || hit.contains(likeIcon));
                                return { state: 'unliked', rect: { x, y }, covered };
                            }, { sel: CONTAINER_SEL, idx }).catch(() => ({ state: 'eval-error' }));

                            // Click → poll aria-pressed. Up to 2 click attempts;
                            // BEST-EFFORT — the reply proceeds regardless (user
                            // directive: never skip commenting on an unliked comment).
                            let likeVerified = false;
                            let likeAlready = false;
                            for (let attempt = 0; attempt < 2 && !likeVerified; attempt++) {
                                let idx = await locateComment(comment);
                                if (idx < 0) break;
                                let res = await resolveLike(idx);
                                if (res.state === 'liked') { likeVerified = true; likeAlready = true; break; }
                                if (!res.rect) { await pause(400, 700); continue; }
                                if (!res.covered) {
                                    await page.evaluate(({ sel, idx }) => {
                                        const el = document.querySelectorAll(sel)[idx];
                                        if (el) el.scrollIntoView({ block: 'center' });
                                    }, { sel: CONTAINER_SEL, idx }).catch(() => {});
                                    await pause(250, 450);
                                    const idx2 = await locateComment(comment);
                                    if (idx2 < 0) continue;
                                    idx = idx2;
                                    res = await resolveLike(idx);
                                    if (res.state === 'liked') { likeVerified = true; break; }
                                    if (!res.rect) continue;
                                }
                                await DOMHelpers.humanClickAt(page, res.rect.x, res.rect.y, { hoverMs: [120, 300] }).catch(() => false);
                                // Poll for aria-pressed=true (~3s).
                                for (let i = 0; i < 6 && !likeVerified; i++) {
                                    await pause(180, 300);
                                    let chk = await resolveLike(idx);
                                    if (chk.state === 'liked') { likeVerified = true; break; }
                                    if (chk.state === 'no-container' || chk.state === 'no-icon') {
                                        const reIdx = await locateComment(comment);
                                        if (reIdx >= 0) {
                                            idx = reIdx;
                                            chk = await resolveLike(idx);
                                            if (chk.state === 'liked') { likeVerified = true; break; }
                                        }
                                    }
                                }
                            }
                            logger.info(`[engage:${taskId}] Comment like verified=${likeVerified}${likeAlready ? ' (already liked)' : ''}: "${comment.text.substring(0, 40)}..."`);
                            // Success-only accounting: count only a NEW like.
                            if (likeVerified && !likeAlready) {
                                await countAction('likeComment');
                            }
                        } catch (e) {
                            logger.warn(`[engage:${taskId}] Comment like verify failed: ${e.message}`);
                        }
                        await pause(200, 400);
                        // Re-resolve the container index (the like poll may have
                        // scrolled/re-rendered the virtualized list) so the reply
                        // targets the correct box. Keep the old index if not found.
                        {
                            const freshIdx = await locateComment(comment).catch(() => -1);
                            if (freshIdx >= 0) cIdx = freshIdx;
                        }

                        // ---- 2. REPLY to the comment ----
                        const replyGate = await checkGate(platform, profileId, 'commentComment');
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
                                const fails = (attemptsByKey.get(comment.key) || 0) + 1;
                                attemptsByKey.set(comment.key, fails);
                                logger.warn(`[engage:${taskId}] Reply button not found for "${comment.text.substring(0, 40)}..." (attempt ${fails}/${MAX_COMMENT_ATTEMPTS}) — skipping.`);
                                continue;
                            }
                            await pause(450, 700);
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
                                await pause(300, 500);
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
                                    await pause(450, 700);
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
                            const aiCoolingDown = Date.now() < aiReplyCooldownUntil;
                            try {
                                const replyPrompt = `${platformConfig.aiPrompts?.replyToComment || 'Reply briefly.'}\n\nVideo analysis: ${analyzedVideo}\nYour comment: ${generatedComment}\nComment to reply to: ${comment.text}`;
                                // Reply generation is on the per-comment critical
                                // path: short cap + no transient retries, fall
                                // back to one emoji instead of stalling.
                                replyText = (ai && !aiCoolingDown)
                                    ? await ai.generate(replyPrompt, { maxTokens: 60, timeoutMs: 15000, maxTransientAttempts: 1 })
                                    : '';
                                replyText = stripMentions(String(replyText || '').replace(/^["']|["']$/g, '').trim()).slice(0, 120);
                                if (!replyText && !aiCoolingDown) {
                                    aiReplyCooldownUntil = Date.now() + 20000;
                                    logger.warn(`[engage:${taskId}] Reply AI returned empty — emoji fallback for ~20s.`);
                                }
                            } catch (e) {
                                replyText = '';
                                if (!aiCoolingDown) {
                                    aiReplyCooldownUntil = Date.now() + 20000;
                                    logger.warn(`[engage:${taskId}] Reply AI failed (${e.message}) — emoji fallback for ~20s.`);
                                }
                            }
                            // AI-off fallback (user directive): reply is a SINGLE
                            // random emoji. Nothing else — no seeded text, no
                            // templates. The previous seed-based fallback duplicated
                            // the main comment into the reply box (exclusion of
                            // generatedComment failed because it had an emoji
                            // appended). One emoji is guaranteed unique-safe.
                            if (!replyText) {
                                const EMOJIS = ['🔥', '💯', '🙌', '😂', '👏', '😊', '😍', '🤯'];
                                replyText = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
                                logger.info(`[engage:${taskId}] Reply${ai ? (aiCoolingDown ? ' (AI cooldown)' : '') : ' AI-off'}: reply = single emoji "${replyText}"`);
                            }
                            if (replyText) {
                                // The banner can re-render on SPA updates; dismiss
                                // it before every reply so the submit is not swallowed.
                                await dismissCookieBanner(page, `[engage:${taskId}]`);
                                const replyRes = await postCommentVerified(page, s, replyText, `[engage:${taskId}]`, { mode: 'reply', containerIndex: cIdx, containerSel: CONTAINER_SEL }).catch(err => ({ posted: false, reason: err.message }));
                                if (replyRes.posted) {
                                    repliedKeys.add(comment.key);
                                    processedCount++;
                                    logger.info(`[engage:${taskId}] Replied to comment: "${comment.text.substring(0, 40)}..." → "${replyText.substring(0, 50)}"`);
                                    await countAction('commentComment');
                                    // TikTok drops the post like after enough comment
                                    // interactions — re-like (only if confidently
                                    // unliked) every N replies.
                                    if (processedCount % POST_LIKE_RETRY_EVERY === 0) {
                                        await retryPostLikeIfNeeded(`after ${processedCount} comments: `);
                                    }
                                } else {
                                    const fails = (attemptsByKey.get(comment.key) || 0) + 1;
                                    attemptsByKey.set(comment.key, fails);
                                    logger.warn(`[engage:${taskId}] Reply NOT posted for "${comment.text.substring(0, 40)}..." (${replyRes.reason}, attempt ${fails}/${MAX_COMMENT_ATTEMPTS}).`);
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
                            const fails = (attemptsByKey.get(comment.key) || 0) + 1;
                            attemptsByKey.set(comment.key, fails);
                            await closeReplyBox().catch(() => false);
                        }
                        await pause(250, 500);
                    }  // end while (wave loop)

                    // ---- Final like check (before leaving the post) ----
                    // Retry ONCE if the heart is confidently unliked (the initial
                    // like frequently drops mid-session). Never toggle a liked
                    // post off.
                    await enforceSingleTab('after comments');
                    await retryPostLikeIfNeeded('at exit: ');
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

        // Fully processed (no stop mid-keyword) — eligible to be marked done.
        if (!stopType) completedKeywords.push(keyword);
    }

    page.off('response', onCommentApiResponse);
    page.off('response', onDiggApiResponse);
    if (runnerBrowser) runnerBrowser.off('targetcreated', onNewTarget);

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

    const quotaTotal = Object.values(quotaTally).reduce((a, b) => a + b, 0);
    logger.info(`[engage:${taskId}] Verified quota this run: ${JSON.stringify(quotaTally)} (total ${quotaTotal})`);
    return {
        results,
        completedKeywords,
        stopType,
        stopReason,
        captchaFailed,
        engaged: results.filter(r => r.status === 'engaged').length,
        failed: results.filter(r => r.status === 'failed').length,
        quota: { ...quotaTally, total: quotaTotal },
    };
}
