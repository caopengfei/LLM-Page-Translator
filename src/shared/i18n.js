(function (global) {
  'use strict';

  // 唯一的界面文案出口。文案表放在 _locales/<locale>/messages.json,
  // 由 chrome.i18n 按浏览器 UI 语言选择;这里只做查找、回退与 DOM 填充。
  function hasRuntimeI18n() {
    return typeof chrome !== 'undefined' && !!chrome && !!chrome.i18n &&
      typeof chrome.i18n.getMessage === 'function';
  }

  // getMessage 在 key 缺失时返回空串;回退成 key 本身,缺失会直接显现在界面上,
  // 而不是静默留白(chrome.i18n 缺 key 时不会自动回退到 default_locale 之外的兜底)
  function t(key, subs) {
    if (!key) return '';
    let out = '';
    if (hasRuntimeI18n()) {
      try { out = chrome.i18n.getMessage(key, subs || []); } catch (e) { out = ''; }
    }
    return out || key;
  }

  // 语言代码等运行时值不含文案,单独拼装以便调用方控制上下文
  function tJoin(parts) {
    return (parts || []).filter((p) => p != null && p !== '').join('');
  }

  function uiLanguage() {
    const C = global.EXT_CONSTANTS;
    if (C && typeof C.uiLanguage === 'function') return C.uiLanguage();
    return '';
  }

  // 把 HTML 里声明的 data-i18n* 标记替换成当前语言的文案。
  // 在 DOMContentLoaded 时调用一次即可,动态生成的节点由各页面自行 setText。
  function apply(root) {
    const doc = root || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.querySelectorAll !== 'function') return;
    const lang = uiLanguage();
    if (lang && doc.documentElement) doc.documentElement.setAttribute('lang', lang);

    const all = (sel) => Array.prototype.slice.call(doc.querySelectorAll(sel));
    all('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    // 少数说明段落内嵌 <b>/<code> 等排版标签;文案表随扩展一起打包,不是用户输入
    all('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    all('[data-i18n-title]').forEach((el) => { el.setAttribute('title', t(el.getAttribute('data-i18n-title'))); });
    all('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'))); });
    all('[data-i18n-placeholder]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-placeholder'))); });
  }

  const ExtI18n = { t, tJoin, uiLanguage, apply, hasRuntimeI18n };
  global.Ext = global.Ext || {};
  global.Ext.i18n = ExtI18n;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtI18n;
})(typeof globalThis !== 'undefined' ? globalThis : self);
