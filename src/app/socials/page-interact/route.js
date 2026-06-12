import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
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
    executeWorkflow,
    DOMHelpers,
} from '../_shared/routeHelper.js';
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';

export { processTask as processPageInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '2', 10);
const activeTasks = new Map();
logger.info(`[Page Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

const ACTION_LIMIT_MAP = {
    "follow": "follow",
    "unfollow": "unfollow",
    "like": "likesOnPost",
};

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    const taskId = taskPayload.taskId || ("page-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operation = (taskPayload.operation || "scrapeProfile").toLowerCase();
        const keyword = taskPayload.searchQuery || taskPayload.targetUsername || "";
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;
        const socialStrategyPrompt = taskPayload.socialStrategyPrompt || null;

        logger.info(`[processTask] ${taskId}: ${platform}/${operation} keyword=${keyword}`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");

        // Check limits
        const relevantActions = ["follow", "unfollow", "like"];
        for (const action of relevantActions) {
            const check = await checkActionAllowed(platform, ACTION_LIMIT_MAP[action] || action, {});
            if (!check.allowed) {
                logger.warn(`[processTask] ${action} blocked: ${check.reason}`);
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

        // Extract results
        if (workflow.extract) {
            const extractor = getExtractor(platform, workflow.extract);
            if (extractor && extractor.parseFunction) {
                try {
                    const parseFunc = new Function('items', extractor.parseFunction);
                    const elements = await page.$$(extractor.selector);
                    results = parseFunc(elements);
                } catch (e) {
                    logger.error(`[processTask] Extraction failed: ${e.message}`);
                    results = [];
                }
            }
        }

        finalStatus = "COMPLETED";

        // Update hub usage
        if (profileId) {
            const performedActions = [];
            if (operation === "followUser" || operation === "followFromSuggested") performedActions.push("follow");
            if (operation === "unfollowUser") performedActions.push("unfollow");
            if (operation === "interactWithProfile") performedActions.push("like");

            for (const action of performedActions) {
                await updateAccountUsage(profileId, ACTION_LIMIT_MAP[action] || action);
            }

            await updateAccountInteractionData(profileId, {
                lastOperation: operation,
                lastTarget: keyword,
                lastRun: new Date().toISOString(),
                status: "ACTIVE",
            });
        }

        logger.info(`[processTask] ${taskId} completed: ${finalStatus}`);

    } catch (error) {
        logger.error(`[processTask] ${taskId} failed: ${error.message}`);
        finalStatus = "FAILED";
        results = [{ error: error.message }];

        if (error.message.includes("blocked by platform limits") && taskPayload.profileId) {
            await updateAccountStatus(taskPayload.profileId, "RATE_LIMITED");
        }
    } finally {
        if (page) { try { await page.close(); } catch (e) {} }
        if (browser) { try { await browser.close(); } catch (e) {} }
        activeTasks.delete(taskId);
    }

    return { taskId, status: finalStatus, resultCount: results.length, results };
}

export async function POST(request) {
    try {
        const body = await request.json();
        const { action, task } = body;

        logger.info(`[POST] action=${action}`);

        if (action === 'execute') {
            if (!task) {
                return setCorsHeaders(NextResponse.json({ error: "Missing task payload" }, { status: 400 }));
            }

            if (activeTasks.size >= MAX_CONCURRENT_TASKS) {
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
