import MultiProviderAI from './multiProviderAI.js';
import logger from './logger.js';

const ai = new MultiProviderAI();

// Browser actions are typed/clicked verbatim. Never trust a model array:
// only allowlisted action types with bounded selector/text survive.
const ALLOWED_ACTION_TYPES = new Set(['click', 'type', 'wait', 'extract', 'press', 'scroll']);
function sanitizeBrowserActions(parsed) {
  const raw = Array.isArray(parsed?.actions) ? parsed.actions : (Array.isArray(parsed) ? parsed : []);
  const out = [];
  for (const a of raw.slice(0, 20)) {
    if (!a || typeof a !== 'object') continue;
    const type = String(a.type || '').toLowerCase().trim();
    if (!ALLOWED_ACTION_TYPES.has(type)) continue;
    const selector = String(a.selector || '').trim().slice(0, 200);
    if (!selector) continue;
    const item = { type, selector };
    if (a.text != null) item.text = String(a.text).replace(/[\x00-\x1F\x7F]/g, '').slice(0, 500);
    if (a.timeoutMs != null) item.timeoutMs = Math.min(Math.max(parseInt(a.timeoutMs, 10) || 0, 0), 10000);
    out.push(item);
  }
  return { actions: out };
}

export async function generateBrowserActions(task) {
  const prompt = `Generate a step-by-step browser automation plan for the following task: ${task}. Return a JSON object with an "actions" array where each action has "type" (click/type/wait/extract), "selector" (CSS selector), and optionally "text" (for type actions).`;
  const result = await ai.generate(prompt, { systemPrompt: 'You are a browser automation planner. Return only valid JSON.', jsonMode: true });
  const parsed = ai.parseAiJson(result);
  if (!parsed) {
    logger.error('[aiHelper] Failed to parse browser actions JSON');
    return { actions: [] };
  }
  return sanitizeBrowserActions(parsed);
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
