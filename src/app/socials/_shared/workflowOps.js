// Shared campaign/workflow helpers — CJS so jest can require() it; imported
// from ESM routes via the default-import + destructure pattern.

// Campaign operation names → workflow key defaults (run-once campaign tasks
// execute the read/scrape workflow for their channel).
const WORKFLOW_ALIASES = {
    'inbox-interact': 'readInbox',
    'activities-interact': 'readNotifications',
    'page-interact': 'scrapeProfile',
    'search-interact': 'search',
};

/**
 * Resolve the workflow key for an operation.
 * Precedence: campaign alias (when the alias exists in the platform's
 * workflows) → exact key → case-insensitive key → alias/original (so
 * getWorkflow still throws its descriptive error).
 * Accepts a workflows object or an array of key strings.
 */
function normalizeWorkflowOp(operation, workflows) {
    const op = String(operation == null ? '' : operation).trim();
    if (!op) return '';
    const keys = Array.isArray(workflows)
        ? workflows
        : (workflows && typeof workflows === 'object' ? Object.keys(workflows) : []);
    const lower = op.toLowerCase();

    const alias = WORKFLOW_ALIASES[lower];
    if (alias && keys.some(k => k === alias)) return alias;

    const exact = keys.find(k => k === op);
    if (exact) return exact;

    const ci = keys.find(k => String(k).toLowerCase() === lower);
    if (ci) return ci;

    return alias || op;
}

/**
 * Resolve the outbound social/DM message with the campaign fallback chain:
 * per-row CSV message → settings.socialMessage → settings.body → settings.message → ''.
 */
function resolveSocialMessage(perRowMessage, settings) {
    const s = settings || {};
    const per = String(perRowMessage == null ? '' : perRowMessage).trim();
    if (per) return per;
    return String(s.socialMessage || s.body || s.message || '').trim();
}

module.exports = {
    WORKFLOW_ALIASES,
    normalizeWorkflowOp,
    resolveSocialMessage,
};
