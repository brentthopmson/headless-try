class OllamaHelper {
    constructor() {
        let baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
            baseUrl = 'http://' + baseUrl;
        }
        this.baseUrl = baseUrl;
        this.model = 'mistral';
    }

    async generateCompletion(prompt) {
        // Add logging for prompt
        if (typeof global !== 'undefined' && global.logger) {
            global.logger.info(`[OllamaHelper] Prompt sent: ${prompt}`);
        }
        try {
            const url = new URL('/api/generate', this.baseUrl).toString();
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.model,
                    prompt,
                    stream: false,
                    format: 'json'
                }),
                signal: controller.signal
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error('Ollama server error');
            }

            const data = await response.json();
            return data.response;
        } catch (error) {
            if (typeof global !== 'undefined' && global.logger) {
                global.logger.error('[OllamaHelper] Error:', error);
            }
            return null;
        }
    }

    async analyzePageContent(page, selectors = [], expectedState = '') {
        try {
            const content = await page.content();
            const title = await page.title();
            
            const domResults = await this.searchPageForElements(page, selectors);
            
            if (domResults.found) {
                return {
                    ...domResults,
                    pageState: expectedState,
                    aiAnalysis: null
                };
            }

            const aiAnalysis = await this.analyzePageState(content, title, expectedState);
            
            return {
                found: aiAnalysis.matches,
                elements: [],
                pageState: aiAnalysis.detectedState,
                aiAnalysis: aiAnalysis.analysis,
                confidence: aiAnalysis.confidence
            };
        } catch (error) {
            if (typeof global !== 'undefined' && global.logger) {
                global.logger.error('[OllamaHelper] Page analysis error:', error);
            }
            return {
                found: false,
                elements: [],
                pageState: 'unknown',
                error: error.message
            };
        }
    }

    async searchPageForElements(page, selectors) {
        const results = {
            found: false,
            elements: []
        };

        try {
            for (const selector of selectors) {
                if (typeof selector === 'string') {
                    const elements = await page.$$(selector);
                    if (elements.length > 0) {
                        results.found = true;
                        results.elements.push(...elements);
                    }
                } else if (selector.xpath) {
                    const elements = await page.$x(selector.xpath);
                    if (elements.length > 0) {
                        results.found = true;
                        results.elements.push(...elements);
                    }
                }
            }
        } catch (error) {
            if (typeof global !== 'undefined' && global.logger) {
                global.logger.error('[OllamaHelper] Element search error:', error);
            }
        }

        return results;
    }

    async analyzePageState(content, title, expectedState) {
        const prompt = `
            Analyze this webpage content and determine if it matches the expected state: "${expectedState}"
            Title: ${title}
            Content: ${content.substring(0, 1000)}...
            
            Return JSON with:
            {
                "matches": boolean,
                "detectedState": "login|password|verification|inbox|unknown",
                "confidence": 0-1,
                "analysis": "brief description of page purpose"
            }
        `;

        try {
            const response = await this.generateCompletion(prompt);
            return {
                matches: response.matches || false,
                detectedState: response.detectedState || 'unknown',
                confidence: response.confidence || 0,
                analysis: response.analysis || 'Unable to analyze page'
            };
        } catch (error) {
            return {
                matches: false,
                detectedState: 'unknown',
                confidence: 0,
                analysis: 'Analysis failed'
            };
        }
    }
}

export default new OllamaHelper();