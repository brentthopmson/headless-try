// Pure limit-evaluation logic — CJS so jest can require() it; imported from
// the ESM limits module (and shared routes) via the default-import pattern.

// Plan-row columns that hold USER-tier monthly quotas. Each maps to a users-sheet
// usage key by swapping the "Limit" suffix for "Usage" (senderLimit → senderUsage).
const USER_LIMIT_COLUMNS = [
    "smtpCheckerLimit",
    "senderLimit",
    "verifyLoginLimit",
    "extractionLimit",
    "shootContactsLimit",
    "validateLimit",
    "enrichLimit",
    "personalizeLimit",
    "shootCampaignLimit",
    "interactionLimit",
];

// Base action name → Limits-sheet ACTION_TYPES column. Routes use these names
// for both checkActionAllowed() and updateAccountUsage().
const BASE_LIMIT_ACTION_MAP = {
    like: "likesOnPost",
    comment: "commentOnPost",
    follow: "follow",
    unfollow: "unfollow",
    message: "coldMessage",
    likeComment: "likesOnComment",
    likeStory: "likeOnStory",
    commentStory: "commentOnStory",
    commentComment: "commentOnComment",
    extract: "extract",
};

// Operation/workflow segments that perform NO quota-consuming platform action.
const READ_OPERATIONS = new Set([
    "search", "search-interact",
    "scrapeprofile", "page-interact",
    "readinbox", "inbox-interact",
    "readnotifications", "activities-interact",
    "extract", "scrape", "read",
]);

// Operation segments that consume quota → base action names.
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

function toInt(value, fallback = 0) {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? fallback : n;
}

function pickLimitNumber(value) {
    if (value === null || value === undefined || value === "") return 0;
    const n = parseInt(value, 10);
    return !Number.isNaN(n) && n >= 0 ? n : 0;
}

function normalizePolicy(policy) {
    const p = policy || {};
    const capRaw = p.cap;
    return {
        hourly: toInt(p.hourly, 0),
        daily: toInt(p.daily, 0),
        monthly: toInt(p.monthly, 0),
        cap: capRaw ? (toInt(capRaw, 0) || null) : null,
    };
}

function normalizeUsage(usage) {
    const u = usage || {};
    return {
        hourly: toInt(u.hourly, 0),
        daily: toInt(u.daily, 0),
        monthly: toInt(u.monthly, 0),
        total: toInt(u.total, 0),
    };
}

// Parse a Limits-sheet action cell (JSON string or object) → policy numbers.
// Returns null when the cell is missing/corrupt (caller decides semantics).
function parseLimitCell(raw) {
    if (!raw) return null;
    if (typeof raw === "object") return normalizePolicy(raw);
    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return normalizePolicy(parsed);
    } catch (e) {
        // fall through
    }
    return null;
}

// Core of checkActionAllowed(): evaluate a platform policy against account usage.
// Semantics: zero/undefined window = no limit for that window; all-zero policy
// = "no_limits_defined" → allowed (platform tier is fail-open by design).
function evaluateActionPolicy(policy, usage) {
    if (!policy) return { allowed: true, reason: "no_limits_configured", tier: "platform" };
    const p = normalizePolicy(policy);
    if (!p.hourly && !p.daily && !p.monthly && !p.cap) {
        return { allowed: true, reason: "no_limits_defined", tier: "platform" };
    }
    const u = normalizeUsage(usage);
    if (p.cap !== null && u.total >= p.cap) {
        return { allowed: false, reason: `cap_reached: ${u.total}/${p.cap}`, tier: "platform" };
    }
    if (p.hourly && u.hourly >= p.hourly) {
        return { allowed: false, reason: `hourly_limit: ${u.hourly}/${p.hourly}`, tier: "platform" };
    }
    if (p.daily && u.daily >= p.daily) {
        return { allowed: false, reason: `daily_limit: ${u.daily}/${p.daily}`, tier: "platform" };
    }
    if (p.monthly && u.monthly >= p.monthly) {
        return { allowed: false, reason: `monthly_limit: ${u.monthly}/${p.monthly}`, tier: "platform" };
    }
    return { allowed: true, reason: "ok", tier: "platform" };
}

// Does this task consume platform quota? Read/scrape operations never do;
// engagementMode forces consuming behavior; unknown segments are treated as
// consuming (safe default — matches mapOperationToActions' fallback).
function operationConsumes(operationRaw, engagementMode) {
    if (engagementMode) return true;
    const raw = String(operationRaw == null ? "" : operationRaw).trim();
    if (!raw) return false;
    const segments = raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    let sawSegment = false;
    for (const seg of segments) {
        sawSegment = true;
        if (READ_OPERATIONS.has(seg)) continue;
        if (RAW_OP_ACTIONS[seg]) return true;
        return true;
    }
    return sawSegment ? false : !!engagementMode;
}

// Base actions for an operation segment list (campaign/sheet task names).
function baseActionsForOperation(operationRaw) {
    const raw = String(operationRaw == null ? "" : operationRaw).trim();
    if (!raw) return [];
    if (raw.includes(",")) {
        const union = [];
        for (const seg of raw.split(",")) {
            for (const a of baseActionsForOperation(seg.trim())) {
                if (!union.includes(a)) union.push(a);
            }
        }
        return union;
    }
    const op = raw.toLowerCase();
    if (READ_OPERATIONS.has(op)) return [];
    if (RAW_OP_ACTIONS[op]) return [...RAW_OP_ACTIONS[op]];
    return ["like"];
}

// Base actions implied by executed workflow keys + the original operation.
// Used AFTER a run so usage increments reflect only actions actually performed.
function actionsForExecutedKeys(executedKeys, operationRaw) {
    const union = [];
    const push = (a) => { if (a && !union.includes(a)) union.push(a); };
    const keys = (executedKeys || []).map(k => String(k).toLowerCase());
    for (const k of keys) {
        if (RAW_OP_ACTIONS[k]) {
            for (const a of RAW_OP_ACTIONS[k]) push(a);
        }
    }
    for (const a of baseActionsForOperation(operationRaw)) push(a);
    if (!keys.length) return [];
    const allRead = keys.every(k => READ_OPERATIONS.has(k));
    if (allRead) return [];
    return union;
}

// Base action names → Limits-sheet column names.
function toLimitActions(baseActions) {
    const out = [];
    for (const a of (baseActions || [])) {
        const col = BASE_LIMIT_ACTION_MAP[a] || a;
        if (col && !out.includes(col)) out.push(col);
    }
    return out;
}

// Parse a Limits-sheet plan row → { <key>: monthlyLimit } keyed by *Usage names.
// Returns null only when the row/headers are missing; a row without any of the
// columns yields {} (every key unlimited until configured).
function parsePlanRow(headers, row) {
    if (!headers || !row) return null;
    const out = {};
    for (const col of USER_LIMIT_COLUMNS) {
        const i = headers.indexOf(col);
        if (i !== -1) out[col.replace(/Limit$/, "Usage")] = pickLimitNumber(row[i]);
    }
    return out;
}

// USER tier: evaluate MONTHLY per-key usage against the user's plan-row limits.
// Policy value 0/missing = unlimited (fail-open) so the tier never breaks
// existing deployments before the plan columns are configured.
// checks: { keys: ['shootCampaignUsage', ...] } — the keys the caller gates.
// No keys given → evaluate every key present in the plan limits.
function evaluateUserQuota(usageBlob, planLimits, checks) {
    const limits = planLimits || {};
    let keys;
    if (checks && Array.isArray(checks.keys)) {
        keys = checks.keys;
    } else if (checks && checks.key) {
        keys = [checks.key];
    } else {
        keys = Object.keys(limits);
    }
    const blob = usageBlob || {};
    for (const key of keys) {
        const limit = pickLimitNumber(limits[key]);
        const entry = blob[key];
        const used = (entry && typeof entry === "object") ? toInt(entry.monthly, 0) : 0;
        if (limit > 0 && used >= limit) {
            return {
                tier: "user",
                allowed: false,
                reason: `user_monthly_limit: ${key} ${used}/${limit}`,
                key,
                used,
                limit,
            };
        }
    }
    return { tier: "user", allowed: true, reason: "ok" };
}

module.exports = {
    USER_LIMIT_COLUMNS,
    BASE_LIMIT_ACTION_MAP,
    READ_OPERATIONS,
    RAW_OP_ACTIONS,
    toInt,
    pickLimitNumber,
    normalizePolicy,
    normalizeUsage,
    parseLimitCell,
    evaluateActionPolicy,
    operationConsumes,
    baseActionsForOperation,
    actionsForExecutedKeys,
    toLimitActions,
    parsePlanRow,
    evaluateUserQuota,
};
