(function (global) {
  'use strict';
  const C = global.EXT_CONSTANTS;
  const FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang'];

  function configFromForm(form) {
    const cfg = {};
    FIELDS.forEach((name) => { cfg[name] = String(form.elements[name].value || '').trim(); });
    return cfg;
  }

  function fillForm(form, cfg) {
    FIELDS.forEach((name) => {
      if (form.elements[name]) form.elements[name].value = (cfg && cfg[name]) || '';
    });
  }

  function validateConfig(cfg) {
    const missing = FIELDS.filter((name) => !cfg || !cfg[name]);
    return { ok: missing.length === 0, missing };
  }

  async function loadConfigInto(form, storage) {
    const data = await storage.get(C.STORAGE_KEYS.CONFIG);
    fillForm(form, (data && data[C.STORAGE_KEYS.CONFIG]) || {});
  }

  async function saveConfigFrom(form, storage) {
    const cfg = configFromForm(form);
    const v = validateConfig(cfg);
    if (!v.ok) return v;
    const obj = {};
    obj[C.STORAGE_KEYS.CONFIG] = cfg;
    await storage.set(obj);
    return v;
  }

  function setStatus(status, text, cls) {
    status.textContent = text;
    status.className = cls || '';
  }

  function wirePage(doc, storage, runtime) {
    const form = doc.getElementById('options-form');
    const status = doc.getElementById('status');
    const missingMsg = (v) => 'Missing: ' + v.missing.join(', ');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = validateConfig(configFromForm(form));
      if (!v.ok) { setStatus(status, missingMsg(v), 'error'); return; }
      await saveConfigFrom(form, storage);
      setStatus(status, 'Saved ✓', 'ok');
    });

    doc.getElementById('test').addEventListener('click', async () => {
      const cfg = configFromForm(form);
      const v = validateConfig(cfg);
      if (!v.ok) { setStatus(status, missingMsg(v), 'error'); return; }
      setStatus(status, 'Testing…', '');
      try {
        const res = await runtime.sendMessage({ type: C.MSG.TEST_CONNECTION, config: cfg });
        if (res && res.ok) setStatus(status, 'OK ✓ sample: ' + res.sample, 'ok');
        else setStatus(status, 'Failed: ' + ((res && res.error) || 'unknown'), 'error');
      } catch (err) {
        setStatus(status, 'Failed: ' + err.message, 'error');
      }
    });

    loadConfigInto(form, storage);
  }

  const api = { FIELDS, configFromForm, fillForm, validateConfig, loadConfigInto, saveConfigFrom, wirePage };
  global.Ext = global.Ext || {};
  global.Ext.options = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 页面接线(测试环境无 chrome 全局,自动跳过)
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    document.addEventListener('DOMContentLoaded', () => wirePage(document, chrome.storage.local, chrome.runtime));
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
