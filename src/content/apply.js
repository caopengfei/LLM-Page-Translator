(function (global) {
  'use strict';

  function applyTranslations(items, translations) {
    const records = [];
    (items || []).forEach((item) => {
      const t = translations ? translations[item.id] : undefined;
      if (typeof t !== 'string' || !t.length || t === item.text) return;
      const node = item.node;
      if (!node) return;
      try {
        if (item.kind === 'text' && node.nodeType === 3) {
          const original = node.nodeValue;
          if (original == null || !original.includes(item.text)) return;
          node.nodeValue = original === item.text ? t : original.replace(item.text, t);
          records.push({ id: item.id, node, kind: 'text', attr: null, original, translated: t });
        } else if (item.kind === 'attr' && typeof node.setAttribute === 'function') {
          const original = node.getAttribute(item.attr);
          if (original == null) return;
          node.setAttribute(item.attr, t);
          records.push({ id: item.id, node, kind: 'attr', attr: item.attr, original, translated: t });
        }
      } catch (e) { /* 单点失败不影响其余节点 */ }
    });
    return records;
  }

  function restoreAll(records) {
    (records || []).slice().reverse().forEach((r) => {
      try {
        if (r.kind === 'text' && r.node.nodeType === 3) r.node.nodeValue = r.original;
        else if (r.kind === 'attr' && typeof r.node.setAttribute === 'function') {
          r.node.setAttribute(r.attr, r.original);
        }
      } catch (e) { /* 节点已脱离文档;忽略 */ }
    });
    return records.length;
  }

  const ExtApply = { applyTranslations, restoreAll };
  global.Ext = global.Ext || {};
  global.Ext.apply = ExtApply;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtApply;
})(typeof globalThis !== 'undefined' ? globalThis : self);