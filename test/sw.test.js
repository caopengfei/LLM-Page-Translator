import { describe, it, expect } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/cache.js';
import '../src/background/service-worker.js';

const C = globalThis.EXT_CONSTANTS;
const Cache = globalThis.Ext.cache;
const makeMessageHandler = globalThis.Ext.sw.makeMessageHandler;

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
  const okJson = (obj) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }), text: async () => '' });
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return okJson({ '0': '你好' });
  };
  const deps = {
    configStorage,
    cacheBackend,
    fetchImpl,
    detectLanguage: async () => 'en',
    sleep: async () => {}
  };
  return { deps, fetchCalls, cacheBackend, okJson };
}

describe('TRANSLATE_BATCH', () => {
  it('serves fully-cached items without calling the LLM', async () => {
    const { deps, fetchCalls, cacheBackend } = makeDeps();
    await Cache.putMany(cacheBackend, 'zh-CN', [{ src: 'Hello', dst: '你好' }]);
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
    const again = await Cache.getMany(cacheBackend, 'zh-CN', ['Hello']);
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
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"0":"你好"}' } }] }), text: async () => '' };
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

  it('caches and returns earlier batches when a later batch permanently fails', async () => {
    const { deps, fetchCalls, cacheBackend, okJson } = makeDeps();
    deps.fetchImpl = async (url, opts) => {
      const payload = JSON.parse(JSON.parse(opts.body).messages[1].content); // user 消息里的翻译 payload
      // 批 1:单条 1100 字符文本(FIRST...);批 2:另一条 1100 字符文本(SECOND...)
      // 批 2 重试 3 次全部失败 → 该批次永久失败,批 1 已缓存并返回
      if (payload['0'] && payload['0'].startsWith('FIRST')) {
        return okJson({ '0': 'FIRST_OK' });
      }
      fetchCalls.push({ url, opts });
      return { ok: false, status: 500, text: async () => 'boom' };
    };
    // 两条各 1100 字符:1100 + 1100 = 2200 > 2000(BATCH_MAX_CHARS)→ 拆成两批
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
    expect(fetchCalls.length).toBe(3); // 批 2:初始 + 2 次重试
    // 批 1 的译文已写入缓存
    const cached = await Cache.getMany(cacheBackend, 'zh-CN', [longA]);
    expect(cached.get(longA)).toBe('FIRST_OK');
  });

  it('keeps ok:false when the first batch fails (no partial results to return)', async () => {
    const { deps, okJson } = makeDeps();
    deps.fetchImpl = async (url, opts) => {
      const payload = JSON.parse(JSON.parse(opts.body).messages[1].content);
      if (payload['0'] && payload['0'].startsWith('FIRST')) {
        return { ok: false, status: 500, text: async () => 'boom' };
      }
      return okJson({ '0': 'SECOND_OK' });
    };
    const longA = 'FIRST' + 'x'.repeat(1095);
    const longB = 'SECOND' + 'y'.repeat(1094);
    const handler = makeMessageHandler(deps);
    const res = await handler({
      type: C.MSG.TRANSLATE_BATCH,
      items: [{ id: 'a', text: longA }, { id: 'b', text: longB }],
      targetLang: 'zh-CN'
    });
    expect(res.ok).toBe(false); // 首批失败,维持 ok:false 契约
    expect(typeof res.error).toBe('string');
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
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"0":"你好"}' } }] }), text: async () => '' };
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
