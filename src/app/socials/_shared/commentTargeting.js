// ==================== CENTRAL TARGET SCREENING ====================
// One AI call per post/thread decides which observed targets (comments, inbox
// messages, etc.) are worth replying to. Engine side is STRUCTURAL ONLY —
// the campaign's socialStrategyPrompt supplies all intents and voice.

import logger from '../../../utils/logger.js';

const DEFAULT_MAX_TARGETS = 30;

/** Stable key for a target (ID when present, else handle+text). */
export function targetKey(target) {
    if (!target) return '';
    if (target.id) return String(target.id).trim().toLowerCase();
    const user = String(target.username || target.displayName || target.name || '').trim().toLowerCase();
    return `${user}|${String(target.text || '').trim().slice(0, 80)}`.toLowerCase();
}

function buildTargetLines(targets) {
    return targets.map((t, i) => {
        const who = [t.displayName || t.name, t.username ? `@${String(t.username).replace(/^@+/, '')}` : '']
            .filter(Boolean).join(' ');
        const likes = t.likeCount ? ` likes=${String(t.likeCount).replace(/\D/g, '').slice(0, 8)}` : '';
        return `${i + 1}. ${who || 'unknown'}${likes}: ${String(t.text || '').slice(0, 300)}`;
    }).join('\n');
}

/**
 * Screen targets with AI. Fail-closed: any error/unparseable output approves
 * nothing (the caller keeps liking/reading, but sends no replies/messages).
 *
 * @param {object} opts
 *  - ai: MultiProviderAI instance/class with .generate
 *  - targets: array of {id, username, displayName, text, likeCount}
 *  - context: raw structural observations {postOwner, mediaAnalysis, ...}
 *  - socialStrategyPrompt: authoritative campaign prompt
 *  - maxTargets: cap on how many targets to send (default 30)
 *  - log, label
 * @returns {Promise<{approved:Set<string>, reasons:object, ok:boolean, error?:string, count:number}>}
 */
export async function screenTargets({
    ai = null,
    targets = [],
    context = {},
    socialStrategyPrompt = '',
    maxTargets = DEFAULT_MAX_TARGETS,
    log = logger,
    label = 'targeting',
} = {}) {
    const list = Array.isArray(targets) ? targets.filter(t => t && String(t.text || '').trim()) : [];
    const result = {
        approved: new Set(),
        reasons: {},
        ok: false,
        count: 0,
    };
    if (!list.length) {
        result.ok = true;
        return result;
    }
    if (!ai || typeof ai.generate !== 'function') {
        result.error = 'no_ai_provider';
        log.warn(`[${label}] target screening unavailable (no AI) — skipping all replies (fail-closed).`);
        return result;
    }

    const capped = list.slice(0, Math.max(1, parseInt(maxTargets, 10) || DEFAULT_MAX_TARGETS));
    const contextLines = Object.entries(context || {})
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim())
        .map(([k, v]) => `${k}: ${String(v).slice(0, 1200)}`);

    const prompt = [
        'CAMPAIGN VOICE & INTENTS (AUTHORITATIVE — use it to decide which targets are on-topic):',
        String(socialStrategyPrompt || '(none configured — approve only clearly relevant targets)').trim(),
        '',
        'PLACEMENT (structural facts only): these are public comments/messages found in a conversation thread. Decide which ones warrant a reply from this campaign account. Do not write any reply text.',
        'OBSERVED CONTEXT:',
        ...contextLines,
        '',
        'TARGETS (numbered):',
        buildTargetLines(capped),
        '',
        'Respond with ONLY JSON: {"approved":[<numbers of targets to reply to>],"reason":"one short sentence explaining the selection"}',
        'Approve only targets that align with the campaign voice/intents. Return [] if none qualify. Do not include commentary outside JSON.',
    ].join('\n');

    try {
        const raw = await ai.generate(prompt, {
            jsonMode: true,
            maxTokens: 400,
            timeoutMs: 60000,
            maxTransientAttempts: 1,
        });
        const text = String(raw || '');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end <= start) {
            result.error = 'unparseable_screening_response';
            log.warn(`[${label}] target screening response was not JSON — skipping all replies (fail-closed).`);
            return result;
        }
        const parsed = JSON.parse(text.slice(start, end + 1));
        let approvedIndexes = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed.approved) ? parsed.approved : []);
        approvedIndexes = approvedIndexes
            .map(v => (typeof v === 'number' ? v - 1 : parseInt(String(v).replace(/^#/, ''), 10) - 1))
            .filter(n => Number.isInteger(n) && n >= 0 && n < capped.length);
        for (const n of approvedIndexes) {
            const t = capped[n];
            const key = targetKey(t);
            if (key) result.approved.add(key);
        }
        result.reasons = { summary: String(parsed.reason || '').slice(0, 300) };
        result.ok = true;
        result.count = approvedIndexes.length;
        log.info(`[${label}] Screened ${capped.length} target(s) → ${result.count} approved${result.reasons.summary ? ` (${result.reasons.summary})` : ''}.`);
        return result;
    } catch (e) {
        result.error = e.message;
        log.warn(`[${label}] target screening failed (${e.message}) — skipping all replies (fail-closed).`);
        return result;
    }
}

/** Is this target approved by a screening result? */
export function isTargetApproved(result, target) {
    if (!result || !result.ok) return false;
    const key = targetKey(target);
    return !!key && result.approved.has(key);
}

export default { screenTargets, targetKey, isTargetApproved };
