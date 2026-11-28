// ==================== CENTRAL COMMENT POLICY ====================
// Single source of truth for the two campaign comment toggles:
//   requireAiForComments — never post non-AI comment/reply/DM text
//   targetedComments     — AI screens targets before replying/messaging
//
// Every interaction entry point (search/page/activities/inbox/social-chain/
// workflow) resolves its policy through this module. Tasks created by
// execute-campaign carry the flags; older or sheet-driven tasks do not —
// for those we fall back to the campaign's SETTINGS row.

import logger from '../../../utils/logger.js';
import { getCampaignSettings } from '../../campaign/_shared/pipelineUtils.js';

const POLICY_CACHE_MS = 60 * 1000;
const policyCache = new Map();

/** Boolean-tolerant parse: true only for real true / "true" (case-insensitive). */
export function parseFlag(value) {
    return value === true || String(value ?? '').trim().toLowerCase() === 'true';
}

/**
 * Resolve both comment-policy flags for a task.
 * Explicit task values win (including an explicit false). Missing values fall
 * back to the campaign settings row, then to OFF/default.
 *
 * @param {object} source - task payload / opts
 * @param {object} options - { campaignId, log, label }
 * @returns {Promise<{requireAiForComments:boolean, targetedComments:boolean, source:string}>}
 */
export async function resolveCommentPolicy(source = {}, options = {}) {
    const { campaignId = null, log = null, label = 'policy' } = options;
    const has = (k) => Object.prototype.hasOwnProperty.call(source || {}, k) && source[k] !== undefined && source[k] !== null && String(source[k]).trim() !== '';
    const hasRequire = has('requireAiForComments');
    const hasTargeted = has('targetedComments');

    let settings = null;
    if ((!hasRequire || !hasTargeted) && campaignId) {
        try {
            const cached = policyCache.get(campaignId);
            if (cached && (Date.now() - cached.at) < POLICY_CACHE_MS) {
                settings = cached.settings;
            } else {
                const result = await getCampaignSettings(campaignId);
                settings = result?.settings || null;
                // Legacy rows kept these toggles in the context column only.
                // Fall back there so an old campaign still honors its choices.
                if (settings) {
                    for (const key of ['requireAiForComments', 'targetedComments']) {
                        if (settings[key] !== undefined) continue;
                        try {
                            const rawContext = result?.campaignRow?.[String(result.headers || []).findIndex(h => String(h).trim().toLowerCase() === 'context')];
                            const legacy = typeof rawContext === 'string' ? JSON.parse(rawContext) : rawContext;
                            if (legacy && legacy[key] !== undefined) settings[key] = legacy[key];
                        } catch {}
                    }
                }
                policyCache.set(campaignId, { at: Date.now(), settings });
            }
        } catch (e) {
            log?.warn?.(`[${label}] campaign settings fallback failed: ${e.message}`);
        }
    }

    const requireAiForComments = hasRequire
        ? parseFlag(source.requireAiForComments)
        : parseFlag(settings?.requireAiForComments);
    const targetedComments = hasTargeted
        ? parseFlag(source.targetedComments)
        : parseFlag(settings?.targetedComments);

    const sourceName = (hasRequire && hasTargeted) ? 'task' : (settings ? 'sheet' : 'default');
    log?.info?.(`[${label}] requireAiForComments=${requireAiForComments ? 'ON' : 'OFF'} targetedComments=${targetedComments ? 'ON' : 'OFF'} source=${sourceName}${campaignId ? ` campaign=${campaignId}` : ''}`);
    return { requireAiForComments, targetedComments, source: sourceName };
}

/** Synchronous convenience for places that already carry both explicit flags. */
export function policyFromFlags(source = {}) {
    return {
        requireAiForComments: parseFlag(source.requireAiForComments),
        targetedComments: parseFlag(source.targetedComments),
        source: 'task',
    };
}

export default { resolveCommentPolicy, policyFromFlags, parseFlag };
