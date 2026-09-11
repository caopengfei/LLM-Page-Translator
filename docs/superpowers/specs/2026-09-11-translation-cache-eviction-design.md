# 翻译缓存容量淘汰 — 设计文档

**日期:** 2026-09-11
**范围:** `src/shared/cache.js`、`src/shared/constants.js`、`src/background/service-worker.js`、`test/cache.test.js`、`test/sw.test.js`
**不改动:** 缓存键格式（仍是 `tc:<目标语言>:<哈希>`）、`getMany` 读取路径、`config` 的读写、`manifest.json`

---

## 1. 背景

翻译缓存（`src/shared/cache.js`）以 `chrome.storage.local` 为后端，键为 `tc:<目标语言>:<FNV-1a 64位哈希>`，值为 `{src, dst, lang}`。目前**只写不删**：全仓库没有任何 `remove` / `clear` / TTL / 容量判定逻辑，设置页也没有清理入口。于是缓存单调增长，直到撞上配额。

### 1.1 撞上配额后的实际后果

`chrome.storage.local` 默认配额约 10MB（Chrome 114+；更早为 5MB），扩展未申请 `unlimitedStorage`。`chrome.storage.local.set()` 超额会**直接拒绝**（`QUOTA_BYTES` 超限）。

而 `src/background/service-worker.js` 的 `runBatch()` 中，`Cache.putMany()` 位于流式推送**之前**且未捕获异常：

```
if (newPairs.length) { await Cache.putMany(...); }   // 超额在此抛错
if (tabId && ...) { sendToTab(tabId, {type: RESULT_BATCH, ...}); }  // 被跳过
```

因此一旦配额写满，每一批都会：

1. 抛错 → 被并发 worker 记为**失败批次**，整批标记 `partial`；
2. 跳过本批的 `RESULT_BATCH` 推送，**失去流式上屏**（译文仍在内存 `translations` 里，最终响应兜底会补上，但体验退化）；
3. 新文本**永远缓存不上**，之后每次翻译都要重新请求 LLM，费用与耗时上升。

已缓存的文本不受影响（读取正常）。所以问题不是"崩溃"，而是"静默退化 + 成本持续上升"。

### 1.2 一个被否掉的方案

最初考虑把缓存改为纯内存或 `chrome.storage.session`。经确认否决：需要缓存跨会话持久化，仍用 `chrome.storage.local`，改为**主动淘汰**来控制占用。

---

## 2. 需求决议（已与用户确认）

1. **后端不变。** 缓存继续存 `chrome.storage.local`，不换内存、不换 `storage.session`、不申请 `unlimitedStorage`。
2. **淘汰策略：FIFO。** 超出容量上限时，移除**最早加入**的缓存条目（不是最近最少使用）。
3. **容量上限不写死，按运行时配额推导。** 触发水位取配额的 90%——Chrome 114+ 的 10MB 配额下即 9MB，旧版的 5MB 配额下为 4.5MB。
4. **配置与 API Key 永不淘汰。** `config`（含 `apiKey`）必须保留。

---

## 3. 方案对比

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 条目自带时间戳 + 超标时全量扫描淘汰** | 每条记录写入时间 `at`；写入后检测占用，超标则读出全部 `tc:*` 条目、按 `at` 升序删最旧的 | **采用**。无额外索引，不存在"索引与数据不一致"；按真实条目大小统计；旧条目缺 `at` 视为最早，向后兼容无需迁移 |
| B. 单独维护索引键 `tc:index` | 另存 `{key, at, size}` 数组，淘汰只查索引 | 拒绝。索引本身可达数百 KB，每次写入都要额外读写整份索引，开销与 A 的全量扫描相当，还多了一份可能失真的状态 |
| C. 只按条数封顶 | 例如最多 5000 条，超了删最早的 | 拒绝。条数与字节无稳定关系——一条长正文可顶几十条短文案，封了条数仍可能撑爆配额；而配额才是真正的失败原因 |

**方案 A 的容量判断优化：** 判断"是否超标"不需要全量读取。用 `chrome.storage.local.getBytesInUse(null)` 由浏览器原生统计占用字节，一次轻量调用即可，只有真的超标时才走"读出全部条目 → 排序 → 批量删除"的重路径。

---

## 4. 数据模型

条目由 `{src, dst, lang}` 扩为 `{src, dst, lang, at}`，`at` 为写入时的 `Date.now()`（毫秒）。

- **向后兼容：** 升级前写入的旧条目没有 `at`，读取时按 `0` 处理，即"最早"，会优先被淘汰。无需迁移脚本。
- `getMany()` 的校验条件（`rec.src === text && typeof rec.dst === 'string'`）不受新增字段影响。
- 键格式不变，缓存命中路径不变。

---

## 5. 容量口径与阈值

**不写死绝对字节数，而是按运行时配额推导。** `chrome.storage.local.QUOTA_BYTES` 是 API 暴露的常量，反映当前浏览器的真实配额：Chrome 114+ 为 10MB，更早版本为 5MB。若写死 8MB，在 5MB 配额的老版本上水位高于配额，**淘汰永远不触发，`set()` 依旧会失败**——这正是必须按配额推导的原因。

| 参数 | 推导 | 10MB 配额 | 5MB 配额 |
|---|---|---|---|
| 配额 | `storage.local.QUOTA_BYTES`（运行时读取） | 10,485,760 | 5,242,880 |
| 触发阈值（高水位） | `floor(配额 × CACHE_MAX_RATIO)`，ratio = 0.9 | 9,437,184 | 4,718,592 |
| 淘汰目标（低水位） | `floor(高水位 × CACHE_EVICT_RATIO)`，ratio = 0.8 | 7,549,747 | 3,774,873 |
| 配额读不到时的兜底 | `CACHE_FALLBACK_QUOTA_BYTES` = 5MB（取常见配额的最小值，保守） | — | — |

- 水位随配额缩放：10MB 配额下触发于 9MB、淘汰到 7.55MB；5MB 配额下触发于 4.5MB、淘汰到 3.77MB。淘汰始终在配额以下发生。
- **超标判断**用 `getBytesInUse(null)` 的真实字节数（含 `config` 等所有键，配置体积极小可忽略），与 Chrome 配额同一套口径。
- **淘汰目标计算**仅针对缓存条目：把扫描到的 `tc:*` 条目按第 6 节的逐条估算累加得到缓存总量，再与低水位比较。即触发用"整个存储区的真实字节"，目标用"缓存条目的估算之和"——两者口径不同但互不干扰，因为配置本身体积可忽略。
- 三个常量（两个比例 + 一个兜底配额）放在 `src/shared/constants.js`，便于测试注入与集中调参。

---

## 6. 淘汰算法（滞后区间）

**关键点：不能在接近上限时反复试探。** 若"超限就删到刚好等于上限"，则缓存停在触发水位附近后，每次写入都会触发一次全量扫描与删除，稳态下等于每次写一小批就扫几 MB。因此引入滞后区间：**超高水位才触发，一次删到低水位为止**（10MB 配额下即 9,437,184 → 7,549,747，腾出约 1.8MB；5MB 配额下 4,718,592 → 3,774,873，腾出约 0.9MB）。按一页新增几十 KB 缓存估算，大约每几十页才触发一次。

`putMany(backend, targetLang, pairs)` 内，写入完成后：

1. 调用 `backend.bytesInUse()`；若 ≤ 高水位（第 5 节按配额推导），直接返回（正常路径，仅一次轻量查询）。
2. 否则进入淘汰重路径：
   - `backend.getAll()` 取出全部条目，**只保留键以 `CACHE_PREFIX`（`tc:`）开头的**；
   - 按 `at` 升序排序（缺 `at` 视为 0，排最前）；
   - 累加这些条目的估算大小得到缓存总量 `total`；若 `total ≤ 低水位` 则不删除（估算偏差下的兜底）；
   - 否则从最旧的开始依次累加其大小，直到 `total − 已删除量 ≤ 低水位`，得到待删集合；
   - `backend.remove(keys)` 一次性批量删除。
3. **永远保留本次刚写入的条目**：若单条就超过低水位，只保留这一条，不进入"删空"循环。

淘汰是"偶发的一大批删除"，不是"每次都挪一点"。

---

## 7. 并发保护

`handleTranslateBatch` 用 3 个 worker 并发跑批次，每个批次结束都会调用 `putMany`，可能同时触发淘汰。`cache.js` 内维护一个模块级 in-flight 闩锁（Promise）：淘汰进行中时，后续触发**复用同一个 Promise**，不做第二次全量扫描。闩锁结束后释放。

---

## 8. 配置与 API Key 保护

淘汰**只删除 `tc:` 前缀的键**，`config` 及其他任何键都不在候选集内。因此"API Key 不被移除"是**结构性保证**，不是靠额外的条件判断。

对应测试专门钉死这条约束：写入 `config`（含 `apiKey`）与足够多的缓存条目 → 触发淘汰 → 断言 `config` 仍原样存在。

---

## 9. 顺带修复：缓存写失败不拖垮整批

淘汰上线后配额报错基本不会发生，但缓存写入失败不应该污染翻译结果。`src/background/service-worker.js` 的 `runBatch()` 中：

- 将 `await Cache.putMany(...)` 包进 `try/catch`，失败仅 `deps.logger.warn(...)`；
- 保证其后的 `sendToTab`（流式推送）照常执行；
- 该批不再因为缓存写失败而被记为失败。

这是本设计的组成部分（正是它让第 1.1 节的退化路径消失），不是无关重构。

---

## 10. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/constants.js` | 新增 `CACHE_MAX_RATIO`、`CACHE_EVICT_RATIO`、`CACHE_FALLBACK_QUOTA_BYTES` |
| `src/shared/cache.js` | 条目写入携带 `at`；新增按配额推导高/低水位的 `resolveLimits(backend)`、`enforceLimit(backend)` 与 in-flight 闩锁；`putMany` 写入后触发淘汰；`chromeStorageBackend` 增加 `remove`、`getAll`、`bytesInUse`、`quotaBytes`（读 `storage.local.QUOTA_BYTES`）；`memoryBackend` 同步补齐，并允许注入配额以便测试 |
| `src/background/service-worker.js` | `runBatch` 中 `Cache.putMany` 失败降级为告警，不阻断流式推送与本批结果 |
| `test/cache.test.js` | 见第 11 节 |
| `test/sw.test.js` | 新增"缓存写失败不改批次结果、不阻断推送" |

`manifest.json`、`src/content/*`、`src/popup/*`、`src/options/*` 均不改动；`cache.js` 虽被 content script 加载，但 content 侧不调用 `putMany`，淘汰逻辑仅在 service worker 生效。

---

## 11. 测试计划

沿用既有约定：模块通过 `import` 副作用挂载 `globalThis.Ext`，测试从全局取 API，jsdom 环境，缓存的持久化用 `memoryBackend` 或可注入的假 storage。

| 用例 | 断言 |
|---|---|
| 写入携带 `at` | `putMany` 后条目含 `at`，且后写入的 `at` 不小于先写入的 |
| 缺 `at` 视为最早 | 预置无 `at` 的旧条目 + 有 `at` 的新条目，超限时旧条目先被删 |
| 超标按加入顺序淘汰 | 构造超过高水位的多条 → 触发淘汰 → 最早加入的被删，较新的保留 |
| 一次删到低水位 | 淘汰后剩余总量 ≤ 低水位（而非仅删 1 条） |
| 未超标不淘汰 | 总量低于高水位时，`remove` 不被调用 |
| 阈值随配额推导 | 注入 10MB 配额 → 高水位 9,437,184、低水位 7,549,747；注入 5MB 配额 → 4,718,592 / 3,774,873 |
| 配额不可用时兜底 | `QUOTA_BYTES` 读不到 → 回退 5MB 兜底，淘汰仍能在该配额下生效 |
| 只删 `tc:` 前缀 | 同时存在 `config` 与缓存条目，淘汰后 `config`（含 `apiKey`）原样保留 |
| 保留刚写入的条目 | 单条超过低水位时，该条不被删除 |
| 并发触发只淘汰一次 | 并发调用 `putMany` 时，全量扫描/删除只发生一次 |
| 缓存写失败降级 | `putMany` 抛错时，该批仍算成功，且 `sendToTab` 仍被调用 |

---

## 12. 边界与非目标

- **不做 LRU。** 用户明确要求"移除最先添加的记录"。LRU 需要在每次命中时回写时间戳，对以"写一次、读多次"为主的翻译缓存代价不划算。
- **不做 TTL。** 淘汰只由容量驱动，不引入过期时间。
- **不换存储后端。** 不换纯内存，不换 `storage.session`，不申请 `unlimitedStorage`（已确认否决）。
- **不引入索引键。** 见第 3 节方案 B 的拒绝理由。
- **不做 UI 清理入口。** 不设置页"清空缓存"按钮。
- **不改缓存键与读取路径。** 命中逻辑、批处理、重试链路均不涉及。

---

## 13. 风险

| 风险 | 应对 |
|---|---|
| `getBytesInUse` 在目标环境不可用 | Chrome 26+ 与 jsdom 环境均支持。`bytesInUse` 实现整体 try/catch，失败时回退为"按已读条目估算"，最坏情况是多走一次全量扫描，不影响正确性 |
| 旧版浏览器配额仅 5MB | 阈值按 `QUOTA_BYTES` 运行时推导，5MB 配额下自动降级为 4MB / 3.2MB，淘汰照常生效（不写死 8MB）；`QUOTA_BYTES` 缺失时回退 `CACHE_FALLBACK_QUOTA_BYTES`（5MB）兜底 |
| 逐条估算与真实字节有偏差（中文按字节计可能更大） | 触发判断用真实字节数；淘汰到低水位（10MB 配额下约 7.55MB），距配额仍有约 2.9MB 余量，估算偏差被吸收 |
| 高水位距配额较近（10MB 配额下约 1MB） | 淘汰在每次写入后立即执行，而单批新增仅数 KB（≤8 条 / 400 字符），峰值不会逼近配额；即便估算偏低导致一次淘汰不够，下次写入的 `getBytesInUse` 会再次触发，收敛到配额以下 |
| 并发 worker 同时淘汰造成重复扫描 | in-flight 闩锁（第 7 节） |
| 单个批次新增数据超过整个容量预算 | 保留本条、淘汰其余最旧条目；极端情况下本次会话写入的条目会挤掉较早的条目，但容量始终受控，且保留的是最新译文 |
| 淘汰误删配置导致 API Key 丢失 | 候选集限定 `CACHE_PREFIX` 前缀，且第 11 节有专门测试钉死 |
