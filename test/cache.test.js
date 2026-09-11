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
