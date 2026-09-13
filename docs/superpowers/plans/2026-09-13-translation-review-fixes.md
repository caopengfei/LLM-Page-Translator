# Translation Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码审查中确认的翻译正确性、语言判断、配置校验和工程验证问题，同时保留现有请求/响应正文日志行为。

**Architecture:** 在现有 collector、service worker、content state、i18n 和 options 模块上做局部修复，不重写翻译状态机或缓存层。所有行为先通过 Vitest 回归测试锁定，再修改最小实现；第 6 点的 `src/background/llm.js` 日志不改动。

**Tech Stack:** 原生 JavaScript、Chrome MV3、Vitest 2、jsdom。

---

## 文件映射

- 修改 `src/content/collect.js`：根元素属性收集、隐藏/不可见节点过滤、属性选择器。
- 修改 `src/content/detect.js`：中文脚本/地区语言匹配。
- 修改 `src/background/llm.js`：保留 HTTP 状态和错误类型供重试分类使用；不改现有正文日志。
- 修改 `src/background/service-worker.js`：只重试明确瞬时错误，拒绝不完整批次。
- 修改 `src/content/main.js`：记录实际翻译目标语言，实现语言变化时一次点击恢复并重译。
- 修改 `src/options/options.js`：绝对 HTTP(S) URL 校验。
- 修改 `src/popup/popup.html`、`src/options/options.html`、`src/content/main.js`、`src/background/service-worker.js`、`src/shared/i18n.js` 及语言资源：补齐用户可见文案国际化。
- 修改 `test/collect.test.js`、`test/detect.test.js`、`test/sw.test.js`、`test/main.test.js`、`test/options.test.js`、`test/i18n.test.js`、`test/manifest.test.js`：新增回归覆盖。
- 修改 `README.md`、`README.zh-CN.md`：更新测试数字、缓存键和超长项说明。
- 修改 `package.json`、必要时新增 `scripts/validate-extension.mjs`：提供语法/资源校验命令。

## 明确不改

- 不修改 `src/background/llm.js` 中打印完整请求体、响应体的日志语句或其默认行为。
- 不改变缓存淘汰策略、批次并发设计和扩展权限范围。

### Task 1: 锁定 collector 和语言检测缺陷

**Files:**
- Test: `test/collect.test.js`
- Test: `test/detect.test.js`
- Modify: `src/content/collect.js`
- Modify: `src/content/detect.js`

- [ ] **Step 1: 写属性根节点和隐藏内容的失败测试**

在 `test/collect.test.js` 增加：属性变化元素作为 root 时仍收集自身 `title`/`placeholder`；`[placeholder]`、`[alt]` 等通用属性选择器可覆盖元素；`hidden`、`aria-hidden="true"` 和 `display:none` 祖先下的文本/属性不收集。

- [ ] **Step 2: 运行 collector 定向测试确认失败**

Run: `npx vitest run test/collect.test.js`
Expected: 新增根属性和隐藏内容断言失败，现有测试保持通过。

- [ ] **Step 3: 实现根属性和可见性过滤**

让 `collect()` 在 `root.nodeType === 1` 且 root 匹配属性选择器时先处理 root，再处理后代；抽取 `isHiddenElement()`，沿祖先检查 `hidden`、`aria-hidden="true"` 和 `getComputedStyle()` 的 `display`/`visibility`；将属性选择器扩展为 `[placeholder], [title], [aria-label], [alt]`，保留既有 skip 标签排除。

- [ ] **Step 4: 写中文语言匹配失败测试**

在 `test/detect.test.js` 增加 `zh-CN/zh-Hans` 与 `zh-TW/zh-Hant` 不互相匹配、`zh-HK` 归入繁体、普通 `en-US/en-GB` 仍按主语言匹配的断言。

- [ ] **Step 5: 实现中文脚本/地区匹配**

在 `langMatches()` 中对中文计算脚本：显式 `Hans` 或 `CN/SG` 归简体，`Hant` 或 `TW/HK/MO` 归繁体；两类不同返回 false，未能判断脚本时才回退到主语言匹配。

- [ ] **Step 6: 运行定向测试**

Run: `npx vitest run test/collect.test.js test/detect.test.js`
Expected: 全部通过。

### Task 2: 收紧重试并校验完整 LLM 响应

**Files:**
- Test: `test/sw.test.js`
- Modify: `src/background/llm.js`
- Modify: `src/background/service-worker.js`

- [ ] **Step 1: 写 4xx、解析错误和部分响应失败测试**

在 `test/sw.test.js` 增加：HTTP 400/401 只调用 fetch 一次；HTTP 500 和 429 按现有次数/退避策略重试；响应缺少任一批次 key 或返回空对象时不返回成功译文、不写缓存、不推送该批次。

- [ ] **Step 2: 运行 service worker 定向测试确认失败**

Run: `npx vitest run test/sw.test.js`
Expected: 新增 4xx 和部分响应断言失败，既有 429 测试保持通过。

- [ ] **Step 3: 保留日志并补充可分类错误信息**

在 `src/background/llm.js` 的 HTTP 错误上保留 `status`，将 429 继续标记 `RATE_LIMIT`；解析或响应形状错误使用稳定的非重试错误码。不得删除、降级或改写当前请求/响应正文日志。

- [ ] **Step 4: 实现明确重试分类**

让 `isRetryable()` 只对 `code === 'RATE_LIMIT'` 或 `status >= 500 && status <= 599` 返回 true；`TIMEOUT`、`NETWORK`、4xx、解析错误和响应格式错误返回 false。`runBatch()` 先验证每个 `batch` 项都有非空字符串译文，缺失即抛出非重试响应错误；只有完整批次才回填、缓存和推送。

- [ ] **Step 5: 运行 service worker 测试**

Run: `npx vitest run test/sw.test.js`
Expected: 全部通过。

### Task 3: 实现目标语言变化的一次点击切换

**Files:**
- Test: `test/main.test.js`
- Modify: `src/content/main.js`
- Modify: `src/shared/constants.js`（仅在需要新增状态字段时）

- [ ] **Step 1: 写语言变化切换失败测试**

构造已翻译为 `de` 的页面，改变 storage 中的目标语言为 `fr`，发送一次 `TOGGLE`；断言旧译文先恢复、随后发起 `fr` 翻译并最终处于 translated 状态。目标语言未变化时一次 `TOGGLE` 仍只恢复页面。

- [ ] **Step 2: 运行 main 定向测试确认失败**

Run: `npx vitest run test/main.test.js`
Expected: 新增语言变化场景失败。

- [ ] **Step 3: 记录实际翻译目标并处理切换**

维护 `translatedTargetLang`；翻译成功时记录当前目标语言，restore 时清空。`TOGGLE` 进入 translated 分支时加载配置：目标语言与 `translatedTargetLang` 不同则先调用 `restorePage()`，再调用 `translatePage()`，否则保持原有 restore 行为。确保 generation guard、observer 和统计状态在自动切换中正确重置。

- [ ] **Step 4: 运行 main 和全套相关测试**

Run: `npx vitest run test/main.test.js test/popup.test.js`
Expected: 全部通过。

### Task 4: 补齐 i18n 和配置 URL 校验

**Files:**
- Test: `test/i18n.test.js`, `test/options.test.js`
- Modify: `src/shared/i18n.js` and locale resources
- Modify: `src/popup/popup.html`, `src/options/options.html`
- Modify: `src/content/main.js`, `src/background/service-worker.js`
- Modify: `src/options/options.js`

- [ ] **Step 1: 为静态文案和 URL 校验写失败测试**

在 `test/i18n.test.js` 扫描 popup/options HTML 的可见静态文本，允许品牌名和表单占位符但拒绝未标记英文文案；在 `test/options.test.js` 增加绝对 `https://`、本地 `http://localhost`/`127.0.0.1` 通过，缺协议、相对路径和不支持协议失败的测试。

- [ ] **Step 2: 运行定向测试确认失败**

Run: `npx vitest run test/i18n.test.js test/options.test.js`
Expected: 新增硬编码文案和 URL 校验断言失败。

- [ ] **Step 3: 迁移用户可见文案到 i18n**

为页面标题、heading、Options 标签和 service-worker/content 错误增加中英文 key；HTML 使用 `data-i18n`/`data-i18n-attr`，运行时错误统一调用 `t()`。保持第 6 点正文日志语句不变。

- [ ] **Step 4: 实现配置 URL 校验**

新增 `isValidBaseUrl(value)`：使用 `URL` 解析，仅接受 `http:`/`https:` 且必须有 hostname；在 `validateConfig()` 返回 `invalidBaseUrl`，保存和测试连接共用该校验，保留 localhost/127.0.0.1 的 HTTP 兼容性。

- [ ] **Step 5: 运行定向测试**

Run: `npx vitest run test/i18n.test.js test/options.test.js`
Expected: 全部通过。

### Task 5: 更新文档和工程验证入口

**Files:**
- Test: `test/manifest.test.js`
- Modify: `README.md`, `README.zh-CN.md`, `package.json`
- Create: `scripts/validate-extension.mjs`

- [ ] **Step 1: 添加验证脚本失败/通过契约**

脚本检查 manifest 引用的文件、content script 文件顺序、HTML/JS 资源存在且可读；非零退出时打印具体缺失路径。将 `npm run validate` 指向该脚本，并在 `test/manifest.test.js` 覆盖脚本可执行入口和关键资源。

- [ ] **Step 2: 更新文档事实**

将 README 测试数量改为不易过期的“运行 `npm test` 查看当前数量”，补充缓存键包含目标语言、模型和源文本，说明超长单项可能超过批次字符上限，补充 `npm run validate`。

- [ ] **Step 3: 运行静态验证**

Run: `npm run validate`
Expected: 输出资源校验成功并退出 0。

### Task 6: 全量验证与审查

**Files:**
- Modify only if test failures reveal inconsistencies.

- [ ] **Step 1: 运行完整测试**

Run: `npm test`
Expected: 所有测试通过，无未处理 rejection；允许已有测试覆盖的预期 warning。

- [ ] **Step 2: 运行语法和资源验证**

Run: `npm run validate`
Expected: 退出 0。

- [ ] **Step 3: 检查第 6 点未被修改**

Run: `git diff -- src/background/llm.js`
Expected: 仅允许为错误分类保留必要的 status/code 调整；请求体/响应体日志语句和默认日志行为保持不变。

- [ ] **Step 4: 检查工作区差异并汇总**

Run: `git status --short && git diff --stat`
Expected: 只包含本计划范围内文件；最终报告测试结果、未解决的风险和未修改的第 6 点。
