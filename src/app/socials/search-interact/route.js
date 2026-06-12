import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
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
    executeWorkflow
} from '../_shared/routeHelper.js';
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus } from '../_shared/hubUpdater.js';
import { fetchTaskData, updateTaskRow } from './routeHelper.js';

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '2', 10);
const activeTasks = new Map();
logger.info(`[Search Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

export { processTask as processSearchInteractTask };

// ==================== Action-to-Limit Mapping ====================

const ACTION_LIMIT_MAP = {
    "like": "likesOnPost",
    "comment": "commentOnPost",
    "follow": "follow",
    "unfollow": "unfollow",
    "message": "coldMessage",
    "likeComment": "likesOnComment",
    "likeStory": "likeOnStory",
    "commentStory": "commentOnStory",
    "commentComment": "commentOnComment",
};

function mapOperationToActions(operation) {
    if (operation === "search-interact") return ["like", "comment", "follow"];
    if (operation === "page-interact") return ["like", "follow"];
    if (operation === "inbox-interact") return ["message"];
    if (operation === "activities-interact") return ["like", "comment"];
    return ["like"];
}

// ==================== Task Processing ====================

async function processTask(taskRow, columnIndexes) {
    const taskId = taskRow[columnIndexes['taskId']];
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];

    try {
        logger.info(`[processTask] Starting task: ${taskId}`);

        const platform = taskRow[columnIndexes['platform']]?.toLowerCase();
        const operation = taskRow[columnIndexes['operation']]?.toLowerCase();
        const keyword = taskRow[columnIndexes['searchQuery']];
        const cookieJSON = taskRow[columnIndexes['cookieJSON']];
        const profileId = taskRow[columnIndexes['profileId']] || taskRow[columnIndexes['accountId']] || null;
        const socialStrategyPrompt = taskRow[columnIndexes['socialStrategyPrompt']] || null;

        if (!platform) throw new Error("Platform not specified");
        if (!operation) throw new Error("Operation not specified");
        if (!cookieJSON) throw new Error("No cookies found. Must login first via social/cookie/cookie-api-login");

        // Check platform limits for all likely actions
        const actions = mapOperationToActions(operation);
        for (const action of actions) {
            const limit = await checkActionAllowed(platform, action, {});
            if (!limit.allowed) {
                throw new Error(`Action '${action}' blocked by platform limits: ${limit.reason}`);
            }
        }

        const platformConfig = getPlatformConfig(platform);
        ({ browser, page } = await launchBrowserWithSession(cookieJSON));

        const workflow = getWorkflow(platform, operation);
        
        const context = {
            platform,
            operation,
            keyword,
            platformConfig,
            socialStrategyPrompt,
        };

        const workflowResults = await executeWorkflow(page, workflow, context, platformConfig, MultiProviderAI);

        if (workflow.extract) {
            const extractor = getExtractor(platform, workflow.extract);
            if (extractor && extractor.parseFunction) {
                try {
                    const parseFunc = new Function('items', extractor.parseFunction);
                    const elements = await page.$$(extractor.selector);
                    results = parseFunc(elements);
                    logger.info(`[processTask] Extracted ${results.length} items`);
                } catch (e) {
                    logger.error(`[processTask] Extraction failed: ${e.message}`);
                    results = [];
                }
            }
        }

        finalStatus = "COMPLETED";

        // Update hub interaction usage if profileId is available
        if (profileId && finalStatus === "COMPLETED") {
            for (const action of actions) {
                await updateAccountUsage(profileId, ACTION_LIMIT_MAP[action] || action);
            }
        }

        logger.info(`[processTask] Task ${taskId} completed successfully`);

    } catch (error) {
        logger.error(`[processTask] Task ${taskId} failed: ${error.message}`);
        finalStatus = "FAILED";
        results = [{ error: error.message, timestamp: new Date().toISOString() }];

        // Mark account as rate limited if limits were hit
        if (error.message.includes("blocked by platform limits") && taskRow[columnIndexes['profileId']]) {
            await updateAccountStatus(taskRow[columnIndexes['profileId']], "RATE_LIMITED");
        }
    } finally {
        if (page) {
            try { await page.close(); } catch (e) { logger.warn(`[processTask] Error closing page: ${e.message}`); }
        }
        if (browser) {
            try { await browser.close(); } catch (e) { logger.warn(`[processTask] Error closing browser: ${e.message}`); }
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
