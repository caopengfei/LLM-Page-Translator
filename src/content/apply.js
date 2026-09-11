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
          // written 是实际落盘的完整值(可能带首尾空白),对账时用它判断站点是否改写过
          const written = original === item.text ? t : original.replace(item.text, t);
          node.nodeValue = written;
          // srcLen 是送去翻译的源文本长度(不含首尾空白),用于累计"本页翻译了多少字"
          records.push({ id: item.id, node, kind: 'text', attr: null, original, translated: t, written, srcLen: (item.text || '').length });
        } else if (item.kind === 'attr' && typeof node.setAttribute === 'function') {
          const original = node.getAttribute(item.attr);
          if (original == null) return;
          node.setAttribute(item.attr, t);
          records.push({ id: item.id, node, kind: 'attr', attr: item.attr, original, translated: t, written: t, srcLen: (item.text || '').length });
        }
      } catch (e) { /* 单点失败不影响其余节点 */ }
    });
    return records;
  }

  function isAlive(rec) {
    return !!(rec && rec.node && rec.node.isConnected);
  }

  // 记录是否仍保持着我们写入的值。站点改写(SPA 路由切换、框架复用节点)会使其为假。
  // 无 written 的历史记录回退比对 translated。
  function stillMatches(rec) {
    if (!rec || !rec.node) return false;
    const expected = rec.written != null ? rec.written : rec.translated;
    try {
      if (rec.kind === 'text') return rec.node.nodeType === 3 && rec.node.nodeValue === expected;
      if (typeof rec.node.getAttribute === 'function') return rec.node.getAttribute(rec.attr) === expected;
    } catch (e) { /* 节点已不可访问,视为不匹配 */ }
    return false;
  }

  // 对账:把"已应用记录"与真实 DOM 对齐,返回仍需保留的记录与应丢弃的记录。
  // 丢弃的节点由调用方解除 skip 标记,使其能被重新收集翻译。
  function reconcile(records) {
    const kept = [];
    const dropped = [];
    (records || []).forEach((rec) => {
      if (isAlive(rec) && stillMatches(rec)) kept.push(rec);
      else dropped.push(rec);
    });
    return { kept, dropped };
  }

  function restoreAll(records) {
    let restored = 0;
    (records || []).slice().reverse().forEach((r) => {
      if (!isAlive(r)) return; // 已脱离文档的节点无需还原,也不计入还原数
      try {
        if (r.kind === 'text' && r.node.nodeType === 3) {
          r.node.nodeValue = r.original;
          restored += 1;
        } else if (r.kind === 'attr' && typeof r.node.setAttribute === 'function') {
          r.node.setAttribute(r.attr, r.original);
          restored += 1;
        }
      } catch (e) { /* 节点已脱离文档;忽略 */ }
    });
    return restored;
  }

  const ExtApply = { applyTranslations, isAlive, stillMatches, reconcile, restoreAll };
  global.Ext = global.Ext || {};
  global.Ext.apply = ExtApply;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtApply;
})(typeof globalThis !== 'undefined' ? globalThis : self);