(function (global) {
  'use strict';
  const LANG_RE = /^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{1,8})*$/;

  function normalize(tag) {
    const t = String(tag || '').trim().replace('_', '-');
    if (!LANG_RE.test(t)) return null;
    return t;
  }

  function pageLang(doc) {
    const raw = doc && doc.documentElement ? doc.documentElement.getAttribute('lang') : '';
    return normalize(raw);
  }

  function chineseForm(tag) {
    const parts = String(tag || '').toLowerCase().split('-');
    if (parts[0] !== 'zh') return null;
    if (parts.includes('hans') || parts.includes('cn') || parts.includes('sg')) return 'simplified';
    if (parts.includes('hant') || parts.includes('tw') || parts.includes('hk') || parts.includes('mo')) return 'traditional';
    return null;
  }

  function langMatches(pageLangTag, targetLang) {
    const a = String(pageLangTag || '').toLowerCase().split('-')[0];
    const b = String(targetLang || '').toLowerCase().split('-')[0];
    if (a === '' || a !== b) return false;
    if (a === 'zh') {
      const pageForm = chineseForm(pageLangTag);
      const targetForm = chineseForm(targetLang);
      if (pageForm && targetForm) return pageForm === targetForm;
    }
    return true;
  }

  function sampleText(doc, maxLen) {
    const limit = maxLen || 500;
    const raw = doc && doc.body ? doc.body.textContent : '';
    const compact = String(raw || '').replace(/\s+/g, ' ').trim();
    return compact.slice(0, limit);
  }

  const ExtDetect = { normalize, pageLang, langMatches, sampleText };
  global.Ext = global.Ext || {};
  global.Ext.detect = ExtDetect;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtDetect;
})(typeof globalThis !== 'undefined' ? globalThis : self);
