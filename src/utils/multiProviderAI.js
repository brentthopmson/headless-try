import axios from 'axios';
import logger from "../../../../utils/logger.js";

/**
 * Multi-Provider AI Helper with fallback chain
 * Providers (in order): Gemini, Groq, Cerebras, Together, Mistral, Cloudflare, Cohere
 */

class MultiProviderAI {
    constructor(config = {}) {
        this.config = {
            gemini: {
                keys: [
                    process.env.GEMINI_API_KEY,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3
                ].filter(k => k && !k.includes('YOUR_')),
                endpoint: 'https://generativelanguage.googleapis.com/v1/models'
            },
            groq: {
                key: process.env.GROQ_API_KEY,
                endpoint: 'https://api.groq.com/openai/v1/chat/completions',
                model: 'llama-3.3-70b-versatile'
            },
            cerebras: {
                key: process.env.CEREBRAS_API_KEY,
                endpoint: 'https://api.cerebras.ai/v1/chat/completions',
                model: 'llama3.1-70b'
            },
            together: {
                key: process.env.TOGETHER_API_KEY,
                endpoint: 'https://api.together.xyz/v1/chat/completions',
                model: 'mistralai/Mixtral-8x7B-Instruct-v0.1'
            },
            mistral: {
                key: process.env.MISTRAL_API_KEY,
                endpoint: 'https://api.mistral.ai/v1/chat/completions',
                model: 'mistral-small-latest'
            },
            cloudflare: {
                accountId: process.env.CF_ACCOUNT_ID,
                token: process.env.CF_API_TOKEN,
                endpoint: (cfId) => `https://api.cloudflare.com/client/v4/accounts/${cfId}/ai/run/@cf/meta/llama-3.1-8b-instruct`
            },
            cohere: {
                key: process.env.COHERE_API_KEY,
                endpoint: 'https://api.cohere.ai/v1/chat',
                model: 'command-r-plus'
            }
        };
        this.lastProvider = null;
    }

    /**
     * Main entry point - calls AI with fallback chain
     */
    async generate(prompt, options = {}) {
        const {
            systemPrompt = "You are a helpful assistant.",
            chatHistory = [],
            maxTokens = 2000,
            temperature = 0.7,
            imageUrl = null,
            videoUrl = null,
            preferProvider = null
        } = options;

        logger.info(`[MultiProviderAI] Generating response. Prefer: ${preferProvider || 'auto'}, Has image: ${!!imageUrl}, Has video: ${!!videoUrl}`);

        // Build messages array
        let messages = [];
        if (systemPrompt) {
            messages.push({ role: "system", content: systemPrompt });
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
        let finalMessage = prompt;
        if (imageUrl) {
            finalMessage = `[Image: ${imageUrl}]\n\n${prompt}`;
        }
        if (videoUrl) {
            finalMessage = `[Video: ${videoUrl}]\n\n${prompt}`;
        }

        messages.push({ role: "user", content: finalMessage });

        // Try preferred provider first
        if (preferProvider) {
            const methodName = `_call${preferProvider.charAt(0).toUpperCase() + preferProvider.slice(1)}`;
            if (typeof this[methodName] === 'function') {
                try {
                    logger.info(`[MultiProviderAI] Attempting preferred provider: ${preferProvider}`);
                    const result = await this[methodName](messages, maxTokens, temperature);
                    this.lastProvider = preferProvider;
                    return result;
                } catch (error) {
                    logger.warn(`[MultiProviderAI] Preferred provider ${preferProvider} failed: ${error.message}. Falling back...`);
                }
            }
        }

        // Fallback chain
        const providers = ['Gemini', 'Groq', 'Cerebras', 'Together', 'Mistral', 'Cloudflare', 'Cohere'];
        for (const provider of providers) {
            try {
                const methodName = `_call${provider}`;
                if (typeof this[methodName] === 'function') {
                    logger.info(`[MultiProviderAI] Trying provider: ${provider}`);
                    const result = await this[methodName](messages, maxTokens, temperature);
                    this.lastProvider = provider;
                    logger.info(`[MultiProviderAI] Success with ${provider}`);
                    return result;
                }
            } catch (error) {
                logger.warn(`[MultiProviderAI] ${provider} failed: ${error.message}`);
                continue;
            }
        }

        throw new Error("All AI providers failed. Check your API keys and network connectivity.");
    }

    // ==================== GEMINI ====================
    async _callGemini(messages, maxTokens, temperature) {
        const keys = this.config.gemini.keys;
        if (!keys || keys.length === 0) {
            throw new Error("No Gemini API keys configured");
        }

        for (let i = 0; i < keys.length; i++) {
            try {
                const apiKey = keys[i];
                const lastMessage = messages[messages.length - 1];
                
                const payload = {
                    contents: messages.map(msg => ({
                        role: msg.role === 'user' ? 'user' : 'model',
                        parts: [{ text: msg.content }]
                    })),
                    generationConfig: {
                        maxOutputTokens: maxTokens,
                        temperature: temperature
                    }
                };

                const url = `${this.config.gemini.endpoint}/gemini-pro:generateContent?key=${apiKey}`;
                const response = await axios.post(url, payload, { timeout: 30000 });

                if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
                    return response.data.candidates[0].content.parts[0].text;
                }
            } catch (error) {
                logger.warn(`[Gemini] Key ${i + 1} failed: ${error.message}`);
                if (i === keys.length - 1) throw error;
            }
        }

        throw new Error("All Gemini keys exhausted");
    }

    // ==================== GROQ ====================
    async _callGroq(messages, maxTokens, temperature) {
        const { key, endpoint, model } = this.config.groq;
        if (!key || key.includes('YOUR_')) {
            throw new Error("Groq API key not configured");
        }

        const response = await axios.post(endpoint, {
            model: model,
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error("Invalid Groq response format");
    }

    // ==================== CEREBRAS ====================
    async _callCerebras(messages, maxTokens, temperature) {
        const { key, endpoint, model } = this.config.cerebras;
        if (!key || key.includes('YOUR_')) {
            throw new Error("Cerebras API key not configured");
        }

        const response = await axios.post(endpoint, {
            model: model,
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error("Invalid Cerebras response format");
    }

    // ==================== TOGETHER ====================
    async _callTogether(messages, maxTokens, temperature) {
        const { key, endpoint, model } = this.config.together;
        if (!key || key.includes('YOUR_')) {
            throw new Error("Together API key not configured");
        }

        const response = await axios.post(endpoint, {
            model: model,
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error("Invalid Together response format");
    }

    // ==================== MISTRAL ====================
    async _callMistral(messages, maxTokens, temperature) {
        const { key, endpoint, model } = this.config.mistral;
        if (!key || key.includes('YOUR_')) {
            throw new Error("Mistral API key not configured");
        }

        const response = await axios.post(endpoint, {
            model: model,
            messages: messages,
            temperature: temperature,
            max_tokens: maxTokens
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });

        if (response.data?.choices?.[0]?.message?.content) {
            return response.data.choices[0].message.content;
        }
        throw new Error("Invalid Mistral response format");
    }

    // ==================== CLOUDFLARE ====================
    async _callCloudflare(messages, maxTokens, temperature) {
        const { accountId, token, endpoint } = this.config.cloudflare;
        if (!accountId || accountId.includes('YOUR_') || !token || token.includes('YOUR_')) {
            throw new Error("Cloudflare credentials not configured");
        }

        const url = endpoint(accountId);
        const response = await axios.post(url, {
            messages: messages
        }, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 30000
        });

        if (response.data?.success && response.data?.result?.response) {
            return response.data.result.response;
        }
        throw new Error("Invalid Cloudflare response format");
    }

    // ==================== COHERE ====================
    async _callCohere(messages, maxTokens, temperature) {
        const { key, endpoint, model } = this.config.cohere;
        if (!key || key.includes('YOUR_')) {
            throw new Error("Cohere API key not configured");
        }

        // Cohere uses a different format
        const chatHistory = messages.slice(1, -1).map(msg => ({
            role: msg.role,
            message: msg.content
        }));

        const response = await axios.post(endpoint, {
            model: model,
            message: messages[messages.length - 1].content,
            chat_history: chatHistory,
            temperature: temperature
        }, {
            headers: { 'Authorization': `Bearer ${key}` },
            timeout: 30000
        });

        if (response.data?.text) {
            return response.data.text;
        }
        throw new Error("Invalid Cohere response format");
    }

    /**
     * Vision analysis - analyze image/video content
     */
    async analyzeMedia(imageUrl, prompt, options = {}) {
        const systemPrompt = options.systemPrompt || `You are an expert visual analyst. Analyze the provided image/video and answer questions about:
- Content and objects visible
- Text and captions
- Actions and interactions
- Sentiment and context
- Relevant details for social media engagement`;

        return this.generate(prompt, {
            ...options,
            imageUrl,
            systemPrompt
        });
    }

    /**
     * Generate social media comments
     */
    async generateComment(postContent, context = '', options = {}) {
        const systemPrompt = options.systemPrompt || `You are a social media expert. Generate a natural, engaging comment that:
- Is authentic and conversational
- Relates to the post content
- Encourages engagement
- Is 1-2 sentences max
- No hashtags unless already in context`;

        return this.generate(
            `Post: ${postContent}\nContext: ${context}\n\nGenerate a comment (natural, engaging, 1-2 sentences):`,
            { ...options, systemPrompt }
        );
    }

    /**
     * Analyze page content and extract insights
     */
    async analyzePageContent(pageHtml, question, options = {}) {
        const systemPrompt = options.systemPrompt || `You are a content analyst. Analyze the page content and answer the user's question accurately and concisely.`;

        return this.generate(
            `Page HTML:\n${pageHtml.slice(0, 4000)}\n\nQuestion: ${question}`,
            { ...options, systemPrompt, maxTokens: 1000 }
        );
    }
}

export default MultiProviderAI;
