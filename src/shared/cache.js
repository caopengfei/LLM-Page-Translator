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

  // key 编码目标语言 + 模型维度:译文质量/风格随模型变化,换模型后旧缓存必须失配。
  // model 经 encodeURIComponent,避免其内容与分隔符':'产生歧义
  function keyFor(targetLang, text, model) {
    return C.STORAGE_KEYS.CACHE_PREFIX + targetLang + ':' + encodeURIComponent(String(model || '')) + ':' + hash64(text);
  }

  // 单条记录的估算大小：键 + 值序列化的 UTF-8 字节数。淘汰目标用它累加；
  // 触发判断用后端的真实字节数，不受这个估算影响。
  // 必须按字节而非 String.length 估算:中文在存储中约 3 字节/字,按字符数会
  // 系统性低估 CJK 为主的缓存,导致淘汰提前停、后续每次写入都全量扫描
  const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  function utf8Length(s) {
    const str = String(s);
    if (textEncoder) return textEncoder.encode(str).length;
    // 无 TextEncoder 环境的保守兜底:非 ASCII 按多字节计(宁可高估多淘汰一点)
    let n = 0;
    for (let i = 0; i < str.length; i += 1) {
      const code = str.charCodeAt(i);
      n += code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    return n;
  }
  function entrySize(key, value) {
    return utf8Length(key) + utf8Length(JSON.stringify(value == null ? null : value));
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

  // 容量淘汰:整体占用(bytesInUse,含 config 等所有键)超过高水位时触发,
  // 但候选与目标都只针对 tc:* 条目。若非缓存键把占用顶过水位而缓存本身
  // 已低于低水位,删缓存无济于事(config 结构性不可删),放弃淘汰,
  // 写入侧会自行降级为告警。
  async function runEnforce(backend) {
    const { maxBytes, evictToBytes } = resolveLimits(backend.quotaBytes ? backend.quotaBytes() : undefined);
    const used = await backend.bytesInUse();
    if (used <= maxBytes) return; // 正常路径：仅一次轻量字节查询
    const all = await backend.getAll();
    const entries = Object.keys(all)
      .filter((k) => k.startsWith(C.STORAGE_KEYS.CACHE_PREFIX))
      .map((k) => ({ key: k, at: Number(all[k] && all[k].at) || 0, size: entrySize(k, all[k]) }))
      .sort((a, b) => a.at - b.at); // 最早的排最前；缺 at 视为 0
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    if (total <= evictToBytes) return;
    const doomed = [];
    // 始终留最后一条（最新写入的），避免把缓存删空
    for (let i = 0; i < entries.length - 1 && total > evictToBytes; i += 1) {
      doomed.push(entries[i].key);
      total -= entries[i].size;
    }
    if (doomed.length) await backend.remove(doomed);
  }

  // in-flight 闩锁：3 个批次 worker 可能同时写完触发淘汰，复用同一个 Promise 避免重复全量扫描。
  // 按 backend 隔离（WeakMap）而非模块级单变量，否则不同 backend 的并发调用会互相串用同一次淘汰
  const enforcingByBackend = new WeakMap();

  function enforceLimit(backend) {
    const running = enforcingByBackend.get(backend);
    if (running) return running;
    const task = runEnforce(backend);
    enforcingByBackend.set(backend, task);
    const clear = () => enforcingByBackend.delete(backend);
    task.then(clear, clear);
    return task;
  }

  async function getMany(backend, targetLang, texts, model) {
    if (!texts || !texts.length) return new Map();
    const uniq = [...new Set(texts)];
    const keys = uniq.map((t) => keyFor(targetLang, t, model));
    const records = await backend.getMany(keys);
    const result = new Map();
    uniq.forEach((text, i) => {
      const rec = records[keys[i]];
      // src 校验防 hash 碰撞脏读;lang 校验防"键格式变更后旧记录串语言"静默命中。
      // 两者都已编码进 key,正常路径恒成立,失败即数据异常,宁可回源重译
      if (rec && rec.src === text && rec.lang === targetLang && typeof rec.dst === 'string') {
        result.set(text, rec.dst);
      }
    });
    return result;
  }

  async function putMany(backend, targetLang, pairs, model) {
    if (!pairs || !pairs.length) return;
    const now = Date.now(); // 同批共用同一时间戳，批内顺序由数组顺序保证
    const entries = pairs.map((p) => [keyFor(targetLang, p.src, model), { src: p.src, dst: p.dst, lang: targetLang, at: now }]);
    await backend.setMany(entries);
    await enforceLimit(backend);
  }

  const ExtCache = { hash64, keyFor, resolveLimits, entrySize, memoryBackend, chromeStorageBackend, getMany, putMany, enforceLimit };
  global.Ext = global.Ext || {};
  global.Ext.cache = ExtCache;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtCache;
})(typeof globalThis !== 'undefined' ? globalThis : self);
