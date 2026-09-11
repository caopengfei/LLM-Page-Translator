(function (global) {
  'use strict';

  // 文案查找惰性解析:batch.js 在 content script、service worker 与单测中加载顺序各不相同
  function tr(key, subs) {
    const i18n = global.Ext && global.Ext.i18n;
    return i18n ? i18n.t(key, subs) : key;
  }

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
    // 1) 剥离 markdown 代码围栏
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) text = fence[1].trim();
    // 2) 提取第一个 { 与最后一个 } 之间的内容(容错模型在 JSON 前后附加说明文字)
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      text = text.slice(firstBrace, lastBrace + 1);
    }

    const tryParse = (s) => {
      const parsed = JSON.parse(s);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(tr('error_batch_not_object'));
      }
      return parsed;
    };

    try {
      return tryParse(text);
    } catch (e) {
      // 3) 常见瑕疵:尾逗号(仅在前一次失败后尝试修复,避免误伤正常译文内容)
      try {
        return tryParse(text.replace(/,(\s*[}\]])/g, '$1'));
      } catch (e2) {
        // 保留原始片段(仅折叠换行),便于用户/上游直接看到接口返回了什么
        const snippet = text.slice(0, 200).replace(/[\r\n]+/g, ' ');
        if (e instanceof SyntaxError || e2 instanceof SyntaxError) {
          throw new Error(tr('error_batch_json', [snippet]));
        }
        throw e2;
      }
    }
  }

  const ExtBatch = { splitIntoBatches, buildPayload, parseResponse };
  global.Ext = global.Ext || {};
  global.Ext.batch = ExtBatch;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtBatch;
})(typeof globalThis !== 'undefined' ? globalThis : self);
