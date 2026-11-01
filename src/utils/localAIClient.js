import axios from 'axios';
import logger from './logger.js';

let localDownUntil = 0;
let activeRequests = 0;
const MAX_CONCURRENT = 1;

function now() {
    return Date.now();
}

function normalizeBaseUrl(baseUrl) {
    if (!baseUrl) return 'http://127.0.0.1:11434';
    let url = String(baseUrl).trim();
    if (!url) return 'http://127.0.0.1:11434';
    if (!/^https?:\/\//i.test(url)) {
        url = `http://${url}`;
    }
    // Remove trailing slash
    url = url.replace(/\/+$/, '');
    return url;
}

function resolveBaseUrl(provider) {
    if (provider?.baseUrl) return normalizeBaseUrl(provider.baseUrl);
    if (process.env.LOCAL_AI_BASE_URL) return normalizeBaseUrl(process.env.LOCAL_AI_BASE_URL);
    if (process.env.OLLAMA_BASE_URL) return normalizeBaseUrl(process.env.OLLAMA_BASE_URL);
    return 'http://127.0.0.1:11434';
}

function buildHeaders(provider) {
    const headers = {
        'Content-Type': 'application/json',
    };
    const key = provider?.key ? String(provider.key).trim() : '';
    if (!key) return headers;
    // If key contains | assume Cloudflare Access style? The plan says for Cloudflare tunnel use single token -> Authorization: Bearer
    // Also support CF-Access-Client-Id/Secret if split by |
    if (key.includes('|')) {
        const parts = key.split('|').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
            headers['CF-Access-Client-Id'] = parts[0];
            headers['CF-Access-Client-Secret'] = parts[1];
            return headers;
        }
    }
    headers['Authorization'] = `Bearer ${key}`;
    return headers;
}

function convertMessages(messages) {
    const converted = [];
    for (const msg of messages) {
        if (!msg) continue;
        if (msg.role === 'system') {
            converted.push({ role: 'system', content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) });
            continue;
        }
        if (Array.isArray(msg.content)) {
            let textParts = [];
            let images = [];
            for (const part of msg.content) {
                if (!part) continue;
                if (part.type === 'text') {
                    textParts.push(part.text || '');
                } else if (part.type === 'image_url' && part.image_url?.url) {
                    const url = part.image_url.url;
                    // Handle data URI
                    const idx = url.indexOf(';base64,');
                    if (idx !== -1) {
                        images.push(url.substring(idx + 8));
                    } else {
                        // If it's just base64 or a URL, pass as-is? Ollama expects base64 without prefix
                        // Try to extract if it's a data URI format
                        if (url.includes('base64,')) {
                            images.push(url.split('base64,')[1]);
                        } else {
                            images.push(url);
                        }
                    }
                }
            }
            const content = textParts.join('\n');
            if (images.length > 0) {
                converted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content, images });
            } else {
                converted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content });
            }
        } else if (typeof msg.content === 'string') {
            converted.push({ role: msg.role === 'assistant' ? 'assistant' : msg.role, content: msg.content });
        } else {
            converted.push({ role: msg.role === 'assistant' ? 'assistant' : msg.role, content: JSON.stringify(msg.content) });
        }
    }
    return converted;
}

async function acquireSlot() {
    while (activeRequests >= MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, 50));
    }
    activeRequests++;
}

function releaseSlot() {
    activeRequests = Math.max(0, activeRequests - 1);
}

export async function callOllama(provider, messages, temperature, maxTokens, timeoutMs = null, options = {}) {
    const baseUrl = resolveBaseUrl(provider);
    // Check down cache
    if (now() < localDownUntil) {
        const err = new Error('Local AI unavailable (cooldown)');
        err.code = 'ECONNREFUSED';
        throw err;
    }

    await acquireSlot();
    try {
        const url = `${baseUrl}/api/chat`;
        const convertedMessages = convertMessages(messages);
        const payload = {
            model: provider.model,
            messages: convertedMessages,
            stream: false,
            options: {
                temperature,
                num_predict: maxTokens,
            },
        };
        if (options.jsonMode) {
            payload.format = 'json';
        }
        // For Qwen3.5 thinking models, disable thinking
        if (String(provider.model).toLowerCase().includes('qwen3')) {
            payload.options.think = false;
        }

        const headers = buildHeaders(provider);
        const timeout = timeoutMs || provider.timeoutMs || 180000;

        const response = await axios.post(url, payload, {
            headers,
            timeout,
        });

        if (response.data?.message?.content) {
            return response.data.message.content;
        }
        if (response.data?.response) {
            return response.data.response;
        }
        throw new Error(`Invalid Ollama response: ${JSON.stringify(response.data).substring(0, 200)}`);
    } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (err.code === 'ECONNREFUSED' || msg.includes('econnrefused') || msg.includes('connect')) {
            localDownUntil = now() + 60000; // 60s cooldown
        }
        throw err;
    } finally {
        releaseSlot();
    }
}

export async function checkOllamaHealth(baseUrl, model) {
    try {
        const url = `${normalizeBaseUrl(baseUrl)}/api/tags`;
        const resp = await axios.get(url, { timeout: 5000 });
        const models = resp.data?.models || [];
        if (model) {
            return models.some(m => m.name === model || m.name?.startsWith(model + ':'));
        }
        return models.length > 0;
    } catch {
        return false;
    }
}

export default { callOllama, checkOllamaHealth };
