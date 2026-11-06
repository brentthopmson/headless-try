import axios from 'axios';
import logger from './logger.js';
import { updateSheetRowApi } from '../app/api/googlesheets.js';
import { getSettingsSheet, invalidateSettings } from './settingsCache.js';
import aiCore from './multiProviderAICore.js';
import { callOllama } from './localAIClient.js';
import { getServerlessId } from './opencodeSettings.js';

const {
    TRANSIENT_MAX_ATTEMPTS,
    shouldRetryTransient,
    transientBackoffMs,
    shouldStripThinkingConfig,
    stripThinkingConfig,
} = aiCore;

// ============================================================
// MULTI-PROVIDER AI — SETTINGS-DRIVEN WATERFALL
//
// Reads provider configs from the SETTINGS sheet:
//   aiSn | aiProvider | aiModel | aiService | aiKey | aiStatus | aiLastRun | aiLimitRetry
//
// Supported provider types: opencode, gemini, groq, cerebras, together, mistral, cloudflare, cohere
//
// STATUS RULES:
//   RATE-LIMITED → retry after aiLimitRetry hours (per-row)
//   FAILED       → retry after 24 hours (mandatory)
//   ACTIVE       → working fine
// ============================================================

const FAILED_COOLDOWN_MS = 24 * 60 * 60 * 1000;

// Approximate tokens per character (English text averages ~4 chars per token)
const CHARS_PER_TOKEN = 4;

// Provider-specific context window limits (input tokens)
const PROVIDER_CONTEXT_WINDOWS = {
    opencode: 128000,
    gemini: 128000,
    groq: 8192,
    cerebras: 8192,
    together: 32000,
    mistral: 32000,
    cloudflare: 8192,
    cohere: 8192,
    ollama: 4096,
    local: 4096,
    lmstudio: 4096,
    vllm: 4096,
    llamacpp: 4096,
};

/**
 * Estimates token count from text. Approximation: ceil(text.length / CHARS_PER_TOKEN).
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function getEnvFallback(provider) {
    const p = String(provider || '').toLowerCase().trim();
    if (p === 'opencode') return process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || '';
    if (p === 'gemini') return process.env.GOOGLE_GEMINI_API_KEY || '';
    if (p === 'groq') return process.env.GROQ_API_KEY || '';
    if (p === 'cerebras') return process.env.CEREBRAS_API_KEY || '';
    if (p === 'together') return process.env.TOGETHER_API_KEY || '';
    if (p === 'mistral') return process.env.MISTRAL_API_KEY || '';
    if (p === 'cloudflare') return process.env.CF_API_TOKEN || '';
    if (p === 'cohere') return process.env.COHERE_API_KEY || '';
    if (p === 'ollama' || p === 'local' || p === 'lmstudio' || p === 'vllm' || p === 'llamacpp') {
        return process.env.OLLAMA_API_KEY || process.env.LOCAL_AI_API_KEY || '';
    }
    return '';
}

class MultiProviderAI {
    constructor() {
        this.settingsCache = null;
        this.cacheTime = 0;
        this.CACHE_TTL = 60000;
        this.lastProvider = null;
    }

    // ==================== SETTINGS LOADER ====================

    async loadProviders(forceRefresh = false) {
        const now = Date.now();
        if (!forceRefresh && this.settingsCache && (now - this.cacheTime < this.CACHE_TTL)) {
            return this.settingsCache;
        }

        try {
            const result = await getSettingsSheet(forceRefresh);
            if (!result || !result.data) {
                logger.warn('[MultiProviderAI] Failed to load settings or empty sheet');
                return this.settingsCache || [];
            }

            const headers = result.headers;
            const aiSnIdx = headers.indexOf('aiSn');
            const aiProviderIdx = headers.indexOf('aiProvider');
            const aiModelIdx = headers.indexOf('aiModel');
            const aiServiceIdx = headers.indexOf('aiService');
            const aiKeyIdx = headers.indexOf('aiKey');
            const aiStatusIdx = headers.indexOf('aiStatus');
            const aiLastRunIdx = headers.indexOf('aiLastRun');
            const aiLimitRetryIdx = headers.indexOf('aiLimitRetry');
            const aiBaseUrlIdx = headers.indexOf('aiBaseUrl');
            const aiTimeoutMsIdx = headers.indexOf('aiTimeoutMs');
            // Tolerant match: aiSeverlessId (sample spelling) / aiServerlessId / variants
            const aiServerlessIdIdx = headers.findIndex((h) => {
                const s = String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                return s === 'aiseverlessid' || s === 'aiserverlessid' || s === 'aiserverlessid';
            });

            if (aiSnIdx === -1 || aiProviderIdx === -1 || aiModelIdx === -1 || aiKeyIdx === -1) {
                logger.warn('[MultiProviderAI] SETTINGS missing required columns (aiSn, aiProvider, aiModel, aiKey)');
                return this.settingsCache || [];
            }

            const serverlessId = getServerlessId();
            const providers = [];

            for (const row of result.data) {
                const sn = parseInt(row[aiSnIdx]);
                const provider = (row[aiProviderIdx] || '').toLowerCase().trim();
                const model = (row[aiModelIdx] || '').trim();
                const service = (row[aiServiceIdx] || '').trim();
                let key = (row[aiKeyIdx] || '').trim() || getEnvFallback(provider);
                const status = (row[aiStatusIdx] || '').toUpperCase().trim();
                const lastRun = aiLastRunIdx !== -1 ? (row[aiLastRunIdx] || '').trim() : '';
                const limitRetryHours = aiLimitRetryIdx !== -1 ? parseInt(row[aiLimitRetryIdx]) || 0 : 0;
                const baseUrl = aiBaseUrlIdx !== -1 ? (row[aiBaseUrlIdx] || '').trim() : '';
                const timeoutMs = aiTimeoutMsIdx !== -1 ? parseInt(row[aiTimeoutMsIdx]) || 0 : 0;
                const aiServerlessIdVal = aiServerlessIdIdx !== -1 ? String(row[aiServerlessIdIdx] || '').trim() : '';

                // Server-scope opencode rows: each server uses only its matching opencode row
                // (aiProvider=opencode AND aiSeverlessId/aiServerlessId == SERVERLESS_ID).
                // Never use another server's opencode row (prevents tunnel/key contention).
                if (provider === 'opencode') {
                    if (serverlessId) {
                        if (aiServerlessIdVal) {
                            if (aiServerlessIdVal.toLowerCase() !== serverlessId.toLowerCase()) continue; // other server's row
                        } else {
                            // Unscoped opencode row: allow only when it's the sole opencode row (compat)
                            const opRows = (result.data || []).filter((rr) => String(rr[aiProviderIdx] || '').toLowerCase().trim() === 'opencode');
                            if (opRows.length !== 1) continue;
                        }
                    }
                    // No SERVERLESS_ID env: don't enforce scoping (legacy/single-server). If multiple
                    // scoped opencode rows exist, prefer unscoped rows to avoid ambiguity.
                    else {
                        const opRows = (result.data || []).filter((rr) => String(rr[aiProviderIdx] || '').toLowerCase().trim() === 'opencode');
                        const scopedOpRows = aiServerlessIdIdx !== -1 ? opRows.filter((rr) => String(rr[aiServerlessIdIdx] || '').trim()) : [];
                        if (scopedOpRows.length > 0 && aiServerlessIdVal) continue; // ambiguous multi-server sheet without env: skip scoped
                    }
                }

                const isLocalProvider = ['ollama', 'local', 'lmstudio', 'llamacpp', 'vllm'].includes(provider);
                // Keyless only allowed for local/ollama providers
                if (!provider || !model) continue;
                if (!key && !isLocalProvider) continue;
                if (!key && isLocalProvider) {
                    key = '';
                } else if (key && key.includes('openai/glm-5.3') && provider === 'openai') {
                    // Keep sn 11 openai/glm-5.3 inert as requested
                    continue;
                }

                // ACTIVE → always include
                if (status === 'ACTIVE' || status === '') {
                    providers.push({ sn, provider, model, service, key, status: 'ACTIVE', baseUrl: baseUrl || undefined, timeoutMs: timeoutMs || undefined });
                    continue;
                }

                // RATE-LIMITED → retry after aiLimitRetry hours
                if (status === 'RATE-LIMITED') {
                    if (!lastRun) {
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE', baseUrl: baseUrl || undefined, timeoutMs: timeoutMs || undefined });
                        continue;
                    }
                    const cooldownMs = limitRetryHours > 0
                        ? limitRetryHours * 60 * 60 * 1000
                        : 60 * 60 * 1000;
                    if (this._isExpired(lastRun, cooldownMs)) {
                        logger.info(`[MultiProviderAI] RATE-LIMITED cooldown expired (${limitRetryHours}h): ${provider}/${model} — retrying`);
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE', baseUrl: baseUrl || undefined, timeoutMs: timeoutMs || undefined });
                    } else {
                        const hrs = this._remainingHours(lastRun, cooldownMs);
                        logger.debug(`[MultiProviderAI] SKIP ${provider}/${model} RATE-LIMITED (${hrs}h left)`);
                    }
                    continue;
                }

                // FAILED → retry after 24 hours
                if (status === 'FAILED') {
                    if (!lastRun) {
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE', baseUrl: baseUrl || undefined, timeoutMs: timeoutMs || undefined });
                        continue;
                    }
                    if (this._isExpired(lastRun, FAILED_COOLDOWN_MS)) {
                        logger.info(`[MultiProviderAI] FAILED 24h cooldown expired: ${provider}/${model} — retrying`);
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE', baseUrl: baseUrl || undefined, timeoutMs: timeoutMs || undefined });
                    } else {
                        const hrs = this._remainingHours(lastRun, FAILED_COOLDOWN_MS);
                        logger.debug(`[MultiProviderAI] SKIP ${provider}/${model} FAILED (${hrs}h left)`);
                    }
                    continue;
                }
            }

            providers.sort((a, b) => a.sn - b.sn);
            this.settingsCache = providers;
            this.cacheTime = now;
            logger.info(`[MultiProviderAI] Loaded ${providers.length} providers from SETTINGS`);
            return providers;
        } catch (err) {
            logger.error(`[MultiProviderAI] Error loading settings: ${err.message}`);
            return this.settingsCache || [];
        }
    }

    // ==================== COOLDOWN HELPERS ====================

    _isExpired(lastRunISO, cooldownMs) {
        const t = new Date(lastRunISO).getTime();
        if (isNaN(t)) return true;
        return (Date.now() - t) >= cooldownMs;
    }

    _remainingHours(lastRunISO, cooldownMs) {
        const t = new Date(lastRunISO).getTime();
        if (isNaN(t)) return '?';
        const left = cooldownMs - (Date.now() - t);
        return Math.max(0, (left / 3600000)).toFixed(1);
    }

    // ==================== STATUS RECORDING ====================

    async _appScriptWriteSettings(sn, values) {
        const appScriptUrl = process.env.SCRIPT_URL;
        const appScriptKey = process.env.SCRIPT_KEY;
        if (!appScriptUrl || !appScriptKey) return { success: false, error: 'No SCRIPT_URL/SCRIPT_KEY' };
        try {
            const params = new URLSearchParams({
                action: 'setMultipleCellDataByColumnSearch',
                sheetName: 'SETTINGS',
                searchColumn: 'aiSn',
                searchValue: String(sn),
                key: appScriptKey,
                data: JSON.stringify(values),
            });
            const resp = await axios.post(appScriptUrl, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 60000,
            });
            return { success: !!resp.data.success, error: resp.data.error || `HTTP ${resp.status}` };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }

    async _persistStatus(provider, status, label) {
        const ts = new Date().toISOString();
        const sn = String(provider.sn);
        const values = { aiLastRun: ts, aiStatus: status };
        logger.info(`[MultiProviderAI] Recording ${label} sn:${sn} ${provider.provider}/${provider.model}`);

        let result;
        try {
            result = await updateSheetRowApi('SETTINGS', 'aiSn', sn, values);
        } catch (e) {
            result = { success: false, error: e.message };
        }

        if (!result.success) {
            logger.warn(`[MultiProviderAI] ${label} via Sheets API failed (${result.error}) — trying App Script fallback`);
            const fallback = await this._appScriptWriteSettings(sn, values);
            if (!fallback.success) {
                logger.error(`[MultiProviderAI] ${label} FAILED for sn:${sn} via both methods: ${fallback.error}`);
                return false;
            }
        }

        invalidateSettings();
        return true;
    }

    recordSuccess(provider) {
        this._persistStatus(provider, 'ACTIVE', 'SUCCESS').catch(err => {
            logger.error(`[MultiProviderAI] SUCCESS record ERROR sn:${provider.sn}: ${err.message}`);
        });
    }

    recordRateLimit(provider) {
        this._persistStatus(provider, 'RATE-LIMITED', 'RATE-LIMITED').catch(err => {
            logger.error(`[MultiProviderAI] RATE-LIMITED record ERROR sn:${provider.sn}: ${err.message}`);
        });
    }

    recordFailure(provider) {
        this._persistStatus(provider, 'FAILED', 'FAILED').catch(err => {
            logger.error(`[MultiProviderAI] FAILED record ERROR sn:${provider.sn}: ${err.message}`);
        });
    }

    // ==================== ERROR CLASSIFICATION ====================

    isRateLimitError(err) {
        const status = err.response?.status;
        const msg = (err.message || '').toLowerCase();
        if (status === 429) return true;
        if (msg.includes('rate limit') || msg.includes('too many requests')) return true;
        if (msg.includes('quota exceeded') || msg.includes('resource exhausted')) return true;
        if (msg.includes('requests per minute') || msg.includes('requests per day')) return true;
        if (msg.includes('rpm limit') || msg.includes('tpm limit')) return true;
        return false;
    }

    isRecoverableError(err) {
        const status = err.response?.status;
        const msg = (err.message || '').toLowerCase();
        if (status === 401 || status === 403 || status === 404) return false;
        if (msg.includes('invalid api key') || msg.includes('unauthorized')) return false;
        if (msg.includes('model not found') || msg.includes('not found')) return false;
        if (msg.includes('invalid authentication') || msg.includes('permission denied')) return false;
        return true;
    }

    isTransientError(err) {
        const status = err.response?.status;
        if (status >= 500 && status < 600) return true;
        const msg = (err.message || '').toLowerCase();
        return msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnreset')
            || msg.includes('etimedout') || msg.includes('socket hang up')
            || msg.includes('econnrefused') || msg.includes('network error');
    }

    async _handleProviderError(provider, err) {
        if (this.isRateLimitError(err)) {
            this.recordRateLimit(provider);
        } else if (this.isTransientError(err)) {
            // 5xx/timeouts are temporary — never write FAILED status (that would
            // poison the provider's cooldown for 24h after a single blip).
            logger.warn(`[MultiProviderAI] Transient error for ${provider.provider}/${provider.model} (${err.message}) — status left unchanged`);
        } else {
            this.recordFailure(provider);
        }
    }

    // ==================== MAIN ENTRY ====================

    async generate(prompt, options = {}) {
        const {
            systemPrompt = "You are a helpful assistant.",
            chatHistory = [],
            maxTokens = 2000,
            temperature = 0.7,
            imageUrl = null,
            videoUrl = null,
            imageBase64 = null,
            preferProvider = null,
            // Per-call overrides (defaults preserve existing behavior). Low-stakes
            // calls (e.g. per-comment replies) pass a short timeoutMs + no retry
            // so a hung/rate-limited provider can't block the interaction flow.
            timeoutMs = null,
            maxTransientAttempts = TRANSIENT_MAX_ATTEMPTS,
            jsonMode = false,
        } = options;
        const effTimeoutMs = (Number.isFinite(timeoutMs) && timeoutMs > 0) ? timeoutMs : null;
        const effAttempts = (Number.isFinite(maxTransientAttempts) && maxTransientAttempts > 0)
            ? Math.floor(maxTransientAttempts)
            : TRANSIENT_MAX_ATTEMPTS;
        this._lastOptionsJsonMode = !!jsonMode;

        logger.info(`[MultiProviderAI] Generating response. Prefer: ${preferProvider || 'auto'}, Has image: ${!!imageUrl}, Has video: ${!!videoUrl}`);

        const providers = await this.loadProviders();
        if (providers.length === 0) {
            throw new Error('No AI providers available in SETTINGS sheet');
        }

        // Build messages array
        let messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        // Add chat history (last 8 messages to save tokens)
        if (Array.isArray(chatHistory)) {
            const recentHistory = chatHistory.slice(-8);
            recentHistory.forEach(msg => {
                messages.push({
                    role: msg.role || (msg.chatter === 'user' ? 'user' : 'assistant'),
                    content: msg.content || msg.message
                });
            });
        }

        // Build final message with media
        if (imageBase64) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
                ]
            });
        } else if (imageUrl) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: `[Image: ${imageUrl}]\n\n${prompt}` },
                ]
            });
        } else if (videoUrl) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: `[Video: ${videoUrl}]\n\n${prompt}` },
                ]
            });
        } else {
            messages.push({ role: 'user', content: prompt });
        }

        // Token estimation and truncation
        const maxInputTokens = options.maxInputTokens || 6000;
        const fullText = messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join(' ');
        const estimatedInputTokens = estimateTokens(fullText);

        if (estimatedInputTokens > maxInputTokens) {
            logger.warn(`[MultiProviderAI] Prompt too long: ~${estimatedInputTokens} tokens exceeds limit ${maxInputTokens}. Truncating.`);
            // Truncate the last user message content
            const lastMsg = messages[messages.length - 1];
            if (typeof lastMsg.content === 'string') {
                const maxChars = maxInputTokens * CHARS_PER_TOKEN;
                lastMsg.content = lastMsg.content.slice(0, maxChars) + '\n\n[Truncated due to token limit]';
            }
        }

        // Try preferred provider first
        if (preferProvider) {
            const match = providers.find(p => p.provider === preferProvider);
            if (match) {
                try {
                    logger.info(`[MultiProviderAI] Attempting preferred provider: ${preferProvider}/${match.model}`);
                    const result = await this._callProvider(match, messages, temperature, maxTokens, effTimeoutMs);
                    this.lastProvider = match;
                    this.recordSuccess(match);
                    return result;
                } catch (err) {
                    logger.warn(`[MultiProviderAI] Preferred ${preferProvider}/${match.model} failed: ${err.message}`);
                    await this._handleProviderError(match, err);
                }
            }
        }

        // Waterfall
        const tried = new Set();
        for (const provider of providers) {
            const key = `${provider.provider}/${provider.model}`;
            if (tried.has(key)) continue;
            tried.add(key);

            const isLocal = ['ollama', 'local', 'lmstudio', 'llamacpp', 'vllm'].includes(provider.provider);
            const maxAtt = isLocal ? 1 : effAttempts;

            // 3 tries: 503 "high demand" spikes from Gemini regularly outlast a
            // single 2s retry, so back off 2s then 4s before giving up on the row.
            for (let attempt = 0; attempt < maxAtt; attempt++) {
                try {
                    if (attempt > 0) {
                        logger.warn(`[MultiProviderAI] ${key} transient failure — retrying (attempt ${attempt + 1}/${maxAtt})`);
                        await new Promise(r => setTimeout(r, transientBackoffMs(attempt)));
                    }
                    logger.info(`[MultiProviderAI] Trying ${key} (sn:${provider.sn})...`);
                    const result = await this._callProvider(provider, messages, temperature, maxTokens, effTimeoutMs);
                    this.lastProvider = provider;
                    this.recordSuccess(provider);
                    logger.info(`[MultiProviderAI] Success with ${key}`);
                    return result;
                } catch (err) {
                    const transient = this.isTransientError(err) && !this.isRateLimitError(err);
                    logger.warn(`[MultiProviderAI] ${key} failed: ${err.message}`);
                    if (shouldRetryTransient(transient, attempt) && attempt < maxAtt - 1) continue;
                    await this._handleProviderError(provider, err);
                    break;
                }
            }
        }

        throw new Error('All AI providers failed. Check SETTINGS sheet status and API keys.');
    }

    // ==================== PROVIDER DISPATCH ====================

    async _callProvider(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const isLocal = ['ollama', 'local', 'lmstudio', 'llamacpp', 'vllm'].includes(provider.provider);
        if (isLocal) {
            let localMaxTokens = maxTokens;
            if (provider.provider === 'ollama') {
                // Cloudflare proxied tunnel has ~100s timeout; clamp to avoid 524
                const isProxied = String(provider.baseUrl || '').includes('trycloudflare.com');
                localMaxTokens = Math.min(maxTokens, isProxied ? 700 : 1200);
            }
            // Apply input clamp
            const maxInputTokens = Math.min(this._getMaxInputTokens(provider), 3000);
            // messages are already built; if needed could truncate - but keep simple
            return callOllama(provider, messages, temperature, localMaxTokens, timeoutMs || provider.timeoutMs, { jsonMode: this._lastOptionsJsonMode });
        }
        switch (provider.provider) {
            case 'opencode': return this._callOpenCode(provider, messages, temperature, maxTokens, timeoutMs);
            case 'gemini': return this._callGemini(provider, messages, temperature, maxTokens, timeoutMs);
            case 'groq': return this._callGroq(provider, messages, temperature, maxTokens, timeoutMs);
            case 'cerebras': return this._callCerebras(provider, messages, temperature, maxTokens, timeoutMs);
            case 'together': return this._callTogether(provider, messages, temperature, maxTokens, timeoutMs);
            case 'mistral': return this._callMistral(provider, messages, temperature, maxTokens, timeoutMs);
            case 'cloudflare': return this._callCloudflare(provider, messages, temperature, maxTokens, timeoutMs);
            case 'cohere': return this._callCohere(provider, messages, temperature, maxTokens, timeoutMs);
            default: throw new Error(`Unknown provider type: ${provider.provider}`);
        }
    }

    _getMaxInputTokens(provider) {
        if (['ollama', 'local', 'lmstudio', 'llamacpp', 'vllm'].includes(provider.provider)) {
            const envLimit = process.env.LOCAL_MAX_INPUT_TOKENS ? parseInt(process.env.LOCAL_MAX_INPUT_TOKENS) : null;
            return envLimit || 3000;
        }
        return 6000;
    }

    // ==================== OPENCODE ====================
    // opencode serve (tunnel/local, Basic auth opencode:<password>, session+message API).
    // Configured mode when SETTINGS aiBaseUrl is set and aiKey = OPENCODE_SERVER_PASSWORD.
    // Intra-provider waterfall: tries multiple opencode models before falling to next aiSn row.
    // Zen cloud (Bearer) fallback only when no serve aiBaseUrl is configured.

    _opencodeAuthHeader(password) {
        return `Basic ${Buffer.from(`opencode:${String(password || '')}`).toString('base64')}`;
    }

    _flattenMessagesToPrompt(messages) {
        if (!Array.isArray(messages)) return String(messages || '');
        const parts = [];
        for (const m of messages) {
            if (!m) continue;
            const role = m.role || 'user';
            const c = m.content;
            let text = '';
            if (typeof c === 'string') text = c;
            else if (Array.isArray(c)) text = c.map(p => (p && p.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
            else if (c && typeof c === 'object') text = c.text || c.content || '';
            if (text) parts.push(`${role}: ${text}`);
        }
        return parts.join('\n\n').trim();
    }

    _opencodeErr(message, status, extra = {}) {
        const e = new Error(String(message || 'opencode_error'));
        if (status != null) e.status = status;
        Object.assign(e, extra);
        return e;
    }

    async _opencodeFetchJson(baseUrl, path, { method = 'GET', headers, body, timeoutMs = 15000, signal } = {}) {
        const base = String(baseUrl || '').replace(/\/+$/, '');
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetch(`${base}${path}`, {
                method,
                headers,
                body: body != null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
                signal: signal || controller.signal,
            });
            const ct = String(res.headers.get('content-type') || '').toLowerCase();
            let json = null;
            if (ct.includes('application/json')) { try { json = await res.json(); } catch {} }
            else { try { const txt = await res.text(); if (txt) json = { _text: txt.slice(0, 300) }; } catch {} }
            return { ok: res.ok, status: res.status, json, ct };
        } catch (e) {
            if (e?.name === 'AbortError') throw this._opencodeErr('opencode_timeout', 408, { retryableModel: true });
            throw this._opencodeErr(e?.message || 'opencode_network_error', null, { retryableModel: true, code: e?.code });
        } finally {
            clearTimeout(t);
        }
    }

    async _discoverOpencodeModels(baseUrl, password, timeoutMs = 12000) {
        const cache = (this._opencodeModelCache = this._opencodeModelCache || new Map());
        const key = String(baseUrl || '');
        const hit = cache.get(key);
        if (hit && (Date.now() - hit.at) < 120000) return hit.models;
        const headers = { Authorization: this._opencodeAuthHeader(password), Accept: 'application/json' };
        const models = [];
        const seen = new Set();
        const add = (id, meta = {}) => {
            const v = String(id || '').trim();
            if (!v || seen.has(v)) return;
            seen.add(v);
            models.push({ id: v, ...meta });
        };
        let authFail = null;
        for (const path of ['/provider', '/config/providers']) {
            try {
                const r = await this._opencodeFetchJson(baseUrl, path, { headers, timeoutMs });
                if (this._isOpencodeAuthError(null, r.status)) { authFail = this._opencodeErr(r.json?.message || 'opencode_auth_failed', r.status); continue; }
                if (!r.ok || !r.json) continue;
                const providers = Array.isArray(r.json?.all) ? r.json.all
                    : Array.isArray(r.json?.providers) ? r.json.providers
                    : Array.isArray(r.json) ? r.json : [];
                for (const p of providers) {
                    const pid = String(p?.id || p?.providerID || '').trim();
                    const m = p?.models;
                    if (m && typeof m === 'object' && !Array.isArray(m)) {
                        for (const [mid, mv] of Object.entries(m)) {
                            const id = String(mv?.id || mid || '').trim();
                            if (!id) continue;
                            add(id, { providerID: pid || mv?.providerID });
                            if (pid) add(`${pid}/${id}`, { providerID: pid, modelID: id });
                        }
                    } else if (Array.isArray(m)) {
                        for (const mv of m) {
                            const id = String(mv?.id || mv?.modelID || mv?.name || '').trim();
                            if (!id) continue;
                            add(id, { providerID: pid || mv?.providerID });
                            if (pid) add(`${pid}/${id}`, { providerID: pid, modelID: id });
                        }
                    }
                }
                if (models.length) break; // got usable discovery
            } catch (e) { if (this._isOpencodeAuthError(e, e?.status)) authFail = e; }
        }
        if (!models.length && authFail) throw authFail;
        cache.set(key, { at: Date.now(), models });
        return models;
    }

    _buildOpencodeCandidates(configuredModel, discovered) {
        const out = [];
        const seen = new Set();
        const push = (id) => { const v = String(id || '').trim(); if (!v || seen.has(v)) return; seen.add(v); out.push(v); };
        push(configuredModel);
        // Prefer free/flash/fast/community models from discovery after the configured one.
        const scored = (discovered || []).map(m => {
            const id = String(m.id || '');
            const l = id.toLower();
            let s = 0;
            if (l.includes('free')) s += 5;
            if (l.includes('flash')) s += 3;
            if (l.includes('mini') || l.includes('fast') || l.includes('lite')) s += 2;
            if (l.includes('preview')) s -= 1;
            return { id, s };
        }).sort((a, b) => b.s - a.s || a.id.localeCompare(b.id));
        for (const m of scored) push(m.id);
        // Safe hints (tried only if present/accepted; 404 just moves on)
        for (const hint of ['opencode-go/iceman-contributor-free','opencode-go/beam-free','opencode-go/deepseek-v4.1-flash','opencode-go/glm-5.3-flash','big-pickle','mimo-v2.5-free']) push(hint);
        return out;
    }

    _isOpencodeAuthError(err, status) {
        const s = status ?? err?.status;
        if (s === 401 || s === 403) return true;
        const m = String(err?.message || '').toLowerCase();
        return m.includes('unauthorized') || m.includes('authentication required') || m.includes('_tag":"unauthorizederror');
    }

    _isOpencodeModelRetryable(err, status) {
        if (err?.retryableModel) return true;
        const s = status ?? err?.status;
        if ([404,408,409,425,429,500,502,503,504].includes(Number(s))) return true;
        const m = String(err?.message || '').toLowerCase();
        return /rate.?limit|quota|too many|overload|high demand|unavailable|model.?not.?found|unknown.?model|no such model|not supported|timeout|temporar|try again|capacity|opencode_serve_http_5|opencode_timeout/.test(m);
    }

    async _callOpenCodeServe(baseUrl, password, model, prompt, timeoutMs) {
        const headers = {
            Authorization: this._opencodeAuthHeader(password),
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
        // 1) create session
        const cs = await this._opencodeFetchJson(baseUrl, '/api/session', { method: 'POST', headers, body: {}, timeoutMs: Math.min(15000, timeoutMs || 15000) });
        if (!cs.ok) throw this._opencodeErr(cs.json?.message || `opencode_serve_http_${cs.status}`, cs.status, { phase: 'session', retryableModel: cs.status >= 500 || cs.status === 429 || cs.status === 408 });
        const sid = cs.json?.data?.id || cs.json?.id;
        if (!sid) throw this._opencodeErr('opencode_no_session_id', 502, { retryableModel: true });
        // 2) send message (try a couple of model shapes for compatibility)
        const modelPayloads = [];
        if (model && typeof model === 'object') modelPayloads.push(model);
        else if (model) {
            modelPayloads.push(String(model));
            if (String(model).includes('/')) {
                const [providerID, ...rest] = String(model).split('/');
                const id = rest.join('/');
                if (providerID && id) modelPayloads.push({ providerID, id });
            }
        } else modelPayloads.push(undefined);
        let last = null;
        for (const mp of modelPayloads) {
            const msgBody = { parts: [{ type: 'text', text: String(prompt || '') }], ...(mp ? { model: mp } : {}) };
            for (const path of [`/session/${sid}/message`, `/api/session/${sid}/message`]) {
                const mr = await this._opencodeFetchJson(baseUrl, path, { method: 'POST', headers, body: msgBody, timeoutMs: timeoutMs || 120000 });
                if (this._isOpencodeAuthError(null, mr.status)) throw this._opencodeErr('opencode_auth_failed', mr.status);
                if (!mr.ok) { last = this._opencodeErr(mr.json?.message || mr.json?._text || `opencode_msg_http_${mr.status}`, mr.status, { retryableModel: this._isOpencodeModelRetryable(null, mr.status) }); continue; }
                const mj = mr.json || {};
                const apiErr = mj?.info?.error || mj?.error;
                if (apiErr && typeof apiErr === 'object') {
                    const msg = apiErr?.data?.message || apiErr?.message || apiErr?.name || 'opencode_api_error';
                    const rs = Number(apiErr?.status) || ( /not.?found|unknown.?model/i.test(String(msg)) ? 404 : (/rate|quota/i.test(String(msg)) ? 429 : 502) );
                    last = this._opencodeErr(msg, rs, { retryableModel: this._isOpencodeModelRetryable({ message: msg, status: rs }, rs), apiError: apiErr });
                    continue;
                }
                if (Array.isArray(mj?.parts)) {
                    const text = mj.parts.filter(p => p && p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('').trim();
                    if (text) return text;
                }
                const direct = mj?.text || mj?.content || mj?.response;
                if (typeof direct === 'string' && direct.trim()) return direct.trim();
                return '';
            }
        }
        throw last || this._opencodeErr('opencode_no_response', 502, { retryableModel: true });
    }

    async _callOpenCode(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key, baseUrl } = provider;
        const prompt = this._flattenMessagesToPrompt(messages);
        const pwd = String(key || '').trim();
        const perModelTimeoutMs = Math.min(Math.max(parseInt(timeoutMs || provider?.timeoutMs || 45000, 10) || 45000, 15000), 90000);

        const serveBases = [];
        if (baseUrl && /^https?:\/\//i.test(String(baseUrl))) serveBases.push(String(baseUrl).replace(/\/+$/, ''));
        serveBases.push('http://127.0.0.1:4096');

        if (pwd) {
            // Resolve a working serve endpoint first (tunnel -> local).
            let activeBase = null;
            let authErr = null;
            for (const base of serveBases) {
                try {
                    // cheap auth/connectivity probe; discovery doubles as probe
                    const discovered = await this._discoverOpencodeModels(base, pwd, 12000);
                    activeBase = base;
                    // proceed with waterfall on this base
                    var _discovered = discovered; // eslint-disable-line no-var
                    break;
                } catch (e) {
                    if (this._isOpencodeAuthError(e, e?.status)) { authErr = e; logger.warn(`[MultiProviderAI] opencode serve auth failed at ${base}: ${e.message}`); }
                    else { logger.warn(`[MultiProviderAI] opencode serve probe failed at ${base}: ${e.message}`); }
                }
            }
            // If discovery-based probe didn't select (e.g. discovery threw network but endpoint may still take sessions), still try bases.
            const basesToTry = activeBase ? [activeBase] : serveBases;
            if (!activeBase && authErr && baseUrl && /^https?:\/\//i.test(String(baseUrl))) {
                throw authErr; // explicit serve config with auth failure -> don't misroute to Zen
            }

            const candidates = this._buildOpencodeCandidates(model, typeof _discovered !== 'undefined' ? _discovered : []);
            const limitedCandidates = candidates.slice(0, 8);
            let lastErr = null;
            let sawAuthErr = null;
            for (const base of basesToTry) {
                // refresh discovery per base if not already
                let discovered = (base === activeBase && typeof _discovered !== 'undefined') ? _discovered : null;
                if (!discovered) { try { discovered = await this._discoverOpencodeModels(base, pwd, 10000); } catch {} }
                const cands = base === activeBase ? limitedCandidates : this._buildOpencodeCandidates(model, discovered).slice(0, 8);
                for (let i = 0; i < cands.length; i++) {
                    const cm = cands[i];
                    try {
                        logger.info(`[MultiProviderAI] opencode serve trying model ${cm} (${i + 1}/${cands.length}) via ${base}`);
                        const text = await this._callOpenCodeServe(base, pwd, cm, prompt, perModelTimeoutMs);
                        logger.info(`[MultiProviderAI] opencode serve success with model ${cm} via ${base}`);
                        return text;
                    } catch (e) {
                        lastErr = e;
                        if (this._isOpencodeAuthError(e, e?.status)) { sawAuthErr = e; logger.warn(`[MultiProviderAI] opencode serve auth error via ${base} (model ${cm}): ${e.message}`); break; }
                        if (this._isOpencodeModelRetryable(e, e?.status) && i < cands.length - 1) {
                            logger.warn(`[MultiProviderAI] opencode model ${cm} failed (${e.message}) — trying next opencode model`);
                            continue;
                        }
                        if (!this._isOpencodeModelRetryable(e, e?.status)) {
                            // non-retryable for this model; still try next model unless it's clearly fatal config
                            logger.warn(`[MultiProviderAI] opencode model ${cm} error (${e.message}) — trying next candidate`);
                            continue;
                        }
                    }
                }
                if (sawAuthErr) break; // auth won't improve across models on same auth base; try next base? fall through
            }
            if (sawAuthErr && baseUrl && /^https?:\/\//i.test(String(baseUrl))) throw sawAuthErr;
            if (lastErr) throw lastErr;
            throw new Error('opencode serve: no models available');
        }

        // Zen cloud fallback (Bearer API key) — only when no serve password/path applies.
        const response = await axios.post('https://opencode.ai/zen/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: timeoutMs || 60000
        });
        if (response.data?.choices?.[0]?.message?.content) return response.data.choices[0].message.content;
        throw new Error(`Invalid OpenCode response: ${JSON.stringify(response.data).substring(0, 200)}`);
    }

    // ==================== GEMINI ====================

    async _callGemini(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;

        const contents = [];
        for (const msg of messages) {
            if (msg.role === 'system') continue;
            const role = msg.role === 'user' ? 'user' : 'model';

            if (Array.isArray(msg.content)) {
                const parts = [];
                for (const part of msg.content) {
                    if (part.type === 'text') {
                        parts.push({ text: part.text });
                    } else if (part.type === 'image_url') {
                        const url = part.image_url.url;
                        const idx = url.indexOf(';base64,');
                        if (idx !== -1) {
                            parts.push({
                                inlineData: {
                                    mimeType: url.substring(url.indexOf(':') + 1, idx),
                                    data: url.substring(idx + 8)
                                }
                            });
                        }
                    }
                }
                contents.push({ role, parts });
            } else {
                contents.push({ role, parts: [{ text: msg.content }] });
            }
        }

        const sysMsg = messages.find(m => m.role === 'system');
        const generationConfig = { maxOutputTokens: maxTokens, temperature };
        // Gemini 2.5/3.x count reasoning tokens inside maxOutputTokens — without
        // this, the thinking budget eats the entire allowance and the visible
        // answer is truncated to a couple of JSON objects (or pure prose).
        if (String(model).includes('2.5') || String(model).includes('3.')) {
            generationConfig.thinkingConfig = { thinkingBudget: 0 };
        }
        const payload = {
            contents,
            generationConfig
        };
        if (sysMsg) {
            payload.systemInstruction = { parts: [{ text: sysMsg.content }] };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        let response;
        try {
            response = await axios.post(url, payload, { timeout: timeoutMs || 60000 });
        } catch (err) {
            if (shouldStripThinkingConfig(err.response?.status, payload.generationConfig)) {
                logger.warn(`[MultiProviderAI] Gemini ${model} rejected thinkingConfig (400) — retrying without it`);
                stripThinkingConfig(payload.generationConfig);
                response = await axios.post(url, payload, { timeout: timeoutMs || 60000 });
            } else {
                throw err;
            }
        }

        const candidate = response.data?.candidates?.[0];
        if (candidate?.finishReason === 'MAX_TOKENS') {
            logger.warn(`[MultiProviderAI] Gemini ${model} finished with MAX_TOKENS — response truncated`);
        }
        if (candidate?.content?.parts?.[0]?.text) {
            return candidate.content.parts[0].text;
        }
        throw new Error(`Invalid Gemini response: ${JSON.stringify(response.data).substring(0, 200)}`);
    }

    // ==================== GROQ ====================

    async _callGroq(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs || 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Groq response format');
    }

    // ==================== CEREBRAS ====================

    async _callCerebras(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;
        const response = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs || 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Cerebras response format');
    }

    // ==================== TOGETHER ====================

    async _callTogether(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;
        const response = await axios.post('https://api.together.xyz/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs || 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Together response format');
    }

    // ==================== MISTRAL ====================

    async _callMistral(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs || 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Mistral response format');
    }

    // ==================== CLOUDFLARE ====================

    async _callCloudflare(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;
        // model format: " accountId/ai/run/@cf/meta/llama-3.1-8b-instruct "
        // or just the model part — extract accountId from key or model
        const accountId = provider.service || process.env.CF_ACCOUNT_ID || '';
        if (!accountId) throw new Error('Cloudflare accountId not configured (set aiService column or CF_ACCOUNT_ID env)');

        const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/${model}`;
        const response = await axios.post(url, {
            messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs || 30000
        });
        if (response.data?.success && response.data?.result?.response) {
            return response.data.result.response;
        }
        throw new Error('Invalid Cloudflare response format');
    }

    // ==================== COHERE ====================

    async _callCohere(provider, messages, temperature, maxTokens, timeoutMs = null) {
        const { model, key } = provider;
        const chatHistory = messages.slice(1, -1).map(msg => ({
            role: msg.role,
            message: msg.content
        }));
        const response = await axios.post('https://api.cohere.ai/v1/chat', {
            model,
            message: messages[messages.length - 1].content,
            chat_history: chatHistory,
            temperature
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: timeoutMs || 30000
        });
        if (response.data?.text) {
            return response.data.text;
        }
        throw new Error('Invalid Cohere response format');
    }

    // ==================== CONVENIENCE METHODS ====================

    async analyzeMedia(imageUrl, prompt, options = {}) {
        const systemPrompt = options.systemPrompt || `You are an expert visual analyst. Analyze the provided image/video and answer questions about content, objects, text, actions, sentiment, and relevant details.`;
        return this.generate(prompt, { ...options, imageUrl, systemPrompt });
    }

    async generateComment(postContent, context = '', options = {}) {
        const systemPrompt = options.systemPrompt || `You are a social media expert. Generate a natural, engaging comment that is authentic, relates to the post, encourages engagement, and is 1-2 sentences max.`;
        return this.generate(
            `Post: ${postContent}\nContext: ${context}\n\nGenerate a comment (natural, engaging, 1-2 sentences):`,
            { ...options, systemPrompt }
        );
    }

    async analyzePageContent(pageHtml, question, options = {}) {
        const systemPrompt = options.systemPrompt || `You are a content analyst. Analyze the page content and answer the user's question accurately and concisely.`;
        return this.generate(
            `Page HTML:\n${pageHtml.slice(0, 4000)}\n\nQuestion: ${question}`,
            { ...options, systemPrompt, maxTokens: 1000 }
        );
    }

    async analyzePageState(pageHtml, title, expectedState) {
        const prompt = `Analyze this webpage to determine if it's a "${expectedState}" page.
Title: ${title}
Content: ${pageHtml.substring(0, 1000)}
Return JSON: {"matches":false,"detectedState":"unknown","confidence":0,"analysis":"desc"}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'Return only valid JSON.',
            maxTokens: 500
        });
        const m = response.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch { return null; }
    }

    async getProviderFromMx(mxRecords, domain) {
        const mxInfo = mxRecords.map(r => `${r.exchange}(${r.priority})`).join(', ');
        return this.generate(
            `Domain: ${domain}, MX: ${mxInfo}. Identify provider (Gmail/Outlook/Yahoo/etc). Return name only.`,
            { maxTokens: 50 }
        );
    }

    async solveRecaptchaChallenge(screenshotBase64, context = 'challenge frame') {
        const prompt = `Solving reCAPTCHA. Screenshot shows ${context}.
Return JSON: {"type":"image_select","cells":[[1,2]],"grid_size":3}
Or: {"type":"dynamic_click","clicks":[[30,40]],"grid_size":null}
Or: {"type":"none","cells":[],"grid_size":null}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'Return only valid JSON.',
            imageBase64: screenshotBase64,
            maxTokens: 500
        });
        const m = response.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch { return null; }
    }

    async extractFinancialSummaryAI(emailTexts) {
        // 35k — the merged f1+f2+f3 content is ~31k chars; the old 20k slice
        // silently dropped batches 2 and 3 from the analysis.
        const sample = Array.isArray(emailTexts) ? emailTexts.join('\n---\n').slice(0, 35000) : String(emailTexts || '').slice(0, 35000);
        if (!sample.trim()) return null;
        const prompt = `Analyze these email messages (subjects, dates, senders, and full body excerpts) and return a financial summary as JSON only.

Rules:
- averageTransactionAmount: average of ALL money amounts actually found (plain number, currency-agnostic). If NO amounts appear anywhere, use 0 — do not invent values.
- highestTransactionAmount: the LARGEST single money amount actually found (plain number, same rules; 0 if none). Do not invent values.
- mailboxProfile: 2–4 sentences describing who owns this mailbox (name + business/role), what they do, and their key payment/payroll relationships (who pays them, who they pay, notable clients/vendors/employer named in the emails). Use ONLY evidence from the emails; '' if not enough info.
- Amounts look like: $1,234.56 / USD 99 / 250.00 / "total due $45.30". Parse them.
- lastTransactionDate: most recent transaction/payment/invoice date found (ISO yyyy-mm-dd, or '' if none).
- pendingTransactionsCount: invoices/payments described as pending, due, awaiting, unpaid, overdue or scheduled (0 if none).
- potentialInvoiceCount: count of invoice-like messages (invoice #, billing statement, attached invoice PDF).
- identifiedPaymentMethods: methods actually seen (visa, mastercard, paypal, bank transfer, stripe, apple pay...), lowercase; [] if none.
- mentionsOfTransactions / transactionBox: true only if real financial content exists.
Return JSON only:
{
  "boxFinancialSummary": { "mentionsOfTransactions": boolean, "identifiedPaymentMethods": string[], "potentialInvoiceCount": number },
  "averageTransactionAmount": number,
  "highestTransactionAmount": number,
  "mailboxProfile": "2-4 sentence description or ''",
  "lastTransactionDate": "ISO or ''",
  "pendingTransactionsCount": number,
  "transactionBox": boolean
}
Emails:\n${sample}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'You are a forensic account analyst. Return only valid JSON, no prose.',
            maxTokens: 8000
        });
        const parsed = this._parseJson(response);
        if (parsed) {
            logger.info(`[MultiProviderAI] extractFinancialSummaryAI parsed: amount=${parsed.averageTransactionAmount ?? '?'} high=${parsed.highestTransactionAmount ?? '?'} last=${parsed.lastTransactionDate || '?'} pending=${parsed.pendingTransactionsCount ?? '?'} invoices=${parsed.boxFinancialSummary?.potentialInvoiceCount ?? '?'} methods=${JSON.stringify(parsed.boxFinancialSummary?.identifiedPaymentMethods || [])} profile="${String(parsed.mailboxProfile || '').slice(0, 160)}"`);
        } else {
            logger.warn(`[MultiProviderAI] extractFinancialSummaryAI unparsable response: ${String(response || '').slice(0, 200)}`);
        }
        return parsed;
    }

    // Fallback when extractFinancialSummaryAI had no email text to analyze
    // (empty financialTexts) but box/personal/contacts data exists — the
    // mailbox profile is still derivable from that context.
    async generateMailboxProfileAI(context) {
        const sample = typeof context === 'string' ? context : JSON.stringify(context || {});
        if (!sample.trim()) return '';
        const prompt = `Based on this mailbox data (personal info, box summary, contacts, activities), write a 2-4 sentence profile of the mailbox owner: name + business/role, what they do, and their key payment/payroll relationships (who pays them, who they pay, notable clients/vendors/employer). Use ONLY evidence from the data; '' if not enough info. Return the profile text only, no JSON, no preamble.\n\nData:\n${sample.slice(0, 20000)}`;
        try {
            const response = await this.generate(prompt, {
                systemPrompt: 'You are a forensic account analyst. Return only the profile text.',
                maxTokens: 600
            });
            const profile = String(response || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
            logger.info(`[MultiProviderAI] generateMailboxProfileAI: ${profile.slice(0, 160)}`);
            return profile.slice(0, 1000);
        } catch (e) {
            logger.warn(`[MultiProviderAI] generateMailboxProfileAI failed: ${e.message}`);
            return '';
        }
    }

    async extractActivitiesAI(emailList, terms = []) {
        // Compact input: one truncated line per email so ALL results reach the
        // model. The old JSON.stringify().slice(0,20000) covered only ~10 of 55
        // items while the prompt demanded 50 outputs → the response got
        // truncated mid-array and failed to parse.
        const items = (Array.isArray(emailList) ? emailList : [String(emailList || '')])
            .filter(t => String(t || '').trim())
            .slice(0, 60)
            .map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, ' ').slice(0, 300)}`);
        if (!items.length) return null;
        const sample = items.join('\n');
        const termList = terms.length ? terms.join(', ') : 'invoice, payment, receipt, bank, transfer, paypal, zelle, venmo, transaction';
        const prompt = `These emails were found by searching for financial activity keywords (${termList}). They represent important financial activity in this mailbox.

Analyze EVERY email line below and return exactly ONE activity object per email, keeping the input order. Do not skip any email and do not merge several emails into one entry — if there are ${items.length} emails, return ${items.length} objects.
For each email, extract:
- type: "READ" for received emails, "SENT" for sent emails (infer from context)
- on: date if available, else ""
- to: recipient for sent emails, sender for received emails
- subject: email subject
- summary: ONE short sentence (max 15 words) with the financial details (amount, purpose, status, parties)

Return JSON array only — no prose, no code fence, compact summaries:
[ { "type": "READ|SENT", "on": "ISO date or ''", "to": "recipient or sender", "subject": "subject", "summary": "short summary" } ]

Emails:
${sample}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'You are a forensic financial analyst. Extract and classify financial transactions from email search results. Return only valid JSON with compact summaries.',
            maxTokens: 8000
        });
        let arr = this._parseJson(response);
        if (!Array.isArray(arr)) {
            arr = this._salvageJsonArray(response);
            if (Array.isArray(arr) && arr.length) {
                const raw = String(response || '');
                logger.warn(`[MultiProviderAI] extractActivitiesAI salvaged ${arr.length} complete activities from truncated/unparsable response; head=${raw.slice(0, 150)} | tail=${raw.slice(-150)}`);
            }
        }
        if (!Array.isArray(arr)) {
            const s = String(response || '');
            logger.warn(`[MultiProviderAI] extractActivitiesAI unparsable response: head=${s.slice(0, 150)} | tail=${s.slice(-150)}`);
            return null;
        }
        return arr;
    }

    // Recover complete {...} objects from a (possibly truncated) JSON array text.
    _salvageJsonArray(text) {
        const s = String(text || '');
        const out = [];
        let depth = 0, start = -1, inStr = false, esc = false;
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (c === '\\') esc = true;
                else if (c === '"') inStr = false;
                continue;
            }
            if (c === '"') { inStr = true; continue; }
            if (c === '{') { if (depth === 0) start = i; depth++; }
            else if (c === '}') {
                depth--;
                if (depth === 0 && start >= 0) {
                    try {
                        const obj = JSON.parse(s.slice(start, i + 1));
                        if (obj && typeof obj === 'object' && !Array.isArray(obj)) out.push(obj);
                    } catch (_) { /* malformed fragment — skip */ }
                    start = -1;
                }
            }
        }
        return out.length ? out : null;
    }

    async summarizeContactRelationship(threadText) {
        const sample = String(threadText || '').slice(0, 5000);
        if (!sample.trim()) return null;
        const prompt = `Summarize the relationship with this contact from their emails. Return JSON:
{ "relationshipSummary": "2-3 sentence summary", "company": "company if detectable else ''", "notes": "key facts" }
Emails:\n${sample}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'You are a relationship analyst. Return only valid JSON.',
            maxTokens: 500
        });
        return this._parseJson(response);
    }

    async inferAccountMetadata(rawText) {
        const sample = String(rawText || '').slice(0, 6000);
        if (!sample.trim()) return null;
        const prompt = `From this account page text, extract personal info as JSON:
{ "name": "", "recoveryEmail": "", "phone": "", "altEmails": [], "storageUsed": "", "createdAt": "" }
Page text:\n${sample}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'You are a data extractor. Return only valid JSON.',
            maxTokens: 500
        });
        return this._parseJson(response);
    }

    _parseJson(response) {
        if (!response) return null;
        // Strip markdown code fences (```json ... ```) — models wrap JSON constantly
        const s = String(response).replace(/```(?:json)?/gi, '').trim();
        try { return JSON.parse(s); } catch { /* fall through to extraction */ }
        // Array-shaped responses (activities) — extract the outer [...] first
        const ma = s.match(/\[[\s\S]*\]/);
        if (ma) { try { return JSON.parse(ma[0]); } catch { /* fall through */ } }
        const m = s.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { return null; } }
        return null;
    }

    getStatus() {
        return {
            providerCount: this.settingsCache?.length || 0,
            lastProvider: this.lastProvider
                ? `${this.lastProvider.provider}/${this.lastProvider.model}`
                : null,
            failedCooldown: '24h'
        };
    }
}

export default MultiProviderAI;
