(function (global) {
  'use strict';
  const C = global.EXT_CONSTANTS;
  const I18n = global.Ext.i18n;
  const t = (key, subs) => I18n.t(key, subs);
  const FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang']; // 必填字段
  const TIMEOUT_FIELD = 'timeoutSec'; // 可选:秒 → 存为 config.timeoutMs

  function configFromForm(form) {
    const cfg = {};
    FIELDS.forEach((name) => { cfg[name] = String(form.elements[name].value || '').trim(); });
    return cfg;
  }

  // 表单里的秒数 → 毫秒;空/非法时返回 null(表示使用默认超时)
  function timeoutMsFromForm(form) {
    const el = form.elements[TIMEOUT_FIELD];
    if (!el) return null;
    const sec = Number(String(el.value || '').trim());
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return Math.round(sec * 1000);
  }

  function fillForm(form, cfg) {
    FIELDS.forEach((name) => {
      // 目标语言没有存过时按浏览器 UI 语言推导,让下拉框显示用户看得懂的那一项
      const fallback = name === 'targetLang' ? C.defaultTargetLang() : '';
      if (form.elements[name]) form.elements[name].value = (cfg && cfg[name]) || fallback;
    });
    const el = form.elements[TIMEOUT_FIELD];
    if (el) {
      const ms = (cfg && Number(cfg.timeoutMs)) || C.DEFAULT_CONFIG.timeoutMs;
      el.value = String(Math.round(ms / 1000));
    }
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
    const timeoutMs = timeoutMsFromForm(form);
    if (timeoutMs) cfg.timeoutMs = timeoutMs;
    const obj = {};
    obj[C.STORAGE_KEYS.CONFIG] = cfg;
    await storage.set(obj);
    return v;
  }

  function setStatus(status, text, cls) {
    status.textContent = text;
    status.className = cls || '';
  }

  // 与 popup 共用同一份语言清单,保证两处可选项一致
  function populateLanguages(select) {
    if (!select) return;
    (C.LANGUAGES || []).forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.label;
      select.appendChild(opt);
    });
  }

  function wirePage(doc, storage, runtime) {
    if (I18n.apply) I18n.apply(doc); // 填充 HTML 里的 data-i18n 静态文案
    doc.title = t('ext_name') + ' — ' + t('options_page_title');
    const form = doc.getElementById('options-form');
    const status = doc.getElementById('status');
    const missingMsg = (v) => t('options_status_missing', [v.missing.join(', ')]);

    populateLanguages(form.elements.targetLang);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = validateConfig(configFromForm(form));
      if (!v.ok) { setStatus(status, missingMsg(v), 'error'); return; }
      await saveConfigFrom(form, storage);
      setStatus(status, t('options_status_saved'), 'ok');
    });

    doc.getElementById('test').addEventListener('click', async () => {
      const cfg = configFromForm(form);
      const v = validateConfig(cfg);
      if (!v.ok) { setStatus(status, missingMsg(v), 'error'); return; }
      const timeoutMs = timeoutMsFromForm(form);
      if (timeoutMs) cfg.timeoutMs = timeoutMs; // Test 也尊重超时设置
      setStatus(status, t('options_status_testing'), '');
      try {
        const res = await runtime.sendMessage({ type: C.MSG.TEST_CONNECTION, config: cfg });
        if (res && res.ok) setStatus(status, t('options_status_test_ok', [res.sample]), 'ok');
        else setStatus(status, t('options_status_test_failed', [(res && res.error) || t('options_status_unknown')]), 'error');
      } catch (err) {
        setStatus(status, t('options_status_test_failed', [err.message]), 'error');
      }
    });

    loadConfigInto(form, storage);
  }

  const api = { FIELDS, TIMEOUT_FIELD, configFromForm, timeoutMsFromForm, fillForm, validateConfig, loadConfigInto, saveConfigFrom, populateLanguages, wirePage };
  global.Ext = global.Ext || {};
  global.Ext.options = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 页面接线(测试环境无 chrome 全局,自动跳过)
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    document.addEventListener('DOMContentLoaded', () => wirePage(document, chrome.storage.local, chrome.runtime));
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
