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
} from '../_shared/routeHelper.js';
import workflowOps from '../_shared/workflowOps.js';

const { normalizeWorkflowOp, resolveWorkflowOps } = workflowOps;
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { requireFeature } from '../../../utils/featureGate.js';
import { resolveAccountGate, accountGateError } from '../_shared/accountGate.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';

export { processTask as processInboxInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '1', 10);
const activeTasks = new Map();
logger.info(`[Inbox Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    const taskId = taskPayload.taskId || ("inbox-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operationRaw = String(taskPayload.operation || "readInbox");
        const operation = operationRaw.toLowerCase();
        const keyword = taskPayload.searchQuery || taskPayload.targetUsername || "";
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;
        const socialStrategyPrompt = taskPayload.socialStrategyPrompt || null;
        const messageText = taskPayload.messageText || "";

        logger.info(`[processTask] ${taskId}: ${platform}/${operation} target=${keyword}`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");

        // ACCOUNT-tier status gate — RATE_LIMITED blocks until windows roll,
        // CANCELLED always blocks. Before any browser launch.
        const statusGate = await resolveAccountGate(profileId, platform);
        if (statusGate.blocked) throw accountGateError(profileId, statusGate);

        // Check coldMessage limit before sending
        const sendsMessage = operation === "sendmessage" ||
            String(operationRaw).split(",").some(seg => seg.trim().toLowerCase() === "sendmessage");
        if (sendsMessage) {
            const accountUsageData = profileId ? await getAccountUsage(profileId) : null;
            const accountUsage = accountUsageData?.interactionUsage || {};
            const check = await checkActionAllowed(platform, "coldMessage", accountUsage);
            if (!check.allowed) {
                throw new Error(`Cold message blocked by platform limits: ${check.reason}`);
            }
        }

        const platformConfig = getPlatformConfig(platform);

        // Generate AI message if messageText not provided but socialStrategyPrompt exists
        let finalMessageText = messageText;
        if (!finalMessageText && socialStrategyPrompt && sendsMessage) {
            try {
                const promptTemplate = platformConfig.aiPrompts?.generateColdMessage || "";
                const targetLink = taskPayload.targetLink || "";
                const fullPrompt = promptTemplate
                    .replace('{{socialStrategyPrompt}}', socialStrategyPrompt)
                    .replace('{context}', keyword || "a user on this platform")
                    + (targetLink ? `\nCampaign target link: ${targetLink} — reference this destination naturally in the message (plain URL, only if it fits the conversation).` : "");
                finalMessageText = await MultiProviderAI.generate(fullPrompt);
                logger.info(`[processTask] AI generated message for ${taskId}`);
            } catch (e) {
                logger.warn(`[processTask] AI message generation failed: ${e.message}`);
                finalMessageText = "Hi! Great to connect with you here.";
            }
        }

        // Hybrid session: use Drive profile + identity if available
        let profileDir = null;
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

        const workflowKeys = resolveWorkflowOps(operationRaw, platformConfig.workflows);
        if (workflowKeys.length === 0) throw new Error(`No workflow resolved for operation: ${operationRaw}`);
        const workflows = workflowKeys.map(key => getWorkflow(platform, key));

        const context = {
            platform,
            operation,
            keyword,
            messageText: finalMessageText,
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
                        const parseFunc = new Function('items', 'return (' + extractor.parseFunction + '\n)(items);');
                        const elements = await page.$$(extractor.selector);
                        const extracted = parseFunc(elements);
                        if (Array.isArray(extracted)) results.push(...extracted);
                    } catch (e) {
                        logger.error(`[processTask] Extraction failed: ${e.message}`);
                    }
                }
            }
        }

        finalStatus = "COMPLETED";

        if (profileId) {
            const executedKeys = workflowKeys.map(k => String(k).toLowerCase());
            if (executedKeys.includes("sendmessage") || operation === "sendmessage") {
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
        if (profileDir) { const fs = await import('fs-extra'); await fs.remove(profileDir).catch(() => {}); }
        activeTasks.delete(taskId);
    }

    return { taskId, status: finalStatus, resultCount: results.length, results };
}

export async function POST(request) {
    try {
        const gate = await requireFeature('allowInteraction', 'social interaction');
        if (gate) return gate;
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
