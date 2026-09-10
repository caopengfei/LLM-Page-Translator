import '../shared/constants.js';
import '../shared/batch.js';
import '../shared/cache.js';
import './llm.js';

const C = globalThis.EXT_CONSTANTS;
const Batch = globalThis.Ext.batch;
const Cache = globalThis.Ext.cache;
const Llm = globalThis.Ext.llm;

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

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withRetry(fn, retries, sleepFn) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleepFn(Math.pow(2, attempt) * 1000);
      attempt += 1;
    }
  }
}

async function loadConfig(configStorage) {
  const data = await configStorage.get(C.STORAGE_KEYS.CONFIG);
  const stored = data && data[C.STORAGE_KEYS.CONFIG];
  return Object.assign({}, C.DEFAULT_CONFIG, stored || {});
}

async function handleTranslateBatch(msg, deps) {
  const config = await loadConfig(deps.configStorage);
  if (!config.apiKey) {
    return { ok: false, error: 'API key is not configured. Open the extension options page.' };
  }
  const items = msg.items || [];
  if (!items.length) return { ok: true, translations: {} };
  const targetLang = msg.targetLang || config.targetLang;

  const cached = await Cache.getMany(deps.cacheBackend, targetLang, [...new Set(items.map((i) => i.text))]);
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
  const batches = Batch.splitIntoBatches(misses, C.BATCH_MAX_ITEMS, C.BATCH_MAX_CHARS);
  let succeeded = 0; // 已成功批次数:用于把"后续批次失败"降级为部分结果
  for (const batch of batches) {
    const payload = Batch.buildPayload(batch);
    try {
      // 逐批缓存 / 回填:即使后续批次失败,已成功批次的译文也已落盘并返回
      const raw = await withRetry(() => Llm.translateViaLlm(requestConfig, payload, deps.fetchImpl), 2, deps.sleep);
      const parsed = Batch.parseResponse(raw);
      const newPairs = [];
      batch.forEach((item, idx) => {
        const t = parsed[String(idx)];
        if (typeof t !== 'string' || !t.length) return;
        (idsByText.get(item.text) || []).forEach((id) => { translations[id] = t; });
        newPairs.push({ src: item.text, dst: t });
      });
      if (newPairs.length) {
        await Cache.putMany(deps.cacheBackend, targetLang, newPairs);
      }
      succeeded += 1;
    } catch (err) {
      const message = String((err && err.message) || err);
      if (succeeded > 0) {
        // 该批次永久失败:已缓存的成功结果不丢,返回已得的部分结果(this round 未译节点下轮重新请求)
        console.warn('[LLM Page Translator] batch failed, returning partial results:', message);
        break;
      }
      // 首批即失败:无部分结果可返回,维持 ok:false 契约
      throw err;
    }
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
  if (!cfg.apiKey) return { ok: false, error: 'API key is required.' };
  try {
    const raw = await withRetry(() => Llm.translateViaLlm(cfg, { '0': 'Hello, world!' }, deps.fetchImpl), 1, deps.sleep);
    const parsed = Batch.parseResponse(raw);
    return { ok: true, sample: parsed['0'] || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

export function makeMessageHandler(overrides) {
  const o = overrides || {};
  const deps = {
    configStorage: o.configStorage || defaultConfigStorage(),
    cacheBackend: o.cacheBackend || defaultCacheBackend(),
    fetchImpl: o.fetchImpl || ((url, opts) => fetch(url, opts)),
    detectLanguage: o.detectLanguage || detectLanguageViaChrome,
    sleep: o.sleep || sleep
  };
  return async function handleMessage(msg) {
    try {
      if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'Unknown message' };
      switch (msg.type) {
        case C.MSG.TRANSLATE_BATCH:
          return await handleTranslateBatch(msg, deps);
        case C.MSG.DETECT_LANGUAGE:
          return await handleDetectLanguage(msg, deps);
        case C.MSG.TEST_CONNECTION:
          return await handleTestConnection(msg, deps);
        case C.MSG.TOGGLE:
          return { ok: true };
        default:
          return { ok: false, error: 'Unknown message type: ' + msg.type };
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
    handler(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步 sendResponse
  });
  if (chrome.action && chrome.action.onClicked) {
    const CONTENT_FILES = [
      'src/shared/constants.js',
      'src/shared/batch.js',
      'src/shared/cache.js',
      'src/content/detect.js',
      'src/content/collect.js',
      'src/content/apply.js',
      'src/content/observer.js',
      'src/content/main.js'
    ];
    chrome.action.onClicked.addListener((tab) => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: C.MSG.TOGGLE }).catch(() => {
        if (chrome.scripting && chrome.scripting.executeScript) {
          chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES }).catch(() => {});
        }
      });
    });
  }
}
