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
import limitsCore from '../_shared/limitsCore.js';
const { operationConsumes, baseActionsForOperation, actionsForExecutedKeys, toLimitActions } = limitsCore;
import { checkActionAllowed, getPlatformLimits } from '../_shared/limits.js';
import { resolveAccountGate, accountGateError } from '../_shared/accountGate.js';
import { getAccountUsage, updateAccountUsage, updateAccountStatus, updateAccountInteractionData } from '../_shared/hubUpdater.js';

export { processTask as processPageInteractTask };

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

const MAX_CONCURRENT_TASKS = parseInt(process.env.MAX_CONCURRENT_TASKS || '2', 10);
const activeTasks = new Map();
logger.info(`[Page Interact] Concurrency limit: ${MAX_CONCURRENT_TASKS}`);

async function processTask(taskPayload) {
    let browser = null;
    let page = null;
    let finalStatus = "FAILED";
    let results = [];
    const taskId = taskPayload.taskId || ("page-" + Math.random().toString(36).substring(2, 11));

    try {
        const platform = (taskPayload.platform || "").toLowerCase();
        const operationRaw = String(taskPayload.operation || "scrapeProfile");
        const operation = operationRaw.toLowerCase();
        const keyword = taskPayload.searchQuery || taskPayload.targetUsername || "";
        const cookieJSON = taskPayload.cookieJSON;
        const profileId = taskPayload.profileId || taskPayload.accountId || null;
        const socialStrategyPrompt = taskPayload.socialStrategyPrompt || null;

        logger.info(`[processTask] ${taskId}: ${platform}/${operation} keyword=${keyword}`);

        if (!platform) throw new Error("Platform not specified");
        if (!cookieJSON) throw new Error("No cookies provided");

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

        let workflowKeys;
        if (engagementMode) {
            const engage = pickWorkflowKey(["followUser", "interactWithProfile"], platformConfig.workflows);
            if (engage) workflowKeys = [engage];
            logger.info(`[processTask] ${taskId}: engagement workflow resolved to [${(workflowKeys || []).join(', ')}]`);
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

        // Update hub usage — count exactly the quota actions this run consumed
        // (same action family the gate above checked; [] for read-only scrapes).
        if (profileId) {
            const quotaActions = consumes
                ? toLimitActions(actionsForExecutedKeys(workflowKeys, operationRaw))
                : [];
            for (const action of quotaActions) {
                await updateAccountUsage(profileId, action);
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
