# 翻译状态准确性与 popup 状态展示 — 设计文档

**日期:** 2026-09-10
**范围:** `src/content/main.js`、`src/content/apply.js`、`src/content/observer.js`、`src/content/collect.js`、`src/shared/constants.js`、`src/background/service-worker.js`、`src/popup/*`、相关测试
**不改动:** `manifest.json`（不新增 content 文件）、批处理与缓存链路

---

## 1. 背景

当前"翻译 / 还原本页"的页面状态只保存在 content script 的内存里，用一个布尔变量 `active` 表示（`src/content/main.js:13`）。它既不写入 `chrome.storage`，也不在 DOM 上留下任何可查证的痕迹。popup 打开时没有任何"查询状态"的通道，按钮文案是写死的。

这带来两类问题。

### 1.1 站内跳转（SPA）后状态失真

`active` 置为 `true` 后只有 `restorePage()` 会把它复位。存在三个同源缺陷：

1. **`applied` 与 `skipMap` 从不清理。** 框架把旧内容整块卸载后，已应用记录仍然留在内存里。长会话的 SPA 站点上记录数持续增长。
2. **`skipMap` 把节点永久标记为"已翻译"。** 站点改写某个已翻译文本节点后，MutationObserver 会上报该节点的父元素，但 `collect()` 因 skip 标记拒绝它，页面就永久停留在我们写入的旧译文上。
3. **属性项完全没有监听。** observer 只注册了 `childList` 与 `characterData`（`src/content/observer.js:30`），站点改写 `placeholder` / `title` / `aria-label` / `alt` 不会触发任何补翻。

此外还有一个独立来源：service worker 在 `sendMessage` 失败时会 `executeScript` 重新注入整套 content 文件（`src/background/service-worker.js:52-65`）。同一页面于是存在两个 main.js 实例，各自持有一套互不可见的状态。

### 1.2 同语言页的状态语义错误

页面语言与目标语言一致时，`translatePage()` 仍把 `active` 置为 `true`（`src/content/main.js:94`）。于是：

- popup 提示"本页已翻译（再点一次可还原）"，但页面上没有任何译文；
- 第二次点击走还原分支，提示"已还原 0 处原文"。

### 1.3 popup 无法展示状态

popup 打开时不查询任何状态，按钮文案静态写死为"翻译 / 还原本页"，用户只能先点一次、从结果文本里反推当前状态。

---

## 2. 需求决议（已与用户确认）

1. **站内跳转后的新内容：自动补翻，状态保持「已翻译」。** 沿用现有 observer 行为，检测到新内容即翻译；站内跳转不重置状态、不停用 observer。代价是每次站内跳转都会产生新的 API 调用（命中的部分由翻译缓存兜底）。
2. **popup 的状态判定依据：内存状态 + DOM 存活校验。** 新增状态查询消息；content script 返回内存状态，同时校验已应用记录里还有多少节点仍在文档中。不改动页面 DOM。
3. **同语言页：单独状态，不算已翻译。** 引入 `skipped-same-language` 状态，按钮仍显示「翻译本页」，状态栏提示语言一致。修掉"已还原 0 处"这一反直觉输出。

---

## 3. 识别内容替换：方案对比

| 方案 | 做法 | 结论 |
|---|---|---|
| **A. 以 DOM 实况为准的单一记录表** | 记录表是唯一事实来源；每轮 observer 回调与每次状态查询前，对记录做一次对账：节点脱离文档则丢弃，DOM 当前值不再等于我们写入值则丢弃并解除 skip 标记 | **采用**。不碰页面 DOM，不劫持 history API，核心为可直接单测的纯函数 |
| B. 给节点打 `data-*` 标记，按 DOM 判定 | 标记已翻译节点，状态直读 DOM | 拒绝。文本节点无法携带属性，只能标在父元素上；而同一父元素下可能有多条文本节点处于不同状态，标记退化为父元素级的粗粒度信息。且会改动页面 DOM，站点脚本读取 `outerHTML` 时可能受影响 |
| C. 劫持 `pushState` / 监听 `popstate`、`hashchange`，路由变化时重扫 | 用 URL 变化作为重扫信号 | 拒绝。URL 变化与内容变化不等价：有的 SPA 换 URL 但复用同一批节点（真正需要的是改写检测），有的内容变了 URL 没变。劫持 history API 侵入性最强，且易与其他扩展冲突 |

**方案 A 的关键推论：** 站内跳转不需要单独的信号源。框架无论整块替换节点，还是复用节点改写文本，都会产生 MutationObserver 可观测的变化，对账逻辑就能覆盖。URL 监听在本设计中没有位置。

---

## 4. 状态模型

用三个明确状态替换 `active` 布尔值。常量集中定义在 `src/shared/constants.js` 的 `STATE` 中，供 content、popup 与测试共用：

| 状态 | 含义 |
|---|---|
| `idle` | 未翻译（初始态，还原后回到此态） |
| `translated` | 已翻译；observer 挂载中，新内容自动补翻 |
| `skipped-same-language` | 页面语言与目标语言一致，未翻译，**不算已翻译** |

切换分支由"`active` 为真"改为"`mode === 'translated'`"：

```
mode === 'translated'  → 还原
其余（idle / skipped-same-language） → 翻译
```

因此同语言页再次点击会重新判定语言并走翻译分支，不再进入还原分支。

**失败路径不改状态。** 翻译过程抛错时 `mode` 保持原值（`idle` 或 `skipped-same-language`），不置为 `translated`，用户可直接重试。这与现有实现"失败时不置 `active`"的意图一致。

**幂等守卫。** `main.js` 顶部加 `globalThis.__llmPageTranslatorLoaded` 标志，重复注入时直接返回。这是为了让"重复注入产生两套状态"这一隐患从根上消失。守卫处需要注释说明原因（service worker 的注入兜底），否则后来的读者会把它当作冗余代码删掉。

---

## 5. 记录表对账

对账逻辑放在 `src/content/apply.js`，因为它最了解记录的形状。

### 5.1 记录新增 `written` 字段

记录新增 `written`，保存**实际写入 DOM 的字符串**。这个字段是必需的：文本节点带首尾空白时，写入值是 `'  你好  '`，而 `translated` 是 `'你好'`（`src/content/apply.js:15`）。只比对 `translated` 会把我们自己的写入误判成站点改写。

### 5.2 新增纯函数

```
isAlive(rec)        → rec.node 仍在文档中（node.isConnected）
stillMatches(rec)   → DOM 当前值仍等于我们写入的值
                      （无 written 的旧记录回退比对 translated）
reconcile(records)  → { kept, dropped }
```

`stillMatches` 按记录类型取值：文本记录比对 `node.nodeValue`，属性记录比对 `node.getAttribute(rec.attr)`；取值过程整体 try/catch，异常视为不匹配（节点可能已不可访问）。

### 5.3 对账的执行时机与效果

执行时机有两处：

- **每轮 observer 回调开始时**，在 `collectMany` 之前。这是保证改写节点被重新收集的关键顺序。
- **每次 `GET_STATE` 时**，仅用于让上报数字准确，不触发翻译。

对 `dropped` 的记录统一调用 `Collect.unmarkSkipped`。对脱离文档的节点，解除标记只是清理（WeakMap 本就会回收）；对**被站点改写的节点**，解除标记正是重新收集它的前提。

翻译由 observer 独占触发，`GET_STATE` 不会因为打开了 popup 就发起 API 调用。改写事件本身会触发 observer（属性改写由新增的 `attributeFilter` 覆盖），防抖到期后该节点的父元素在待处理集合里，对账解除标记后即被重新收集翻译。

**我们的写入不会误判：** 自己写入的值等于 `written`，`stillMatches` 返回真，记录保留。首次整页翻译的写入发生在 `startObserver` 之前，不产生反馈；observer 驱动的写入会多触发一轮空 observer 回调（此时节点已带 skip 标记，collect 收不到内容），无副作用。

### 5.4 还原计数

`restoreAll` 改为返回**实际写回的存活记录数**。脱离文档的节点不再计入"已还原 N 处"。这是可见变化：SPA 站点上该数字会比以前小，但反映的是真实还原过的数量。

---

## 6. observer 增加属性监听

`observer.start` 新增可选参数 `attributeFilter`（数组）。传入时合并到 observe 配置中，并处理 `attributes` 类型的 mutation：`pending.add(m.target)`。

由 `main.js` 传入 `Collect.ATTR_NAMES`，因此 `collect.js` 需要把该常量加入其导出 API。加过滤名单是为了避免 `class`、`style` 的高频抖动带来额外开销。

`observer.js` 保持通用，不感知具体的属性名单。

---

## 7. 消息协议

新增 `MSG.GET_STATE`（定义于 `src/shared/constants.js`）。

| type | 方向 | payload | 响应 |
|---|---|---|---|
| `GET_STATE` | popup → bg（带 `tabId`）→ content | 无 | `{ok:true, state, translated, lang?, targetLang?}` |

- `lang` / `targetLang` 仅在 `state === 'skipped-same-language'` 时附带，供 popup 展示。
- `translated` 的语义是**对账后的存活记录数**（即当前页面上真实处于已翻译状态的条目数）；`state` 为 `idle` 或 `skipped-same-language` 时恒为 `0`。
- service worker 新增 `queryState(tabId)` 依赖，默认实现为 `chrome.tabs.sendMessage(tabId, {type: GET_STATE})`。
- **`queryState` 不做注入兜底。** content script 不在，说明该页面从未被翻译过，直接回 `{ok:true, state:'idle', translated:0}`。为了读一个状态而注入整套脚本不划算，这与 `toggleTab` 的兜底策略刻意不同。
- `tabId` 非数字时报 `{ok:false, error}`。
- `TOGGLE_TAB` 的响应顺带携带 `state`，popup 据此更新按钮文案，无需二次查询。

---

## 8. popup 行为

**打开即查询。** DOMContentLoaded 时先取当前 tab、发送 `GET_STATE`，再渲染按钮文案与状态提示。

**按钮文案。** `state === 'translated'` 时为「还原本页」，其余为「翻译本页」。`popup.html` 中的静态文案由"翻译 / 还原本页"改为默认的「翻译本页」，避免查询期间的闪变。

**状态栏。** 打开时 `#status` 显示当前状态（"已翻译 N 处文本" / "页面语言与目标语言一致"）；点击后显示本次操作结果。

**同语言改为中性样式。** 新增 `.info` 样式类，与既有 `.ok`、`.error` 并列。`describeResult` 对 `skipped-same-language` 返回 `info` 而非 `error`；`runToggle` 的 `ok` 判定相应放宽——它是"操作完成、无需翻译"，不是失败。

popup 生命周期很短，本轮不做状态变化的实时推送。

---

## 9. 文件改动清单

| 文件 | 改动 |
|---|---|
| `src/shared/constants.js` | 新增 `MSG.GET_STATE`、`STATE` 枚举 |
| `src/content/apply.js` | 记录新增 `written`；新增 `isAlive`、`stillMatches`、`reconcile`；`restoreAll` 返回存活计数 |
| `src/content/collect.js` | 导出 `ATTR_NAMES` |
| `src/content/observer.js` | `start` 支持 `attributeFilter`；处理 `attributes` 类型 mutation |
| `src/content/main.js` | `active` → `mode` 三态；observer 回调与 `GET_STATE` 中对账；传入 `attributeFilter`；同语言单独状态；幂等守卫；响应携带 `state` |
| `src/background/service-worker.js` | 新增 `queryState` 依赖与 `GET_STATE` 处理（无注入兜底） |
| `src/popup/popup.js` | 打开即查询；`labelFor` / `hintFor`；同语言中性化；点击后按 `state` 更新文案 |
| `src/popup/popup.html` | 按钮静态文案改为「翻译本页」 |
| `src/popup/popup.css` | 新增 `.info` 样式 |
| `README.md` | "再点一次恢复原文"一段随按钮文案调整 |

---

## 10. 测试计划

沿用既有约定：模块通过 `import` 副作用挂载 `globalThis.Ext`，从全局取 API，jsdom 环境。

| 测试文件 | 新增/调整 |
|---|---|
| `test/apply.test.js` | 记录携带 `written`；`reconcile` 各分支——存活未改写保留、脱离文档丢弃、被站点改写丢弃、无 `written` 的旧记录回退比对 `translated`；`restoreAll` 存活计数（脱离文档不计入） |
| `test/observer.test.js` | 属性改写经 `attributeFilter` 上报 `m.target`；未列入过滤名单的属性不触发 |
| `test/popup.test.js` | `labelFor` / `hintFor` 映射；`refreshState` 打开即发 `GET_STATE` 并渲染；同语言两条断言按 `info` 新语义更新 |
| `test/sw.test.js` | `GET_STATE` 透传 content 响应；`queryState` 抛错时回 `idle`；缺 `tabId` 报错 |
| `test/manifest.test.js` | 无需改动（不新增文件；`STATE` 与 `MSG` 的唯一性断言自动覆盖新常量） |

`main.js` 为编排薄层，与既有约定一致，不做单测，由手动端到端验收覆盖。

**手动验收补充项：**

1. 打开某 SPA（如 GitHub 仓库页内切换 Tab）→ 翻译 → 站内跳转 → 新内容自动变中文，且 popup 打开即显示「还原本页 / 已翻译 N 处」。
2. 翻译后由站点脚本改写某条已翻译文本（DevTools 手动改 `textContent`）→ 防抖后该处被重新翻译，而非停留在旧译文。
3. 打开目标语言与页面语言一致的站点 → 点按钮 → 提示语言一致（中性色），按钮仍为「翻译本页」；再点一次仍是同样提示，不出现"已还原 0 处"。
4. 翻译中打开 popup → 文案与状态与实际相符。

---

## 11. 边界与非目标

- **不改动页面 DOM。** 不引入 `data-*` 标记，不劫持 history API。
- **不做状态实时推送。** popup 打开时查询一次即可。
- **不引入 URL 变化监听。** 见第 3 节方案 C 的拒绝理由。
- **不改变翻译/缓存链路。** 批处理、重试、缓存键均不涉及。
- **已知残留：** 若站点改写发生在属性名单之外（如 `value`、`data-*`），或站点在 iframe 内改写内容，本设计不做处理——与现有边界一致。
- **`mode` 仍为单页内存态。** 刷新页面后回到 `idle`，这与"刷新后 DOM 也回到原文"是一致的，属于预期行为而非缺陷。

---

## 12. 风险

| 风险 | 应对 |
|---|---|
| `isConnected` 在目标环境不可用 | 现代 Chrome 与 jsdom 均已实现；`stillMatches` 与存活判定整体 try/catch，异常降级为"丢弃记录"而非抛错 |
| 属性过滤名单带来额外 observer 开销 | 仅注册 4 个属性名；站点若高频改写 `title` 等，会走防抖合并，单轮最多产生一次 `TRANSLATE_BATCH` 调用（其内部再按批并发） |
| 同语言提示由红转中性，与既有测试断言冲突 | 属预期的行为变更，测试按新语义改写（第 10 节已列出） |
| 对账丢弃被站点改写的记录后，该节点本轮可能未被 observer 覆盖 | 改写事件本身（`characterData` / `attributes`）必然进入待处理集合，父元素/target 会在本轮被重新收集 |
