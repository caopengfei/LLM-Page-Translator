import '../shared/constants.js';
import '../shared/i18n.js';
import '../shared/batch.js';
import '../shared/cache.js';
import './llm.js';

const C = globalThis.EXT_CONSTANTS;
const Batch = globalThis.Ext.batch;
const Cache = globalThis.Ext.cache;
const Llm = globalThis.Ext.llm;
const t = (key, subs) => globalThis.Ext.i18n.t(key, subs);

function chromeStorage() { return chrome.storage.local; }

function defaultConfigStorage() {
  return { get: (key) => chromeStorage().get(key) };
}

function defaultCacheBackend() {
  return Cache.chromeStorageBackend(chromeStorage());
}

function detectLanguageViaChrome(text) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.i18n || !chrome.i18n.detectLanguage) {
      reject(new Error('chrome.i18n.detectLanguage is unavailable'));
      return;
    }
    chrome.i18n.detectLanguage(text, (result) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      const langs = (result && result.languages) || [];
      if (!langs.length) { reject(new Error('No language detected')); return; }
      resolve(langs[0].language);
    });
  });
}

// content script 注入顺序:必须与 manifest.json 的 content_scripts[0].js 保持一致
// (数组顺序即依赖顺序,constants 必须最先加载)
const CONTENT_FILES = [
  'src/shared/constants.js',
  'src/shared/i18n.js',
  'src/shared/batch.js',
  'src/shared/cache.js',
  'src/content/detect.js',
  'src/content/collect.js',
  'src/content/apply.js',
  'src/content/observer.js',
  'src/content/main.js'
];

// 向标签页发送 TOGGLE;若 content script 尚未注入(安装后首次点击 /
// 页面在安装前已打开),先注入再补发,避免本次点击被吞掉
async function defaultToggleTab(tabId) {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    throw new Error('chrome.tabs is unavailable');
  }
  try {
    // content script 的 TOGGLE 回包即翻译/还原的结构化结果(直接透传给 popup)
    return await chrome.tabs.sendMessage(tabId, { type: C.MSG.TOGGLE });
  } catch (e) { /* 未注入 → 走下面的注入分支 */ }
  if (!chrome.scripting || !chrome.scripting.executeScript) {
    throw new Error(t('popup_status_page_unavailable'));
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  return chrome.tabs.sendMessage(tabId, { type: C.MSG.TOGGLE });
}

// 读取标签页的翻译状态。刻意不做注入兜底:content script 不在,说明该页面
// 从未被翻译过,直接按 idle 上报;为了读一个状态而注入整套脚本不划算
async function defaultQueryState(tabId) {
  if (typeof chrome === 'undefined' || !chrome.tabs) {
    throw new Error('chrome.tabs is unavailable');
  }
  return chrome.tabs.sendMessage(tabId, { type: C.MSG.GET_STATE });
}

// 流式上屏:每批译文完成即推给 tab,不等全部批次返回。页面已关闭/未注入时静默忽略
async function defaultSendToTab(tabId, message) {
  if (typeof chrome === 'undefined' || !chrome.tabs || typeof chrome.tabs.sendMessage !== 'function') {
    return;
  }
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (e) { /* 页面已关闭或 content script 未注入:忽略 */ }
}

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withRetry(fn, retries, sleepFn, shouldRetry) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      // 地址不可达(超时/网络)重试无意义,直接失败,避免用户白等 3 倍超时
      if (shouldRetry && !shouldRetry(err)) throw err;
      // 限流(429)退避加倍:密集重试只会进一步触发限流。
      // MV3 说明:await sleep 期间 SW 靠未决 Promise 保持存活(约 5 分钟预算),
      // 单次睡眠封顶 10s(翻译批次最多睡 5s+10s=15s),避免退避把存活窗口拖得过长
      const base = err && err.code === 'RATE_LIMIT' ? 5000 : 1000;
      const delay = Math.min(Math.pow(2, attempt) * base, 10000);
      await sleepFn(delay);
      attempt += 1;
    }
  }
}

// 仅对明确的瞬时问题重试:限流(429)和服务端错误(5xx)。
// 认证/参数错误、解析错误、超时和网络错误都不会重复发送请求。
function isRetryable(err) {
  if (!err) return false;
  if (err.code === 'RATE_LIMIT') return true;
  return Number.isInteger(err.status) && err.status >= 500 && err.status <= 599;
}

// Test connection 的重试次数固定为 1:它只是一次连通性探测,
// 用设置页配置的重试次数会让"点一下测试"在最坏情况下等上很久
const TEST_CONNECTION_RETRIES = 1;

async function loadConfig(configStorage) {
  const data = await configStorage.get(C.STORAGE_KEYS.CONFIG);
  const stored = data && data[C.STORAGE_KEYS.CONFIG];
  return Object.assign({}, C.DEFAULT_CONFIG, stored || {});
}

async function handleTranslateBatch(msg, deps, sender) {
  const config = await loadConfig(deps.configStorage);
  if (!config.apiKey) {
    return { ok: false, error: t('page_not_configured') };
  }
  const items = msg.items || [];
  if (!items.length) return { ok: true, translations: {} };
  const targetLang = msg.targetLang || config.targetLang;
  // 流式推送的目标 tab;来自 content script 的 sender 一定带 tab,其余调用方(popup/测试)没有
  const tabId = sender && sender.tab ? sender.tab.id : undefined;

  const cached = await Cache.getMany(deps.cacheBackend, targetLang, [...new Set(items.map((i) => i.text))], config.model);
  const translations = {};
  items.forEach((item) => {
    const hit = cached.get(item.text);
    if (typeof hit === 'string') translations[item.id] = hit;
  });

  const idsByText = new Map();
  items.forEach((item) => {
    if (item.id in translations) return;
    const arr = idsByText.get(item.text) || [];
    arr.push(item.id);
    idsByText.set(item.text, arr);
  });
  const misses = [...idsByText.keys()].map((text, idx) => ({ id: 'm' + idx, text }));

  const requestConfig = Object.assign({}, config, { targetLang });
  // 重试次数来自设置页(默认 3),storage 里的值可能越界或非法,统一夹紧后再用
  const retries = C.normalizeRetries(config.retries);
  const batches = Batch.splitIntoBatches(misses, C.BATCH_MAX_ITEMS, C.BATCH_MAX_CHARS);
  const concurrency = Math.min(C.BATCH_CONCURRENCY || 1, batches.length);
  let cursor = 0;
  let succeeded = 0;
  let lastError = null;

  // 一个批次:请求 → 解析 → 回填 → 逐批落盘(成功即缓存,后续批次失败不影响)
  // 完成后把该批译文立即推给页面,实现"每批回来就上屏"
  async function runBatch(batch) {
    const payload = Batch.buildPayload(batch);
    const raw = await withRetry(
      () => Llm.translateViaLlm(requestConfig, payload, deps.fetchImpl, deps.logger),
      retries, deps.sleep, isRetryable
    );
    const parsed = Batch.parseResponse(raw);
    const newPairs = [];
    const batchTranslations = {};
    const resolved = [];
    batch.forEach((item, idx) => {
      const translated = parsed[String(idx)];
      if (typeof translated !== 'string' || !translated.trim()) {
        const error = new Error(t('error_incomplete_response', [String(idx)]));
        error.code = 'INCOMPLETE_RESPONSE';
        throw error;
      }
      resolved.push({ item, text: translated });
      newPairs.push({ src: item.text, dst: translated });
    });
    resolved.forEach(({ item, text }) => {
      (idsByText.get(item.text) || []).forEach((id) => {
        translations[id] = text;
        batchTranslations[id] = text;
      });
    });
    if (newPairs.length) {
      // 缓存写入失败（含配额超限）只降级为告警：译文照常返回并推送，
      // 否则一次存储异常会连带丢掉本批的流式上屏
      try {
        await Cache.putMany(deps.cacheBackend, targetLang, newPairs, config.model);
      } catch (e) {
        deps.logger.warn('[LLM Page Translator] cache write failed:', String((e && e.message) || e));
      }
    }
    if (tabId && Object.keys(batchTranslations).length) {
      try {
        const p = deps.sendToTab(tabId, { type: C.MSG.RESULT_BATCH, translations: batchTranslations });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) { /* 推送失败不影响批次结果 */ }
    }
  }

  // 并发池:慢接口下串行等待是"翻译很久"的主因
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= batches.length) return;
      try {
        await runBatch(batches[index]);
        succeeded += 1;
      } catch (err) {
        lastError = String((err && err.message) || err);
        deps.logger.warn('[LLM Page Translator] batch failed:', lastError);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (succeeded === 0 && Object.keys(translations).length === 0) {
    return { ok: false, error: lastError || t('popup_status_not_executed') };
  }
  if (succeeded < batches.length) {
    // 部分批次失败:已成功部分照常返回,未译节点下一轮(或再次点击)重新请求
    deps.logger.warn('[LLM Page Translator] partial result: ' + succeeded + '/' + batches.length + ' batches');
    return { ok: true, translations, partial: true };
  }
  return { ok: true, translations };
}

async function handleDetectLanguage(msg, deps) {
  try {
    const language = await deps.detectLanguage(String(msg.text || '').slice(0, 1000));
    return { ok: true, language };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function handleTestConnection(msg, deps) {
  const cfg = Object.assign({}, C.DEFAULT_CONFIG, msg.config || {});
  if (!cfg.apiKey) return { ok: false, error: t('page_not_configured') };
  try {
    const raw = await withRetry(
      () => Llm.translateViaLlm(cfg, { '0': 'Hello, world!' }, deps.fetchImpl, deps.logger),
      TEST_CONNECTION_RETRIES, deps.sleep, isRetryable
    );
    const parsed = Batch.parseResponse(raw);
    return { ok: true, sample: parsed['0'] || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// popup 点击"翻译/还原本页"时调用:对指定 tab 执行切换
async function handleToggleTab(msg, deps) {
  const tabId = msg.tabId;
  if (typeof tabId !== 'number') return { ok: false, error: t('popup_status_page_unavailable') };
  try {
    const result = await deps.toggleTab(tabId);
    // content script 返回结构化结果时直接透传(popup 据此显示"已翻译 N 处/未翻译原因")
    if (result && typeof result.ok === 'boolean') return result;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// popup 打开时查询当前页状态:用于渲染按钮文案与状态提示
async function handleGetState(msg, deps) {
  const tabId = msg.tabId;
  if (typeof tabId !== 'number') return { ok: false, error: t('popup_status_page_unavailable') };
  try {
    const result = await deps.queryState(tabId);
    if (result && typeof result.ok === 'boolean') return result;
    return { ok: true, state: C.STATE.IDLE, translated: 0 };
  } catch (err) {
    // 收不到回包 = 该页面从未被翻译(或页面已关闭)
    return { ok: true, state: C.STATE.IDLE, translated: 0 };
  }
}

export function makeMessageHandler(overrides) {
  const o = overrides || {};
  const deps = {
    configStorage: o.configStorage || defaultConfigStorage(),
    cacheBackend: o.cacheBackend || defaultCacheBackend(),
    fetchImpl: o.fetchImpl || ((url, opts) => fetch(url, opts)),
    // 日志出口:默认 console(Service Worker 控制台可见);测试注入静默 logger
    logger: o.logger || console,
    // 流式上屏出口:每批译文推给 tab;默认 chrome.tabs.sendMessage,测试注入 spy
    sendToTab: o.sendToTab || defaultSendToTab,
    detectLanguage: o.detectLanguage || detectLanguageViaChrome,
    sleep: o.sleep || sleep,
    toggleTab: o.toggleTab || defaultToggleTab,
    queryState: o.queryState || defaultQueryState
  };
  return async function handleMessage(msg, sender) {
    try {
      if (!msg || typeof msg.type !== 'string') return { ok: false, error: t('popup_status_not_executed') };
      switch (msg.type) {
        case C.MSG.TRANSLATE_BATCH:
          return await handleTranslateBatch(msg, deps, sender);
        case C.MSG.DETECT_LANGUAGE:
          return await handleDetectLanguage(msg, deps);
        case C.MSG.TEST_CONNECTION:
          return await handleTestConnection(msg, deps);
        case C.MSG.TOGGLE_TAB:
          return await handleToggleTab(msg, deps);
        case C.MSG.GET_STATE:
          return await handleGetState(msg, deps);
        default:
          return { ok: false, error: t('popup_status_not_executed') };
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };
}

// ---- globalThis.Ext.sw 挂载(供测试读取;引用与导出相同的函数对象) ----
const ExtSw = { makeMessageHandler };
globalThis.Ext = globalThis.Ext || {};
globalThis.Ext.sw = ExtSw;

// ---- chrome 运行时接线(测试环境无 chrome 全局,自动跳过) ----
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  const handler = makeMessageHandler();
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handler(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步 sendResponse
  });
  if (chrome.action && chrome.action.onClicked) {
    // 注:manifest 声明了 default_popup 时该事件不会触发;保留作为兜底路径
    chrome.action.onClicked.addListener((tab) => {
      if (!tab || !tab.id) return;
      defaultToggleTab(tab.id).catch(() => {});
    });
  }
}
