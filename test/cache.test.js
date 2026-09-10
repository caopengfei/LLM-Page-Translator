import { describe, it, expect } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/cache.js';

const Cache = globalThis.Ext.cache;

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
