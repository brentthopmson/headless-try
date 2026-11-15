const fs = require('fs');
const funcs = `
async function analyzeBatchWithAI(scrapeResults, targetColumns) {
  if (scrapeResults.length === 0) return [];
  const batchContent = scrapeResults.map((r, i) => {
    const known = r.knownData ? 'KNOWN DATA: ' + JSON.stringify(r.knownData) : '';
    const parts = [r.title, r.description, r.bodyText && r.bodyText.slice(0, 1500), (r.internalTexts || []).join(' ').slice(0, 1500)].filter(Boolean).join('. ');
    return '[' + (i + 1) + '] ' + known + '\\nCONTENT: ' + parts;
  }).join('\\n\\n---\\n\\n');

  const colList = targetColumns.join(', ');

  const prompt = 'You are a data enrichment agent. For each row below, extract information into these columns: ' + colList + '.\\n\\n' + batchContent + '\\n\\nRules:\\n1. Clean up FIRSTNAME if it contains "First Last" -> split into FIRSTNAME and LASTNAME.\\n2. Only fill a field if directly supported by the scraped content or known data.\\n3. For generic email domains (gmail, yahoo, etc.), try to find the person by name + email. For business domains, search the company site.\\n4. If you cannot verify a field, leave it empty - do not guess.\\n5. Return a JSON array with one object per row (same order). Each object has keys matching the target columns plus a "confidence" field ("high", "medium", "low", or "none").\\n6. If confidence is "none", set all enriched fields to empty (except name cleanup).\\n7. CONTEXT should contain a 2-3 sentence summary of what the person/company does.\\n\\nReturn ONLY valid JSON array.';

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 6000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed)) {
      return parsed.map(r => {
        if (!r || typeof r !== 'object') return null;
        const out = {};
        for (const col of targetColumns) {
          out[col] = ai.sanitizeAiPlainText(String(r[col] || ''), 2000);
        }
        out.confidence = String(r.confidence || 'low').toLowerCase();
        if (out.confidence === 'none') {
          for (const col of targetColumns) {
            if (col !== 'FIRSTNAME' && col !== 'LASTNAME') out[col] = '';
          }
        }
        return out;
      }).filter(Boolean);
    }
    if (typeof ai._salvageJsonArray === 'function') {
      const salvaged = ai._salvageJsonArray(text);
      if (Array.isArray(salvaged) && salvaged.length) {
        return salvaged.map(r => {
          const out = {};
          for (const col of targetColumns) out[col] = ai.sanitizeAiPlainText(String(r && r[col] || ''), 2000);
          out.confidence = String(r && r.confidence || 'low').toLowerCase();
          return out;
        });
      }
    }
  } catch (err) {
    logger.warn('[Enrich] Batch AI analysis failed: ' + err.message);
  }
  return [];
}

async function reviewBatchWithAI(extracted, scrapedData) {
  if (!extracted || extracted.length === 0) return extracted;
  const reviewContent = extracted.map((r, i) => {
    const source = scrapedData[i] ? (scrapedData[i].bodyText || '').slice(0, 1000) : '';
    return '[' + (i + 1) + '] EXTRACTED: ' + JSON.stringify(r) + '\\nSOURCE: ' + source;
  }).join('\\n\\n');

  const prompt = 'Review these extracted data points against their source content. Remove any field not directly supported by the source. Adjust confidence. Return the corrected JSON array (same structure, same order).\\n\\n' + reviewContent + '\\n\\nReturn ONLY valid JSON array with the same keys plus "confidence".';

  try {
    const ai = new MultiProviderAI();
    const text = await ai.generate(prompt, { maxTokens: 4000, jsonMode: true });
    const parsed = ai.parseAiJson(text);
    if (Array.isArray(parsed) && parsed.length === extracted.length) {
      return parsed.map((r, i) => {
        if (!r || typeof r !== 'object') return extracted[i];
        const out = Object.assign({}, extracted[i]);
        for (const key of Object.keys(r)) {
          if (r[key] !== undefined && r[key] !== null && r[key] !== '') {
            out[key] = (typeof r[key] === 'string') ? r[key] : String(r[key]);
          }
        }
        out.confidence = String(r.confidence || extracted[i].confidence || 'low').toLowerCase();
        return out;
      });
    }
  } catch (err) {
    logger.warn('[Enrich] Review pass failed: ' + err.message);
  }
  return extracted;
}
`;
fs.appendFileSync('src/app/campaign/enrich-campaign/route.js', funcs);
console.log('appended');