import { NextResponse } from "next/server";
import logger from "../../../../utils/logger.js";
import {
    getPlatformConfig,
    getWorkflow,
    getExtractor,
    MultiProviderAI
} from "./platforms.js";
import {
    setCorsHeaders,
    launchBrowserWithSession,
    executeWorkflow,
    DOMHelpers,
} from '../_shared/routeHelper.js';
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';

export { processTask as processActivitiesInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);
const activeTasks = new Map();
logger.info(`[Activities Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

const ACTION_LIMIT_MAP = {
    "like": "likesOnPost",
    "follow": "follow",
};

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    const taskId = taskPayload.taskId || ("act-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operation = (taskPayload.operation || "readNotifications").toLowerCase();
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;

        logger.info(`[processTask] ${taskId}: ${platform}/${operation}`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");

        // Check limits before engaging
        if (operation === "engageWithNotifications" || operation === "followBack") {
            const likeCheck = await checkActionAllowed(platform, "likesOnPost", {});
            if (!likeCheck.allowed) {
                logger.warn(`[processTask] Likes blocked: ${likeCheck.reason}`);
            }
            const followCheck = await checkActionAllowed(platform, "follow", {});
            if (!followCheck.allowed) {
                logger.warn(`[processTask] Follows blocked: ${followCheck.reason}`);
            }
        }

        const platformConfig = getPlatformConfig(platform);
        ({ browser, page } = await launchBrowserWithSession(cookieJSON));

        const workflow = getWorkflow(platform, operation);

        const context = {
            platform,
            operation,
            platformConfig,
        };

        const workflowResults = await executeWorkflow(page, workflow, context, platformConfig, MultiProviderAI);

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

        if (profileId) {
            const performedActions = [];
            if (operation === "engageWithNotifications") performedActions.push("likesOnPost");
            if (operation === "followBack") performedActions.push("follow");

            for (const action of performedActions) {
                await updateAccountUsage(profileId, action);
            }

            await updateAccountInteractionData(profileId, {
                lastOperation: operation,
                lastRun: new Date().toISOString(),
                results: results.length,
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

            const tid = task.taskId || ("act-" + Math.random().toString(36).substring(2, 11));
            activeTasks.set(tid, true);

            const result = await processTask(task);

            return setCorsHeaders(NextResponse.json({
                message: "Activities task executed",
                task: result
            }));
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
