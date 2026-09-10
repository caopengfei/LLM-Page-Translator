(function (global) {
  'use strict';

  function splitIntoBatches(items, maxItems, maxChars) {
    const batches = [];
    let current = [];
    let chars = 0;
    (items || []).forEach((item) => {
      const len = String(item.text || '').length;
      if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += len;
    });
    if (current.length > 0) batches.push(current);
    return batches;
  }

  function buildPayload(batch) {
    const payload = {};
    (batch || []).forEach((item, i) => { payload[String(i)] = item.text; });
    return payload;
  }

  function parseResponse(raw) {
    let text = String(raw == null ? '' : raw).trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) text = fence[1].trim();
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LLM response is not a JSON object');
    }
    return parsed;
  }

  const ExtBatch = { splitIntoBatches, buildPayload, parseResponse };
  global.Ext = global.Ext || {};
  global.Ext.batch = ExtBatch;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtBatch;
})(typeof globalThis !== 'undefined' ? globalThis : self);
