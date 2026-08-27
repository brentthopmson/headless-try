import axios from 'axios';
import logger from './logger.js';
import { updateSheetRowApi } from '../app/api/googlesheets.js';
import { getSettingsSheet, invalidateSettings } from './settingsCache.js';

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
    if (provider === 'opencode') return process.env.OPENCODE_API_KEY || process.env.OPENAI_API_KEY || '';
    if (provider === 'gemini') return process.env.GOOGLE_GEMINI_API_KEY || '';
    if (provider === 'groq') return process.env.GROQ_API_KEY || '';
    if (provider === 'cerebras') return process.env.CEREBRAS_API_KEY || '';
    if (provider === 'together') return process.env.TOGETHER_API_KEY || '';
    if (provider === 'mistral') return process.env.MISTRAL_API_KEY || '';
    if (provider === 'cloudflare') return process.env.CF_API_TOKEN || '';
    if (provider === 'cohere') return process.env.COHERE_API_KEY || '';
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

            if (aiSnIdx === -1 || aiProviderIdx === -1 || aiModelIdx === -1 || aiKeyIdx === -1) {
                logger.warn('[MultiProviderAI] SETTINGS missing required columns (aiSn, aiProvider, aiModel, aiKey)');
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

                // RATE-LIMITED → retry after aiLimitRetry hours
                if (status === 'RATE-LIMITED') {
                    if (!lastRun) {
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                        continue;
                    }
                    const cooldownMs = limitRetryHours > 0
                        ? limitRetryHours * 60 * 60 * 1000
                        : 60 * 60 * 1000;
                    if (this._isExpired(lastRun, cooldownMs)) {
                        logger.info(`[MultiProviderAI] RATE-LIMITED cooldown expired (${limitRetryHours}h): ${provider}/${model} — retrying`);
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                    } else {
                        const hrs = this._remainingHours(lastRun, cooldownMs);
                        logger.debug(`[MultiProviderAI] SKIP ${provider}/${model} RATE-LIMITED (${hrs}h left)`);
                    }
                    continue;
                }

                // FAILED → retry after 24 hours
                if (status === 'FAILED') {
                    if (!lastRun) {
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
                        continue;
                    }
                    if (this._isExpired(lastRun, FAILED_COOLDOWN_MS)) {
                        logger.info(`[MultiProviderAI] FAILED 24h cooldown expired: ${provider}/${model} — retrying`);
                        providers.push({ sn, provider, model, service, key, status: 'ACTIVE' });
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

    async _handleProviderError(provider, err) {
        if (this.isRateLimitError(err)) {
            this.recordRateLimit(provider);
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
            preferProvider = null
        } = options;

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
                    const result = await this._callProvider(match, messages, temperature, maxTokens);
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

            try {
                logger.info(`[MultiProviderAI] Trying ${key} (sn:${provider.sn})...`);
                const result = await this._callProvider(provider, messages, temperature, maxTokens);
                this.lastProvider = provider;
                this.recordSuccess(provider);
                logger.info(`[MultiProviderAI] Success with ${key}`);
                return result;
            } catch (err) {
                logger.warn(`[MultiProviderAI] ${key} failed: ${err.message}`);
                await this._handleProviderError(provider, err);
                continue;
            }
        }

        throw new Error('All AI providers failed. Check SETTINGS sheet status and API keys.');
    }

    // ==================== PROVIDER DISPATCH ====================

    async _callProvider(provider, messages, temperature, maxTokens) {
        switch (provider.provider) {
            case 'opencode': return this._callOpenCode(provider, messages, temperature, maxTokens);
            case 'gemini': return this._callGemini(provider, messages, temperature, maxTokens);
            case 'groq': return this._callGroq(provider, messages, temperature, maxTokens);
            case 'cerebras': return this._callCerebras(provider, messages, temperature, maxTokens);
            case 'together': return this._callTogether(provider, messages, temperature, maxTokens);
            case 'mistral': return this._callMistral(provider, messages, temperature, maxTokens);
            case 'cloudflare': return this._callCloudflare(provider, messages, temperature, maxTokens);
            case 'cohere': return this._callCohere(provider, messages, temperature, maxTokens);
            default: throw new Error(`Unknown provider type: ${provider.provider}`);
        }
    }

    // ==================== OPENCODE ====================

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

    // ==================== GEMINI ====================

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

    // ==================== GROQ ====================

    async _callGroq(provider, messages, temperature, maxTokens) {
        const { model, key } = provider;
        const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Groq response format');
    }

    // ==================== CEREBRAS ====================

    async _callCerebras(provider, messages, temperature, maxTokens) {
        const { model, key } = provider;
        const response = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Cerebras response format');
    }

    // ==================== TOGETHER ====================

    async _callTogether(provider, messages, temperature, maxTokens) {
        const { model, key } = provider;
        const response = await axios.post('https://api.together.xyz/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Together response format');
    }

    // ==================== MISTRAL ====================

    async _callMistral(provider, messages, temperature, maxTokens) {
        const { model, key } = provider;
        const response = await axios.post('https://api.mistral.ai/v1/chat/completions', {
            model, messages, temperature, max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });
        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error('Invalid Mistral response format');
    }

    // ==================== CLOUDFLARE ====================

    async _callCloudflare(provider, messages, temperature, maxTokens) {
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
            timeout: 30000
        });
        if (response.data?.success && response.data?.result?.response) {
            return response.data.result.response;
        }
        throw new Error('Invalid Cloudflare response format');
    }

    // ==================== COHERE ====================

    async _callCohere(provider, messages, temperature, maxTokens) {
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
            timeout: 30000
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
        const sample = Array.isArray(emailTexts) ? emailTexts.join('\n---\n').slice(0, 20000) : String(emailTexts || '').slice(0, 20000);
        if (!sample.trim()) return null;
        const prompt = `Analyze these email messages and return a financial summary as JSON only.
Return JSON:
{
  "boxFinancialSummary": { "mentionsOfTransactions": boolean, "identifiedPaymentMethods": string[], "potentialInvoiceCount": number },
  "averageTransactionAmount": number,
  "lastTransactionDate": "ISO or ''",
  "pendingTransactionsCount": number,
  "transactionBox": boolean
}
Emails:\n${sample}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'You are a forensic account analyst. Return only valid JSON.',
            maxTokens: 800
        });
        return this._parseJson(response);
    }

    async extractActivitiesAI(emailList) {
        const sample = Array.isArray(emailList) ? JSON.stringify(emailList).slice(0, 20000) : String(emailList || '').slice(0, 20000);
        if (!sample.trim()) return null;
        const prompt = `Given the last emails from an account, return a JSON array of activities (max 50).
Return JSON array only:
[ { "type": "READ|SENT", "on": "ISO date or ''", "to": "recipient or sender", "subject": "subject", "summary": "one-sentence summary" } ]
Emails:\n${sample}`;
        const response = await this.generate(prompt, {
            systemPrompt: 'You are a forensic account analyst. Return only valid JSON.',
            maxTokens: 1500
        });
        const arr = this._parseJson(response);
        return Array.isArray(arr) ? arr : null;
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
        const m = String(response).match(/\{[\s\S]*\}/);
        if (!m) return null;
        try { return JSON.parse(m[0]); } catch { return null; }
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
