import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import {
    getPlatformConfig,
    getWorkflow,
    getExtractor,
    MultiProviderAI
} from "./platforms.js";
import {
    getColumnIndexes,
    setCorsHeaders,
    launchBrowserWithSession,
    resolveSocialSession,
    executeWorkflow,
    DOMHelpers,
} from '../_shared/routeHelper.js';
import workflowOps from '../_shared/workflowOps.js';

const { normalizeWorkflowOp, resolveWorkflowOps, pickWorkflowKey } = workflowOps;
import { requireFeature } from '../../../utils/featureGate.js';
import { getMaxConcurrentTasks, getMaxConcurrentTasksSync } from '../../../utils/campaignConcurrency.js';
import limitsCore from '../_shared/limitsCore.js';
const { operationConsumes, baseActionsForOperation, actionsForExecutedKeys, toLimitActions } = limitsCore;
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { resolveAccountGate, accountGateError } from '../_shared/accountGate.js';
import { getAccountUsage, consumeAccountActions, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';
import { runPageInteract, supportsPageRunner, pageActionForOperation } from './routeHelper.js';
import { getPlatformHelper } from './platformHelper/index.js';
import { probeSocialPlatform } from '../_shared/probeRunner.js';

export { processTask as processPageInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

// Fallback only — live ceiling is SETTINGS MAX_CONCURRENT_TASKS (campaignConcurrency.js).
const MAX_CONCURRENT_TASKS = getMaxConcurrentTasksSync();
const activeTasks = new Map();
logger.info(`[Page Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS} (settings-driven)`);

// ---- People Search discovery (tag-first, no CSV required) ----
// Mirrors search-interact's searchResults: navigate to the platform people
// search, type the tag, then collect profile handles via the platform
// `people` extractor (falls back to generic link scan when the platform has
// no extractor yet — e.g. FB/IG/Quora/YT/Reddit/Threads page configs).
async function discoverPeopleHandles(page, platformConfig, tags, maxPerTag = 5) {
    const s = platformConfig.selectors || {};
    const found = new Map();
    for (const tag of tags) {
        const url = platformConfig.searchUrl || platformConfig.profileUrl;
        if (!url) continue;
        const q = String(tag || '').trim().replace(/^#/, '');
        if (!q) continue;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
        if (s.searchBox) {
            await page.click(s.searchBox, { timeout: 4000 }).catch(() => {});
            await page.keyboard.down('Control').catch(() => {});
            const keys = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(keys).catch(() => {});
            await page.keyboard.press('a').catch(() => {});
            await page.keyboard.up('Control').catch(() => {});
            await page.keyboard.up(keys).catch(() => {});
            await page.keyboard.type(q, { delay: 10 }).catch(() => {});
        }
        if (s.searchSubmit) await page.click(s.searchSubmit, { timeout: 2000 }).catch(() => {});
        await page.keyboard.press('Enter').catch(() => {});
        await new Promise(r => setTimeout(r, 2500));
        // Prefer People/Users tab when available (TikTok/X/IG/FB expose it).
        if (s.peopleTab) await page.click(s.peopleTab, { timeout: 2000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 1200));
        let items = [];
        const ext = platformConfig.extractors?.people;
        if (ext?.selector && ext?.parseFunction) {
            try {
                const parseFunc = new Function('items', 'return (' + ext.parseFunction + '\n)(items);');
                items = await page.$$eval(ext.selector, parseFunc).catch(() => []);
            } catch (e) { logger.warn(`[discover] extractor failed (${q}): ${e.message}`); items = []; }
        }
        if (!items.length) {
            // Generic fallback: scan visible profile-ish links for this platform.
            items = await page.evaluate(() => {
                const out = [];
                const seen = new Set();
                for (const a of document.querySelectorAll('a[href]')) {
                    const href = a.getAttribute('href') || '';
                    const u = href.match(/\/(?:@)?([A-Za-z0-9_.]+)\/?(?:\?.*)?$/);
                    if (!u || /search|explore|notifications|home|login|signup/i.test(href)) continue;
                    const handle = (u[1] || '').replace(/^@+/, '');
                    if (!handle || seen.has(handle)) continue;
                    seen.add(handle);
                    out.push({ username: handle, url: a.href });
                    if (out.length >= 30) break;
                }
                return out;
            }).catch(() => []);
        }
        for (const it of (items || []).slice(0, maxPerTag)) {
            const h = String(it?.username || it?.handle || '').trim().replace(/^@+/, '');
            if (h && !found.has(h)) found.set(h, { username: h, url: it?.url || '', tag: q });
            if (found.size >= 50) break;
        }
        logger.info(`[discover] tag "${q}": +${(items || []).length} people`);
    }
    return [...found.values()];
}

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    // Verified actions across every handle/workflow in this task.
    const quota = {};
    let profileDir = null;
    let runnerAccounted = false;
    const taskId = taskPayload.taskId || ("page-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operationRaw = String(taskPayload.operation || "scrapeProfile");
        const operation = operationRaw.toLowerCase();
        // Batch mode: searchQueries array carries ALL target handles.
        // People Search discovery (no CSV): `tags`/`discoveryTags`/
        // `peopleTags`/`discoveryKeywords` carry tags to search people for.
        // When present, handles list may be empty (front-end no-CSV path).
        let searchQueries = [];
        const discoveryMode = taskPayload.discoveryMode === true
            || String(taskPayload.discoveryMode || '').toLowerCase() === 'true'
            || !!taskPayload.tags || !!taskPayload.discoveryTags || !!taskPayload.peopleTags || !!taskPayload.discoveryKeywords;
        let discoveryTags = [];
        const rawTags = taskPayload.tags || taskPayload.discoveryTags || taskPayload.peopleTags || taskPayload.discoveryKeywords || [];
        if (Array.isArray(rawTags) && rawTags.length > 0) discoveryTags = rawTags.map(q => String(q || '').trim()).filter(Boolean);
        else if (discoveryMode && Array.isArray(taskPayload.searchQueries) && taskPayload.searchQueries.length > 0 && !taskPayload.targets) discoveryTags = taskPayload.searchQueries.map(q => String(q || '').trim()).filter(Boolean);
        if (Array.isArray(taskPayload.targets) && taskPayload.targets.length > 0) {
            searchQueries = taskPayload.targets.map(q => String(q || '').trim().replace(/^@+/, '')).filter(Boolean);
        } else if (Array.isArray(taskPayload.searchQueries) && taskPayload.searchQueries.length > 0 && !discoveryTags.length) {
            searchQueries = taskPayload.searchQueries.map(q => String(q || '').trim().replace(/^@+/, '')).filter(Boolean);
        } else {
            const single = String(taskPayload.searchQuery || taskPayload.targetUsername || "").trim().replace(/^@+/, "");
            if (single && !discoveryTags.length) searchQueries = [single];
        }
        // When discoveryTags cover the task (no CSV), searchQueries doubles as tags
        // only if no explicit handle list was given.
        if (!searchQueries.length && discoveryTags.length) {
            // discovery populates handles below — keep searchQueries empty here.
        }
        const keyword = searchQueries[0] || discoveryTags[0] || "";
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;
        const socialStrategyPrompt = taskPayload.socialStrategyPrompt || null;

        logger.info(`[processTask] ${taskId}: ${platform}/${operation} handles=${searchQueries.length} discoveryTags=${discoveryTags.length} [${(searchQueries.length ? searchQueries : discoveryTags).slice(0, 3).join(', ')}${(searchQueries.length ? searchQueries : discoveryTags).length > 3 ? '...' : ''}]`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");
        if (!searchQueries.length && !discoveryTags.length) throw new Error("No target handles or discovery tags provided");

        const engagementMode = taskPayload.engagementMode === true || String(taskPayload.engagementMode || "").toLowerCase() === "true";
        const platformConfig = getPlatformConfig(platform);

        // ACCOUNT-tier status gate — RATE_LIMITED blocks until windows roll,
        // CANCELLED always blocks. Before any browser launch.
        const statusGate = await resolveAccountGate(profileId, platform);
        if (statusGate.blocked) throw accountGateError(profileId, statusGate);

        // PLATFORM×ACCOUNT quota gate — only for consuming tasks (engagement
        // or explicit follow/unfollow ops); read-only scrape never gates.
        const consumes = operationConsumes(operationRaw, engagementMode);
        if (consumes) {
            let baseActions;
            if (engagementMode) {
                const engageKey = pickWorkflowKey(["followUser", "interactWithProfile"], platformConfig.workflows);
                baseActions = actionsForExecutedKeys(engageKey ? [engageKey] : [], operationRaw);
            } else {
                baseActions = baseActionsForOperation(operationRaw);
            }
            const gateActions = toLimitActions(baseActions);
            const accountUsageData = profileId ? await getAccountUsage(profileId) : null;
            const accountUsage = accountUsageData?.interactionUsage || {};
            for (const action of gateActions) {
                const check = await checkActionAllowed(platform, action, accountUsage);
                if (!check.allowed) {
                    throw new Error(`Action '${action}' blocked by platform limits: ${check.reason}`);
                }
            }
        }

        // Hybrid session: use Drive profile + identity if available
        try {
            const sessionResult = await resolveSocialSession({
                cookies: cookieJSON,
                browserIdentity: taskPayload.browserIdentity || null,
                driveUrl: taskPayload.driveUrl || "",
                profileId,
                platform,
            });
            browser = sessionResult.browser;
            page = sessionResult.page;
            profileDir = sessionResult.profileDir;
        } catch (e) {
            ({ browser, page } = await launchBrowserWithSession(cookieJSON));
        }

        // Preferred path: per-platform DOM runner with verified accounting.
        // Falls back to the legacy workflow engine for read-only operations and
        // platforms without a helper.
        const useRunner = supportsPageRunner(platform) && !!pageActionForOperation(operationRaw, engagementMode);
        let runnerStop = null;

        // People Search discovery — populates handles when no CSV is given.
        // Chain: list → discovery → activities (see fallback below).
        const doDiscovery = async (exclude) => {
            const discMax = Number(taskPayload.maxDiscoveryPerTag || taskPayload.maxResultsPerKeyword || 5);
            const discovered = await discoverPeopleHandles(page, platformConfig, discoveryTags, discMax);
            const fresh = discovered.filter(d => !exclude.has(d.username.toLowerCase()));
            if (!fresh.length) { logger.info(`[processTask] ${taskId}: discovery found 0 new profiles for ${discoveryTags.length} tag(s)`); return []; }
            logger.info(`[processTask] ${taskId}: discovery found ${fresh.length} profile(s) for ${discoveryTags.length} tag(s)`);
            return fresh;
        };
        let effectiveHandles = searchQueries;
        const discoveredHandlesRef = { discovered: [] };
        if (useRunner && discoveryTags.length && !searchQueries.length) {
            const fresh = await doDiscovery(new Set());
            effectiveHandles = fresh.map(d => d.username);
            discoveredHandlesRef.discovered = fresh;
            logger.info(`[processTask] ${taskId}: discovery mode (no CSV) — ${effectiveHandles.length} handle(s) from People Search`);
        }

        if (useRunner) {
            const messageText = taskPayload.messageText || taskPayload.commentText || taskPayload.comment || "";
            const doneHandles = new Set();
            for (const kw of effectiveHandles) {
                const run = await runPageInteract({
                    page,
                    platform,
                    profileId,
                    campaignId: taskPayload.campaignId || taskPayload.campaign || null,
                    taskId,
                    handles: [kw],
                    operation: operationRaw,
                    engagementMode,
                    messageText,
                    stopAfterHours: Number(taskPayload.stopAfterHours) || 0,
                });
                for (const [k, v] of Object.entries(run.quota || {})) {
                    if (k === "total") continue;
                    quota[k] = (quota[k] || 0) + (Number(v) || 0);
                }
                results.push(...(run.results || []).map(r => ({ ...r, keyword: kw })));
                doneHandles.add(String(kw).toLowerCase());
                if (run.stopType) { runnerStop = run.stopType; break; }
            }
            // List exhausted → People Search discovery (if tags provided) → then activities.
            const doDiscoveryFallback = taskPayload.fallbackToDiscovery !== false && taskPayload.fallbackToDiscovery !== 'false';
            if (!runnerStop && discoveryTags.length && doDiscoveryFallback) {
                const fresh = await doDiscovery(doneHandles);
                if (fresh.length) {
                    logger.info(`[processTask] ${taskId}: list done — discovering ${fresh.length} via People Search tags`);
                    for (const d of fresh) {
                        const run = await runPageInteract({
                            page,
                            platform,
                            profileId,
                            campaignId: taskPayload.campaignId || taskPayload.campaign || null,
                            taskId,
                            handles: [d.username],
                            operation: operationRaw,
                            engagementMode,
                            messageText,
                            stopAfterHours: Number(taskPayload.stopAfterHours) || 0,
                        });
                        for (const [k, v] of Object.entries(run.quota || {})) { if (k === "total") continue; quota[k] = (quota[k] || 0) + (Number(v) || 0); }
                        results.push(...(run.results || []).map(r => ({ ...r, keyword: d.username, discovered: true })));
                        doneHandles.add(d.username.toLowerCase());
                        if (run.stopType) { runnerStop = run.stopType; break; }
                    }
                }
            }
            if (runnerStop) logger.info(`[processTask] ${taskId}: runner stopped (${runnerStop})`);
            runnerAccounted = true;
            // Fallback chain: when the profile list is exhausted, keep the
            // account engaging via notifications + For You feed until quota or
            // time stops it (no idle gaps while the campaign is running).
            const fallback = taskPayload.fallbackToActivities !== false && taskPayload.fallbackToActivities !== 'false';
            const anyRemaining = searchQueries.length > 0 || discoveredHandlesRef.discovered.length > 0;
            if (fallback && anyRemaining && !runnerStop) {
                try {
                    const actHelper = await import('../activities-interact/routeHelper.js');
                    if (actHelper.supportsActivitiesRunner && actHelper.supportsActivitiesRunner(platform)) {
                        logger.info(`[processTask] ${taskId}: profile list done — falling back to activities (notifications + feed)`);
                        const actRun = await actHelper.runActivitiesInteract({
                            page, platform, profileId,
                            campaignId: taskPayload.campaignId || taskPayload.campaign || null,
                            taskId: taskId + '-fallback',
                            operation: 'engageWithNotifications',
                            engagementMode: true,
                            messageText: taskPayload.messageText || taskPayload.commentText || '',
                            stopAfterHours: Number(taskPayload.stopAfterHours) || 0,
                            maxEngagements: Number(taskPayload.maxEngagements) || 20,
                        });
                        for (const [k, v] of Object.entries(actRun.quota || {})) {
                            if (k === "total") continue;
                            quota[k] = (quota[k] || 0) + (Number(v) || 0);
                        }
                        results.push(...(actRun.results || []).map(r => ({ ...r, via: 'activities-fallback' })));
                    }
                } catch (e) {
                    logger.warn(`[processTask] ${taskId}: activities fallback failed: ${e.message}`);
                }
            }
        }

        let workflowKeys;
        if (!useRunner && engagementMode) {
            const engage = pickWorkflowKey(["followUser", "interactWithProfile"], platformConfig.workflows);
            if (engage) workflowKeys = [engage];
            logger.info(`[processTask] ${taskId}: engagement workflow resolved to [${(workflowKeys || []).join(', ')}]`);
        }
        if (!useRunner) {
            if (!workflowKeys || workflowKeys.length === 0) {
                workflowKeys = resolveWorkflowOps(operationRaw, platformConfig.workflows);
            }
            if (workflowKeys.length === 0) throw new Error(`No workflow resolved for operation: ${operationRaw}`);
            const workflows = workflowKeys.map(key => getWorkflow(platform, key));

            // People Search fallback for workflow-only platforms: discover handles
            // from tags when no CSV list was given, then run them through workflows.
            let workflowHandles = searchQueries;
            if (!workflowHandles.length && discoveryTags.length) {
                try {
                    const fresh = await discoverPeopleHandles(page, platformConfig, discoveryTags, Number(taskPayload.maxDiscoveryPerTag || taskPayload.maxResultsPerKeyword || 5));
                    workflowHandles = fresh.map(d => d.username);
                    logger.info(`[processTask] ${taskId}: discovery (workflow) found ${workflowHandles.length} profile(s)`);
                } catch (e) { logger.warn(`[processTask] ${taskId}: discovery failed: ${e.message}`); }
            }

            // ---- Single-session batch: loop ALL target handles in ONE browser ----
            for (const kw of workflowHandles) {
                const context = {
                    platform,
                    operation,
                    keyword: kw,
                    platformConfig,
                    socialStrategyPrompt,
                };

                let workflowResults = {};
                for (const workflow of workflows) {
                    const wfResult = await executeWorkflow(page, workflow, context, platformConfig, MultiProviderAI);
                    for (const [k, v] of Object.entries(wfResult.__quota || {})) {
                        quota[k] = (quota[k] || 0) + (Number(v) || 0);
                    }
                    Object.assign(workflowResults, wfResult);
                    if (workflow.extract) {
                        const extractor = getExtractor(platform, workflow.extract);
                        if (extractor && extractor.parseFunction) {
                            try {
                                const parseFunc = new Function('items', 'return (' + extractor.parseFunction + '\n)(items);');
                                const extracted = await page.$$eval(extractor.selector, parseFunc);
                                if (Array.isArray(extracted)) results.push(...extracted.map(e => ({ ...e, keyword: kw })));
                            } catch (e) {
                                logger.error(`[processTask] Extraction failed for "${kw}": ${e.message}`);
                            }
                        }
                    }
                }
            }
        }

        finalStatus = "COMPLETED";

        // Update hub usage — only actions VERIFIED after execution. The DOM
        // runner already consumed each verified action, so never double-write.
        if (profileId) {
            const counted = (consumes && !useRunner) ? await consumeAccountActions(profileId, quota) : {};
            if (Object.keys(counted).length) {
                logger.info(`[processTask] ${taskId}: counted verified actions ${JSON.stringify(counted)}`);
            }

            await updateAccountInteractionData(profileId, {
                lastOperation: operation,
                lastTarget: keyword,
                lastRun: new Date().toISOString(),
                results: results.length,
                status: "ACTIVE",
            });
        }

        logger.info(`[processTask] ${taskId} completed: ${finalStatus} (${searchQueries.length} handles)`);

    } catch (error) {
        logger.error(`[processTask] ${taskId} failed: ${error.message}`);
        finalStatus = "FAILED";
        results = [{ error: error.message }];

        // Actions verified before the failing step are still real spend.
        for (const [k, v] of Object.entries(error.quota || {})) {
            quota[k] = (quota[k] || 0) + (Number(v) || 0);
        }
        const failedPid = taskPayload.profileId || taskPayload.accountId;
        if (failedPid && Object.keys(quota).length && !runnerAccounted) {
            await consumeAccountActions(failedPid, quota).catch((qErr) => {
                logger.warn(`[processTask] ${taskId}: partial quota write failed: ${qErr.message}`);
            });
        }

        if (error.message.includes("blocked by platform limits") && taskPayload.profileId) {
            await updateAccountStatus(taskPayload.profileId, "RATE_LIMITED");
        }
    } finally {
        if (page) { try { await page.close(); } catch (e) {} }
        if (browser) { try { await browser.close(); } catch (e) {} }
        // profileDir intentionally not deleted — downloadAndExtractProfile caches it for 60 min.
        activeTasks.delete(taskId);
    }

    const quotaTotal = Object.values(quota).reduce((a, b) => a + (Number(b) || 0), 0);
    return { taskId, status: finalStatus, resultCount: results.length, results, quota: { ...quota, total: quotaTotal } };
}

export async function POST(request) {
    try {
        const gate = await requireFeature('allowInteraction', 'social interaction');
        if (gate) return gate;
        const body = await request.json();
        const { action, task } = body;
        const maxConcurrent = await getMaxConcurrentTasks();

        logger.info(`[POST] action=${action}`);

        if (action === 'execute') {
            if (!task) {
                return setCorsHeaders(NextResponse.json({ error: "Missing task payload" }, { status: 400 }));
            }

            if (activeTasks.size >= maxConcurrent) {
                return setCorsHeaders(NextResponse.json({ error: "Concurrency limit reached" }, { status: 429 }));
            }

            const tid = task.taskId || ("page-" + Math.random().toString(36).substring(2, 11));
            activeTasks.set(tid, true);

            const result = await processTask(task);

            return setCorsHeaders(NextResponse.json({
                message: "Task executed",
                task: result
            }));
        }

        if (action === 'probe') {
            if (!task) {
                return setCorsHeaders(NextResponse.json({ error: "Missing task payload" }, { status: 400 }));
            }
            const probe = await probeSocialPlatform({
                helper: getPlatformHelper(task.platform),
                taskPayload: task,
                mode: body.mode || task.probeMode,
            });
            return setCorsHeaders(NextResponse.json({ message: "Probe complete", probe }));
        }

        if (action === 'limits') {
            const { platform } = body;
            const limits = platform ? await getPlatformLimits(platform) : null;
            return setCorsHeaders(NextResponse.json({ limits }));
        }

        return setCorsHeaders(NextResponse.json({ error: "Invalid action" }, { status: 400 }));

    } catch (e) {
        logger.error(`[POST] Error: ${e.message}`);
        return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
    }
}

export async function OPTIONS() {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
