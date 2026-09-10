(function (global) {
  'use strict';

  function start(root, options) {
    const debounceMs = (options && options.debounceMs) || 500;
    const onNewNodes = options && options.onNewNodes;
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
    mo.observe(root, { childList: true, subtree: true, characterData: true });

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