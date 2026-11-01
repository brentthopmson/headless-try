// Pure decision helpers for AI provider configuration (no side effects)

function normalizeBaseUrl(baseUrl) {
    if (!baseUrl) return 'http://127.0.0.1:11434';
    let url = String(baseUrl).trim();
    if (!url) return 'http://127.0.0.1:11434';
    if (!/^https?:\/\//i.test(url)) {
        url = `http://${url}`;
    }
    return url.replace(/\/+$/, '');
}

function resolveLocalBaseUrl(provider, env = process.env) {
    if (provider?.baseUrl) return normalizeBaseUrl(provider.baseUrl);
    if (env?.LOCAL_AI_BASE_URL) return normalizeBaseUrl(env.LOCAL_AI_BASE_URL);
    if (env?.OLLAMA_BASE_URL) return normalizeBaseUrl(env.OLLAMA_BASE_URL);
    return 'http://127.0.0.1:11434';
}

function isKeylessProvider(provider) {
    const p = String(provider || '').toLowerCase().trim();
    return p === 'ollama' || p === 'local' || p === 'lmstudio' || p === 'llamacpp' || p === 'vllm';
}

function isLocalProvider(provider) {
    const p = String(provider || '').toLowerCase().trim();
    return ['ollama', 'local', 'lmstudio', 'llamacpp', 'vllm'].includes(p);
}

function isVisionCapableModel(model) {
    const m = String(model || '').toLowerCase();
    return /vl|vision|llava|moondream|minicpm-v|qwen3\.5|qwen2\.5vl/.test(m);
}

function shouldSkipLocalForImage(provider, model, hasImage) {
    if (!hasImage) return false;
    if (!isLocalProvider(provider)) return false;
    return !isVisionCapableModel(model);
}

function clampLocalTokens(maxTokens, isProxied = false) {
    const limit = isProxied ? 700 : 1200;
    if (!Number.isFinite(maxTokens)) return limit;
    return Math.min(maxTokens, limit);
}

function clampLocalInputTokens(maxInputTokens) {
    const limit = 3000;
    if (!Number.isFinite(maxInputTokens)) return limit;
    return Math.min(maxInputTokens, limit);
}

function buildAuthHeaders(key) {
    const headers = { 'Content-Type': 'application/json' };
    if (!key) return headers;
    const k = String(key).trim();
    if (!k) return headers;
    if (k.includes('|')) {
        const parts = k.split('|').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) {
            headers['CF-Access-Client-Id'] = parts[0];
            headers['CF-Access-Client-Secret'] = parts[1];
            return headers;
        }
    }
    headers['Authorization'] = `Bearer ${k}`;
    return headers;
}

module.exports = {
    normalizeBaseUrl,
    resolveLocalBaseUrl,
    isKeylessProvider,
    isLocalProvider,
    isVisionCapableModel,
    shouldSkipLocalForImage,
    clampLocalTokens,
    clampLocalInputTokens,
    buildAuthHeaders,
};
