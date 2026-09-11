(function (global) {
  'use strict';

  function start(root, options) {
    const debounceMs = (options && options.debounceMs) || 500;
    const onNewNodes = options && options.onNewNodes;
    // 属性名白名单:站点改写 placeholder/title 等也应触发补翻。由调用方传入,
    // 观察器本身不感知具体名单,避免 class/style 的高频抖动带来额外回调
    const attributeFilter = (options && options.attributeFilter) || null;
    let timer = null;
    let pending = new Set();

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === 1) pending.add(n);
            else if (n.nodeType === 3 && n.parentElement) pending.add(n.parentElement);
          });
        } else if (m.type === 'characterData' && m.target.parentElement) {
          pending.add(m.target.parentElement);
        } else if (m.type === 'attributes' && m.target) {
          pending.add(m.target);
        }
      }
      if (pending.size && timer === null) {
        timer = setTimeout(() => {
          timer = null;
          const roots = Array.from(pending);
          pending = new Set();
          onNewNodes(roots);
        }, debounceMs);
      }
    });
    const config = { childList: true, subtree: true, characterData: true };
    if (attributeFilter && attributeFilter.length) {
      config.attributes = true;
      config.attributeFilter = attributeFilter.slice();
    }
    mo.observe(root, config);

    return {
      stop() {
        mo.disconnect();
        if (timer !== null) { clearTimeout(timer); timer = null; }
      }
    };
  }

  const ExtObserver = { start };
  global.Ext = global.Ext || {};
  global.Ext.observer = ExtObserver;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtObserver;
})(typeof globalThis !== 'undefined' ? globalThis : self);