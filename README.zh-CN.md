[English](README.md) | **简体中文**

# LLM Page Translator (Chrome MV3)

一个 Chrome Manifest V3 扩展:点击工具栏图标把当前网页的**全部可读文本**——正文、导航、按钮文字,以及 `placeholder` / `title` / `aria-label` / `alt` 属性——通过任意 **OpenAI 兼容的 LLM API** 翻译成目标语言;再点一次即可还原原文。无限滚动与 SPA 动态加载的内容会自动补翻。

无需任何翻译服务账号,只要一个兼容 OpenAI `POST /chat/completions` 的接口即可:OpenAI、DeepSeek、Ollama、vLLM、各类中转网关都行。

---

## 功能特性

- **整页翻译**:正文文本节点 + 4 类文本属性(placeholder / title / aria-label / alt)一并处理
- **一键切换**:同一个按钮按页面状态在「翻译本页 / 还原本页」之间自动切换
- **流式上屏**:翻译按批进行,每批译文一返回就立即写入页面,不必等所有批次走完
- **动态补翻**:`MutationObserver` 监听新增节点与被站点改写的属性,防抖后自动补翻(适合无限滚动、SPA 路由切换)
- **原文安全还原**:逐条记录原文,还原时精确写回;站点改写过的节点会被对账机制识别并重新翻译
- **按目标语言缓存**:相同原文不重复请求,重复内容不再计费
- **并发请求**:多批次并发(默认 3),相比串行显著缩短总耗时
- **多语言界面**:18 种 UI 语言,文案与代码分离;目标语言默认按浏览器 UI 语言推导
- **零硬编码密钥**:API Key 只存本机 `chrome.storage.local`,只发往你配置的 Base URL

---

## 界面截图

工具栏面板 —— 翻译前 / 翻译后:

| 未翻译 | 已翻译 |
| --- | --- |
| ![未翻译状态的工具栏面板](docs/screenshots/popup-idle.png) | ![已翻译状态的工具栏面板](docs/screenshots/popup-translated.png) |

设置页:

![设置页](docs/screenshots/options.png)

<sub>截图由扩展真实的 HTML/CSS/JS 渲染,界面为英文。实际界面文案跟随浏览器语言,共支持 18 种。</sub>

---

## 安装(开发者模式)

1. 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**,选择本仓库根目录
4. 建议把扩展图标固定到工具栏,方便使用

---

## 配置

打开配置页(任选一种):

- 点工具栏图标弹出面板 → 右上角 **⚙ 设置**
- 右键工具栏图标 → **选项**
- `chrome://extensions` → 本扩展 → **扩展程序选项**

填写以下字段后点 **Save**:

| 字段 | 说明 |
| --- | --- |
| **API Base URL** | 接口根地址,如 `https://api.openai.com/v1`。DeepSeek:`https://api.deepseek.com/v1`;Ollama:`http://localhost:11434/v1`。已包含 `/chat/completions` 时不会重复拼接 |
| **API Key** | 对应服务的密钥 |
| **Model** | 模型名,如 `gpt-4o-mini` |
| **Target language** | 目标语言。首次默认按浏览器 UI 语言推导(界面为德语 → 默认德语),识别不出时用英语;手动选过一次后一直沿用 |
| **Request timeout (seconds)** | 单次翻译请求最长等待,默认 **120 秒**。Test connection 也会遵守该值 |

点 **Test connection** 可验证连通性,成功时会回显一句示例译文。

> **注意**:Test connection 只发送一行极短文本,它通过**不代表**正式翻译一定能通。正式翻译一次会发送成批文本(默认每批 ≤ 8 条 / 400 字符,3 批并发);接口慢或对请求体大小敏感时,可能出现「Test 通过但翻译超时」。此时可调大 **Request timeout**,或换用响应更快的模型/接口。

### 面板内快速切换语言

工具栏面板自带**目标语言**下拉(共 18 种语言),切换即保存、下一次翻译即生效,不必进设置页。面板与设置页共用同一份语言清单,可选项始终一致。

---

## 使用

1. 打开任意网页,点工具栏图标弹出面板
2. 点 **翻译本页**,译文会分批流式上屏
3. 再点 **还原本页**(按钮文案此时已自动切换)恢复原文

**页面状态与提示**:

- 面板打开时会查询当前页状态,按钮文案与状态栏随状态变化
- 页面语言与目标语言一致时自动跳过,面板提示「语言一致」,这不计为翻译
- 翻译未完成时再次点击会提示「正在翻译中」,不会重复触发
- 翻译完成后状态栏显示 `已翻译 N 处文本,共 X 字,用时 Y 秒`(字数为源文字符数,用时含动态补翻的累计)
- 部分批次失败时显示部分结果,未翻译的节点可在下一轮补翻或再次点击重试
- 页面在扩展安装前就已打开时,首次点击会自动注入 content script 再执行,不会无响应

---

## 工作原理

```
┌──────────┐  TOGGLE_TAB / GET_STATE   ┌────────────────┐
│  popup   │ ────────────────────────▶ │ service worker │
└──────────┘                           └────────────────┘
                                            │  ▲
                        TOGGLE / GET_STATE  │  │  RESULT_BATCH(流式,每批一次)
                                            ▼  │
                                      ┌──────────────┐
                                      │content script│ ── collect → batch → LLM
                                      └──────────────┘        ↑            │
                                                              └─ apply ◀───┘
```

1. **收集**:content script 用 `TreeWalker` 遍历文本节点,并扫描 `placeholder` / `title` / `aria-label` / `alt`;用 `WeakMap` 记录「已跳过」标记,避免重复翻译
2. **批次**:去重后按 **8 条 / 400 字符**上限切批,**3 批并发**发送
3. **请求**:service worker 以 `{ "0": "文本", "1": "…" }` 的 JSON 形式提交,要求模型返回同 key 的 JSON;带 120s 超时与重试
4. **上屏**:每批译文完成即通过 `RESULT_BATCH` 推给页面并写入缓存,DOM 按 id 去重应用
5. **补翻**:`MutationObserver` 防抖 500ms 汇总变更节点,只对新增/被改写的部分补翻

### 页面状态机

页面维护三态,而非简单的布尔值——「同语言跳过」必须与「已翻译」区分开,否则再次点击会误入还原分支:

| 状态 | 含义 |
| --- | --- |
| `idle` | 未翻译 |
| `translated` | 已翻译,按钮语义变为「还原」 |
| `skipped-same-language` | 页面语言与目标语言一致,已跳过 |

---

## 成本与可靠性

- **去重**:同一批内的重复文本只请求一次;跨批次、跨会话命中的原文直接读缓存
- **缓存**:按「目标语言 + 原文」为键(FNV-1a 64 位哈希),存于 `chrome.storage.local`;超出容量水位后按写入时间自动淘汰最早的条目
- **重试**:失败自动重试 **2 次**,退避 1s / 2s;**仅对服务端瞬时问题(如 HTTP 5xx)重试**;超时与网络不可达直接失败,避免用户白等 3 倍超时
- **部分成功**:某批次永久失败时,已成功批次的译文仍会返回并写入缓存,下次点击只补翻缺失部分

---

## 界面多语言

界面文案不写死在代码里,统一放在 `_locales/<locale>/messages.json`,由 Chrome 按**浏览器 UI 语言**自动选择;`en` 是 `default_locale`,缺失的 key 自动回退到它。

- 已支持 18 种界面语言:`en`(默认)、`zh_CN`、`zh_TW`、`ja`、`ko`、`de`、`fr`、`es`、`it`、`pt`、`ru`、`nl`、`pl`、`tr`、`ar`、`hi`、`vi`、`th`
- 扩展名、描述、工具栏提示走 manifest 的 `__MSG_ext_name__` 等占位符
- 页面内提示与报错信息全部经 `Ext.i18n.t(key, [subs])`,不出现硬编码中文
- 目标语言选择器里的语言名一律用**母语自称**(English / 日本語 / Deutsch…),不随界面语言翻译
- **新增一种界面语言**:复制 `_locales/en/messages.json` 为 `_locales/<locale>/messages.json` 并翻译 `message` 字段。占位符 `$1 $2` 必须原样保留;`npm test` 会校验各语言的键集合与占位符一致

---

## 开发

```bash
npm install
npm test        # Vitest + jsdom,13 个测试文件 / 157 个用例
```

测试覆盖:批次切分与响应解析、缓存哈希、DOM 收集与替换/还原对账、观察器防抖、LLM 请求构建与超时、service worker 消息路由与重试、popup/options 状态渲染、i18n 键完整性、manifest 文件存在性。

修改代码后,在 `chrome://extensions` 点扩展卡片上的刷新按钮即可生效;改了 content script 后需刷新目标网页。

### 调试日志

每次 LLM 请求/响应都会打印到 **Service Worker 控制台**:

- 请求:`[LLM Page Translator] → POST <url>` + 请求体 JSON(model、system prompt、待翻译文本)
- 响应:`[LLM Page Translator] ← HTTP <status> <url> (<耗时>ms)` + 原始响应体(成功与非 2xx 都打印)
- 超时/网络失败额外打印 `✖` 警告,含 URL 与失败原因

日志只输出请求体、**不输出请求头**,因此不会泄漏 API Key。

查看方式:`chrome://extensions` → 本扩展 → 点 **Service Worker**(或卡片上的「检查视图」)→ Console。

> 日志始终开启,内容会包含页面文本;Service Worker 休眠重启后控制台日志会清空,不落盘、不持久化。

---

## 代码结构

```
manifest.json                     MV3 清单(default_locale + __MSG__ 本地化)
_locales/<locale>/messages.json   18 种界面语言文案表
icons/                            16/32/48/128 扩展图标
src/shared/constants.js           消息类型 / 页面状态 / 默认配置 / 批参数 / 语言清单 / UI 语言推导
src/shared/i18n.js                文案查找(t / apply)与 data-i18n* DOM 填充
src/shared/batch.js               批切分 + LLM JSON payload 构建与容错解析
src/shared/cache.js               翻译缓存(FNV-1a 64 位 key,可插拔后端)
src/shared/theme.css              面板与设置页共用的主题样式
src/background/llm.js             OpenAI 兼容请求构建 + 请求/响应日志 + 超时
src/background/service-worker.js  消息路由 / 缓存 / 并发批次 / 重试 / content 注入兜底
src/content/detect.js             页面语言检测与同语言判定
src/content/collect.js            DOM 文本节点与属性收集(skip map 防重翻)
src/content/apply.js              译文替换、记录对账与原文还原
src/content/observer.js           防抖 MutationObserver
src/content/main.js               content 编排入口(TOGGLE 切换 + 流式上屏)
src/popup/                        工具栏面板(popup.html / popup.css / popup.js)
src/options/                      配置页(options.html / options.css / options.js)
test/                             单元测试(Vitest + jsdom)
docs/superpowers/                 设计与实现计划文档
```

---

## 已知边界

- `<script>/<style>/<noscript>/<template>/<textarea>/<code>/<pre>/<kbd>/<samp>/<iframe>` 内的内容不翻译(保持原样)
- 点击工具栏图标只弹出面板,需在面板中点「翻译本页 / 还原本页」才会执行
- 同一文本节点内重复出现的同一词仅替换首处
- 极少数站点脚本持有原文本引用,替换后其内部状态可能不同步——再点一次图标还原即可
- 缓存按容量自动淘汰:触发水位为 `chrome.storage.local` 配额的 90%(Chrome 114+ 约 9MB),超出后按写入时间删除最早的条目直到降至 72%;配置与 API Key 不受影响
- 仅支持 OpenAI 兼容的 `/chat/completions` 接口,不支持其他协议的翻译服务

---

## 隐私说明

- API Key 仅保存在本机 `chrome.storage.local`,不会上传到任何第三方
- 待翻译文本仅发送到**你自己配置的 Base URL**
- 扩展不含遥测、统计或远程配置拉取
- 需要的权限:`storage`(存配置与缓存)、`scripting`(向已打开页面注入 content script)、`http/https` 全站主机权限(读取并替换页面文本)

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。
