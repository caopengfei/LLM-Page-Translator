(function () {
  'use strict';
  const C = globalThis.EXT_CONSTANTS;
  const Collect = globalThis.Ext.collect;
  const Apply = globalThis.Ext.apply;
  const Detect = globalThis.Ext.detect;
  const Obs = globalThis.Ext.observer;

  let skipMap = new WeakMap();
  let applied = [];
  let translating = false;
  let active = false;
  let observerHandle = null;

  function send(msg) {
    return chrome.runtime.sendMessage(msg).then((res) => {
      if (!res) throw new Error('No response from background');
      if (!res.ok) throw new Error(res.error || 'Background error');
      return res;
    });
  }

  async function loadTargetLang() {
    const data = await chrome.storage.local.get(C.STORAGE_KEYS.CONFIG);
    const cfg = Object.assign({}, C.DEFAULT_CONFIG, (data && data[C.STORAGE_KEYS.CONFIG]) || {});
    return cfg.targetLang;
  }

  async function resolvePageLang(targetLang) {
    let lang = Detect.pageLang(document);
    if (!lang) {
      try {
        const res = await send({ type: C.MSG.DETECT_LANGUAGE, text: Detect.sampleText(document) });
        lang = res.language;
      } catch (e) { lang = null; }
    }
    return { same: !!(lang && Detect.langMatches(lang, targetLang)), lang };
  }

  function keyOf(rec) { return Collect.skipKey(rec.kind, rec.attr); }

  async function translateRoots(roots, targetLang) {
    // collectMany 在合并多个 root 后统一重新编号,避免各 root 的 'i0' id 冲突导致译文串位
    const items = Collect.collectMany(roots, { skip: skipMap });
    if (!items.length) return 0;
    const res = await send({
      type: C.MSG.TRANSLATE_BATCH,
      items: items.map((it) => ({ id: it.id, text: it.text })),
      targetLang
    });
    const appliedNow = Apply.applyTranslations(items, res.translations);
    appliedNow.forEach((rec) => {
      applied.push(rec);
      Collect.markSkipped(skipMap, rec.node, keyOf(rec));
    });
    return appliedNow.length;
  }

  function startObserver(targetLang) {
    if (observerHandle) return;
    observerHandle = Obs.start(document, {
      debounceMs: C.DEBOUNCE_MS,
      onNewNodes: (roots) => {
        if (!active || translating) return;
        translating = true;
        translateRoots(roots, targetLang)
          .catch(() => { /* 动态补翻失败静默,保持原文 */ })
          .finally(() => { translating = false; });
      }
    });
  }

  async function translatePage() {
    if (translating || active) return;
    translating = true;
    try {
      const targetLang = await loadTargetLang();
      const { same } = await resolvePageLang(targetLang);
      if (!same) {
        const n = await translateRoots([document], targetLang);
        if (n > 0) startObserver(targetLang);
      }
      active = true;
    } catch (err) {
      console.warn('[LLM Page Translator]', err.message || err);
    } finally {
      translating = false;
    }
  }

  function restorePage() {
    if (observerHandle) { observerHandle.stop(); observerHandle = null; }
    Apply.restoreAll(applied);
    applied.forEach((rec) => Collect.unmarkSkipped(skipMap, rec.node, keyOf(rec)));
    applied = [];
    active = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== C.MSG.TOGGLE) return;
    if (active) restorePage(); else translatePage();
  });
})();
