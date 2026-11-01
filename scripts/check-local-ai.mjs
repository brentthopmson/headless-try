#!/usr/bin/env node
import axios from 'axios';

const baseUrl = process.env.LOCAL_AI_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const model = process.env.LOCAL_AI_MODEL || 'qwen3.5:4b';
const token = process.env.LOCAL_AI_TOKEN || process.env.OLLAMA_API_KEY || '';

function normalize(url) {
  let u = String(url).trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

async function check() {
  const url = normalize(baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  try {
    const tags = await axios.get(`${url}/api/tags`, { headers, timeout: 10000 });
    const models = tags.data?.models?.map(m => m.name) || [];
    console.log('OK - tags:', models.join(', ') || '(none)');
    if (models.some(m => m === model || m.startsWith(model + ':'))) {
      console.log(`Found model: ${model}`);
    } else {
      console.log(`Model ${model} not found in tags`);
    }
    // Try chat
    const resp = await axios.post(`${url}/api/chat`, {
      model,
      messages: [{ role: 'user', content: 'Reply with READY' }],
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 10 }
    }, { headers, timeout: 60000 });
    console.log('Chat:', resp.data?.message?.content || resp.data?.response || JSON.stringify(resp.data).slice(0, 100));
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.response?.status, e.response?.data || e.message);
    process.exit(1);
  }
}

check();
