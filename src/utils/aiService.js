import axios from 'axios';
import logger from './logger.js';
import { getSheetDataApi, updateSheetRowApi } from '../app/api/googlesheets.js';

// ============================================================
// CENTRALIZED AI SERVICE
// Columns: aiSn | aiProvider | aiModel | aiService | aiKey | aiStatus | aiLastRun | aiLimitRetry
//
// STATUS RULES:
//   RATE-LIMITED → only on quota/rate-limit errors (429, "rate limit", "quota exceeded")
//   FAILED       → on other errors (bad key, model not found, auth, etc.)
//   ACTIVE       → working fine
//
// RETRY RULES:
//   RATE-LIMITED → retry after aiLimitRetry hours (per-row, e.g. 6, 12, 18)
//   FAILED       → retry after 24 hours (mandatory)
// ============================================================

const FAILED_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

function getEnvFallback(provider) {
    if (provider === 'opencode') {
        return process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || '';
    }
    if (provider === 'gemini') {
        return process.env.GOOGLE_GEMINI_API_KEY || '';
    }
    return '';
}

class AIService {
    constructor() {
        this.providers = [];
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
            const result = await getSheetDataApi('SETTINGS');
            if (!result.success || !result.data) {
                logger.warn('[AIService] Failed to load settings or empty sheet');
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

            if (aiSnIdx === -1 || aiProviderIdx === -1 || aiModelIdx === -1 || aiKeyIdx === -1) {
                logger.warn('[AIService] SETTINGS missing required columns');
                return this.settingsCache || [];
            }

            const providers = [];

            for (const row of result.data) {
                const sn = parseInt(row[aiSnIdx]);
                const provider = (row[aiProviderIdx] || '').toLowerCase().trim();
                const model = (row[aiModelIdx] || '').trim();
                const service = (row[aiServiceIdx] || '').trim();
                const key = (row[aiKeyIdx] || '').trim() || getEnvFallback(provider);
                const status = (row[aiStatusIdx] || '').toUpperCase().trim();
                const lastRun = aiLastRunIdx !== -1 ? (row[aiLastRunIdx] || '').trim() : '';
                const limitRetryHours = aiLimitRetryIdx !== -1 ? parseInt(row[aiLimitRetryIdx]) || 0 : 0;

                if (!provider || !model || !key) continue;

                // ACTIVE → always include
                if (status === 'ACTIVE' || status === '') {
                    providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                    continue;
                }

                // RATE-LIMITED → retry after aiLimitRetry hours (per-row)
                if (status === 'RATE-LIMITED') {
                    if (!lastRun) {
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                        continue;
                    }
                    const cooldownMs = limitRetryHours > 0
                        ? limitRetryHours * 60 * 60 * 1000
                        : 60 * 60 * 1000; // default 1h if aiLimitRetry not set

                    if (this._isExpired(lastRun, cooldownMs)) {
                        logger.info(`[AIService] RATE-LIMITED cooldown expired (${limitRetryHours}h): ${provider}/${model} — retrying`);
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                    } else {
                        const hrs = this._remainingHours(lastRun, cooldownMs);
                        logger.debug(`[AIService] SKIP ${provider}/${model} RATE-LIMITED (${hrs}h left, cooldown: ${limitRetryHours}h)`);
                    }
                    continue;
                }

                // FAILED → retry after 24 hours mandatory
                if (status === 'FAILED') {
                    if (!lastRun) {
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                        continue;
                    }
                    if (this._isExpired(lastRun, FAILED_COOLDOWN_MS)) {
                        logger.info(`[AIService] FAILED 24h cooldown expired: ${provider}/${model} — retrying`);
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                    } else {
                        const hrs = this._remainingHours(lastRun, FAILED_COOLDOWN_MS);
                        logger.debug(`[AIService] SKIP ${provider}/${model} FAILED (${hrs}h left)`);
                    }
                    continue;
                }
            }

            providers.sort((a, b) => a.sn - b.sn);
            this.settingsCache = providers;
            this.cacheTime = now;
            logger.info(`[AIService] Loaded ${providers.length} providers from SETTINGS`);
            return providers;
        } catch (err) {
            logger.error(`[AIService] Error loading settings: ${err.message}`);
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
    // All recording is fire-and-forget — never blocks the caller.

    recordRateLimit(provider) {
        const ts = new Date().toISOString();
        logger.info(`[AIService] Recording RATE-LIMITED sn:${provider.sn} ${provider.provider}/${provider.model} at ${ts}`);
        updateSheetRowApi('SETTINGS', 'aiSn', String(provider.sn), {
            aiLastRun: ts,
            aiStatus: 'RATE-LIMITED'
        }).then(result => {
            if (result.success) {
                logger.info(`[AIService] ✓ RATE-LIMITED recorded for sn:${provider.sn}`);
            } else {
                logger.error(`[AIService] ✗ RATE-LIMITED record FAILED for sn:${provider.sn}: ${result.error}`);
            }
        }).catch(err => {
            logger.error(`[AIService] ✗ RATE-LIMITED record ERROR for sn:${provider.sn}: ${err.message}`);
        });
    }

    recordFailure(provider) {
        const ts = new Date().toISOString();
        logger.info(`[AIService] Recording FAILED sn:${provider.sn} ${provider.provider}/${provider.model} at ${ts}`);
        updateSheetRowApi('SETTINGS', 'aiSn', String(provider.sn), {
            aiLastRun: ts,
            aiStatus: 'FAILED'
        }).then(result => {
            if (result.success) {
                logger.info(`[AIService] ✓ FAILED recorded for sn:${provider.sn}`);
            } else {
                logger.error(`[AIService] ✗ FAILED record FAILED for sn:${provider.sn}: ${result.error}`);
            }
        }).catch(err => {
            logger.error(`[AIService] ✗ FAILED record ERROR for sn:${provider.sn}: ${err.message}`);
        });
    }

    recordSuccess(provider) {
        const ts = new Date().toISOString();
        updateSheetRowApi('SETTINGS', 'aiSn', String(provider.sn), {
            aiLastRun: ts,
            aiStatus: 'ACTIVE'
        }).then(result => {
            if (result.success) {
                logger.debug(`[AIService] ✓ SUCCESS recorded for sn:${provider.sn}`);
            } else {
                logger.warn(`[AIService] ✗ SUCCESS record FAILED for sn:${provider.sn}: ${result.error}`);
            }
        }).catch(err => {
            logger.error(`[AIService] ✗ SUCCESS record ERROR for sn:${provider.sn}: ${err.message}`);
        });
    }

    // ==================== ERROR CLASSIFICATION ====================

    isRateLimitError(err) {
        const status = err.response?.status;
        const msg = (err.message || '').toLowerCase();

        if (status === 429) return true;
        if (msg.includes('rate limit')) return true;
        if (msg.includes('too many requests')) return true;
        if (msg.includes('quota exceeded')) return true;
        if (msg.includes('resource exhausted')) return true;
        if (msg.includes('requests per minute')) return true;
        if (msg.includes('requests per day')) return true;
        if (msg.includes('rpm limit')) return true;
        if (msg.includes('tpm limit')) return true;

        return false;
    }

    isRecoverableError(err) {
        const status = err.response?.status;
        const msg = (err.message || '').toLowerCase();

        if (status === 401) return false;
        if (status === 403) return false;
        if (status === 404) return false;
        if (msg.includes('invalid api key')) return false;
        if (msg.includes('unauthorized')) return false;
        if (msg.includes('model not found')) return false;
        if (msg.includes('not found')) return false;
        if (msg.includes('invalid authentication')) return false;
        if (msg.includes('permission denied')) return false;

        return true;
    }

    // ==================== MAIN ENTRY ====================

    async generate(prompt, options = {}) {
        const {
            systemPrompt = '',
            imageUrl = null,
            imageBase64 = null,
            temperature = 0.7,
            maxTokens = 2000,
            preferProvider = null
        } = options;

        const providers = await this.loadProviders();
        if (providers.length === 0) {
            throw new Error('No AI providers available in SETTINGS sheet');
        }

        const messages = [];
        if (systemPrompt) {
            messages.push({ role: 'system', content: systemPrompt });
        }

        let userContent = prompt;
        if (imageBase64) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } }
                ]
            });
            userContent = null;
        } else if (imageUrl) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: imageUrl } }
                ]
            });
            userContent = null;
        }

        if (userContent !== null) {
            messages.push({ role: 'user', content: userContent });
        }

        // Try preferred provider first
        if (preferProvider) {
            const match = providers.find(p => p.provider === preferProvider);
            if (match) {
                try {
                    const result = await this._callProvider(match, messages, temperature, maxTokens);
                    this.lastProvider = match;
                    this.recordSuccess(match);
                    return result;
                } catch (err) {
                    logger.warn(`[AIService] Preferred ${preferProvider}/${match.model} failed: ${err.message}`);
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

            try {
                logger.info(`[AIService] Trying ${key} (sn:${provider.sn})...`);
                const result = await this._callProvider(provider, messages, temperature, maxTokens);
                this.lastProvider = provider;
                this.recordSuccess(provider);
                logger.info(`[AIService] Success with ${key}`);
                return result;
            } catch (err) {
                logger.warn(`[AIService] ${key} failed: ${err.message}`);
                await this._handleProviderError(provider, err);
                continue;
            }
        }

        throw new Error('All AI providers failed. Check SETTINGS sheet status and API keys.');
    }

    async _handleProviderError(provider, err) {
        if (this.isRateLimitError(err)) {
            this.recordRateLimit(provider);
        } else {
            this.recordFailure(provider);
        }
    }

    // ==================== PROVIDER DISPATCH ====================

    async _callProvider(provider, messages, temperature, maxTokens) {
        switch (provider.provider) {
            case 'opencode':
                return this._callOpenCode(provider, messages, temperature, maxTokens);
            case 'gemini':
                return this._callGemini(provider, messages, temperature, maxTokens);
            default:
                throw new Error(`Unknown provider: ${provider.provider}`);
        }
    }

    async _callOpenCode(provider, messages, temperature, maxTokens) {
        const { model, key } = provider;
        const response = await axios.post('https://opencode.ai/zen/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            timeout: 60000
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error(`Invalid OpenCode response: ${JSON.stringify(response.data).substring(0, 200)}`);
    }

    async _callGemini(provider, messages, temperature, maxTokens) {
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
        const payload = {
            contents,
            generationConfig: { maxOutputTokens: maxTokens, temperature }
        };
        if (sysMsg) {
            payload.systemInstruction = { parts: [{ text: sysMsg.content }] };
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        const response = await axios.post(url, payload, { timeout: 60000 });

        if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
            return response.data.candidates[0].content.parts[0].text;
        }
        throw new Error(`Invalid Gemini response: ${JSON.stringify(response.data).substring(0, 200)}`);
    }

    // ==================== HELPERS ====================

    async analyzeImage(imageBase64, prompt, options = {}) {
        return this.generate(prompt, { ...options, imageBase64 });
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

    async getProviderFromMx(mxRecords, domain) {
        const mxInfo = mxRecords.map(r => `${r.exchange}(${r.priority})`).join(', ');
        return this.generate(
            `Domain: ${domain}, MX: ${mxInfo}. Identify provider (Gmail/Outlook/Yahoo/etc). Return name only.`,
            { maxTokens: 50 }
        );
    }

    async generateComment(postContent, context = '') {
        return this.generate(
            `Post: ${postContent}\nContext: ${context}\nGenerate a natural comment (1-2 sentences):`,
            { systemPrompt: 'Social media expert.', maxTokens: 200 }
        );
    }

    async analyzePageContent(pageHtml, question) {
        return this.generate(
            `HTML: ${pageHtml.slice(0, 4000)}\nQuestion: ${question}`,
            { systemPrompt: 'Content analyst.', maxTokens: 1000 }
        );
    }

    getStatus() {
        return {
            providerCount: this.providers?.length || 0,
            lastProvider: this.lastProvider
                ? `${this.lastProvider.provider}/${this.lastProvider.model}`
                : null,
            failedCooldown: '24h'
        };
    }
}

const aiService = new AIService();
export default aiService;
