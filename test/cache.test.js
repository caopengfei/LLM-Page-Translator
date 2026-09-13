import { describe, it, expect } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/cache.js';

const Cache = globalThis.Ext.cache;
const C = globalThis.EXT_CONSTANTS;

describe('hash64 / keyFor', () => {
  it('is stable and collision-different for distinct texts', () => {
    expect(Cache.hash64('Hello')).toBe(Cache.hash64('Hello'));
    expect(Cache.hash64('Hello')).not.toBe(Cache.hash64('Hellp'));
  });

  it('namespace includes cache prefix, target language and hash', () => {
    const key = Cache.keyFor('zh-CN', 'Hello');
    expect(key.startsWith('tc:zh-CN:')).toBe(true);
    expect(Cache.keyFor('en', 'Hello')).not.toBe(Cache.keyFor('zh-CN', 'Hello'));
  });
});

describe('memoryBackend + getMany/putMany', () => {
  it('round-trips translations and validates src to guard hash collisions', async () => {
    const backend = Cache.memoryBackend();
    await Cache.putMany(backend, 'zh-CN', [{ src: 'Hello', dst: '你好' }, { src: 'World', dst: '世界' }]);
    // 预埋一条 key 相同但 src 不匹配的记录，模拟 hash 碰撞后的脏数据
    await backend.setMany([[Cache.keyFor('zh-CN', 'Missing'), { src: 'OTHER-TEXT', dst: '错误的译文' }]]);
    const got = await Cache.getMany(backend, 'zh-CN', ['Hello', 'World', 'Missing']);
    expect(got.get('Hello')).toBe('你好');
    expect(got.get('World')).toBe('世界');
    expect(got.has('Missing')).toBe(false);
  });

  it('does not return entries from another target language', async () => {
    const backend = Cache.memoryBackend();
    await Cache.putMany(backend, 'zh-CN', [{ src: 'Hello', dst: '你好' }]);
    const got = await Cache.getMany(backend, 'en', ['Hello']);
    expect(got.has('Hello')).toBe(false);
  });

  it('separates cache entries by model', async () => {
    const backend = Cache.memoryBackend();
    await Cache.putMany(backend, 'zh-CN', [{ src: 'Hello', dst: '你好' }], 'model-a');
    expect((await Cache.getMany(backend, 'zh-CN', ['Hello'], 'model-a')).get('Hello')).toBe('你好');
    // 换模型后旧缓存天然失配,不会读到旧模型的译文
    expect((await Cache.getMany(backend, 'zh-CN', ['Hello'], 'model-b')).has('Hello')).toBe(false);
  });

  it('rejects records whose lang does not match the requested language', async () => {
    const backend = Cache.memoryBackend();
    // 键格式变更前的旧记录:src 对得上但 lang 串了,必须回源重译而不是静默命中
    await backend.setMany([[Cache.keyFor('zh-CN', 'Hello'), { src: 'Hello', dst: 'WRONG-LANG', lang: 'en', at: 1 }]]);
    expect((await Cache.getMany(backend, 'zh-CN', ['Hello'])).has('Hello')).toBe(false);
  });

  it('misses legacy records without a lang field instead of hitting them', async () => {
    const backend = Cache.memoryBackend();
    await backend.setMany([[Cache.keyFor('zh-CN', 'Hello'), { src: 'Hello', dst: 'legacy' }]]);
    // 无 lang 的老条目按 miss 处理(回源重译后会被带 lang 的新记录覆盖),不报错
    expect((await Cache.getMany(backend, 'zh-CN', ['Hello'])).has('Hello')).toBe(false);
  });
});

describe('chromeStorageBackend', () => {
  it('delegates get/set to a chrome.storage-like object', async () => {
    const calls = [];
    const fakeStorage = {
      get: async (keys) => { calls.push(['get', keys]); return { k1: { src: 'A', dst: 'B' } }; },
      set: async (obj) => { calls.push(['set', obj]); }
    };
    const backend = Cache.chromeStorageBackend(fakeStorage);
    const got = await backend.getMany(['k1', 'k2']);
    expect(got).toEqual({ k1: { src: 'A', dst: 'B' } });
    await backend.setMany([['k3', { src: 'C', dst: 'D' }]]);
    expect(calls[1]).toEqual(['set', { k3: { src: 'C', dst: 'D' } }]);
  });
});

describe('entrySize', () => {
  it('counts UTF-8 bytes, not UTF-16 code units', () => {
    // '你好' 是 2 个字符、6 个 UTF-8 字节;按字符数估算会低估到 1/3
    const rec = { src: '你好', dst: 'Hello', lang: 'en', at: 1 };
    const expected = new TextEncoder().encode('k').length
      + new TextEncoder().encode(JSON.stringify(rec)).length;
    expect(Cache.entrySize('k', rec)).toBe(expected);
    expect(Cache.entrySize('k', rec)).toBeGreaterThan('k'.length + JSON.stringify(rec).length);
  });

  it('handles null values', () => {
    expect(Cache.entrySize('k', null)).toBe(
      new TextEncoder().encode('k').length + new TextEncoder().encode('null').length
    );
  });
});

describe('resolveLimits', () => {
  it('derives watermarks from the runtime quota', () => {
    // 10MB 配额：高水位 90% = 9,437,184，低水位为其 80% = 7,549,747
    expect(Cache.resolveLimits(10 * 1024 * 1024)).toEqual({ maxBytes: 9437184, evictToBytes: 7549747 });
    // 5MB 配额（Chrome 114 之前）：高水位 4,718,592，低水位 3,774,873
    expect(Cache.resolveLimits(5 * 1024 * 1024)).toEqual({ maxBytes: 4718592, evictToBytes: 3774873 });
  });

  it('falls back to the conservative quota when the value is missing', () => {
    expect(Cache.resolveLimits(undefined)).toEqual({ maxBytes: 4718592, evictToBytes: 3774873 });
    expect(Cache.resolveLimits(0)).toEqual({ maxBytes: 4718592, evictToBytes: 3774873 });
  });
});

describe('backend capabilities', () => {
  it('memory backend lists all entries, removes keys and reports bytes', async () => {
    const backend = Cache.memoryBackend({ quotaBytes: 1000 });
    await backend.setMany([['tc:a', { src: 'A', dst: 'B' }], ['config', { apiKey: 'k' }]]);
    const all = await backend.getAll();
    expect(Object.keys(all).sort()).toEqual(['config', 'tc:a']);
    expect(await backend.bytesInUse()).toBeGreaterThan(0);
    expect(backend.quotaBytes()).toBe(1000);
    await backend.remove(['tc:a']);
    expect(Object.keys(await backend.getAll())).toEqual(['config']);
  });

  it('memory backend defaults its quota to the conservative fallback', async () => {
    expect(Cache.memoryBackend().quotaBytes()).toBe(C.CACHE_FALLBACK_QUOTA_BYTES);
  });

  it('chrome backend delegates getAll/remove and reads QUOTA_BYTES', async () => {
    const calls = [];
    const fakeStorage = {
      QUOTA_BYTES: 7 * 1024 * 1024,
      get: async (keys) => { calls.push(['get', keys]); return { k1: { src: 'A', dst: 'B' } }; },
      set: async () => {},
      remove: async (keys) => { calls.push(['remove', keys]); },
      getBytesInUse: async (keys) => { calls.push(['bytes', keys]); return 321; }
    };
    const backend = Cache.chromeStorageBackend(fakeStorage);
    expect(await backend.getAll()).toEqual({ k1: { src: 'A', dst: 'B' } });
    expect(calls[0]).toEqual(['get', null]);
    await backend.remove(['k1']);
    expect(calls[1]).toEqual(['remove', ['k1']]);
    expect(await backend.bytesInUse()).toBe(321);
    expect(backend.quotaBytes()).toBe(7 * 1024 * 1024);
  });

  it('chrome backend falls back when getBytesInUse or QUOTA_BYTES is unavailable', async () => {
    const fakeStorage = {
      get: async () => ({ 'tc:x': { src: 'X', dst: 'Y', lang: 'zh-CN', at: 1 } }),
      set: async () => {},
      remove: async () => {}
    };
    const backend = Cache.chromeStorageBackend(fakeStorage);
    expect(backend.quotaBytes()).toBe(C.CACHE_FALLBACK_QUOTA_BYTES);
    expect(await backend.bytesInUse()).toBeGreaterThan(0); // 回退为按条目估算
  });

  it('chrome backend falls back to estimation when getBytesInUse throws', async () => {
    const fakeStorage = {
      QUOTA_BYTES: 10 * 1024 * 1024,
      get: async () => ({ 'tc:x': { src: 'X', dst: 'Y', lang: 'zh-CN', at: 1 } }),
      set: async () => {},
      remove: async () => {},
      // 真机上 getBytesInUse 可能抛错(如存储瞬时故障):不能让一次查询失败拖垮整批翻译
      getBytesInUse: async () => { throw new Error('transient storage error'); }
    };
    const backend = Cache.chromeStorageBackend(fakeStorage);
    expect(await backend.bytesInUse()).toBeGreaterThan(0);
  });

  it('memory backend with quota 0 falls back to the conservative quota', async () => {
    // quotaBytes=0 按"缺失"处理:直接用 5MB 兜底,而不是算出水位 0 让淘汰删空缓存
    const backend = Cache.memoryBackend({ quotaBytes: 0 });
    expect(backend.quotaBytes()).toBe(C.CACHE_FALLBACK_QUOTA_BYTES);
    await backend.setMany([['tc:a', { src: 'A', dst: 'B', lang: 'zh-CN', at: 1 }]]);
    await Cache.enforceLimit(backend); // 小缓存远不到兜底水位,不得误删
    expect(Object.keys(await backend.getAll())).toEqual(['tc:a']);
  });

  it('chrome backend with quota 0 falls back to the conservative quota', async () => {
    const backend = Cache.chromeStorageBackend({ get: async () => ({}), set: async () => {}, remove: async () => {}, QUOTA_BYTES: 0 });
    expect(backend.quotaBytes()).toBe(C.CACHE_FALLBACK_QUOTA_BYTES);
  });
});

describe('enforceLimit (FIFO eviction)', () => {
  const seed = (backend, specs) => backend.setMany(specs.map((s) => [Cache.keyFor('zh-CN', s.src), s]));

  it('evicts the earliest-added entries down to the low watermark', async () => {
    // quota=1000 → 高水位 900、低水位 720。每条约 250 字节 → 5 条约 1250
    const backend = Cache.memoryBackend({ quotaBytes: 1000 });
    const body = 'x'.repeat(200);
    await seed(backend, [
      { src: 'e1' + body, dst: 'A', lang: 'zh-CN', at: 1 },
      { src: 'e2' + body, dst: 'B', lang: 'zh-CN', at: 2 },
      { src: 'e3' + body, dst: 'C', lang: 'zh-CN', at: 3 },
      { src: 'e4' + body, dst: 'D', lang: 'zh-CN', at: 4 },
      { src: 'e5' + body, dst: 'E', lang: 'zh-CN', at: 5 }
    ]);
    await Cache.enforceLimit(backend);
    const left = Object.values(await backend.getAll()).map((r) => r.dst).sort();
    expect(left).toEqual(['D', 'E']); // 最旧的 e1..e3 被删，最新的保留
    expect(await backend.bytesInUse()).toBeLessThanOrEqual(720);
  });

  it('treats a missing at as the oldest entry', async () => {
    // quota=400 → 高水位 360、低水位 288；两条各约 270 字节 → 合计约 540，超过高水位
    const backend = Cache.memoryBackend({ quotaBytes: 400 });
    const body = 'x'.repeat(200);
    await backend.setMany([
      [Cache.keyFor('zh-CN', 'legacy' + body), { src: 'legacy' + body, dst: 'OLD', lang: 'zh-CN' }],
      [Cache.keyFor('zh-CN', 'fresh' + body), { src: 'fresh' + body, dst: 'NEW', lang: 'zh-CN', at: 999 }]
    ]);
    await Cache.enforceLimit(backend);
    const dsts = Object.values(await backend.getAll()).map((r) => r.dst);
    expect(dsts).toEqual(['NEW']);
  });

  it('never deletes the newest entry even when it alone exceeds the low watermark', async () => {
    const backend = Cache.memoryBackend({ quotaBytes: 100 });
    const big = { src: 'big' + 'x'.repeat(300), dst: 'KEEP', lang: 'zh-CN', at: 1 };
    await backend.setMany([[Cache.keyFor('zh-CN', big.src), big]]);
    await Cache.enforceLimit(backend);
    expect(Object.values(await backend.getAll()).map((r) => r.dst)).toEqual(['KEEP']);
  });

  it('never evicts config or other non-cache keys', async () => {
    const backend = Cache.memoryBackend({ quotaBytes: 1000 });
    const body = 'x'.repeat(200);
    const config = { apiKey: 'sk-secret', baseUrl: 'https://api.test/v1' };
    await backend.setMany([['config', config]]);
    await seed(backend, [1, 2, 3, 4, 5].map((i) => ({ src: 'e' + i + body, dst: 'D' + i, lang: 'zh-CN', at: i })));
    await Cache.enforceLimit(backend);
    expect((await backend.getAll()).config).toEqual(config);
  });

  it('does nothing when under the high watermark', async () => {
    const backend = Cache.memoryBackend({ quotaBytes: 100000 });
    let removeCalls = 0;
    const origRemove = backend.remove.bind(backend);
    backend.remove = async (keys) => { removeCalls += 1; return origRemove(keys); };
    await seed(backend, [{ src: 'small', dst: 'A', lang: 'zh-CN', at: 1 }]);
    await Cache.enforceLimit(backend);
    expect(removeCalls).toBe(0);
  });

  it('runs a single pass under concurrent calls (in-flight latch)', async () => {
    const backend = Cache.memoryBackend({ quotaBytes: 1000 });
    const body = 'x'.repeat(200);
    await seed(backend, [1, 2, 3, 4, 5].map((i) => ({ src: 'e' + i + body, dst: 'D' + i, lang: 'zh-CN', at: i })));
    let getAllCalls = 0;
    const origGetAll = backend.getAll.bind(backend);
    backend.getAll = async () => { getAllCalls += 1; return origGetAll(); };
    await Promise.all([Cache.enforceLimit(backend), Cache.enforceLimit(backend)]);
    expect(getAllCalls).toBe(1);
  });

  it('isolates the in-flight latch per backend', async () => {
    const body = 'x'.repeat(200);
    const specs = [1, 2, 3, 4, 5].map((i) => [
      Cache.keyFor('zh-CN', 'e' + i + body),
      { src: 'e' + i + body, dst: 'D' + i, lang: 'zh-CN', at: i }
    ]);
    const a = Cache.memoryBackend({ quotaBytes: 1000 });
    const b = Cache.memoryBackend({ quotaBytes: 1000 });
    await a.setMany(specs);
    await b.setMany(specs);
    let aGetAll = 0;
    let bGetAll = 0;
    const origA = a.getAll.bind(a);
    const origB = b.getAll.bind(b);
    a.getAll = async () => { aGetAll += 1; return origA(); };
    b.getAll = async () => { bGetAll += 1; return origB(); };
    await Promise.all([Cache.enforceLimit(a), Cache.enforceLimit(b)]);
    expect(aGetAll).toBe(1);
    expect(bGetAll).toBe(1); // 两个 backend 各自独立淘汰,而不是共用一个闩锁
  });
});
