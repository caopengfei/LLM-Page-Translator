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
});
