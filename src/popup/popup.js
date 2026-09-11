(function (global) {
  'use strict';
  const C = global.EXT_CONSTANTS;
  const S = C.STATE;
  const I18n = global.Ext.i18n;
  const t = (key, subs) => I18n.t(key, subs);

  async function activeTabId(tabs) {
    const list = await tabs.query({ active: true, currentWindow: true });
    const tab = list && list[0];
    return tab && typeof tab.id === 'number' ? tab.id : null;
  }

  function setStatus(el, text, cls) {
    el.textContent = text;
    el.className = cls || '';
  }

  // 按钮文案随页面状态变化:已翻译时点击的语义是"还原"
  function labelFor(state) {
    return state === S.TRANSLATED ? t('popup_btn_restore') : t('popup_btn_translate');
  }

  // 翻译时长:不足一分钟显示到小数秒,超过则按分秒展示
  function formatDuration(ms) {
    const total = Math.max(0, ms || 0);
    if (total < 60000) return t('popup_duration_seconds', [(Math.round(total / 100) / 10).toFixed(1)]);
    const m = Math.floor(total / 60000);
    const s = Math.round((total % 60000) / 1000);
    return t('popup_duration_minutes', [m, s]);
  }

  // 打开的弹窗提示里,已翻译状态的描述
  function hintFor(payload) {
    if (!payload) return { text: '', cls: '' };
    if (payload.state === S.TRANSLATED) {
      return { text: t('popup_status_translated', [payload.translated || 0]) + statsSuffix(payload), cls: 'ok' };
    }
    if (payload.state === S.SKIPPED_SAME_LANGUAGE) {
      return {
        text: t('popup_status_same_lang', [payload.lang, payload.targetLang]),
        cls: 'info'
      };
    }
    return { text: '', cls: '' };
  }

  // 字数/用时统计片段;响应里没有统计字段时返回空串(兼容旧回包)
  function statsSuffix(res) {
    if (res.chars != null && res.ms != null) {
      return t('popup_status_stats', [res.chars, formatDuration(res.ms)]);
    }
    return '';
  }

  // content script 未回传 state 时按 reason 反推(兼容旧回包)
  function stateFromReason(reason) {
    if (reason === 'restored') return S.IDLE;
    if (reason === 'translated' || reason === 'already-translated') return S.TRANSLATED;
    if (reason === 'same-language') return S.SKIPPED_SAME_LANGUAGE;
    return null;
  }

  function renderLabel(doc, state) {
    const btn = doc.getElementById('toggle');
    if (!btn) return;
    // data-state 驱动图标切换(翻译/还原),CSS 负责呈现
    btn.dataset.state = state || S.IDLE;
    const label = btn.querySelector('.btn-label');
    if (label) label.textContent = labelFor(state);
    else btn.textContent = labelFor(state);
  }

  // 把 content script / background 返回的结构化结果映射为可读状态
  function describeResult(res) {
    if (!res) return { text: t('popup_status_no_response'), cls: 'error' };
    if (res.ok) {
      if (res.reason === 'restored') return { text: t('popup_status_restored', [res.restored]), cls: 'ok' };
      if (res.reason === 'already-translated') return { text: t('popup_status_already'), cls: 'ok' };
      if (res.reason === 'translated') {
        const suffix = res.partial ? t('popup_status_partial') : '';
        return { text: t('popup_status_translated', [res.translated]) + statsSuffix(res) + suffix, cls: res.partial ? '' : 'ok' };
      }
      return { text: t('popup_status_done'), cls: 'ok' };
    }
    // 语言一致是"无需翻译"的提示,不是失败
    if (res.reason === 'same-language') {
      return { text: res.message || t('popup_status_same_lang_generic'), cls: 'info' };
    }
    return { text: res.message || res.error || t('popup_status_not_executed'), cls: 'error' };
  }

  // 打开面板时查询当前页状态,用于渲染按钮文案与状态提示
  async function refreshState(doc, runtime, tabs) {
    const status = doc.getElementById('status');
    let tabId = null;
    try {
      tabId = await activeTabId(tabs);
    } catch (err) {
      renderLabel(doc, null);
      setStatus(status, t('popup_status_tab_error', [err.message]), 'error');
      return { ok: false };
    }
    if (tabId === null) {
      renderLabel(doc, null);
      setStatus(status, t('popup_status_page_unavailable'), 'error');
      return { ok: false };
    }
    let payload = null;
    try {
      payload = await runtime.sendMessage({ type: C.MSG.GET_STATE, tabId });
    } catch (err) {
      payload = null; // content script 未注入:页面必然未翻译,保持默认文案
    }
    const state = payload && payload.ok ? payload.state : null;
    renderLabel(doc, state);
    if (state) {
      const hint = hintFor(payload);
      setStatus(status, hint.text, hint.cls);
    }
    return { ok: !!(payload && payload.ok), state };
  }

  // 请求 background 对指定标签页执行翻译/还原切换
  // (注入 content script 的兜底逻辑集中在 service worker 的 TOGGLE_TAB 处理里)
  async function runToggle(doc, runtime, tabs) {
    const status = doc.getElementById('status');
    setStatus(status, t('popup_status_processing'), '');
    let tabId = null;
    try {
      tabId = await activeTabId(tabs);
    } catch (err) {
      setStatus(status, t('popup_status_tab_error', [err.message]), 'error');
      return { ok: false };
    }
    if (tabId === null) {
      setStatus(status, t('popup_status_page_unavailable'), 'error');
      return { ok: false };
    }
    try {
      const res = await runtime.sendMessage({ type: C.MSG.TOGGLE_TAB, tabId });
      const described = describeResult(res);
      setStatus(status, described.text, described.cls);
      const nextState = (res && res.state) || stateFromReason(res && res.reason);
      if (nextState) renderLabel(doc, nextState);
      return { ok: described.cls !== 'error' }; // 语言一致等信息性结果只提示,不算失败
    } catch (err) {
      setStatus(status, t('popup_status_failed', [err.message]), 'error');
      return { ok: false };
    }
  }

  // 用共享清单填充语言下拉(popup 与 options 页同一份,保证可选项一致)
  function populateLangSelect(sel) {
    (C.LANGUAGES || []).forEach((l) => {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = l.label;
      sel.appendChild(opt);
    });
  }

  // 读取当前目标语言;未配置时按浏览器 UI 语言推导(推导不出才用 DEFAULT_CONFIG)
  async function loadTargetLang(storage) {
    const data = await storage.get(C.STORAGE_KEYS.CONFIG);
    const stored = (data && data[C.STORAGE_KEYS.CONFIG]) || {};
    return stored.targetLang || C.defaultTargetLang();
  }

  // 只改 targetLang,保留其余配置字段(apiKey 等)
  async function saveTargetLang(storage, code) {
    const data = await storage.get(C.STORAGE_KEYS.CONFIG);
    const cfg = Object.assign({}, (data && data[C.STORAGE_KEYS.CONFIG]) || {}, { targetLang: code });
    const obj = {};
    obj[C.STORAGE_KEYS.CONFIG] = cfg;
    await storage.set(obj);
  }

  function wirePage(doc, runtime, tabs, storage) {
    if (I18n.apply) I18n.apply(doc); // 填充 HTML 里的 data-i18n 静态文案
    doc.getElementById('toggle').addEventListener('click', () => { runToggle(doc, runtime, tabs); });
    doc.getElementById('open-options').addEventListener('click', () => {
      runtime.openOptionsPage();
      if (typeof global.close === 'function') global.close();
    });
    const langSel = doc.getElementById('target-lang');
    if (langSel) {
      populateLangSelect(langSel);
      if (storage) {
        loadTargetLang(storage).then((code) => { langSel.value = code; });
        // 切换即保存,下一次翻译用新语言
        langSel.addEventListener('change', () => {
          saveTargetLang(storage, langSel.value).catch(() => {});
        });
      }
    }
    refreshState(doc, runtime, tabs);
  }

  const api = { activeTabId, labelFor, formatDuration, hintFor, describeResult, refreshState, runToggle, populateLangSelect, loadTargetLang, saveTargetLang, wirePage };
  global.Ext = global.Ext || {};
  global.Ext.popup = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // 页面接线(测试环境无 chrome 全局,自动跳过)
  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
    document.addEventListener('DOMContentLoaded', () => wirePage(document, chrome.runtime, chrome.tabs, chrome.storage.local));
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
