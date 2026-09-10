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

  function langMatches(pageLangTag, targetLang) {
    const a = String(pageLangTag || '').toLowerCase().split('-')[0];
    const b = String(targetLang || '').toLowerCase().split('-')[0];
    return a !== '' && a === b;
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
