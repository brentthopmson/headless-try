// Isolation tests for the three-tier limits core (platform / account / user).
// Pure logic only — no sheets, no browser: every decision the engine makes
// about limits funnels through these functions.
const {
    USER_LIMIT_COLUMNS,
    BASE_LIMIT_ACTION_MAP,
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
} = require('../src/app/socials/_shared/limitsCore.js');

describe('parseLimitCell / normalizePolicy (Limits sheet cell → policy)', () => {
    test('parses a JSON cell into numeric policy', () => {
        const p = parseLimitCell('{"hourly":"5","daily":"50","monthly":"500","cap":"2000"}');
        expect(p).toEqual({ hourly: 5, daily: 50, monthly: 500, cap: 2000 });
    });

    test('accepts an already-parsed object', () => {
        const p = parseLimitCell({ hourly: 10, daily: 0, monthly: 0, cap: "" });
        expect(p).toEqual({ hourly: 10, daily: 0, monthly: 0, cap: null });
    });

    test('missing/corrupt cells return null', () => {
        expect(parseLimitCell(null)).toBeNull();
        expect(parseLimitCell("")).toBeNull();
        expect(parseLimitCell("{not json")).toBeNull();
    });

    test('pickLimitNumber: 0 = unlimited sentinel, negatives/garbage → 0', () => {
        expect(pickLimitNumber("40")).toBe(40);
        expect(pickLimitNumber(0)).toBe(0);
        expect(pickLimitNumber("")).toBe(0);
        expect(pickLimitNumber(null)).toBe(0);
        expect(pickLimitNumber("-5")).toBe(0);
        expect(pickLimitNumber("abc")).toBe(0);
    });
});

describe('evaluateActionPolicy (PLATFORM policy × ACCOUNT usage)', () => {
    const usage = { hourly: 3, daily: 10, monthly: 100, total: 250 };

    test('missing policy → allowed, tagged platform tier', () => {
        const r = evaluateActionPolicy(null, usage);
        expect(r.allowed).toBe(true);
        expect(r.reason).toBe('no_limits_configured');
        expect(r.tier).toBe('platform');
    });

    test('all-zero policy → no_limits_defined (platform tier is fail-open)', () => {
        const r = evaluateActionPolicy({ hourly: 0, daily: 0, monthly: 0, cap: "" }, usage);
        expect(r.allowed).toBe(true);
        expect(r.reason).toBe('no_limits_defined');
    });

    test('hourly limit blocks at boundary', () => {
        expect(evaluateActionPolicy({ hourly: 3, daily: 0, monthly: 0, cap: "" }, usage).allowed).toBe(false);
        expect(evaluateActionPolicy({ hourly: 4, daily: 0, monthly: 0, cap: "" }, usage).allowed).toBe(true);
    });

    test('daily limit blocks at boundary', () => {
        const r = evaluateActionPolicy({ hourly: 0, daily: 10, monthly: 0, cap: "" }, usage);
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe('daily_limit: 10/10');
    });

    test('monthly limit blocks at boundary', () => {
        expect(evaluateActionPolicy({ hourly: 0, daily: 0, monthly: 100, cap: "" }, usage).allowed).toBe(false);
        expect(evaluateActionPolicy({ hourly: 0, daily: 0, monthly: 101, cap: "" }, usage).allowed).toBe(true);
    });

    test('total cap blocks regardless of window resets', () => {
        const freshWindows = { hourly: 0, daily: 0, monthly: 0, total: 250 };
        const r = evaluateActionPolicy({ hourly: 0, daily: 0, monthly: 0, cap: 250 }, freshWindows);
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe('cap_reached: 250/250');
    });

    test('string counters/limits are coerced', () => {
        expect(evaluateActionPolicy({ hourly: "2", daily: 0, monthly: 0, cap: "" }, { hourly: "2" }).allowed).toBe(false);
    });

    test('missing usage entry treated as zeros', () => {
        expect(evaluateActionPolicy({ hourly: 5, daily: 0, monthly: 0, cap: "" }, undefined).allowed).toBe(true);
    });
});

describe('operationConsumes (does this task touch quota?)', () => {
    test('read/scrape operations never consume — even as campaign op names', () => {
        expect(operationConsumes('search-interact', false)).toBe(false);
        expect(operationConsumes('page-interact', false)).toBe(false);
        expect(operationConsumes('inbox-interact', false)).toBe(false);
        expect(operationConsumes('activities-interact', false)).toBe(false);
        expect(operationConsumes('readInbox', false)).toBe(false);
        expect(operationConsumes('scrapeProfile', false)).toBe(false);
        expect(operationConsumes('readNotifications', false)).toBe(false);
        expect(operationConsumes('', false)).toBe(false);
    });

    test('engagementMode forces consuming regardless of operation name', () => {
        expect(operationConsumes('search-interact', true)).toBe(true);
        expect(operationConsumes('page-interact', true)).toBe(true);
        expect(operationConsumes('readInbox', true)).toBe(true);
    });

    test('explicit consuming ops consume', () => {
        expect(operationConsumes('followUser', false)).toBe(true);
        expect(operationConsumes('sendmessage', false)).toBe(true);
        expect(operationConsumes('interactWithVideo', false)).toBe(true);
        expect(operationConsumes('engageWithNotifications', false)).toBe(true);
    });

    test('comma chains: read + engage → consuming; all-read → not', () => {
        expect(operationConsumes('search,interactWithVideo', false)).toBe(true);
        expect(operationConsumes('readInbox,sendMessage', false)).toBe(true);
        expect(operationConsumes('scrapeProfile,search', false)).toBe(false);
    });

    test('unknown segments default to consuming (safe default)', () => {
        expect(operationConsumes('someNewOp', false)).toBe(true);
    });
});

describe('baseActionsForOperation / actionsForExecutedKeys / toLimitActions', () => {
    test('campaign op names are read-only → no actions', () => {
        expect(baseActionsForOperation('search-interact')).toEqual([]);
        expect(baseActionsForOperation('inbox-interact')).toEqual([]);
        expect(baseActionsForOperation('activities-interact')).toEqual([]);
    });

    test('explicit ops map to base actions', () => {
        expect(baseActionsForOperation('followUser')).toEqual(['follow']);
        expect(baseActionsForOperation('unfollowuser')).toEqual(['unfollow']);
        expect(baseActionsForOperation('interactWithVideo')).toEqual(['like', 'comment']);
        expect(baseActionsForOperation('sendmessage')).toEqual(['message']);
    });

    test('comma chains union their actions', () => {
        expect(baseActionsForOperation('followUser,interactWithPost')).toEqual(['follow', 'like', 'comment']);
    });

    test('executed read-only workflows produce no actions (stops over-increment)', () => {
        expect(actionsForExecutedKeys(['search'], 'search-interact')).toEqual([]);
        expect(actionsForExecutedKeys(['readInbox'], 'inbox-interact')).toEqual([]);
        expect(actionsForExecutedKeys(['readNotifications'], 'activities-interact')).toEqual([]);
    });

    test('executed engagement workflows produce exactly their actions', () => {
        expect(actionsForExecutedKeys(['search', 'interactWithVideo'], 'search-interact')).toEqual(['like', 'comment']);
        expect(actionsForExecutedKeys(['followUser'], 'page-interact')).toEqual(['follow']);
        expect(actionsForExecutedKeys(['engageWithNotifications'], 'activities-interact')).toEqual(['like', 'comment']);
        expect(actionsForExecutedKeys(['sendMessage'], 'sendmessage')).toEqual(['message']);
    });

    test('no executed keys → no actions', () => {
        expect(actionsForExecutedKeys([], 'followUser')).toEqual([]);
    });

    test('base actions map to Limits-sheet columns', () => {
        expect(toLimitActions(['like', 'comment', 'follow', 'message'])).toEqual(['likesOnPost', 'commentOnPost', 'follow', 'coldMessage']);
        expect(toLimitActions(['extract'])).toEqual(['extract']);
        expect(toLimitActions(['unfollow'])).toEqual(['unfollow']);
        expect(toLimitActions([])).toEqual([]);
        expect(BASE_LIMIT_ACTION_MAP.like).toBe('likesOnPost');
    });
});

describe('evaluateUserQuota (USER tier — monthly *Usage vs plan-row *Limit)', () => {
    const blob = {
        smtpCheckerUsage: { hourly: 1, daily: 2, monthly: 2, total: 5 },
        senderUsage: { monthly: 50, total: 300 },
        shootCampaignUsage: { monthly: 100, total: 100 },
        validateUsage: { monthly: 3, total: 9 },
    };

    test('0/missing plan limit = unlimited (fail-open before columns configured)', () => {
        expect(evaluateUserQuota(blob, { shootCampaignUsage: 0 }).allowed).toBe(true);
        expect(evaluateUserQuota(blob, {}).allowed).toBe(true);
        expect(evaluateUserQuota(blob, null).allowed).toBe(true);
        expect(evaluateUserQuota(blob, { shootCampaignUsage: 0 }).tier).toBe('user');
    });

    test('monthly counter blocks at boundary', () => {
        const r = evaluateUserQuota(blob, { smtpCheckerUsage: 2 }, { keys: ['smtpCheckerUsage'] });
        expect(r.allowed).toBe(false);
        expect(r.reason).toBe('user_monthly_limit: smtpCheckerUsage 2/2');
        expect(r.key).toBe('smtpCheckerUsage');
        expect(r.used).toBe(2);
        expect(r.limit).toBe(2);
    });

    test('below limit allowed; at limit blocked', () => {
        expect(evaluateUserQuota(blob, { smtpCheckerUsage: 3 }, { keys: ['smtpCheckerUsage'] }).allowed).toBe(true);
        const r = evaluateUserQuota(blob, { senderUsage: 50 }, { keys: ['senderUsage'] });
        expect(r.allowed).toBe(false);
        expect(r.used).toBe(50);
    });

    test('only gated keys are checked (exhausted sibling keys ignored)', () => {
        const policy = { smtpCheckerUsage: 1, validateUsage: 10 };
        expect(evaluateUserQuota(blob, policy, { keys: ['validateUsage'] }).allowed).toBe(true);
        expect(evaluateUserQuota(blob, policy, { keys: ['smtpCheckerUsage'] }).allowed).toBe(false);
    });

    test('missing usage entry treated as 0', () => {
        const r = evaluateUserQuota({}, { shootCampaignUsage: 5 }, { keys: ['shootCampaignUsage'] });
        expect(r.allowed).toBe(true);
    });

    test('no keys given → evaluate every key present in the plan limits', () => {
        const policy = { smtpCheckerUsage: 1, senderUsage: 1000 };
        const r = evaluateUserQuota(blob, policy);
        expect(r.allowed).toBe(false);
        expect(r.key).toBe('smtpCheckerUsage');
    });

    test('string counters/limits are coerced', () => {
        const r = evaluateUserQuota(
            { validateUsage: { monthly: '3' } },
            { validateUsage: '3' },
            { keys: ['validateUsage'] },
        );
        expect(r.allowed).toBe(false);
        expect(r.used).toBe(3);
    });

    test('non-object usage entry treated as 0', () => {
        expect(evaluateUserQuota({ senderUsage: 99 }, { senderUsage: 1 }, { keys: ['senderUsage'] }).allowed).toBe(true);
    });

    test('single-key shorthand (checks.key)', () => {
        expect(evaluateUserQuota(blob, { senderUsage: 50 }, { key: 'senderUsage' }).allowed).toBe(false);
        expect(evaluateUserQuota(blob, { senderUsage: 50 }, { key: 'validateUsage' }).allowed).toBe(true);
    });
});

describe('parsePlanRow (Limits plan row → monthly *Usage limits)', () => {
    const headers = ['plan', 'actionTypes', 'smtpCheckerLimit', 'validateLimit', 'shootCampaignLimit', 'interactionLimit', 'unrelatedLimit'];

    test('maps *Limit columns to *Usage keys with numeric values', () => {
        const out = parsePlanRow(headers, ['VETERAN', '{}', '100', 50, 0, 10, 999]);
        expect(out).toEqual({
            smtpCheckerUsage: 100,
            validateUsage: 50,
            shootCampaignUsage: 0,
            interactionUsage: 10,
        });
    });

    test('ignores columns outside USER_LIMIT_COLUMNS', () => {
        const out = parsePlanRow(headers, ['X', '', '1', '1', '1', '1', '7']);
        expect(out.unrelatedUsage).toBeUndefined();
        expect(Object.keys(out)).toEqual(['smtpCheckerUsage', 'validateUsage', 'shootCampaignUsage', 'interactionUsage']);
    });

    test('garbage cell values → 0 (unlimited sentinel)', () => {
        const out = parsePlanRow(['plan', 'smtpCheckerLimit'], ['NEWBEE', 'abc']);
        expect(out).toEqual({ smtpCheckerUsage: 0 });
    });

    test('null headers/row → null', () => {
        expect(parsePlanRow(null, [])).toBeNull();
        expect(parsePlanRow([], null)).toBeNull();
    });

    test('USER_LIMIT_COLUMNS drives the *Limit → *Usage uniform rule', () => {
        expect(USER_LIMIT_COLUMNS).toContain('shootCampaignLimit');
        expect(USER_LIMIT_COLUMNS).toContain('verifyLoginLimit');
        expect(USER_LIMIT_COLUMNS).not.toContain('campaignStartLimit');
    });
});

describe('util helpers', () => {
    test('toInt coerces and falls back', () => {
        expect(toInt('7')).toBe(7);
        expect(toInt('x', -1)).toBe(-1);
        expect(toInt(undefined)).toBe(0);
    });

    test('normalizeUsage coerces string counters', () => {
        expect(normalizeUsage({ hourly: '2', daily: '3', monthly: '4', total: '5' })).toEqual({ hourly: 2, daily: 3, monthly: 4, total: 5 });
        expect(normalizeUsage(undefined)).toEqual({ hourly: 0, daily: 0, monthly: 0, total: 0 });
    });

    test('normalizePolicy drops empty cap to null', () => {
        expect(normalizePolicy({ hourly: 1, daily: 2, monthly: 3, cap: '' }).cap).toBeNull();
        expect(normalizePolicy({ hourly: 1, daily: 2, monthly: 3, cap: '9' }).cap).toBe(9);
    });
});
