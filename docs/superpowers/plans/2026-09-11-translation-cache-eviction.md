# 翻译缓存容量淘汰 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让翻译缓存按容量自动淘汰最早加入的条目，阈值随 `chrome.storage.local` 的真实配额推导，且配置与 API Key 永不被删除。

**Architecture:** 缓存条目新增 `at`（写入时间戳），按 `at` 升序做 FIFO 淘汰。触发水位为配额的 90%、淘汰目标为高水位的 80%，二者都由运行时读取的 `storage.local.QUOTA_BYTES` 推导，避免写死字节数在老版本 5MB 配额上失效。淘汰只在写入后触发，用 `getBytesInUse` 做轻量超标判断，并用模块级 in-flight 闩锁防止并发重复扫描。淘汰候选集仅限 `tc:` 前缀，因此 `config`/API Key 结构性不可删。

**Tech Stack:** 原生 JS（IIFE + `globalThis.Ext` 挂载）、Chrome MV3 `chrome.storage.local`、Vitest + jsdom。

**Spec:** `docs/superpowers/specs/2026-09-11-translation-cache-eviction-design.md`

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `src/shared/constants.js` | 集中常量 | 新增 `CACHE_MAX_RATIO`、`CACHE_EVICT_RATIO`、`CACHE_FALLBACK_QUOTA_BYTES` |
| `src/shared/cache.js` | 缓存读写与容量淘汰 | 条目加 `at`；新增 `entrySize`、`resolveLimits`、`enforceLimit`；`putMany` 写入后触发淘汰；两个后端补齐 `getAll`/`remove`/`bytesInUse`/`quotaBytes` |
| `src/background/service-worker.js` | 消息编排 | `runBatch` 中缓存写入失败降级为告警 |
| `test/cache.test.js` | 缓存单测 | 新增淘汰相关用例 |
| `test/sw.test.js` | 编排单测 | 新增"缓存写失败不改批次结果、不阻断推送" |
| `README.md` / `README.zh-CN.md` | 已知边界 | 移除"缓存无容量驱逐"的描述，改为说明自动淘汰 |

---

## Task 1: 常量与阈值推导

**Files:**
- Modify: `src/shared/constants.js`（在 `DEBOUNCE_MS` 附近新增）
- Modify: `src/shared/cache.js`（新增 `resolveLimits` 并导出）
- Test: `test/cache.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/cache.test.js` 末尾追加：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/cache.test.js -t resolveLimits`
Expected: FAIL（`Cache.resolveLimits is not a function`）

- [ ] **Step 3: 加常量**

`src/shared/constants.js` 的 `DEBOUNCE_MS: 500,` 之后新增：

```js
    // 缓存容量水位：按运行时配额推导，不写死字节数——旧版 Chrome 的 local 配额只有 5MB，
    // 写死 8MB 会让触发水位高于配额，淘汰永不发生、set() 照旧失败
    CACHE_MAX_RATIO: 0.9,          // 高水位 = 配额 × 0.9（超过才触发淘汰）
    CACHE_EVICT_RATIO: 0.8,        // 低水位 = 高水位 × 0.8（一次淘汰到此为止，留出滞后区间）
    CACHE_FALLBACK_QUOTA_BYTES: 5 * 1024 * 1024, // QUOTA_BYTES 读不到时按最小常见配额保守兜底
```

- [ ] **Step 4: 实现 resolveLimits**

`src/shared/cache.js` 中，`keyFor` 之后新增：

```js
  // 由配额推导高/低水位。配额缺失时回退到保守兜底值，保证 5MB 配额下也能触发淘汰
  function resolveLimits(quotaBytes) {
    const q = Number(quotaBytes) > 0 ? Number(quotaBytes) : C.CACHE_FALLBACK_QUOTA_BYTES;
    const maxBytes = Math.floor(q * C.CACHE_MAX_RATIO);
    return { maxBytes, evictToBytes: Math.floor(maxBytes * C.CACHE_EVICT_RATIO) };
  }
```

并把 `resolveLimits` 加入导出。注意**不要一次写全**——`entrySize`、`enforceLimit` 要到后续任务才定义，提前引用会让模块加载即抛 ReferenceError：

```js
  const ExtCache = { hash64, keyFor, resolveLimits, memoryBackend, chromeStorageBackend, getMany, putMany };
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/cache.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/shared/constants.js src/shared/cache.js test/cache.test.js
git commit -m "feat: derive cache watermarks from the storage quota"
```

---

## Task 2: 后端能力补齐（getAll / remove / bytesInUse / quotaBytes）

**Files:**
- Modify: `src/shared/cache.js`
- Test: `test/cache.test.js`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/cache.test.js -t "backend capabilities"`
Expected: FAIL（`backend.getAll is not a function`）

- [ ] **Step 3: 实现**

`src/shared/cache.js` 中，`keyFor` 之后、`resolveLimits` 之前新增：

```js
  // 单条记录的估算大小：键长 + 值序列化长度。淘汰目标用它累加；
  // 触发判断用后端的真实字节数，不受这个估算影响
  function entrySize(key, value) {
    return String(key).length + JSON.stringify(value == null ? null : value).length;
  }
```

将 `memoryBackend` 整体替换为：

```js
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
```

将 `chromeStorageBackend` 整体替换为：

```js
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
```

并把 `entrySize` 加入导出：

```js
  const ExtCache = { hash64, keyFor, resolveLimits, entrySize, memoryBackend, chromeStorageBackend, getMany, putMany };
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/cache.test.js`
Expected: PASS（含既有 `chromeStorageBackend` 委托用例——`getMany`/`setMany` 行为未变）

- [ ] **Step 5: 提交**

```bash
git add src/shared/cache.js test/cache.test.js
git commit -m "feat: add list/remove/bytesInUse/quotaBytes to cache backends"
```

---

## Task 3: 写入时间戳与 FIFO 淘汰

**Files:**
- Modify: `src/shared/cache.js`
- Test: `test/cache.test.js`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/cache.test.js -t "enforceLimit"`
Expected: FAIL（`Cache.enforceLimit is not a function`）

- [ ] **Step 3: 实现**

`src/shared/cache.js` 中，`chromeStorageBackend` 之后新增：

```js
  // in-flight 闩锁：3 个批次 worker 可能同时写完触发淘汰，复用同一个 Promise 避免重复全量扫描
  let enforcing = null;

  // 容量淘汰：超过高水位时，把最旧的 tc:* 条目删到低水位为止。
  // 只删缓存前缀，config 与其他键不在候选集内，因此 API Key 结构性不可删。
  function enforceLimit(backend) {
    if (enforcing) return enforcing;
    enforcing = (async () => {
      try {
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
      } finally {
        enforcing = null;
      }
    })();
    return enforcing;
  }
```

把 `putMany` 替换为：

```js
  async function putMany(backend, targetLang, pairs) {
    if (!pairs || !pairs.length) return;
    const now = Date.now(); // 同批共用同一时间戳，批内顺序由数组顺序保证
    const entries = pairs.map((p) => [keyFor(targetLang, p.src), { src: p.src, dst: p.dst, lang: targetLang, at: now }]);
    await backend.setMany(entries);
    await enforceLimit(backend);
  }
```

并把 `enforceLimit` 加入导出：

```js
  const ExtCache = { hash64, keyFor, resolveLimits, entrySize, memoryBackend, chromeStorageBackend, getMany, putMany, enforceLimit };
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/cache.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/cache.js test/cache.test.js
git commit -m "feat: evict oldest cache entries when over the size watermark"
```

---

## Task 4: 缓存写失败不拖垮整批

**Files:**
- Modify: `src/background/service-worker.js`（`runBatch` 内的 `Cache.putMany` 调用）
- Test: `test/sw.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/sw.test.js` 的 `describe('streaming batch results to the tab', ...)` 之后追加：

```js
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sw.test.js -t "cache write failures"`
Expected: FAIL（`res.ok` 为 `false`，`pushed.length` 为 `0`）

- [ ] **Step 3: 实现**

`src/background/service-worker.js` 的 `runBatch` 中，把：

```js
    if (newPairs.length) {
      await Cache.putMany(deps.cacheBackend, targetLang, newPairs);
    }
```

替换为：

```js
    if (newPairs.length) {
      // 缓存写入失败（含配额超限）只降级为告警：译文照常返回并推送，
      // 否则一次存储异常会连带丢掉本批的流式上屏
      try {
        await Cache.putMany(deps.cacheBackend, targetLang, newPairs);
      } catch (e) {
        deps.logger.warn('[LLM Page Translator] cache write failed:', String((e && e.message) || e));
      }
    }
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/sw.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/background/service-worker.js test/sw.test.js
git commit -m "fix: degrade cache write failures instead of failing the batch"
```

---

## Task 5: 更新 README 的已知边界

**Files:**
- Modify: `README.md`、`README.zh-CN.md`

- [ ] **Step 1: 改中文 README**

`README.zh-CN.md` 的「已知边界」中，把：

```
- 缓存无容量驱逐(v0.1):`chrome.storage.local` 默认约 10MB,按条目计可存数万条
```

替换为：

```
- 缓存按容量自动淘汰:触发水位为 `chrome.storage.local` 配额的 90%(Chrome 114+ 约 9MB),超出后按写入时间删除最早的条目直到降至 72%,配置与 API Key 不受影响
```

- [ ] **Step 2: 改英文 README**

`README.md` 的 "Known limitations" 中，把：

```
- The cache has no eviction policy (v0.1): `chrome.storage.local` is about 10MB by default, enough for tens of thousands of entries
```

替换为：

```
- The cache evicts by size: the trigger is 90% of the `chrome.storage.local` quota (about 9MB on Chrome 114+); past it, the earliest-added entries are removed until usage falls to 72%. Config and the API key are never evicted
```

- [ ] **Step 3: 全文跑测试并提交**

Run: `npm test`
Expected: 全部通过

```bash
git add README.md README.zh-CN.md
git commit -m "docs: document cache size-based eviction"
```

---

## 验收

- [ ] `npm test` 全绿
- [ ] 手动：`chrome://extensions` 重载扩展 → 翻译一个页面 → DevTools Application → Storage → Local Storage 出现 `tc:` 条目，且值内含 `at`
- [ ] 手动：把配额调小复现淘汰（可选）——在 Service Worker 控制台执行 `Cache.enforceLimit(Cache.chromeStorageBackend(chrome.storage.local))` 不报错

## 非目标（不要做）

- 不做 LRU、不做 TTL
- 不换 `storage.session`、不换纯内存、不申请 `unlimitedStorage`
- 不加设置页"清空缓存"按钮
- 不改缓存键格式与 `getMany` 命中逻辑
