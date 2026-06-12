import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import axios from 'axios';
import logger from "../../../utils/logger.js";
import { getSheetDataApi, updateSheetRowApi, appendSheetRowApi } from '../../api/googlesheets.js';
import { localExecutablePath, isDev, userAgent, remoteExecutablePath } from "../../../utils/utils.js";

// ==================== Browser Session Management ====================

export async function loadBrowserSession(cookieJSON) {
    if (!cookieJSON) throw new Error("No cookies provided");
    try {
        return typeof cookieJSON === 'string' ? JSON.parse(cookieJSON) : cookieJSON;
    } catch (e) {
        logger.error(`[loadBrowserSession] Error parsing cookies: ${e.message}`);
        throw e;
    }
}

export async function launchBrowserWithSession(cookieJSON, headless = true) {
    try {
        const browser = await puppeteer.launch({
            ignoreDefaultArgs: ["--enable-automation"],
            args: isDev
                ? ["--disable-blink-features=AutomationControlled", "--disable-features=site-per-process", "-disable-site-isolation-trials"]
                : [...chromium.args, "--disable-blink-features=AutomationControlled"],
            executablePath: isDev ? localExecutablePath : await chromium.executablePath(remoteExecutablePath),
            headless,
        });

        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent(userAgent);

        const cookies = await loadBrowserSession(cookieJSON);
        await page.setCookie(...cookies);

        logger.info(`[launchBrowserWithSession] Browser launched with session`);
        return { browser, page };
    } catch (e) {
        logger.error(`[launchBrowserWithSession] Error: ${e.message}`);
        throw e;
    }
}

// ==================== Data Fetching & Caching ====================

let appScriptDataCache = null;
let lastCacheUpdateTime = 0;
const SHEETS_API_MIN_INTERVAL = 5000;
let isUpdatingCache = false;
let currentUpdatePromise = null;

async function _fetchSheetWithCache(sheetName, retries = 3, timeout = 120000, forceRefresh = false) {
    const now = Date.now();
    if (isUpdatingCache && currentUpdatePromise) return await currentUpdatePromise;
    if (!forceRefresh && appScriptDataCache && (now - lastCacheUpdateTime < SHEETS_API_MIN_INTERVAL)) {
        return appScriptDataCache;
    }

    isUpdatingCache = true;
    const fetchPromise = (async () => {
        try {
            const result = await getSheetDataApi(sheetName);
            if (result.success) {
                appScriptDataCache = [result.headers, ...result.data];
                lastCacheUpdateTime = Date.now();
                return appScriptDataCache;
            }
            logger.warn(`[_fetchSheetWithCache] Sheets API failed for ${sheetName}: ${result.error}`);
        } catch (e) {
            logger.error(`[_fetchSheetWithCache] Error fetching ${sheetName}: ${e.message}`);
        }

        const appScriptUrl = process.env.SCRIPT_URL;
        const params = new URLSearchParams({ action: 'getData', sheetName, key: process.env.SCRIPT_KEY });

        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                const response = await axios.post(appScriptUrl, params, { timeout, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                if (response.data?.success) {
                    appScriptDataCache = [response.data.headers, ...response.data.data];
                    lastCacheUpdateTime = Date.now();
                    return appScriptDataCache;
                }
            } catch (error) {
                logger.error(`[_fetchSheetWithCache] Attempt ${attempt} failed: ${error.message}`);
                if (attempt === retries) throw new Error(`Failed after ${retries} attempts.`);
            }
        }
    })();

    currentUpdatePromise = fetchPromise;
    const result = await fetchPromise;
    isUpdatingCache = false;
    currentUpdatePromise = null;
    return result;
}

export async function fetchSheetData(sheetName, forceRefresh = false) {
    return await _fetchSheetWithCache(sheetName, 3, 120000, forceRefresh);
}

// ==================== Column Index Management ====================

export function getColumnIndexes(headers) {
    return headers.reduce((acc, header, index) => {
        acc[header] = index;
        return acc;
    }, {});
}

// ==================== Row Update Operations ====================

export async function updateSheetRow(sheetName, searchColumn, searchValue, updateObject) {
    if (!sheetName || !searchColumn || !searchValue) {
        throw new Error("Missing required params for updateSheetRow");
    }

    try {
        const result = await updateSheetRowApi(sheetName, searchColumn, searchValue, updateObject);
        if (result.success) {
            logger.info(`[updateSheetRow] ${sheetName} row updated successfully via Sheets API.`);
            return result;
        }
        throw new Error(`Sheets API update failed: ${result.error}`);
    } catch (e) {
        logger.warn(`[updateSheetRow] Sheets API error: ${e.message}. Trying App Script fallback.`);
        const appScriptUrl = process.env.SCRIPT_URL;
        const params = new URLSearchParams({
            action: 'setMultipleCellDataByColumnSearch',
            sheetName,
            searchColumn,
            searchValue,
            key: process.env.SCRIPT_KEY,
            data: JSON.stringify(updateObject),
        });
        try {
            const response = await axios.post(appScriptUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 60000,
            });
            if (!response.data?.success) throw new Error(response.data?.error || 'Unknown error');
            logger.info(`[updateSheetRow] ${sheetName} row updated via App Script fallback.`);
            return { success: true };
        } catch (fallbackError) {
            logger.error(`[updateSheetRow] App Script fallback failed: ${fallbackError.message}`);
            throw fallbackError;
        }
    }
}

export async function appendSheetRow(sheetName, dataObject) {
    if (!sheetName) throw new Error("Missing sheetName for appendSheetRow");
    try {
        const result = await appendSheetRowApi(sheetName, dataObject);
        if (result.success) {
            logger.info(`[appendSheetRow] Row appended to ${sheetName} via Sheets API.`);
            return result;
        }
        throw new Error(`Append failed: ${result.error}`);
    } catch (e) {
        logger.error(`[appendSheetRow] Error appending to ${sheetName}: ${e.message}`);
        throw e;
    }
}

// ==================== DOM Interaction Helpers ====================

export const DOMHelpers = {
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

    randomDelay: async (min = 1000, max = 3000) => {
        await new Promise(res => setTimeout(res, Math.random() * (max - min) + min));
    },

    scrollDown: async (page, distance = 300) => {
        await page.evaluate((dist) => window.scrollBy(0, dist), distance);
        await new Promise(res => setTimeout(res, 1500));
    },

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

// ==================== Template Interpolation ====================

export function interpolate(value, context) {
    if (typeof value !== 'string') return value;
    return value.replace(/\$\{([^}]+)\}/g, (match, key) => {
        const keys = key.split('.');
        let val = context;
        for (const k of keys) {
            if (val && typeof val === 'object') val = val[k];
            else return match;
        }
        return val !== undefined ? val : match;
    });
}

// ==================== Generic Workflow Executor ====================

export async function executeWorkflow(page, workflow, context, platformConfig, aiProvider) {
    const results = {};

    try {
        logger.info(`[executeWorkflow] Starting workflow: ${workflow.name}`);

        for (let i = 0; i < workflow.steps.length; i++) {
            const step = workflow.steps[i];
            const stepNum = i + 1;
            const action = step.action;
            const stepContext = { ...context, ...results, selectors: platformConfig.selectors };

            logger.debug(`[executeWorkflow] Step ${stepNum}/${workflow.steps.length}: ${action}`);

            try {
                switch (action) {
                    case 'navigate': {
                        const url = interpolate(step.url, stepContext);
                        await page.goto(url, { waitUntil: step.waitUntil || 'networkidle0', timeout: platformConfig.timing?.navigationTimeout || 15000 });
                        break;
                    }
                    case 'pause': {
                        const duration = step.duration || 1000;
                        await DOMHelpers.randomDelay(duration * 0.8, duration * 1.2);
                        break;
                    }
                    case 'fillSearch': {
                        const selector = interpolate(step.selector, stepContext);
                        const value = interpolate(step.value, stepContext);
                        await DOMHelpers.typeText(page, selector, value, { delay: 50 });
                        break;
                    }
                    case 'submitSearch': {
                        const submitSelector = platformConfig.selectors?.searchSubmit;
                        if (submitSelector) await DOMHelpers.clickElement(page, submitSelector);
                        else await page.keyboard.press('Enter');
                        break;
                    }
                    case 'click': {
                        const selector = interpolate(step.selector, stepContext);
                        await DOMHelpers.clickElement(page, selector);
                        break;
                    }
                    case 'fillText': {
                        const selector = interpolate(step.selector, stepContext);
                        const value = interpolate(step.value, stepContext);
                        await DOMHelpers.typeText(page, selector, value, { delay: 30 });
                        break;
                    }
                    case 'scroll': {
                        const distance = step.distance || 300;
                        await page.evaluate((dist) => window.scrollBy(0, dist), distance);
                        break;
                    }
                    case 'clickPost': {
                        const postIndex = step.postIndex || 0;
                        const postSelector = platformConfig.selectors?.postItem;
                        if (postSelector) {
                            const allPosts = await page.$$(postSelector);
                            if (allPosts[postIndex]) await allPosts[postIndex].click();
                        }
                        break;
                    }
                    case 'clickVideo': {
                        const videoIndex = step.videoIndex || 0;
                        const videoSelector = platformConfig.selectors?.videoItem;
                        if (videoSelector) {
                            const allVideos = await page.$$(videoSelector);
                            if (allVideos[videoIndex]) await allVideos[videoIndex].click();
                        }
                        break;
                    }
                    case 'capturePageContent': {
                        const captureName = step.captureName || 'pageContent';
                        results[captureName] = await page.content();
                        break;
                    }
                    case 'aiAnalyzePost':
                    case 'aiAnalyzeVideo':
                    case 'aiAnalyzeComments': {
                        const prompt = interpolate(step.prompt, stepContext);
                        const pageContent = results[step.captureName || 'pageContent'] || '';
                        try {
                            const analysis = aiProvider ? await aiProvider.analyzePageContent(pageContent, prompt) : "AI not available";
                            results[step.resultKey || 'analysis'] = analysis;
                        } catch (e) {
                            logger.error(`[executeWorkflow] AI analysis failed: ${e.message}`);
                            results[step.resultKey || 'analysis'] = "Could not analyze";
                        }
                        break;
                    }
                    case 'aiGenerateReply':
                    case 'aiGenerateComment': {
                        const prompt = step.prompt || '';
                        const fullPrompt = Object.entries(stepContext).reduce((p, [key, val]) => {
                            return p.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val ?? ''));
                        }, prompt);
                        try {
                            const generated = aiProvider ? await aiProvider.generate(fullPrompt) : "Great content!";
                            results[step.resultKey || 'generated'] = generated;
                        } catch (e) {
                            logger.error(`[executeWorkflow] AI generation failed: ${e.message}`);
                            results[step.resultKey || 'generated'] = "Great content!";
                        }
                        break;
                    }
                    case 'likeRandomComments': {
                        const maxCount = step.maxCount || 3;
                        const commentSelector = platformConfig.selectors?.commentButton;
                        if (commentSelector) {
                            const buttons = await page.$$(`${commentSelector}~button[aria-label*='like']`);
                            const numToLike = Math.min(maxCount, buttons.length);
                            for (let j = 0; j < numToLike; j++) {
                                try {
                                    await buttons[Math.floor(Math.random() * buttons.length)].click();
                                    await DOMHelpers.randomDelay(500, 1500);
                                } catch (e) { /* skip failed clicks */ }
                            }
                        }
                        break;
                    }
                    default:
                        logger.warn(`[executeWorkflow] Unknown action: ${action}`);
                }

                if (i < workflow.steps.length - 1) {
                    const minDelay = platformConfig.timing?.minDelayBetweenActions || 1000;
                    const maxDelay = platformConfig.timing?.maxDelayBetweenActions || 3000;
                    await DOMHelpers.randomDelay(minDelay, maxDelay);
                }
            } catch (stepError) {
                logger.error(`[executeWorkflow] Step ${stepNum} (${action}) failed: ${stepError.message}`);
                throw stepError;
            }
        }

        logger.info(`[executeWorkflow] Workflow completed: ${workflow.name}`);
        return results;
    } catch (e) {
        logger.error(`[executeWorkflow] Workflow failed: ${e.message}`);
        throw e;
    }
}

// ==================== CORS ====================

export const setCorsHeaders = (response) => {
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    return response;
};

export const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};
