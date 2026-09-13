(function (global) {
  'use strict';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA',
    'CODE', 'PRE', 'KBD', 'SAMP', 'IFRAME'
  ]);
  const ATTR_NAMES = ['placeholder', 'title', 'aria-label', 'alt'];
  const ATTR_SELECTOR = '[placeholder], [title], [aria-label], [alt]';
  // DOM NodeFilter 数值常量:SHOW_TEXT=4, FILTER_ACCEPT=1, FILTER_REJECT=2
  const SHOW_TEXT = 4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;

  function makeSkipMap() { return new WeakMap(); }

  function skipKey(kind, attr) { return kind === 'text' ? 'text' : 'attr:' + attr; }

  function hasSkipAncestor(node, stop) {
    let el = node && node.parentElement;
    while (el && el !== stop) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      el = el.parentElement;
    }
    // stop 元素自身若是 skip 标签(如 collect(codeElement) 直接以 skip 元素为根)也要拒绝
    if (el && stop && SKIP_TAGS.has(stop.tagName)) return true;
    return false;
  }

  function isHiddenElement(el, stop) {
    let current = el;
    while (current && current !== stop) {
      if (current.hidden || String(current.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
      const view = current.ownerDocument && current.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === 'function') {
        const style = view.getComputedStyle(current);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
      }
      current = current.parentElement;
    }
    if (stop && stop.nodeType === 1) {
      if (stop.hidden || String(stop.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
      const view = stop.ownerDocument && stop.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === 'function') {
        const style = view.getComputedStyle(stop);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
      }
    }
    return false;
  }

  function matchesAttr(el) {
    return el && el.nodeType === 1 && typeof el.matches === 'function' && el.matches(ATTR_SELECTOR);
  }

  function collectAttributes(attrScope, skipMap, items) {
    const elements = [];
    if (attrScope && attrScope.nodeType === 1 && matchesAttr(attrScope)) elements.push(attrScope);
    if (attrScope && typeof attrScope.querySelectorAll === 'function') {
      elements.push(...attrScope.querySelectorAll(ATTR_SELECTOR));
    }
    elements.forEach((el) => {
      if (hasSkipAncestor(el, attrScope) || isHiddenElement(el, attrScope)) return;
      ATTR_NAMES.forEach((name) => {
        if (!el.hasAttribute(name)) return;
        const value = el.getAttribute(name) || '';
        if (!value.trim() || !/\p{L}/u.test(value)) return;
        const key = skipKey('attr', name);
        if (skipMap && isSkipped(skipMap, el, key)) return;
        items.push({ node: el, kind: 'attr', attr: name, text: value.trim() });
      });
    });
  }

  function isSkipped(map, node, key) {
    const s = map.get(node);
    return !!(s && s.has(key));
  }

  function markSkipped(map, node, key) {
    let s = map.get(node);
    if (!s) { s = new Set(); map.set(node, s); }
    s.add(key);
  }

  function unmarkSkipped(map, node, key) {
    const s = map.get(node);
    if (!s) return;
    s.delete(key);
    if (!s.size) map.delete(node);
  }

  function collect(root, options) {
    const skipMap = options && options.skip;
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const scope = root.nodeType === 9 ? (root.body || root.documentElement) : root;
    const items = [];

    if (doc && scope) {
      const walker = doc.createTreeWalker(scope, SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return FILTER_REJECT;
          if (hasSkipAncestor(node, scope) || isHiddenElement(parent, scope)) return FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return FILTER_REJECT;
          if (skipMap && isSkipped(skipMap, node, 'text')) return FILTER_REJECT;
          return FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        items.push({ node, kind: 'text', attr: null, text: node.nodeValue.trim() });
      }
    }

    if (doc) {
      const attrScope = root.nodeType === 9 ? doc : root;
      collectAttributes(attrScope, skipMap, items);
    }

    items.forEach((item, i) => { item.id = 'i' + i; });
    return items;
  }

  // 多个 root 合并收集(观察器一次可能上报多个新增子树):
  // collect() 每次调用都从 'i0' 起编号,直接拼接会产生重复 id 导致译文串位;
  // 这里合并后统一重新编号,保证 id 在整批内全局唯一。
  function collectMany(roots, options) {
    const items = [];
    (roots || []).forEach((root) => {
      const type = root && root.nodeType;
      if (type !== 1 && type !== 9) return;
      // 观察器防抖期间节点可能已被移出文档:对死子树发起翻译纯属浪费请求
      if (root.isConnected === false) return;
      items.push(...collect(root, options));
    });
    items.forEach((item, i) => { item.id = 'i' + i; });
    return items;
  }

  const ExtCollect = { ATTR_NAMES, makeSkipMap, skipKey, isSkipped, markSkipped, unmarkSkipped, collect, collectMany };
  global.Ext = global.Ext || {};
  global.Ext.collect = ExtCollect;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtCollect;
})(typeof globalThis !== 'undefined' ? globalThis : self);

