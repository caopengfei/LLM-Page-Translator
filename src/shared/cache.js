(function (global) {
  'use strict';
  const C = global.EXT_CONSTANTS;

  function fnv1a32(str, basis, prime) {
    let h = basis >>> 0;
    for (let i = 0; i < str.length; i += 1) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, prime) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function hash64(text) {
    const s = String(text);
    // two independent FNV-1a variants for a ~2^-64 collision space
    return fnv1a32(s, 0x811c9dc5, 0x01000193) + fnv1a32(s, 0x01000193, 0x811c9dc5);
  }

  function keyFor(targetLang, text) {
    return C.STORAGE_KEYS.CACHE_PREFIX + targetLang + ':' + hash64(text);
  }

  // 单条记录的估算大小：键长 + 值序列化长度。淘汰目标用它累加；
  // 触发判断用后端的真实字节数，不受这个估算影响
  function entrySize(key, value) {
    return String(key).length + JSON.stringify(value == null ? null : value).length;
  }

  // 由配额推导高/低水位。配额缺失时回退到保守兜底值，保证 5MB 配额下也能触发淘汰
  function resolveLimits(quotaBytes) {
    const q = Number(quotaBytes) > 0 ? Number(quotaBytes) : C.CACHE_FALLBACK_QUOTA_BYTES;
    const maxBytes = Math.floor(q * C.CACHE_MAX_RATIO);
    return { maxBytes, evictToBytes: Math.floor(maxBytes * C.CACHE_EVICT_RATIO) };
  }

  function memoryBackend(options) {
    const map = new Map();
    const quota = options && Number(options.quotaBytes) > 0
      ? Number(options.quotaBytes)
      : C.CACHE_FALLBACK_QUOTA_BYTES;
    return {
      async getMany(keys) {
        const out = {};
        keys.forEach((k) => { if (map.has(k)) out[k] = map.get(k); });
        return out;
      },
      async setMany(entries) { entries.forEach(([k, v]) => map.set(k, v)); },
      async getAll() {
        const out = {};
        map.forEach((v, k) => { out[k] = v; });
        return out;
      },
      async remove(keys) { keys.forEach((k) => map.delete(k)); },
      quotaBytes() { return quota; },
      async bytesInUse() {
        let n = 0;
        map.forEach((v, k) => { n += entrySize(k, v); });
        return n;
      }
    };
  }

  function chromeStorageBackend(storage) {
    async function getAll() {
      const data = await storage.get(null);
      return data || {};
    }
    return {
      async getMany(keys) {
        const data = await storage.get(keys);
        return data || {};
      },
      async setMany(entries) {
        const obj = {};
        entries.forEach(([k, v]) => { obj[k] = v; });
        await storage.set(obj);
      },
      getAll,
      async remove(keys) { await storage.remove(keys); },
      // QUOTA_BYTES 由 API 暴露；读不到时按保守兜底，保证淘汰仍会触发
      quotaBytes() {
        try {
          const q = Number(storage.QUOTA_BYTES);
          return q > 0 ? q : C.CACHE_FALLBACK_QUOTA_BYTES;
        } catch (e) { return C.CACHE_FALLBACK_QUOTA_BYTES; }
      },
      async bytesInUse() {
        try {
          if (typeof storage.getBytesInUse === 'function') {
            return Number(await storage.getBytesInUse(null)) || 0;
          }
        } catch (e) { /* 降级为按条目估算 */ }
        const all = await getAll();
        return Object.keys(all).reduce((sum, k) => sum + entrySize(k, all[k]), 0);
      }
    };
  }

  async function getMany(backend, targetLang, texts) {
    if (!texts || !texts.length) return new Map();
    const uniq = [...new Set(texts)];
    const keys = uniq.map((t) => keyFor(targetLang, t));
    const records = await backend.getMany(keys);
    const result = new Map();
    uniq.forEach((text, i) => {
      const rec = records[keys[i]];
      if (rec && rec.src === text && typeof rec.dst === 'string') result.set(text, rec.dst);
    });
    return result;
  }

  async function putMany(backend, targetLang, pairs) {
    if (!pairs || !pairs.length) return;
    const entries = pairs.map((p) => [keyFor(targetLang, p.src), { src: p.src, dst: p.dst, lang: targetLang }]);
    await backend.setMany(entries);
  }

  const ExtCache = { hash64, keyFor, resolveLimits, entrySize, memoryBackend, chromeStorageBackend, getMany, putMany };
  global.Ext = global.Ext || {};
  global.Ext.cache = ExtCache;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtCache;
})(typeof globalThis !== 'undefined' ? globalThis : self);
