import { NextResponse } from "next/server";
import logger from "../../../utils/logger.js";
import {
    getPlatformConfig,
    getWorkflow,
    getAIPrompt,
    getExtractor,
    MultiProviderAI
} from "./platforms.js";
import {
    getColumnIndexes,
    DOMHelpers,
    setCorsHeaders,
    launchBrowserWithSession,
    resolveSocialSession,
    executeWorkflow
} from '../_shared/routeHelper.js';
import workflowOps from '../_shared/workflowOps.js';

const { normalizeWorkflowOp, resolveWorkflowOps, pickWorkflowKey } = workflowOps;
import limitsCore from '../_shared/limitsCore.js';
const { operationConsumes, baseActionsForOperation, actionsForExecutedKeys, toLimitActions } = limitsCore;
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { resolveAccountGate, accountGateError } from '../_shared/accountGate.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus } from '../_shared/hubUpdater.js';
import { fetchTaskData, updateTaskRow } from './routeHelper.js';
import { requireFeature } from '../../../utils/featureGate.js';

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '2', 10);
const activeTasks = new Map();
logger.info(`[Search Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

export { processTask as processSearchInteractTask };

const RAW_OP_ACTIONS = {
    followuser: ["follow"],
    followfromsuggested: ["follow"],
    unfollowuser: ["unfollow"],
    interactwithpost: ["like", "comment"],
    interactwithvideo: ["like", "comment"],
    interactwithprofile: ["like"],
    engagewithnotifications: ["like", "comment"],
    followback: ["follow"],
    sendmessage: ["message"],
};

function mapOperationToActions(operation) {
    const raw = String(operation == null ? '' : operation).trim();
    if (raw.includes(',')) {
        const union = [];
        for (const seg of raw.split(',')) {
            for (const a of mapOperationToActions(seg.trim())) {
                if (!union.includes(a)) union.push(a);
            }
        }
        return union;
    }
    const op = raw.toLowerCase();
    if (op === "search-interact") return ["like", "comment", "follow"];
    if (op === "page-interact") return ["like", "follow"];
    if (op === "inbox-interact") return ["message"];
    if (op === "activities-interact") return ["like", "comment"];
    if (RAW_OP_ACTIONS[op]) return [...RAW_OP_ACTIONS[op]];
    return ["like"];
}

// ==================== Task Processing ====================

async function processTask(taskRow, columnIndexes) {
    // The sheet scheduler calls processTask(row, columnIndexes); the campaign
    // executor calls handler(taskPayload) with a plain object. Normalize both
    // shapes to a field getter.
    const get = (columnIndexes && typeof columnIndexes === 'object')
        ? (key => taskRow[columnIndexes[key]])
        : (key => (taskRow ? taskRow[key] : undefined));
    const taskId = get('taskId');
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];

    try {
        logger.info(`[processTask] Starting task: ${taskId}`);

        const platform = get('platform')?.toLowerCase();
        const operationRaw = get('operation') || "";
        const operation = operationRaw.toLowerCase();
        const keyword = get('searchQuery');
        const cookieJSON = get('cookieJSON');
        const profileId = get('profileId') || get('accountId') || null;
        const socialStrategyPrompt = get('socialStrategyPrompt') || null;

        if (!platform) throw new Error("Platform not specified");
        if (!operation) throw new Error("Operation not specified");
        if (!cookieJSON) throw new Error("No cookies found. Must login first via social/cookie/cookie-api-login");

        const engagementMode = get('engagementMode') === true || String(get('engagementMode') || '').toLowerCase() === 'true';
        const platformConfig = getPlatformConfig(platform);

        // ACCOUNT-tier status gate — RATE_LIMITED blocks until windows roll
        // (auto-recover), CANCELLED always blocks. Runs before any launch.
        const statusGate = await resolveAccountGate(profileId, platform);
        if (statusGate.blocked) throw accountGateError(profileId, statusGate);

        // PLATFORM×ACCOUNT quota gate — only when this task actually performs
        // consuming actions (read/scrape runs never touch quota).
        const consumes = operationConsumes(operationRaw, engagementMode);
        if (consumes) {
            const baseActions = engagementMode
                ? actionsForExecutedKeys([pickWorkflowKey(['interactWithVideo', 'interactWithPost'], platformConfig.workflows)].filter(Boolean), operationRaw)
                : baseActionsForOperation(operationRaw);
            const gateActions = toLimitActions(baseActions);
            const accountUsageData = profileId ? await getAccountUsage(profileId) : null;
            const accountUsage = accountUsageData?.interactionUsage || {};
            for (const action of gateActions) {
                const limit = await checkActionAllowed(platform, action, accountUsage);
                if (!limit.allowed) {
                    throw new Error(`Action '${action}' blocked by platform limits: ${limit.reason}`);
                }
            }
        }

        // Hybrid session: use Drive profile + identity if available
        let profileDir = null;
        try {
            let browserIdentity = null;
            let driveUrl = '';
            let resolvedProfileId = profileId;
            try { browserIdentity = get('browserIdentity') || null; } catch (_) {}
            try { driveUrl = get('driveUrl') || ''; } catch (_) {}
            try { resolvedProfileId = get('profileId') || get('accountId') || profileId; } catch (_) {}

            const sessionResult = await resolveSocialSession({
                cookies: cookieJSON,
                browserIdentity,
                driveUrl,
                profileId: resolvedProfileId,
                platform,
            });
            browser = sessionResult.browser;
            page = sessionResult.page;
            profileDir = sessionResult.profileDir;
        } catch (e) {
            // Fallback to cookie-only if resolveSocialSession fails
            ({ browser, page } = await launchBrowserWithSession(cookieJSON));
        }

        let workflowKeys;
        if (engagementMode) {
            const base = pickWorkflowKey(['search'], platformConfig.workflows);
            const engage = pickWorkflowKey(['interactWithVideo', 'interactWithPost'], platformConfig.workflows);
            workflowKeys = [base, engage].filter(Boolean);
            logger.info(`[processTask] ${taskId}: engagement chain candidates resolved to [${workflowKeys.join(', ')}]`);
        }
        if (!workflowKeys || workflowKeys.length === 0) {
            workflowKeys = resolveWorkflowOps(operationRaw, platformConfig.workflows);
        }
        if (workflowKeys.length === 0) throw new Error(`No workflow resolved for operation: ${operationRaw}`);
        const workflows = workflowKeys.map(key => getWorkflow(platform, key));

        const context = {
            platform,
            operation,
            keyword,
            platformConfig,
            socialStrategyPrompt,
        };

        let workflowResults = {};
        for (const workflow of workflows) {
            Object.assign(workflowResults, await executeWorkflow(page, workflow, context, platformConfig, MultiProviderAI));
            if (workflow.extract) {
                const extractor = getExtractor(platform, workflow.extract);
                if (extractor && extractor.parseFunction) {
                    try {
                        // parseFunction is browser-context code (item.querySelector),
                        // so it must run inside the page via $$eval — running it on
                        // Node ElementHandles always threw and extraction returned [].
                        const parseFunc = new Function('items', 'return (' + extractor.parseFunction + '\n)(items);');
                        const extracted = await page.$$eval(extractor.selector, parseFunc);
                        if (Array.isArray(extracted)) results.push(...extracted);
                        logger.info(`[processTask] Extracted ${Array.isArray(extracted) ? extracted.length : 0} items after '${workflow.name}'`);
                    } catch (e) {
                        logger.error(`[processTask] Extraction failed: ${e.message}`);
                    }
                }
            }
        }

        finalStatus = "COMPLETED";

        // Update hub interaction usage if profileId is available — only the
        // actions actually performed by the executed workflow keys, and only
        // for consuming tasks (read-only runs must not burn quota).
        if (profileId && finalStatus === "COMPLETED") {
            const performedActions = consumes
                ? toLimitActions(actionsForExecutedKeys(workflowKeys, operationRaw))
                : [];
            for (const action of performedActions) {
                await updateAccountUsage(profileId, action);
            }
        }

        logger.info(`[processTask] Task ${taskId} completed successfully`);

    } catch (error) {
        logger.error(`[processTask] Task ${taskId} failed: ${error.message}`);
        finalStatus = "FAILED";
        results = [{ error: error.message, timestamp: new Date().toISOString() }];

        // Mark account as rate limited if limits were hit
        if (error.message.includes("blocked by platform limits") && get('profileId')) {
            await updateAccountStatus(get('profileId'), "RATE_LIMITED");
        }
    } finally {
        if (page) {
            try { await page.close(); } catch (e) { logger.warn(`[processTask] Error closing page: ${e.message}`); }
        }
        if (browser) {
            try { await browser.close(); } catch (e) { logger.warn(`[processTask] Error closing browser: ${e.message}`); }
        }
        if (profileDir) {
            const fs = await import('fs-extra');
            await fs.remove(profileDir).catch(() => {});
        }

        try {
            await updateTaskRow(taskId, {
                status: finalStatus,
                resultCount: results.length,
                lastResult: JSON.stringify(results[results.length - 1] || { status: finalStatus }),
                completedAt: new Date().toISOString()
            });
            logger.info(`[processTask] Updated task: ${taskId} -> ${finalStatus}`);
        } catch (updateError) {
            logger.error(`[processTask] Error updating task row: ${updateError.message}`);
        }

        activeTasks.delete(taskId);
    }

    return { taskId, status: finalStatus, resultCount: results.length };
}

// ==================== API Handlers ====================

export async function POST(request) {
    try {
        const gate = await requireFeature('allowInteraction', 'social interaction');
        if (gate) return gate;
        const body = await request.json();
        const { action, taskId } = body;

        logger.info(`[POST] Received: action=${action}`);

        // Status check (from social-tasks sheet)
        if (action === 'status' && taskId) {
            const taskData = await fetchTaskData(true);
            const headers = taskData[0];
            const columnIndexes = getColumnIndexes(headers);
            const row = taskData.slice(1).find(r => r[columnIndexes['taskId']] === taskId);

            if (row) {
                return setCorsHeaders(NextResponse.json({
                    taskId,
                    status: row[columnIndexes['status']],
                    lastResult: row[columnIndexes['lastResult']],
                    completedAt: row[columnIndexes['completedAt']],
                    resultCount: row[columnIndexes['resultCount']]
                }));
            }
            return setCorsHeaders(NextResponse.json({ error: "Task not found" }, { status: 404 }));
        }

        // Batch process pending tasks from social-tasks sheet (legacy)
        if (action === 'process') {
            const taskData = await fetchTaskData(true);
            const headers = taskData[0];
            const columnIndexes = getColumnIndexes(headers);
            const pendingTasks = taskData.slice(1).filter(r => r[columnIndexes['status']] === 'PENDING');

            logger.info(`[POST] Found ${pendingTasks.length} pending tasks`);

            const results = [];
            for (const taskRow of pendingTasks) {
                if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
                    logger.warn(`[POST] Reached concurrency limit`);
                    break;
                }

                const tid = taskRow[columnIndexes['taskId']];
                activeTasks.set(tid, true);

                processTask(taskRow, columnIndexes).catch(e => {
                    logger.error(`[POST] Uncaught error in task ${tid}: ${e.message}`);
                });

                results.push({ taskId: tid, status: "PROCESSING" });
            }

            return setCorsHeaders(NextResponse.json({
                message: "Tasks queued for processing",
                tasksQueued: results.length,
                tasks: results
            }));
        }

        // Direct execution (new - called from execute-campaign, no social-tasks sheet)
        if (action === 'execute') {
            const { task } = body;
            if (!task) {
                return setCorsHeaders(NextResponse.json({ error: "Missing task payload" }, { status: 400 }));
            }

            const taskId = task.taskId || ("direct-" + Math.random().toString(36).substring(2, 11));
            const headers = Object.keys(task);
            const columnIndexes = getColumnIndexes(headers);
            const taskRow = headers.map(h => task[h] !== undefined ? task[h] : '');

            // Enrich the task row with headers for processTask compatibility
            const enrichedTaskRow = [];
            for (const h of headers) {
                enrichedTaskRow[columnIndexes[h]] = task[h];
            }

            if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
                return setCorsHeaders(NextResponse.json({ error: "Concurrency limit reached" }, { status: 429 }));
            }

            activeTasks.set(taskId, true);
            const result = await processTask(enrichedTaskRow, columnIndexes);

            return setCorsHeaders(NextResponse.json({
                message: "Task executed",
                task: result
            }));
        }

        return setCorsHeaders(NextResponse.json({ error: "Invalid action" }, { status: 400 }));

    } catch (e) {
        logger.error(`[POST] Error: ${e.message}`);
        return setCorsHeaders(NextResponse.json({ error: e.message }, { status: 500 }));
    }
}

export async function OPTIONS(request) {
    return new Response(null, {
        status: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        },
    });
}
