import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import {
    getPlatformConfig,
    getWorkflow,
    getExtractor,
    MultiProviderAI
} from "./platforms.js";
import {
    setCorsHeaders,
    launchBrowserWithSession,
    resolveSocialSession,
    executeWorkflow,
    DOMHelpers,
} from '../_shared/routeHelper.js';
import workflowOps from '../_shared/workflowOps.js';

const { normalizeWorkflowOp, resolveWorkflowOps, pickWorkflowKey } = workflowOps;
import limitsCore from '../_shared/limitsCore.js';
const { operationConsumes, baseActionsForOperation, actionsForExecutedKeys, toLimitActions } = limitsCore;
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { requireFeature } from '../../../utils/featureGate.js';
import { getMaxConcurrentTasks, getMaxConcurrentTasksSync } from '../../../utils/campaignConcurrency.js';
import { resolveAccountGate, accountGateError } from '../_shared/accountGate.js';
import { getAccountUsage, consumeAccountActions, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';
import { runActivitiesInteract, supportsActivitiesRunner, activitiesActionForOperation } from './routeHelper.js';
import { getPlatformHelper } from './platformHelper/index.js';
import { probeSocialPlatform } from '../_shared/probeRunner.js';

export { processTask as processActivitiesInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

// Fallback only — live ceiling is SETTINGS MAX_CONCURRENT_TASKS (campaignConcurrency.js).
const MAX_CONCURRENT_TASKS = getMaxConcurrentTasksSync();
const activeTasks = new Map();
logger.info(`[Activities Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS} (settings-driven)`);

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    // Verified actions across every workflow iteration in this task.
    const quota = {};
    let profileDir = null;
    let runnerAccounted = false;
    const taskId = taskPayload.taskId || ("act-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operationRaw = String(taskPayload.operation || "readNotifications");
        const operation = operationRaw.toLowerCase();
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;
        // Batch mode: searchQueries array (optional; activities often have no
        // per-keyword targets — falls back to single searchQuery or empty).
        let searchQueries = [];
        if (Array.isArray(taskPayload.searchQueries) && taskPayload.searchQueries.length > 0) {
            searchQueries = taskPayload.searchQueries.map(q => String(q || '').trim()).filter(Boolean);
        } else if (taskPayload.searchQuery) {
            searchQueries = [String(taskPayload.searchQuery).trim()].filter(Boolean);
        }

        logger.info(`[processTask] ${taskId}: ${platform}/${operation} queries=${searchQueries.length}`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");

        const engagementMode = taskPayload.engagementMode === true || String(taskPayload.engagementMode || "").toLowerCase() === "true";
        const platformConfig = getPlatformConfig(platform);

        // ACCOUNT-tier status gate — RATE_LIMITED blocks until windows roll,
        // CANCELLED always blocks. Before any browser launch.
        const statusGate = await resolveAccountGate(profileId, platform);
        if (statusGate.blocked) throw accountGateError(profileId, statusGate);

        // PLATFORM×ACCOUNT quota gate — read-only notification reads never
        // gate; engagement/explicit ops block before launch when over quota.
        const consumes = operationConsumes(operationRaw, engagementMode);
        if (consumes) {
            let baseActions;
            if (engagementMode) {
                const engageKey = pickWorkflowKey(["engageWithNotifications", "followBack"], platformConfig.workflows);
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

        const useRunner = supportsActivitiesRunner(platform) && !!activitiesActionForOperation(operationRaw, engagementMode);
        if (useRunner) {
            const run = await runActivitiesInteract({
                page,
                platform,
                profileId,
                taskId,
                operation: operationRaw,
                engagementMode,
                messageText: taskPayload.messageText || taskPayload.commentText || "",
                stopAfterHours: Number(taskPayload.stopAfterHours) || 0,
                maxEngagements: Number(taskPayload.maxEngagements) || 20,
            });
            for (const [k, v] of Object.entries(run.quota || {})) {
                if (k === "total") continue;
                quota[k] = (quota[k] || 0) + (Number(v) || 0);
            }
            results.push(...(run.results || []));
            runnerAccounted = true;
            if (run.stopType) logger.info(`[processTask] ${taskId}: runner stopped (${run.stopType})`);
        }

        let handledIterations = 0;
        if (!useRunner) {
            let workflowKeys;
            if (engagementMode) {
                const engage = pickWorkflowKey(["engageWithNotifications", "followBack"], platformConfig.workflows);
                if (engage) workflowKeys = [engage];
                logger.info(`[processTask] ${taskId}: engagement workflow resolved to [${(workflowKeys || []).join(', ')}]`);
            }
            if (!workflowKeys || workflowKeys.length === 0) {
                workflowKeys = resolveWorkflowOps(operationRaw, platformConfig.workflows);
            }
            if (workflowKeys.length === 0) throw new Error(`No workflow resolved for operation: ${operationRaw}`);
            const workflows = workflowKeys.map(key => getWorkflow(platform, key));

            // ---- Single-session batch: loop in ONE browser session ----
            // Activities workflows are notification-centric (no per-keyword loop
            // needed), but when searchQueries are provided we iterate them (e.g.
            // multiple notification filters) without reopening the browser.
            const queryLoop = searchQueries.length > 0 ? searchQueries : [null];
            for (const kw of queryLoop) {
                const context = {
                    platform,
                    operation,
                    keyword: kw || undefined,
                    platformConfig,
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
                                if (Array.isArray(extracted)) results.push(...extracted.map(e => ({ ...e, keyword: kw || undefined })));
                            } catch (e) {
                                logger.error(`[processTask] Extraction failed: ${e.message}`);
                            }
                        }
                    }
                }
                handledIterations++;
            }
        }

        finalStatus = "COMPLETED";

        if (profileId) {
            // The DOM runner already consumed each verified action.
            const counted = runnerAccounted ? {} : await consumeAccountActions(profileId, quota);
            if (Object.keys(counted).length) {
                logger.info(`[processTask] ${taskId}: counted verified actions ${JSON.stringify(counted)}`);
            }

            await updateAccountInteractionData(profileId, {
                lastOperation: operation,
                lastRun: new Date().toISOString(),
                results: results.length,
                status: "ACTIVE",
            });
        }

        logger.info(`[processTask] ${taskId} completed: ${finalStatus} (${handledIterations} iterations)`);

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

            const tid = task.taskId || ("act-" + Math.random().toString(36).substring(2, 11));
            activeTasks.set(tid, true);

            const result = await processTask(task);

            return setCorsHeaders(NextResponse.json({
                message: "Activities task executed",
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
                mode: body.mode || task.probeMode || "notifications",
            });
            return setCorsHeaders(NextResponse.json({ message: "Probe complete", probe }));
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
