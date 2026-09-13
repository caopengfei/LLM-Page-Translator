(function (global) {
  'use strict';

  // 语言下拉公共逻辑:popup 与 options 页共用,保证可选项与"补选项"行为一致。
  // 存量配置的语言代码可能不在共享清单里,直接给 select 赋值会静默回落到
  // 第一项,下次保存时把用户配置悄悄改掉——先补选项再赋值
  function populate(select) {
    if (!select) return;
    const C = global.EXT_CONSTANTS;
    ((C && C.LANGUAGES) || []).forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.label;
      select.appendChild(opt);
    });
  }

  function ensureOption(select, value) {
    if (!select || !value) return;
    const has = Array.prototype.some.call(select.options, (o) => o.value === value);
    if (!has) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      select.appendChild(opt);
    }
  }

  const api = { populate, ensureOption };
  global.Ext = global.Ext || {};
  global.Ext.langSelect = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);
