import axios from 'axios';
import logger from "../../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi } from '../../../api/googlesheets.js';

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
    ...updateObject
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
      ...updateObject
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

// ==================== DOM Interaction Helpers ====================

export const DOMHelpers = {
  /**
   * Wait for selector with retries
   */
  waitForSelector: async (page, selector, options = {}) => {
    const { timeout = 10000, visible = false, retries = 3 } = options;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await page.waitForSelector(selector, { timeout, visible });
        return true;
      } catch (e) {
        if (attempt === retries) throw e;
        await new Promise(res => setTimeout(res, 1000));
      }
    }
  },

  /**
   * Random delay (rate limiting)
   */
  randomDelay: async (min = 1000, max = 3000) => {
    const delay = Math.random() * (max - min) + min;
    await new Promise(res => setTimeout(res, delay));
  },

  /**
   * Scroll page and wait for load
   */
  scrollDown: async (page, distance = 300) => {
    await page.evaluate((dist) => {
      window.scrollBy(0, dist);
    }, distance);
    await new Promise(res => setTimeout(res, 1500));
  },

  /**
   * Click with safety checks
   */
  clickElement: async (page, selector, options = {}) => {
    const { timeout = 5000, delay = 500 } = options;
    try {
      await page.waitForSelector(selector, { visible: true, timeout });
      await page.click(selector);
      await new Promise(res => setTimeout(res, delay));
      return true;
    } catch (e) {
      logger.warn(`[clickElement] Failed to click ${selector}: ${e.message}`);
      return false;
    }
  },

  /**
   * Type text with human-like speed
   */
  typeText: async (page, selector, text, options = {}) => {
    const { delay = 50 } = options;
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 5000 });
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.value = '';
      }, selector);
      await page.type(selector, text, { delay });
      return true;
    } catch (e) {
      logger.warn(`[typeText] Failed to type in ${selector}: ${e.message}`);
      return false;
    }
  }
};

// ==================== Platform-Specific Helpers ====================

export const TwitterHelpers = {
  /**
   * Extract posts from current page
   */
  extractPosts: async (page) => {
    try {
      const posts = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll("article[role='presentation']").forEach((article, idx) => {
          try {
            const textEl = article.querySelector("div[data-testid='tweetText']");
            const linkEl = article.querySelector("a[role='link'][href*='/status/']");
            const authorEl = article.querySelector("a[data-testid='User-Name']");
            
            if (textEl && linkEl) {
              items.push({
                index: idx,
                text: textEl.textContent.trim().slice(0, 280),
                author: authorEl?.textContent?.trim() || 'unknown',
                url: linkEl.href,
                postId: linkEl.href.split('/status/')[1]
              });
            }
          } catch (e) {
            console.error('Post extraction error:', e);
          }
        });
        return items;
      });
      logger.debug(`[TwitterHelpers] Extracted ${posts.length} posts`);
      return posts;
    } catch (e) {
      logger.error(`[TwitterHelpers.extractPosts] Error: ${e.message}`);
      return [];
    }
  },

  /**
   * Like a post
   */
  likePost: async (page, postIndex) => {
    try {
      const liked = await page.evaluate((idx) => {
        const articles = document.querySelectorAll("article[role='presentation']");
        if (articles[idx]) {
          const likeBtn = articles[idx].querySelector("button[aria-label*='Like']");
          if (likeBtn) {
            likeBtn.click();
            return true;
          }
        }
        return false;
      }, postIndex);
      
      if (liked) {
        await new Promise(res => setTimeout(res, 1500));
        logger.info(`[TwitterHelpers] Liked post at index ${postIndex}`);
        return true;
      }
      return false;
    } catch (e) {
      logger.error(`[TwitterHelpers.likePost] Error: ${e.message}`);
      return false;
    }
  }
};

export const TikTokHelpers = {
  /**
   * Extract videos from current feed
   */
  extractVideos: async (page) => {
    try {
      const videos = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll("div[data-testid='video-item']").forEach((item, idx) => {
          try {
            const captionEl = item.querySelector("div[data-testid='video-caption']");
            const authorEl = item.querySelector("a[data-testid='user-link']");
            
            if (captionEl && authorEl) {
              items.push({
                index: idx,
                caption: captionEl.textContent.trim().slice(0, 200),
                author: authorEl.textContent.trim(),
                authorUrl: authorEl.href,
              });
            }
          } catch (e) {
            console.error('Video extraction error:', e);
          }
        });
        return items;
      });
      logger.debug(`[TikTokHelpers] Extracted ${videos.length} videos`);
      return videos;
    } catch (e) {
      logger.error(`[TikTokHelpers.extractVideos] Error: ${e.message}`);
      return [];
    }
  },

  /**
   * Like a video
   */
  likeVideo: async (page, videoIndex) => {
    try {
      const liked = await page.evaluate((idx) => {
        const items = document.querySelectorAll("div[data-testid='video-item']");
        if (items[idx]) {
          const likeBtn = items[idx].querySelector("button[data-testid='like-button']");
          if (likeBtn && likeBtn.getAttribute('aria-pressed') !== 'true') {
            likeBtn.click();
            return true;
          }
        }
        return false;
      }, videoIndex);
      
      if (liked) {
        await new Promise(res => setTimeout(res, 1000));
        logger.info(`[TikTokHelpers] Liked video at index ${videoIndex}`);
        return true;
      }
      return false;
    } catch (e) {
      logger.error(`[TikTokHelpers.likeVideo] Error: ${e.message}`);
      return false;
    }
  },

  /**
   * Follow a user
   */
  followUser: async (page, videoIndex) => {
    try {
      const followed = await page.evaluate((idx) => {
        const items = document.querySelectorAll("div[data-testid='video-item']");
        if (items[idx]) {
          const followBtn = items[idx].querySelector("button[data-testid='follow-button']");
          if (followBtn) {
            followBtn.click();
            return true;
          }
        }
        return false;
      }, videoIndex);
      
      if (followed) {
        await new Promise(res => setTimeout(res, 1500));
        logger.info(`[TikTokHelpers] Followed user from video at index ${videoIndex}`);
        return true;
      }
      return false;
    } catch (e) {
      logger.error(`[TikTokHelpers.followUser] Error: ${e.message}`);
      return false;
    }
  }
};

export const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};
