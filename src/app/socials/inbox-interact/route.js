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
    executeWorkflow,
} from '../_shared/routeHelper.js';
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';

export { processTask as processInboxInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);
const activeTasks = new Map();
logger.info(`[Inbox Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

const ACTION_LIMIT_MAP = {
    "sendMessage": "coldMessage",
    "replyMessage": "coldMessage",
};

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    const taskId = taskPayload.taskId || ("inbox-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operation = (taskPayload.operation || "readInbox").toLowerCase();
        const keyword = taskPayload.searchQuery || taskPayload.targetUsername || "";
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;
        const socialStrategyPrompt = taskPayload.socialStrategyPrompt || null;
        const messageText = taskPayload.messageText || "";

        logger.info(`[processTask] ${taskId}: ${platform}/${operation} target=${keyword}`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");

        // Check coldMessage limit before sending
        if (operation === "sendMessage") {
            const check = await checkActionAllowed(platform, "coldMessage", {});
            if (!check.allowed) {
                throw new Error(`Cold message blocked by platform limits: ${check.reason}`);
            }
        }

        const platformConfig = getPlatformConfig(platform);

        // Generate AI message if messageText not provided but socialStrategyPrompt exists
        let finalMessageText = messageText;
        if (!finalMessageText && socialStrategyPrompt && operation === "sendMessage") {
            try {
                const promptTemplate = platformConfig.aiPrompts?.generateColdMessage || "";
                const fullPrompt = promptTemplate
                    .replace('{{socialStrategyPrompt}}', socialStrategyPrompt)
                    .replace('{context}', keyword || "a user on this platform");
                finalMessageText = await MultiProviderAI.generate(fullPrompt);
                logger.info(`[processTask] AI generated message for ${taskId}`);
            } catch (e) {
                logger.warn(`[processTask] AI message generation failed: ${e.message}`);
                finalMessageText = "Hi! Great to connect with you here.";
            }
        }

        ({ browser, page } = await launchBrowserWithSession(cookieJSON));

        const workflow = getWorkflow(platform, operation);

        const context = {
            platform,
            operation,
            keyword,
            messageText: finalMessageText,
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
                } catch (e) {
                    logger.error(`[processTask] Extraction failed: ${e.message}`);
                    results = [];
                }
            }
        }

        finalStatus = "COMPLETED";

        if (profileId) {
            if (operation === "sendMessage") {
                await updateAccountUsage(profileId, "coldMessage");
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

            const tid = task.taskId || ("inbox-" + Math.random().toString(36).substring(2, 11));
            activeTasks.set(tid, true);

            const result = await processTask(task);

            return setCorsHeaders(NextResponse.json({
                message: "Inbox task executed",
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
