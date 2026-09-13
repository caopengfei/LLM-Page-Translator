import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/cache.js';
import '../src/background/service-worker.js';

const C = globalThis.EXT_CONSTANTS;
const Cache = globalThis.Ext.cache;
const makeMessageHandler = globalThis.Ext.sw.makeMessageHandler;

// 静默 logger:请求/响应日志的断言在 llm.test.js,这里只要不污染测试输出
const silentLogger = { log() {}, warn() {} };

function makeDeps() {
  const store = new Map();
  store.set(C.STORAGE_KEYS.CONFIG, {
    baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN'
  });
  const configStorage = {
    get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {})
  };
  const cacheBackend = Cache.memoryBackend();
  const fetchCalls = [];
  const okJson = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return okJson({ '0': '你好' });
  };
  const deps = {
    configStorage,
    cacheBackend,
    fetchImpl,
    logger: silentLogger,
    detectLanguage: async () => 'en',
    sleep: async () => {}
  };
  return { deps, fetchCalls, cacheBackend, okJson };
}

describe('TRANSLATE_BATCH', () => {
  it('serves fully-cached items without calling the LLM', async () => {
    const { deps, fetchCalls, cacheBackend } = makeDeps();
    await Cache.putMany(cacheBackend, 'zh-CN', [{ src: 'Hello', dst: '你好' }], 'm1');
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res).toEqual({ ok: true, translations: { a: '你好' } });
    expect(fetchCalls.length).toBe(0);
  });

  it('translates misses, backfills and writes the cache', async () => {
    const { deps, fetchCalls, cacheBackend } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(true);
    expect(res.translations.a).toBe('你好');
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].opts.headers.Authorization).toBe('Bearer sk-test');
    const again = await Cache.getMany(cacheBackend, 'zh-CN', ['Hello'], 'm1');
    expect(again.get('Hello')).toBe('你好');
  });

  it('dedupes identical texts within one batch request', async () => {
    const { deps, fetchCalls } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({
      type: C.MSG.TRANSLATE_BATCH,
      items: [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'Hello' }],
      targetLang: 'zh-CN'
    });
    expect(res.translations).toEqual({ a: '你好', b: '你好' });
    expect(fetchCalls.length).toBe(1);
  });

  it('retries failed requests twice before succeeding', async () => {
    const { deps, fetchCalls } = makeDeps();
    let n = 0;
    deps.fetchImpl = async () => {
      n += 1;
      if (n <= 2) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] }) };
    };
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(true);
    expect(n).toBe(3);
  });

  it('returns ok:false when the LLM answer is unparseable', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }), text: async () => '' });
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });

  it('does not retry malformed LLM JSON responses', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'not json' } }] }) };
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('rejects empty and partial batch responses without caching or streaming them', async () => {
    const { deps, cacheBackend } = makeDeps();
    const pushed = [];
    deps.sendToTab = async (tabId, msg) => { pushed.push(msg); };
    let response = {};
    deps.fetchImpl = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] })
    });
    const handler = makeMessageHandler(deps);
    response = {};
    const empty = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' }, { tab: { id: 8 } });
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain('Incomplete translation response');
    expect(pushed).toEqual([]);
    expect((await Cache.getMany(cacheBackend, 'zh-CN', ['Hello'], 'm1')).get('Hello')).toBeUndefined();

    response = { '0': '你好' };
    const partial = await handler({
      type: C.MSG.TRANSLATE_BATCH,
      items: [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }],
      targetLang: 'zh-CN'
    }, { tab: { id: 8 } });
    expect(partial.ok).toBe(false);
    expect(partial.translations).toBeUndefined();
    expect(pushed).toEqual([]);
  });

  it('does not retry when the request times out (unreachable endpoint)', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      const err = new Error('请求超时(10ms,无响应): https://api.test/v1/chat/completions');
      err.code = 'TIMEOUT';
      throw err;
    };
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('请求超时');
    expect(calls).toBe(1); // 超时不重试
  });

  it('does not retry on network errors either', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      const err = new Error('请求失败: https://api.test/v1/chat/completions — Failed to fetch');
      err.code = 'NETWORK';
      throw err;
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it.each([400, 401, 403, 404])('does not retry permanent HTTP %i errors', async (status) => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      return { ok: false, status, text: async () => 'permanent failure' };
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('still retries transient server errors (HTTP 5xx)', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] }) };
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3); // 5xx 仍然重试
  });

  it('backs off with doubled intervals on HTTP 429 rate limiting', async () => {
    const { deps } = makeDeps();
    const sleeps = [];
    deps.sleep = async (ms) => { sleeps.push(ms); };
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, status: 429, text: async () => 'slow down' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] }) };
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(true);
    expect(sleeps).toEqual([5000, 10000]); // 限流退避 5s/10s,而非 1s/2s
  });

  it('retries up to the default 3 times (4 requests in total)', async () => {
    const { deps } = makeDeps();
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      if (calls <= 3) return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] }) };
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(4); // 首次 + 3 次重试
  });

  it.each([[0, 1], [1, 2], [5, 6]])('sends %i retries after the first attempt when configured', async (retries, expected) => {
    const { deps } = makeDeps();
    deps.configStorage = {
      get: async () => ({ [C.STORAGE_KEYS.CONFIG]: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN', retries } })
    };
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      return { ok: false, status: 503, text: async () => 'unavailable' };
    };
    const res = await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(false);
    expect(calls).toBe(expected);
  });

  it('clamps an out-of-range stored retry count to the maximum', async () => {
    const { deps } = makeDeps();
    deps.configStorage = {
      get: async () => ({ [C.STORAGE_KEYS.CONFIG]: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN', retries: 99 } })
    };
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      return { ok: false, status: 503, text: async () => 'unavailable' };
    };
    await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(calls).toBe(C.RETRY_MAX + 1); // 夹到上限,而不是照着 99 重试
  });

  it('falls back to the default retry count when the stored value is unusable', async () => {
    const { deps } = makeDeps();
    deps.configStorage = {
      get: async () => ({ [C.STORAGE_KEYS.CONFIG]: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN', retries: 'abc' } })
    };
    let calls = 0;
    deps.fetchImpl = async () => {
      calls += 1;
      return { ok: false, status: 503, text: async () => 'unavailable' };
    };
    await makeMessageHandler(deps)({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(calls).toBe(C.DEFAULT_CONFIG.retries + 1);
  });

  it('caches and returns earlier batches when a later batch permanently fails', async () => {
    const { deps, fetchCalls, cacheBackend, okJson } = makeDeps();
    deps.fetchImpl = async (url, opts) => {
      const payload = JSON.parse(JSON.parse(opts.body).messages[1].content); // user 消息里的翻译 payload
      // 批 1:单条 1100 字符文本(FIRST...);批 2:另一条 1100 字符文本(SECOND...)
      // 批 2 重试 3 次全部失败 → 该批次永久失败,批 1 已缓存并返回(部分结果)
      if (payload['0'] && payload['0'].startsWith('FIRST')) {
        return okJson({ '0': 'FIRST_OK' });
      }
      fetchCalls.push({ url, opts });
      return { ok: false, status: 500, text: async () => 'boom' };
    };
    // 两条各 1100 字符,均超过 BATCH_MAX_CHARS → 各自成批
    const longA = 'FIRST' + 'x'.repeat(1095);
    const longB = 'SECOND' + 'y'.repeat(1094);
    const handler = makeMessageHandler(deps);
    const res = await handler({
      type: C.MSG.TRANSLATE_BATCH,
      items: [{ id: 'a', text: longA }, { id: 'b', text: longB }],
      targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(true);
    expect(res.translations.a).toBe('FIRST_OK');
    expect('b' in res.translations).toBe(false); // 批 2 失败,未翻译
    expect(res.partial).toBe(true); // 标记为部分结果
    expect(fetchCalls.length).toBe(4); // 批 2:初始 + 3 次重试(默认值)
    // 批 1 的译文已写入缓存
    const cached = await Cache.getMany(cacheBackend, 'zh-CN', [longA], 'm1');
    expect(cached.get(longA)).toBe('FIRST_OK');
  });

  it('returns ok:false only when every batch fails', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const longA = 'FIRST' + 'x'.repeat(1095);
    const longB = 'SECOND' + 'y'.repeat(1094);
    const handler = makeMessageHandler(deps);
    const res = await handler({
      type: C.MSG.TRANSLATE_BATCH,
      items: [{ id: 'a', text: longA }, { id: 'b', text: longB }],
      targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });

  it('runs batches concurrently up to BATCH_CONCURRENCY', async () => {
    const { deps } = makeDeps();
    let active = 0;
    let maxActive = 0;
    deps.fetchImpl = async (url, opts) => {
      const payload = JSON.parse(JSON.parse(opts.body).messages[1].content);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5)); // 让并发窗口重叠
      active -= 1;
      const out = {};
      Object.keys(payload).forEach((k) => { out[k] = 'T:' + payload[k]; });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }) };
    };
    // 9 条各 200 字符、互不相同 → 每批 2 条(2×200=400)→ 5 批,并发上限 3
    const items = Array.from({ length: 9 }, (_, i) => ({
      id: 'i' + i,
      text: 'z'.repeat(199) + String.fromCharCode(97 + i)
    }));
    const res = await makeMessageHandler(deps)({ type: C.MSG.TRANSLATE_BATCH, items, targetLang: 'zh-CN' });
    expect(res.ok).toBe(true);
    expect(Object.keys(res.translations).length).toBe(9);
    expect(maxActive).toBeGreaterThan(1); // 确实并发(而非串行)
    expect(maxActive).toBeLessThanOrEqual(3); // 不超过上限
  });
});

describe('DETECT_LANGUAGE / TEST_CONNECTION', () => {
  it('returns detected language', async () => {
    const { deps } = makeDeps();
    const handler = makeMessageHandler(deps);
    expect(await handler({ type: C.MSG.DETECT_LANGUAGE, text: 'hello world' })).toEqual({ ok: true, language: 'en' });
  });

  it('tests connection with the provided config without reading storage', async () => {
    const { deps, fetchCalls } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TEST_CONNECTION, config: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', targetLang: 'zh-CN' } });
    expect(res.ok).toBe(true);
    expect(typeof res.sample).toBe('string');
    expect(fetchCalls.length).toBe(1);
  });

  it('retries test connection once on transient failure', async () => {
    const { deps } = makeDeps();
    let n = 0;
    deps.fetchImpl = async () => {
      n += 1;
      if (n === 1) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] }) };
    };
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TEST_CONNECTION, config: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', targetLang: 'zh-CN' } });
    expect(res.ok).toBe(true);
    expect(n).toBe(2);
  });

  it('rejects unknown message types with ok:false', async () => {
    const { deps } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: 'NOPE' });
    expect(res.ok).toBe(false);
  });
});

describe('streaming batch results to the tab', () => {
  it('pushes each batch translation to the tab as it completes, then returns the full result', async () => {
    const { deps } = makeDeps();
    const pushed = [];
    deps.sendToTab = async (tabId, msg) => { pushed.push({ tabId, msg }); };
    // 两条各 1100 字符 → 各自成批,共 2 批
    const longA = 'FIRST' + 'x'.repeat(1095);
    const longB = 'SECOND' + 'y'.repeat(1094);
    const handler = makeMessageHandler(deps);
    const res = await handler(
      { type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: longA }, { id: 'b', text: longB }], targetLang: 'zh-CN' },
      { tab: { id: 7 } }
    );
    expect(res.ok).toBe(true);
    expect(res.translations.a).toBe('你好');
    expect(res.translations.b).toBe('你好');
    expect(pushed.length).toBe(2); // 每批一条推送
    pushed.forEach((p) => {
      expect(p.tabId).toBe(7);
      expect(p.msg.type).toBe(C.MSG.RESULT_BATCH);
      expect(typeof p.msg.translations).toBe('object');
    });
    // 推送覆盖所有原文 id(a、b),且与最终响应一致(与批次完成顺序无关)
    expect(pushed.flatMap((p) => Object.keys(p.msg.translations)).sort()).toEqual(['a', 'b']);
    const pushedMap = Object.fromEntries(pushed.flatMap((p) => Object.entries(p.msg.translations)));
    expect(pushedMap).toEqual(res.translations);
  });

  it('pushes nothing when the caller is not a tab (e.g. direct handler calls)', async () => {
    const { deps } = makeDeps();
    const pushed = [];
    deps.sendToTab = async (tabId, msg) => { pushed.push({ tabId, msg }); };
    const handler = makeMessageHandler(deps);
    const res = await handler({
      type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(true);
    expect(pushed.length).toBe(0); // 无 sender.tab → 不推送,保持原有整包返回
  });

  it('still pushes the successful batch when another batch fails permanently', async () => {
    const { deps } = makeDeps();
    const pushed = [];
    deps.sendToTab = async (tabId, msg) => { pushed.push(msg); };
    deps.fetchImpl = async (url, opts) => {
      const payload = JSON.parse(JSON.parse(opts.body).messages[1].content);
      if (payload['0'] && payload['0'].startsWith('FIRST')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"0":"FIRST_OK"}' } }] }) };
      }
      return { ok: false, status: 500, text: async () => 'boom' };
    };
    const longA = 'FIRST' + 'x'.repeat(1095);
    const longB = 'SECOND' + 'y'.repeat(1094);
    const handler = makeMessageHandler(deps);
    const res = await handler(
      { type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: longA }, { id: 'b', text: longB }], targetLang: 'zh-CN' },
      { tab: { id: 9 } }
    );
    expect(res.ok).toBe(true);
    expect(res.partial).toBe(true);
    expect(res.translations.a).toBe('FIRST_OK');
    expect(pushed.map((m) => m.translations)).toEqual([{ a: 'FIRST_OK' }]);
  });
});

describe('cache write failures', () => {
  it('keeps the batch successful and still streams when the cache write fails', async () => {
    const { deps } = makeDeps();
    const pushed = [];
    deps.sendToTab = async (tabId, msg) => { pushed.push(msg); };
    deps.cacheBackend = {
      getMany: async () => ({}),
      setMany: async () => { throw new Error('QUOTA_BYTES quota exceeded'); },
      getAll: async () => ({}),
      remove: async () => {},
      quotaBytes: () => 0,
      bytesInUse: async () => 0
    };
    const res = await makeMessageHandler(deps)(
      { type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' },
      { tab: { id: 3 } }
    );
    expect(res.ok).toBe(true);
    expect(res.translations.a).toBe('你好');
    expect(res.partial).toBeUndefined(); // 缓存写失败不算批次失败
    expect(pushed.length).toBe(1); // 流式推送照常发生
  });
});

describe('TOGGLE_TAB', () => {
  it('invokes deps.toggleTab with the given tabId', async () => {
    const { deps } = makeDeps();
    const seen = [];
    deps.toggleTab = async (tabId) => { seen.push(tabId); };
    const handler = makeMessageHandler(deps);
    expect(await handler({ type: C.MSG.TOGGLE_TAB, tabId: 42 })).toEqual({ ok: true });
    expect(seen).toEqual([42]);
  });

  it('returns ok:false when tabId is missing or not a number', async () => {
    const { deps } = makeDeps();
    let called = false;
    deps.toggleTab = async () => { called = true; };
    const handler = makeMessageHandler(deps);
    expect((await handler({ type: C.MSG.TOGGLE_TAB })).ok).toBe(false);
    expect((await handler({ type: C.MSG.TOGGLE_TAB, tabId: '7' })).ok).toBe(false);
    expect(called).toBe(false);
  });

  it('passes through the structured result returned by content scripts', async () => {
    const { deps } = makeDeps();
    deps.toggleTab = async () => ({ ok: true, reason: 'translated', translated: 12 });
    const handler = makeMessageHandler(deps);
    expect(await handler({ type: C.MSG.TOGGLE_TAB, tabId: 1 }))
      .toEqual({ ok: true, reason: 'translated', translated: 12 });
  });

  it('propagates a content-side skip result (e.g. same language)', async () => {
    const { deps } = makeDeps();
    deps.toggleTab = async () => ({ ok: false, reason: 'same-language', message: '页面语言是 zh,与目标语言 zh-CN 一致,未翻译' });
    const res = await makeMessageHandler(deps)({ type: C.MSG.TOGGLE_TAB, tabId: 1 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('same-language');
    expect(res.message).toContain('一致');
  });

  it('surfaces toggleTab failures as ok:false with the error message', async () => {
    const { deps } = makeDeps();
    deps.toggleTab = async () => { throw new Error('Content script is not available on this page'); };
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TOGGLE_TAB, tabId: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('not available');
  });
});

describe('GET_STATE', () => {
  it('passes through the state payload returned by the content script', async () => {
    const { deps } = makeDeps();
    const seen = [];
    deps.queryState = async (tabId) => {
      seen.push(tabId);
      return { ok: true, state: C.STATE.TRANSLATED, translated: 3 };
    };
    const res = await makeMessageHandler(deps)({ type: C.MSG.GET_STATE, tabId: 5 });
    expect(res).toEqual({ ok: true, state: C.STATE.TRANSLATED, translated: 3 });
    expect(seen).toEqual([5]);
  });

  it('reports idle when no content script is present, without injecting anything', async () => {
    const { deps } = makeDeps();
    deps.queryState = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
    const res = await makeMessageHandler(deps)({ type: C.MSG.GET_STATE, tabId: 5 });
    expect(res).toEqual({ ok: true, state: C.STATE.IDLE, translated: 0 });
  });

  it('requires a numeric tabId', async () => {
    const { deps } = makeDeps();
    let called = false;
    deps.queryState = async () => { called = true; };
    const handler = makeMessageHandler(deps);
    expect((await handler({ type: C.MSG.GET_STATE })).ok).toBe(false);
    expect((await handler({ type: C.MSG.GET_STATE, tabId: '5' })).ok).toBe(false);
    expect(called).toBe(false);
  });

  it('default queryState never injects content scripts', async () => {
    let sendCount = 0;
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: async () => { sendCount += 1; throw new Error('no receiver'); } }
    });
    const res = await makeMessageHandler({
      configStorage: { get: async () => ({}) },
      cacheBackend: Cache.memoryBackend(),
      fetchImpl: async () => { throw new Error('unused'); },
      logger: silentLogger,
      detectLanguage: async () => 'en',
      sleep: async () => {}
    })({ type: C.MSG.GET_STATE, tabId: 9 });
    expect(res).toEqual({ ok: true, state: C.STATE.IDLE, translated: 0 });
    expect(sendCount).toBe(1);
    vi.unstubAllGlobals();
  });
});

// 默认实现 defaultToggleTab 依赖 chrome.tabs / chrome.scripting(用 stub 验证兜底路径)
describe('default toggleTab (chrome stubs)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function bareHandler() {
    return makeMessageHandler({
      configStorage: { get: async () => ({}) },
      cacheBackend: Cache.memoryBackend(),
      fetchImpl: async () => { throw new Error('unused'); },
      logger: silentLogger,
      detectLanguage: async () => 'en',
      sleep: async () => {}
    });
  }

  it('sends TOGGLE straight to the tab when the content script is present', async () => {
    const sent = [];
    const inject = vi.fn();
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: async (tabId, msg) => { sent.push([tabId, msg]); } },
      scripting: { executeScript: inject }
    });
    const res = await bareHandler()({ type: C.MSG.TOGGLE_TAB, tabId: 3 });
    expect(res).toEqual({ ok: true });
    expect(sent).toEqual([[3, { type: C.MSG.TOGGLE }]]);
    expect(inject).not.toHaveBeenCalled();
  });

  it('injects content scripts then retries TOGGLE when the content script is missing', async () => {
    let sendCount = 0;
    const injectedFiles = [];
    vi.stubGlobal('chrome', {
      tabs: {
        sendMessage: async () => {
          sendCount += 1;
          if (sendCount === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
        }
      },
      scripting: { executeScript: async (opts) => { injectedFiles.push(...opts.files); } }
    });
    const res = await bareHandler()({ type: C.MSG.TOGGLE_TAB, tabId: 9 });
    expect(res).toEqual({ ok: true });
    expect(sendCount).toBe(2); // 首次失败 → 注入后重发
    expect(injectedFiles[injectedFiles.length - 1]).toBe('src/content/main.js');
  });

  it('reports ok:false when injection is unavailable', async () => {
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: async () => { throw new Error('no receiver'); } }
      // 无 chrome.scripting → 无法注入
    });
    const res = await bareHandler()({ type: C.MSG.TOGGLE_TAB, tabId: 9 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/available|error_content_script_unavailable/);
  });
});
