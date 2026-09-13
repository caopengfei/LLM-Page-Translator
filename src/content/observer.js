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
    // 重试策略:返回 false 是"忙"背压(整页翻译耗时可能很长),无上限重排——
    // 对它设上限会在慢翻译中丢节点,重蹈翻译窗口内漏翻的覆辙,只在连续忙碌首现时提示一次。
    // 抛异常是调用方 bug:每次告警,连续 maxErrors 次后放弃并丢弃,避免坏回调让定时器空转
    const maxErrors = (options && Number.isFinite(options.maxErrors) && options.maxErrors > 0)
      ? Math.floor(options.maxErrors)
      : 5;
    let errors = 0;           // 连续抛异常次数;成功处理或正常背压即清零
    let busyNotified = false; // 本轮连续忙碌是否已提示过;成功处理即清零,避免刷屏

    function schedule() {
      if (!pending.size || timer !== null) return;
      timer = setTimeout(flush, debounceMs);
    }

    // 回调返回 false 表示"此刻无法处理"(例如正在翻译中)。此时把节点重新入队并稍后重试;
    // 直接丢弃会让翻译期间新增/改写的节点被永久漏翻,直到页面上再发生别的变更。
    // 调用方异常与背压区分处理:背压是预期的长等待,只在首现时提示;异常是 bug,
    // 连续超过 maxErrors 次后放弃本批并告警,避免坏回调让定时器无限空转
    function flush() {
      timer = null;
      if (!pending.size) return;
      const roots = Array.from(pending);
      pending = new Set();
      let accepted = true;
      let errored = false;
      try {
        accepted = onNewNodes(roots) !== false;
      } catch (e) {
        // 回调异常按"此刻无法处理"处理:重新入队稍后重试,
        // 既不静默丢节点,也不让异常打断计时器状态
        console.warn('[LLM Page Translator] observer callback failed, re-queued:', e);
        accepted = false;
        errored = true;
      }
      if (!accepted) {
        if (errored) {
          errors += 1;
          if (errors > maxErrors) {
            // 连续抛异常超过上限:放弃本批避免空转,重置计数等待下一次真实变更
            console.warn('[LLM Page Translator] observer callback failed ' + errors + ' times in a row, dropping ' + roots.length + ' node(s)');
            errors = 0;
            busyNotified = false;
            return;
          }
        } else {
          // 正常背压:清零异常计数;连续忙碌只提示一次,成功后重置
          errors = 0;
          if (!busyNotified) {
            busyNotified = true;
            console.warn('[LLM Page Translator] observer busy, re-queued ' + roots.length + ' node(s)');
          }
        }
        roots.forEach((n) => pending.add(n));
        schedule();
      } else {
        errors = 0;
        busyNotified = false;
      }
    }

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
      schedule();
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