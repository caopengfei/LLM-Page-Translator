(function () {
  'use strict';
  // service worker 在 TOGGLE 发送失败时会重新注入整套 content 文件;
  // 没有这个守卫,同一页面会出现两个 main.js 实例,各持一套互不可见的状态
  if (globalThis.__llmPageTranslatorLoaded) return;
  globalThis.__llmPageTranslatorLoaded = true;

  const C = globalThis.EXT_CONSTANTS;
  const S = C.STATE;
  const I18n = globalThis.Ext.i18n;
  const t = (key, subs) => I18n.t(key, subs);
  const Collect = globalThis.Ext.collect;
  const Apply = globalThis.Ext.apply;
  const Detect = globalThis.Ext.detect;
  const Obs = globalThis.Ext.observer;

  let skipMap = Collect.makeSkipMap();
  let applied = [];
  let translating = false;
  let translatingSince = 0;
  // 三态代替早先的 active 布尔值:同语言跳过必须与"已翻译"区分开
  let mode = S.IDLE;
  let skipInfo = null; // 同语言跳过时保留 {lang, targetLang},供 popup 展示
  let observerHandle = null;
  // 会话累计统计:源文字符数与翻译总耗时(含动态补翻),随 GET_STATE/响应带给 popup
  let stats = { chars: 0, ms: 0 };

  function send(msg) {
    return chrome.runtime.sendMessage(msg).then((res) => {
      if (!res) throw new Error('No response from background');
      if (!res.ok) throw new Error(res.error || 'Background error');
      return res;
    });
  }

  async function loadConfig() {
    const data = await chrome.storage.local.get(C.STORAGE_KEYS.CONFIG);
    const stored = (data && data[C.STORAGE_KEYS.CONFIG]) || {};
    const cfg = Object.assign({}, C.DEFAULT_CONFIG, stored);
    // 用户从未选过目标语言时按浏览器 UI 语言推导,而不是沿用 DEFAULT_CONFIG 的兜底值
    if (!stored.targetLang) cfg.targetLang = C.defaultTargetLang();
    return cfg;
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

  // 对账:丢弃脱离文档或被站点改写过的记录。两者都要解除 skip 标记——
  // 后者是为了让本轮 collect 能把它重新收进来翻译
  function reconcileRecords() {
    const { kept, dropped } = Apply.reconcile(applied);
    if (!dropped.length) return 0;
    applied = kept;
    dropped.forEach((rec) => Collect.unmarkSkipped(skipMap, rec.node, keyOf(rec)));
    return dropped.length;
  }

  async function translateRoots(roots, targetLang) {
    const startedAt = Date.now();
    // collectMany 在合并多个 root 后统一重新编号,避免各 root 的 'i0' id 冲突导致译文串位
    const items = Collect.collectMany(roots, { skip: skipMap });
    if (!items.length) return { applied: 0, partial: false, chars: 0, ms: 0 };
    const byId = new Map(items.map((it) => [it.id, it]));

    let appliedCount = 0;
    let chars = 0;
    let partial = false;
    const appliedIds = new Set();

    // 把一批译文应用到 DOM。按 id 去重:同一节点只应用一次,
    // 避免 background 推送与最终响应把同一译文重复上屏、产生重复对账记录
    const applyBatch = (translations) => {
      const batchItems = [];
      Object.keys(translations || {}).forEach((id) => {
        if (appliedIds.has(id)) return;
        const item = byId.get(id);
        if (item) batchItems.push(item);
      });
      if (!batchItems.length) return;
      const records = Apply.applyTranslations(batchItems, translations);
      records.forEach((rec) => {
        appliedIds.add(rec.id);
        applied.push(rec);
        Collect.markSkipped(skipMap, rec.node, keyOf(rec));
      });
      appliedCount += records.length;
      chars += records.reduce((sum, rec) => sum + (rec.srcLen || 0), 0);
    };

    let batchListener = null;
    try {
      // 流式上屏:background 每完成一批就推 RESULT_BATCH,收到立即应用,不等全部返回
      batchListener = (msg) => {
        if (!msg || msg.type !== C.MSG.RESULT_BATCH) return;
        applyBatch(msg.translations);
      };
      chrome.runtime.onMessage.addListener(batchListener);
      const res = await send({
        type: C.MSG.TRANSLATE_BATCH,
        items: items.map((it) => ({ id: it.id, text: it.text })),
        targetLang
      });
      partial = !!(res && res.partial);
      // 兜底:个别批次推送丢失(或旧版 background 不推送)时,用完整响应补齐;
      // 已上屏的 id 会被 appliedIds 跳过
      applyBatch(res.translations);
    } finally {
      if (batchListener) chrome.runtime.onMessage.removeListener(batchListener);
    }
    return { applied: appliedCount, partial, chars, ms: Date.now() - startedAt };
  }

  function startObserver(targetLang) {
    if (observerHandle) return;
    observerHandle = Obs.start(document, {
      debounceMs: C.DEBOUNCE_MS,
      // 站点改写 placeholder/title/aria-label/alt 也要触发补翻
      attributeFilter: Collect.ATTR_NAMES,
      onNewNodes: (roots) => {
        if (mode !== S.TRANSLATED || translating) return;
        translating = true;
        reconcileRecords();
        // 动态补翻也计入"共 X 字 / 总是用时"累计
        translateRoots(roots, targetLang)
          .then((run) => {
            stats.chars += run.chars;
            stats.ms += run.ms;
          })
          .catch(() => { /* 动态补翻失败静默,保持原文 */ })
          .finally(() => { translating = false; });
      }
    });
  }

  function statePayload() {
    const payload = {
      ok: true,
      state: mode,
      translated: applied.length,
      chars: stats.chars,
      ms: stats.ms
    };
    if (mode === S.SKIPPED_SAME_LANGUAGE && skipInfo) {
      payload.lang = skipInfo.lang;
      payload.targetLang = skipInfo.targetLang;
    }
    return payload;
  }

  // 返回结构化结果,由 background 透传给 popup 展示(避免"点了没反应"的黑盒体验)
  async function translatePage() {
    if (translating) {
      const elapsed = translatingSince ? Math.round((Date.now() - translatingSince) / 1000) : 0;
      return {
        ok: false,
        reason: 'busy',
        state: mode,
        message: t('page_busy', [elapsed])
      };
    }
    if (mode === S.TRANSLATED) {
      return { ok: true, reason: 'already-translated', state: mode, translated: applied.length, chars: stats.chars, ms: stats.ms };
    }
    translating = true;
    translatingSince = Date.now();
    try {
      const config = await loadConfig();
      const targetLang = config.targetLang;
      if (!config.apiKey) {
        return { ok: false, reason: 'not-configured', state: mode, message: t('page_not_configured') };
      }
      const { same, lang } = await resolvePageLang(targetLang);
      if (same) {
        mode = S.SKIPPED_SAME_LANGUAGE;
        skipInfo = { lang, targetLang };
        return {
          ok: false,
          reason: 'same-language',
          state: mode,
          lang,
          targetLang,
          message: t('page_same_lang', [lang, targetLang])
        };
      }
      // 页面确实可翻译:归位为 idle,翻译失败时不残留旧的"语言一致"判定
      mode = S.IDLE;
      skipInfo = null;
      const { applied: n, partial, chars, ms } = await translateRoots([document], targetLang);
      stats.chars += chars;
      stats.ms += ms;
      if (n === 0) {
        return { ok: false, reason: 'no-text', state: mode, message: t('page_no_text') };
      }
      startObserver(targetLang);
      mode = S.TRANSLATED;
      return { ok: true, reason: 'translated', state: mode, translated: applied.length, chars: stats.chars, ms: stats.ms, partial, targetLang };
    } catch (err) {
      // 失败时不置 translated,用户可直接重试
      const message = String((err && err.message) || err);
      console.warn('[LLM Page Translator]', message);
      return { ok: false, reason: 'error', state: mode, message };
    } finally {
      translating = false;
    }
  }

  function restorePage() {
    if (observerHandle) { observerHandle.stop(); observerHandle = null; }
    const restored = Apply.restoreAll(applied);
    applied.forEach((rec) => Collect.unmarkSkipped(skipMap, rec.node, keyOf(rec)));
    applied = [];
    mode = S.IDLE;
    skipInfo = null;
    stats = { chars: 0, ms: 0 }; // 页面已还原,统计随之清零
    return { ok: true, reason: 'restored', state: mode, restored };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === C.MSG.GET_STATE) {
      // 只对账上报数字,不在这里发起翻译;改写会先触发 observer,由它负责补翻
      reconcileRecords();
      sendResponse(statePayload());
      return false;
    }
    if (msg.type !== C.MSG.TOGGLE) return false;
    if (mode === S.TRANSLATED) {
      sendResponse(restorePage());
      return false;
    }
    translatePage()
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, reason: 'error', state: mode, message: String((err && err.message) || err) }));
    return true; // 异步 sendResponse
  });
})();