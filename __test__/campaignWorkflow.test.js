// Phase 3: campaign workflow-op mapping + social message fallbacks.
const {
    WORKFLOW_ALIASES,
    normalizeWorkflowOp,
    resolveSocialMessage,
} = require('../src/app/socials/_shared/workflowOps.js');

const workflows = ['readInbox', 'sendMessage', 'checkConversation'];

describe('normalizeWorkflowOp', () => {
    test('campaign op aliases map to default workflow keys', () => {
        expect(WORKFLOW_ALIASES['inbox-interact']).toBe('readInbox');
        expect(normalizeWorkflowOp('inbox-interact', { readInbox: {}, sendMessage: {} })).toBe('readInbox');
        expect(normalizeWorkflowOp('activities-interact', { readNotifications: {} })).toBe('readNotifications');
        expect(normalizeWorkflowOp('page-interact', { scrapeProfile: {} })).toBe('scrapeProfile');
        expect(normalizeWorkflowOp('search-interact', { search: {} })).toBe('search');
    });

    test('case-insensitive resolution against workflow keys (handlers lowercase ops)', () => {
        expect(normalizeWorkflowOp('readinbox', { readInbox: {} })).toBe('readInbox');
        expect(normalizeWorkflowOp('ReadInbox', { readInbox: {} })).toBe('readInbox');
        expect(normalizeWorkflowOp('sendmessage', { readInbox: {}, sendMessage: {} })).toBe('sendMessage');
        expect(normalizeWorkflowOp('scrapeprofile', { scrapeProfile: {} })).toBe('scrapeProfile');
    });

    test('exact key passes through untouched', () => {
        expect(normalizeWorkflowOp('sendMessage', workflows)).toBe('sendMessage');
        expect(normalizeWorkflowOp('checkConversation', { checkConversation: {} })).toBe('checkConversation');
    });

    test('accepts an array of key strings', () => {
        expect(normalizeWorkflowOp('readinbox', workflows)).toBe('readInbox');
        expect(normalizeWorkflowOp('inbox-interact', workflows)).toBe('readInbox');
    });

    test('alias not present in workflows → still returns alias (getWorkflow throws its own error)', () => {
        expect(normalizeWorkflowOp('inbox-interact', { other: {} })).toBe('readInbox');
    });

    test('unknown op with no alias returns original for descriptive error', () => {
        expect(normalizeWorkflowOp('doesNotExist', workflows)).toBe('doesNotExist');
    });

    test('empty / null input returns empty string', () => {
        expect(normalizeWorkflowOp('', workflows)).toBe('');
        expect(normalizeWorkflowOp(null, workflows)).toBe('');
        expect(normalizeWorkflowOp(undefined)).toBe('');
    });
});

describe('resolveSocialMessage', () => {
    test('per-row CSV message wins', () => {
        expect(resolveSocialMessage('  per-row dm  ', { socialMessage: 'settings dm' })).toBe('per-row dm');
    });

    test('falls back to settings.socialMessage', () => {
        expect(resolveSocialMessage('', { socialMessage: 'settings dm' })).toBe('settings dm');
        expect(resolveSocialMessage(null, { socialMessage: 'settings dm' })).toBe('settings dm');
    });

    test('falls back to settings.body when no socialMessage', () => {
        expect(resolveSocialMessage(null, { body: 'campaign body' })).toBe('campaign body');
    });

    test('socialMessage beats body', () => {
        expect(resolveSocialMessage('', { socialMessage: 'dm', body: 'body' })).toBe('dm');
    });

    test('falls back to settings.message last', () => {
        expect(resolveSocialMessage('', { message: 'legacy message' })).toBe('legacy message');
    });

    test('empty settings → empty string', () => {
        expect(resolveSocialMessage('', {})).toBe('');
        expect(resolveSocialMessage(undefined, null)).toBe('');
    });
});
