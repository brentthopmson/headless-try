import MultiProviderAI from './multiProviderAI.js';
import logger from './logger.js';

const ai = new MultiProviderAI();

export async function generateBrowserActions(task) {
  const prompt = `Generate a step-by-step browser automation plan for the following task: ${task}. Return a JSON object with an "actions" array where each action has "type" (click/type/wait/extract), "selector" (CSS selector), and optionally "text" (for type actions).`;
  const result = await ai.generate(prompt, { systemPrompt: 'You are a browser automation planner. Return only valid JSON.' });
  try {
    return JSON.parse(result);
  } catch {
    logger.error('[aiHelper] Failed to parse browser actions JSON');
    return { actions: [] };
  }
}

export async function analyzeContent(content, instructions) {
  const prompt = `${instructions}\n\nContent:\n${content}`;
  const result = await ai.generate(prompt, { systemPrompt: 'You are a content analyst.' });
  return result;
}

export async function processError(errorMessage, context) {
  const prompt = `Error: ${errorMessage}\nContext: ${context}\n\nSuggest how to fix this error.`;
  const result = await ai.generate(prompt, { systemPrompt: 'You are a debugging assistant.' });
  return result;
}

export default { generateBrowserActions, analyzeContent, processError };
