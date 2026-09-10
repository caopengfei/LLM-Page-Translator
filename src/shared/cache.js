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

  function memoryBackend() {
    const map = new Map();
    return {
      async getMany(keys) {
        const out = {};
        keys.forEach((k) => { if (map.has(k)) out[k] = map.get(k); });
        return out;
      },
      async setMany(entries) { entries.forEach(([k, v]) => map.set(k, v)); }
    };
  }

  function chromeStorageBackend(storage) {
    return {
      async getMany(keys) {
        const data = await storage.get(keys);
        return data || {};
      },
      async setMany(entries) {
        const obj = {};
        entries.forEach(([k, v]) => { obj[k] = v; });
        await storage.set(obj);
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

  const ExtCache = { hash64, keyFor, memoryBackend, chromeStorageBackend, getMany, putMany };
  global.Ext = global.Ext || {};
  global.Ext.cache = ExtCache;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtCache;
})(typeof globalThis !== 'undefined' ? globalThis : self);
