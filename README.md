# LLM Page Translator (Chrome MV3)

点击工具栏图标,把当前网页的全部可读内容(正文、导航、按钮文字,以及 placeholder / title / aria-label / alt)通过任意 **OpenAI 兼容 LLM API** 翻译成目标语言;再点一次恢复原文。支持无限滚动/SPA 的动态内容自动补翻。

## 安装(开发者模式)

1. Chrome 打开 `chrome://extensions`
2. 右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**,选择本目录

## 配置

1. `chrome://extensions` → 本扩展 → **选项**(Details → Extension options)
2. 填写:
   - **API Base URL**:如 `https://api.openai.com/v1`(DeepSeek: `https://api.deepseek.com/v1`;Ollama: `http://localhost:11434/v1`)
   - **API Key**
   - **Model**:如 `gpt-4o-mini`
   - **Target language**:默认简体中文
3. **Save** 保存,**Test connection** 验证连通性

## 使用

- 点工具栏图标:翻译 / 还原(切换)
- 页面语言与目标语言相同时自动跳过
- 翻译结果按「目标语言+原文」缓存(`chrome.storage.local`),重复内容不再计费
- 滚动加载的新内容会在防抖后自动补翻

## 成本说明

相邻文本合并进同一请求(每批最多 50 条 / 2000 字符),同一批内重复文本去重;失败自动重试 2 次(1s/2s 退避)。某批次永久失败时,已成功批次的译文仍会返回并写入缓存。

## 开发

```bash
npm install
npm test        # Vitest + jsdom 单元测试
```

修改代码后在 `chrome://extensions` 点扩展卡片上的刷新按钮即可生效。

## 代码结构

```
manifest.json                 MV3 清单
src/shared/constants.js       消息类型 / 默认配置 / 批参数
src/shared/batch.js           批切分 + LLM JSON payload 构建/解析
src/shared/cache.js           翻译缓存(FNV-1a 64bit key,可插拔后端)
src/background/llm.js         OpenAI 兼容请求构建
src/background/service-worker.js  消息路由 + 缓存 + 重试
src/content/detect.js         页面语言检测
src/content/collect.js        DOM 文本节点与属性收集(skip map 防重翻)
src/content/apply.js          原文替换与还原
src/content/observer.js       防抖 MutationObserver
src/content/main.js           content 编排入口(TOGGLE 切换)
src/options/                  配置页
test/                         单元测试(Vitest + jsdom)
```

## 已知边界

- `<code>/<pre>/<textarea>` 等代码类内容不翻译(保持原样,含被包装元素嵌套的场景)
- 同一文本节点内重复出现的同一词仅替换首处
- 极少数站点脚本持有原文本引用,替换后其内部状态可能不同步——再点一次图标还原即可
- 缓存无容量驱逐(v0.1):`chrome.storage.local` 默认约 10MB,按「原文+译文」条目计可存数万条
- API key 仅存于本机 `chrome.storage.local`,请求仅发往你配置的 Base URL
