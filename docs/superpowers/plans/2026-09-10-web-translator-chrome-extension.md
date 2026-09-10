# LLM Page Translator (Chrome MV3 Extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个 Chrome MV3 插件:点击工具栏图标,通过用户自配的 OpenAI 兼容 LLM API 翻译当前页面全部可读文本(含 placeholder/title/aria-label/alt),原文原地替换、可一键还原,并持续监听动态内容自动补翻。

**Architecture:** 无构建流程(改完刷新即生效):content scripts 按 manifest 顺序注入多个文件,共享 `globalThis.Ext` 命名空间;background service worker(ESM module 模式)统一代理 LLM 请求(避开 CORS)、执行批合并、翻译缓存与重试;配置存 `chrome.storage.local`。所有 DOM 逻辑与纯函数用 Vitest + jsdom 做 TDD,端到端行为用 Chrome 手动验收。

**Tech Stack:** Chrome Extension Manifest V3 · 原生 JavaScript(无 bundler)· Vitest + jsdom · Node 23 / npm 10(环境已具备)

**需求决议(grilling 已敲定):**
1. 引擎:LLM API,OpenAI 兼容接口,baseURL/model/apiKey 用户可配
2. 范围:全部文本节点 + placeholder/title/aria-label/alt 属性
3. 呈现:原地替换原文,保留快照可还原
4. 目标语言:设置可选(默认 zh-CN)+ 页面语言自动检测,同语言跳过
5. 动态内容:MutationObserver 防抖持续补翻
6. 成本:相邻文本合并同批请求 + 本地翻译缓存 + 已翻译节点标记防重翻

---

## 全局约定(所有 Task 遵循)

**模块模式**:除 `src/background/service-worker.js` 外,所有 `src/` 文件用同一 wrapper —— 同时支持浏览器全局挂载(content script 无 ES module)与 Vitest import(副作用挂 `globalThis.Ext`):

```js
(function (global) {
  'use strict';
  const XxxApi = { /* ... */ };
  global.Ext = global.Ext || {};
  global.Ext.xxx = XxxApi;
  if (typeof module !== 'undefined' && module.exports) module.exports = XxxApi;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

测试中统一 `import '<相对路径>'` 后从 `globalThis.Ext.xxx` 取 API。

**消息协议**(定义于 `src/shared/constants.js`,`EXT_CONSTANTS.MSG`):

| type | 方向 | payload | 响应 |
|---|---|---|---|
| `TRANSLATE_BATCH` | content→bg | `{items:[{id,text}], targetLang}` | `{ok:true, translations:{id:string}}` 或 `{ok:false,error}` |
| `DETECT_LANGUAGE` | content→bg | `{text}` | `{ok:true, language}` 或 `{ok:false,error}` |
| `TEST_CONNECTION` | options→bg | `{config}` | `{ok:true, sample}` 或 `{ok:false,error}` |
| `TOGGLE` | bg→content | 无 | (content 自行处理,不回包) |

**"相邻合并"的技术解释**:决议中的相邻文本合并实现为"同一请求批次"(一次 LLM 调用携带多条文本的 JSON 映射),不做字符串级串接——串接会破坏逐节点回填。批上限:`BATCH_MAX_ITEMS=50` 条、`BATCH_MAX_CHARS=2000` 字符,重复文本在批内按 `text` 去重。

## 文件结构

```
chorme_ext_translate/
├── manifest.json                    # MV3 清单(唯一的"构建配置")
├── package.json                     # dev: vitest, jsdom
├── vitest.config.js                 # jsdom 环境
├── .gitignore
├── README.md                        # 安装/配置/使用说明
├── src/
│   ├── shared/
│   │   ├── constants.js             # 消息类型、默认配置、批参数
│   │   ├── batch.js                 # 批切分 + LLM JSON payload 构建/解析
│   │   └── cache.js                 # 翻译缓存(FNV-1a 64bit key,可插拔存储后端)
│   ├── background/
│   │   ├── llm.js                   # 请求体构建 + 响应提取 + fetch 封装
│   │   └── service-worker.js        # 消息路由:批翻译/语言检测/连接测试 + 重试
│   ├── content/
│   │   ├── detect.js                # 页面语言检测(html lang + 采样)
│   │   ├── collect.js               # TreeWalker 收集文本节点与属性项 + skip 标记
│   │   ├── apply.js                 # 原文替换/还原
│   │   ├── observer.js              # 防抖 MutationObserver
│   │   └── main.js                  # content 入口:TOGGLE 编排(薄层,手动验收)
│   └── options/
│       ├── options.html
│       ├── options.js               # 表单↔配置转换(纯函数可测)+ 页面接线
│       └── options.css
└── test/
    ├── manifest.test.js
    ├── batch.test.js
    ├── cache.test.js
    ├── llm.test.js
    ├── sw.test.js
    ├── detect.test.js
    ├── collect.test.js
    ├── apply.test.js
    ├── observer.test.js
    └── options.test.js
```

---

### Task 1: 项目脚手架 + manifest + 常量

**Files:**
- Create: `package.json`, `vitest.config.js`, `.gitignore`, `manifest.json`, `src/shared/constants.js`, `test/manifest.test.js`

- [ ] **Step 1: git init 与 npm 安装**

```bash
git init
npm install --save-dev vitest@^2.1.9 jsdom@^25.0.0
```

Expected: 生成 `node_modules/` 与 `package-lock.json`;若网络不可用,停止并报告(后续 DOM 测试依赖 jsdom)。

- [ ] **Step 2: 写 package.json / vitest.config.js / .gitignore**

`package.json`:

```json
{
  "name": "web-translator-ext",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run"
  },
  "devDependencies": {
    "jsdom": "^25.0.0",
    "vitest": "^2.1.9"
  }
}
```

`vitest.config.js`:

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.js']
  }
});
```

`.gitignore`:

```
node_modules/
*.log
```

- [ ] **Step 3: 写 src/shared/constants.js**

```js
(function (global) {
  'use strict';
  const EXT_CONSTANTS = {
    MSG: {
      TOGGLE: 'TOGGLE',
      TRANSLATE_BATCH: 'TRANSLATE_BATCH',
      DETECT_LANGUAGE: 'DETECT_LANGUAGE',
      TEST_CONNECTION: 'TEST_CONNECTION'
    },
    DEFAULT_CONFIG: {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini',
      targetLang: 'zh-CN'
    },
    BATCH_MAX_ITEMS: 50,
    BATCH_MAX_CHARS: 2000,
    DEBOUNCE_MS: 500,
    STORAGE_KEYS: { CONFIG: 'config', CACHE_PREFIX: 'tc:' }
  };
  global.EXT_CONSTANTS = EXT_CONSTANTS;
  if (typeof module !== 'undefined' && module.exports) module.exports = EXT_CONSTANTS;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 写 manifest.json**

```json
{
  "manifest_version": 3,
  "name": "LLM Page Translator",
  "version": "0.1.0",
  "description": "Translate all readable content of the current page via any OpenAI-compatible LLM API.",
  "permissions": ["storage", "scripting"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": {
    "service_worker": "src/background/service-worker.js",
    "type": "module"
  },
  "options_page": "src/options/options.html",
  "action": {
    "default_title": "Translate / restore this page"
  },
  "content_scripts": [
    {
      "matches": ["http://*/*", "https://*/*"],
      "js": [
        "src/shared/constants.js",
        "src/shared/batch.js",
        "src/shared/cache.js",
        "src/content/detect.js",
        "src/content/collect.js",
        "src/content/apply.js",
        "src/content/observer.js",
        "src/content/main.js"
      ],
      "run_at": "document_idle"
    }
  ]
}
```

(此时 `src/background/service-worker.js`、`src/content/*` 尚不存在,`js` 数组校验在 Task 12 会全绿;本 Task 的测试只校验存在的文件与结构。)

- [ ] **Step 5: 写失败测试 test/manifest.test.js**

```js
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import '../src/shared/constants.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}manifest.json`, 'utf8'));
const C = globalThis.EXT_CONSTANTS;

describe('manifest.json', () => {
  it('is Manifest V3 with required permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'scripting']));
    expect(manifest.host_permissions).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
  });

  it('content_scripts js files exist on disk (for files defined so far)', () => {
    const known = ['src/shared/constants.js'];
    manifest.content_scripts[0].js
      .filter((f) => known.includes(f))
      .forEach((f) => expect(existsSync(`${root}${f}`)).toBe(true));
    expect(manifest.content_scripts[0].js[manifest.content_scripts[0].js.length - 1])
      .toBe('src/content/main.js');
  });

  it('background service worker is an ESM module', () => {
    expect(manifest.background.type).toBe('module');
  });
});

describe('EXT_CONSTANTS', () => {
  it('message types are unique non-empty strings', () => {
    const values = Object.values(C.MSG);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    values.forEach((v) => expect(typeof v).toBe('string'));
  });

  it('defaults target language to zh-CN and has batch limits', () => {
    expect(C.DEFAULT_CONFIG.targetLang).toBe('zh-CN');
    expect(C.BATCH_MAX_ITEMS).toBeGreaterThan(0);
    expect(C.BATCH_MAX_CHARS).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 6: 运行测试确认通过(本 Task 是基础结构,直接应绿)**

Run: `npx vitest run test/manifest.test.js`
Expected: `Test Files 1 passed`。若失败按报错修正。

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.js .gitignore manifest.json src/shared/constants.js test/manifest.test.js
git commit -m "chore: scaffold MV3 extension with manifest and constants"
```

---

### Task 2: 批切分与 LLM payload 解析 (src/shared/batch.js)

**Files:**
- Create: `src/shared/batch.js`
- Test: `test/batch.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import '../src/shared/batch.js';

const { splitIntoBatches, buildPayload, parseResponse } = globalThis.Ext.batch;

describe('splitIntoBatches', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoBatches([], 50, 2000)).toEqual([]);
  });

  it('splits by maxChars boundary', () => {
    const items = [
      { id: 'a', text: 'x'.repeat(900) },
      { id: 'b', text: 'y'.repeat(900) },
      { id: 'c', text: 'z'.repeat(900) }
    ];
    const batches = splitIntoBatches(items, 50, 2000);
    expect(batches.length).toBe(2);
    expect(batches[0].map((i) => i.id)).toEqual(['a', 'b']);
    expect(batches[1].map((i) => i.id)).toEqual(['c']);
  });

  it('splits by maxItems boundary', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, text: 'a' }));
    const batches = splitIntoBatches(items, 50, 2000);
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBe(50);
    expect(batches[1].length).toBe(10);
  });

  it('keeps an oversized single item as its own batch', () => {
    const items = [{ id: 'big', text: 'x'.repeat(5000) }];
    const batches = splitIntoBatches(items, 50, 2000);
    expect(batches.length).toBe(1);
    expect(batches[0][0].id).toBe('big');
  });
});

describe('buildPayload', () => {
  it('maps batch items to a JSON object keyed by index', () => {
    expect(buildPayload([{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }]))
      .toEqual({ '0': 'Hello', '1': 'World' });
  });
});

describe('parseResponse', () => {
  it('parses a plain JSON object', () => {
    expect(parseResponse('{"0":"你好"}')).toEqual({ '0': '你好' });
  });

  it('strips markdown code fences', () => {
    expect(parseResponse('```json\n{"0":"你好"}\n```')).toEqual({ '0': '你好' });
    expect(parseResponse('```\n{"0":"你好"}\n```')).toEqual({ '0': '你好' });
  });

  it('throws on non-JSON and non-object payloads', () => {
    expect(() => parseResponse('not json')).toThrow();
    expect(() => parseResponse('["a"]')).toThrow();
    expect(() => parseResponse('null')).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/batch.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'batch')`(globalThis.Ext.batch 尚不存在)。

- [ ] **Step 3: 实现 src/shared/batch.js**

```js
(function (global) {
  'use strict';

  function splitIntoBatches(items, maxItems, maxChars) {
    const batches = [];
    let current = [];
    let chars = 0;
    (items || []).forEach((item) => {
      const len = String(item.text || '').length;
      if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
        batches.push(current);
        current = [];
        chars = 0;
      }
      current.push(item);
      chars += len;
    });
    if (current.length > 0) batches.push(current);
    return batches;
  }

  function buildPayload(batch) {
    const payload = {};
    (batch || []).forEach((item, i) => { payload[String(i)] = item.text; });
    return payload;
  }

  function parseResponse(raw) {
    let text = String(raw == null ? '' : raw).trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    if (fence) text = fence[1].trim();
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LLM response is not a JSON object');
    }
    return parsed;
  }

  const ExtBatch = { splitIntoBatches, buildPayload, parseResponse };
  global.Ext = global.Ext || {};
  global.Ext.batch = ExtBatch;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtBatch;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/batch.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/shared/batch.js test/batch.test.js
git commit -m "feat: batch splitting and LLM payload parsing"
```

---

### Task 3: 翻译缓存 (src/shared/cache.js)

**Files:**
- Create: `src/shared/cache.js`
- Test: `test/cache.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
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
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/cache.test.js`
Expected: FAIL — `globalThis.Ext.cache` 未定义。

- [ ] **Step 3: 实现 src/shared/cache.js**

```js
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/cache.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/shared/cache.js test/cache.test.js
git commit -m "feat: translation cache with hash keys and pluggable backends"
```

---

### Task 4: OpenAI 兼容请求构建 (src/background/llm.js)

**Files:**
- Create: `src/background/llm.js`
- Test: `test/llm.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/background/llm.js';

const Llm = globalThis.Ext.llm;
const config = { baseUrl: 'https://api.test/v1/', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('joinUrl', () => {
  it('joins base and path trimming trailing slashes', () => {
    expect(Llm.joinUrl('https://api.test/v1/', '/chat/completions')).toBe('https://api.test/v1/chat/completions');
    expect(Llm.joinUrl('https://api.test/v1', '/chat/completions')).toBe('https://api.test/v1/chat/completions');
  });
});

describe('buildRequestBody', () => {
  it('contains model, zero temperature and translated system prompt', () => {
    const body = Llm.buildRequestBody(config, { '0': 'Hello' });
    expect(body.model).toBe('m1');
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('zh-CN');
    expect(body.messages[1].role).toBe('user');
    expect(JSON.parse(body.messages[1].content)).toEqual({ '0': 'Hello' });
  });
});

describe('extractContent', () => {
  it('extracts choices[0].message.content', () => {
    expect(Llm.extractContent({ choices: [{ message: { content: '{"0":"你好"}' } }] })).toBe('{"0":"你好"}');
  });
  it('throws on unexpected shape', () => {
    expect(() => Llm.extractContent({})).toThrow();
    expect(() => Llm.extractContent(null)).toThrow();
  });
});

describe('translateViaLlm', () => {
  it('posts to base/chat/completions with bearer auth and returns content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"0":"你好"}' } }] }),
      text: async () => ''
    });
    const raw = await Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl);
    expect(raw).toBe('{"0":"你好"}');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('throws with HTTP status and body excerpt on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    await expect(Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl)).rejects.toThrow('LLM API HTTP 401');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/llm.test.js`
Expected: FAIL — `globalThis.Ext.llm` 未定义。

- [ ] **Step 3: 实现 src/background/llm.js**

```js
(function (global) {
  'use strict';

  function joinUrl(base, path) {
    return String(base || '').replace(/\/+$/, '') + path;
  }

  function systemPrompt(targetLang) {
    return [
      'You are a translation engine. Translate every value of the user JSON object into ' + targetLang + '.',
      'Rules: translate ALL values; keep the same JSON keys; keep numbers, URLs, code identifiers and placeholders unchanged;',
      'respond with ONLY the JSON object, no explanations, no markdown fences.'
    ].join(' ');
  }

  function buildRequestBody(config, payload) {
    return {
      model: config.model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt(config.targetLang) },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    };
  }

  function extractContent(apiResponse) {
    const choice = apiResponse && apiResponse.choices && apiResponse.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (typeof content !== 'string') throw new Error('Unexpected LLM API response shape');
    return content;
  }

  async function safeErrorText(res) {
    try { return await res.text(); } catch (e) { return ''; }
  }

  async function translateViaLlm(config, payload, fetchImpl) {
    const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
    const url = joinUrl(config.baseUrl, '/chat/completions');
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify(buildRequestBody(config, payload))
    });
    if (!res.ok) {
      const detail = await safeErrorText(res);
      throw new Error('LLM API HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
    }
    const data = await res.json();
    return extractContent(data);
  }

  const ExtLlm = { joinUrl, systemPrompt, buildRequestBody, extractContent, translateViaLlm };
  global.Ext = global.Ext || {};
  global.Ext.llm = ExtLlm;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtLlm;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/llm.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/background/llm.js test/llm.test.js
git commit -m "feat: OpenAI-compatible LLM request builder"
```

---

### Task 5: background service worker(消息路由 + 缓存 + 重试)

**Files:**
- Create: `src/background/service-worker.js`
- Test: `test/sw.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/cache.js';
import '../src/background/service-worker.js';

const C = globalThis.EXT_CONSTANTS;
const Cache = globalThis.Ext.cache;
const makeMessageHandler = globalThis.Ext.sw.makeMessageHandler;

function makeDeps() {
  const store = new Map();
  store.set(C.STORAGE_KEYS.CONFIG, {
    baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN'
  });
  const configStorage = {
    get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {})
  };
  const cacheBackend = Cache.memoryBackend();
  const fetchCalls = [];
  const okJson = (obj) => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(obj) } }] }), text: async () => '' });
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return okJson({ '0': '你好' });
  };
  const deps = {
    configStorage,
    cacheBackend,
    fetchImpl,
    detectLanguage: async () => 'en',
    sleep: async () => {}
  };
  return { deps, fetchCalls, cacheBackend, okJson };
}

describe('TRANSLATE_BATCH', () => {
  it('serves fully-cached items without calling the LLM', async () => {
    const { deps, fetchCalls, cacheBackend } = makeDeps();
    await Cache.putMany(cacheBackend, 'zh-CN', [{ src: 'Hello', dst: '你好' }]);
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res).toEqual({ ok: true, translations: { a: '你好' } });
    expect(fetchCalls.length).toBe(0);
  });

  it('translates misses, backfills and writes the cache', async () => {
    const { deps, fetchCalls, cacheBackend } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(true);
    expect(res.translations.a).toBe('你好');
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].opts.headers.Authorization).toBe('Bearer sk-test');
    const again = await Cache.getMany(cacheBackend, 'zh-CN', ['Hello']);
    expect(again.get('Hello')).toBe('你好');
  });

  it('dedupes identical texts within one batch request', async () => {
    const { deps, fetchCalls } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({
      type: C.MSG.TRANSLATE_BATCH,
      items: [{ id: 'a', text: 'Hello' }, { id: 'b', text: 'Hello' }],
      targetLang: 'zh-CN'
    });
    expect(res.translations).toEqual({ a: '你好', b: '你好' });
    expect(fetchCalls.length).toBe(1);
  });

  it('retries failed requests twice before succeeding', async () => {
    const { deps, fetchCalls } = makeDeps();
    let n = 0;
    deps.fetchImpl = async () => {
      n += 1;
      if (n <= 2) return { ok: false, status: 500, text: async () => 'boom' };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"0":"你好"}' } }] }), text: async () => '' };
    };
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(true);
    expect(n).toBe(3);
  });

  it('returns ok:false when the LLM answer is unparseable', async () => {
    const { deps } = makeDeps();
    deps.fetchImpl = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not json' } }] }), text: async () => '' });
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TRANSLATE_BATCH, items: [{ id: 'a', text: 'Hello' }], targetLang: 'zh-CN' });
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});

describe('DETECT_LANGUAGE / TEST_CONNECTION', () => {
  it('returns detected language', async () => {
    const { deps } = makeDeps();
    const handler = makeMessageHandler(deps);
    expect(await handler({ type: C.MSG.DETECT_LANGUAGE, text: 'hello world' })).toEqual({ ok: true, language: 'en' });
  });

  it('tests connection with the provided config without reading storage', async () => {
    const { deps, fetchCalls } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: C.MSG.TEST_CONNECTION, config: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', targetLang: 'zh-CN' } });
    expect(res.ok).toBe(true);
    expect(typeof res.sample).toBe('string');
    expect(fetchCalls.length).toBe(1);
  });

  it('rejects unknown message types with ok:false', async () => {
    const { deps } = makeDeps();
    const handler = makeMessageHandler(deps);
    const res = await handler({ type: 'NOPE' });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/sw.test.js`
Expected: FAIL — `globalThis.Ext.sw` 未定义。

- [ ] **Step 3: 实现 src/background/service-worker.js**

```js
import '../shared/constants.js';
import '../shared/batch.js';
import '../shared/cache.js';
import './llm.js';

const C = globalThis.EXT_CONSTANTS;
const Batch = globalThis.Ext.batch;
const Cache = globalThis.Ext.cache;
const Llm = globalThis.Ext.llm;

function chromeStorage() { return chrome.storage.local; }

function defaultConfigStorage() {
  return { get: (key) => chromeStorage().get(key) };
}

function defaultCacheBackend() {
  return Cache.chromeStorageBackend(chromeStorage());
}

function detectLanguageViaChrome(text) {
  return new Promise((resolve, reject) => {
    if (typeof chrome === 'undefined' || !chrome.i18n || !chrome.i18n.detectLanguage) {
      reject(new Error('chrome.i18n.detectLanguage is unavailable'));
      return;
    }
    chrome.i18n.detectLanguage(text, (result) => {
      const err = chrome.runtime.lastError;
      if (err) { reject(new Error(err.message)); return; }
      const langs = (result && result.languages) || [];
      if (!langs.length) { reject(new Error('No language detected')); return; }
      resolve(langs[0].language);
    });
  });
}

async function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withRetry(fn, retries, sleepFn) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleepFn(1000 * Math.pow(2, attempt));
      attempt += 1;
    }
  }
}

async function loadConfig(configStorage) {
  const data = await configStorage.get(C.STORAGE_KEYS.CONFIG);
  const stored = data && data[C.STORAGE_KEYS.CONFIG];
  return Object.assign({}, C.DEFAULT_CONFIG, stored || {});
}

async function handleTranslateBatch(msg, deps) {
  const config = await loadConfig(deps.configStorage);
  if (!config.apiKey) {
    return { ok: false, error: 'API key is not configured. Open the extension options page.' };
  }
  const items = msg.items || [];
  if (!items.length) return { ok: true, translations: {} };
  const targetLang = msg.targetLang || config.targetLang;

  const texts = items.map((i) => i.text);
  const cached = await Cache.getMany(deps.cacheBackend, targetLang, texts);
  const translations = {};
  items.forEach((item) => {
    const hit = cached.get(item.text);
    if (typeof hit === 'string') translations[item.id] = hit;
  });

  // 去重:相同 text 只请求一次,响应后回填所有同文 id
  const idsByText = new Map();
  items.forEach((item) => {
    if (item.id in translations) return;
    const arr = idsByText.get(item.text) || [];
    arr.push(item.id);
    idsByText.set(item.text, arr);
  });
  const misses = [...idsByText.keys()].map((text, idx) => ({ id: 'm' + idx, text }));

  const requestConfig = Object.assign({}, config, { targetLang });
  const newPairs = [];
  const batches = Batch.splitIntoBatches(misses, C.BATCH_MAX_ITEMS, C.BATCH_MAX_CHARS);
  for (const batch of batches) {
    const payload = Batch.buildPayload(batch);
    const raw = await withRetry(() => Llm.translateViaLlm(requestConfig, payload, deps.fetchImpl), 2, deps.sleep);
    const parsed = Batch.parseResponse(raw);
    batch.forEach((item, idx) => {
      const t = parsed[String(idx)];
      if (typeof t !== 'string' || !t.length) return;
      (idsByText.get(item.text) || []).forEach((id) => { translations[id] = t; });
      newPairs.push({ src: item.text, dst: t });
    });
  }
  await Cache.putMany(deps.cacheBackend, targetLang, newPairs);
  return { ok: true, translations };
}

async function handleDetectLanguage(msg, deps) {
  try {
    const language = await deps.detectLanguage(String(msg.text || '').slice(0, 1000));
    return { ok: true, language };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

async function handleTestConnection(msg, deps) {
  const cfg = Object.assign({}, C.DEFAULT_CONFIG, msg.config || {});
  if (!cfg.apiKey) return { ok: false, error: 'API key is required.' };
  try {
    const raw = await Llm.translateViaLlm(cfg, { '0': 'Hello, world!' }, deps.fetchImpl);
    const parsed = Batch.parseResponse(raw);
    return { ok: true, sample: parsed['0'] || '' };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

export function makeMessageHandler(overrides) {
  const o = overrides || {};
  const deps = {
    configStorage: o.configStorage || defaultConfigStorage(),
    cacheBackend: o.cacheBackend || defaultCacheBackend(),
    fetchImpl: o.fetchImpl || ((url, opts) => fetch(url, opts)),
    detectLanguage: o.detectLanguage || detectLanguageViaChrome,
    sleep: o.sleep || sleep
  };
  return async function handleMessage(msg) {
    try {
      if (!msg || typeof msg.type !== 'string') return { ok: false, error: 'Unknown message' };
      switch (msg.type) {
        case C.MSG.TRANSLATE_BATCH:
          return await handleTranslateBatch(msg, deps);
        case C.MSG.DETECT_LANGUAGE:
          return await handleDetectLanguage(msg, deps);
        case C.MSG.TEST_CONNECTION:
          return await handleTestConnection(msg, deps);
        case C.MSG.TOGGLE:
          return { ok: true };
        default:
          return { ok: false, error: 'Unknown message type: ' + msg.type };
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  };
}

// ---- chrome 运行时接线(测试环境无 chrome 全局,自动跳过)----
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  const handler = makeMessageHandler();
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    handler(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步 sendResponse
  });
  if (chrome.action && chrome.action.onClicked) {
    const CONTENT_FILES = [
      'src/shared/constants.js',
      'src/shared/batch.js',
      'src/shared/cache.js',
      'src/content/detect.js',
      'src/content/collect.js',
      'src/content/apply.js',
      'src/content/observer.js',
      'src/content/main.js'
    ];
    chrome.action.onClicked.addListener((tab) => {
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: C.MSG.TOGGLE }).catch(() => {
        if (chrome.scripting && chrome.scripting.executeScript) {
          chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES }).catch(() => {});
        }
      });
    });
  }
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/sw.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/background/service-worker.js test/sw.test.js
git commit -m "feat: background service worker message handling with retry and cache"
```

---

### Task 6: 页面语言检测 (src/content/detect.js)

**Files:**
- Create: `src/content/detect.js`
- Test: `test/detect.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import '../src/content/detect.js';

const Detect = globalThis.Ext.detect;

describe('normalize', () => {
  it('accepts BCP-47 style tags and converts underscores', () => {
    expect(Detect.normalize('en')).toBe('en');
    expect(Detect.normalize('zh-CN')).toBe('zh-CN');
    expect(Detect.normalize('zh_CN')).toBe('zh-CN');
    expect(Detect.normalize('')).toBe(null);
    expect(Detect.normalize('not a lang!')).toBe(null);
  });
});

describe('pageLang', () => {
  it('reads documentElement lang attribute', () => {
    document.documentElement.setAttribute('lang', 'fr');
    expect(Detect.pageLang(document)).toBe('fr');
  });

  it('returns null when missing or invalid', () => {
    document.documentElement.removeAttribute('lang');
    expect(Detect.pageLang(document)).toBe(null);
    document.documentElement.setAttribute('lang', '???');
    expect(Detect.pageLang(document)).toBe(null);
    document.documentElement.removeAttribute('lang');
  });
});

describe('langMatches', () => {
  it('compares primary subtags only', () => {
    expect(Detect.langMatches('en', 'en-US')).toBe(true);
    expect(Detect.langMatches('en-US', 'en')).toBe(true);
    expect(Detect.langMatches('en', 'zh-CN')).toBe(false);
    expect(Detect.langMatches(null, 'zh-CN')).toBe(false);
  });
});

describe('sampleText', () => {
  it('collapses whitespace and truncates', () => {
    document.body.innerHTML = '<p>  Hello   world  </p><p>Second</p>';
    const sample = Detect.sampleText(document, 10);
    expect(sample).toBe('Hello worl');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/detect.test.js`
Expected: FAIL — `globalThis.Ext.detect` 未定义。

- [ ] **Step 3: 实现 src/content/detect.js**

```js
(function (global) {
  'use strict';
  const LANG_RE = /^[a-zA-Z]{2,3}([_-][a-zA-Z0-9]{1,8})*$/;

  function normalize(tag) {
    const t = String(tag || '').trim().replace('_', '-');
    if (!LANG_RE.test(t)) return null;
    return t;
  }

  function pageLang(doc) {
    const raw = doc && doc.documentElement ? doc.documentElement.getAttribute('lang') : '';
    return normalize(raw);
  }

  function langMatches(pageLangTag, targetLang) {
    const a = String(pageLangTag || '').toLowerCase().split('-')[0];
    const b = String(targetLang || '').toLowerCase().split('-')[0];
    return a !== '' && a === b;
  }

  function sampleText(doc, maxLen) {
    const limit = maxLen || 500;
    const raw = doc && doc.body ? doc.body.textContent : '';
    const compact = String(raw || '').replace(/\s+/g, ' ').trim();
    return compact.slice(0, limit);
  }

  const ExtDetect = { normalize, pageLang, langMatches, sampleText };
  global.Ext = global.Ext || {};
  global.Ext.detect = ExtDetect;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtDetect;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/detect.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/content/detect.js test/detect.test.js
git commit -m "feat: page language detection helpers"
```

---

### Task 7: DOM 收集与 skip 标记 (src/content/collect.js)

**Files:**
- Create: `src/content/collect.js`
- Test: `test/collect.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/content/collect.js';

const Collect = globalThis.Ext.collect;

beforeEach(() => { document.body.innerHTML = ''; });

describe('collect', () => {
  it('collects visible text nodes, excluding script/style/whitespace', () => {
    document.body.innerHTML = `
      <p>Hello world</p>
      <p>   </p>
      <script>var no = 'translate me';</script>
      <style>.x { content: 'nope' }</style>
      <pre>keep code</pre>
      <span>Second text</span>
    `;
    const items = Collect.collect(document, {});
    const texts = items.filter((i) => i.kind === 'text').map((i) => i.text);
    expect(texts).toContain('Hello world');
    expect(texts).toContain('Second text');
    expect(texts).not.toContain('translate me');
    expect(texts).not.toContain('keep code');
    expect(items.every((i) => i.id && i.id.length > 0)).toBe(true);
  });

  it('collects translatable attributes', () => {
    document.body.innerHTML = `
      <input placeholder="Type your name">
      <a href="/x" title="Read more">link</a>
      <div aria-label="Close menu"></div>
      <img src="a.png" alt="A red apple">
      <input placeholder="12345">
      <img src="b.png" alt="">
    `;
    const items = Collect.collect(document, {});
    const attrs = items.filter((i) => i.kind === 'attr').map((i) => i.attr);
    expect(attrs).toContain('placeholder');
    expect(attrs).toContain('title');
    expect(attrs).toContain('aria-label');
    expect(attrs).toContain('alt');
    // 纯数字与空属性不收
    expect(items.filter((i) => i.kind === 'attr' && i.text === '12345').length).toBe(0);
  });

  it('assigns unique ids', () => {
    document.body.innerHTML = '<p>a</p><p>b</p><input title="c">';
    const items = Collect.collect(document, {});
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('skips nodes marked in the skip map, per key', () => {
    document.body.innerHTML = '<p>First</p><input title="Tip"><input placeholder="Fill">';
    const skip = Collect.makeSkipMap();
    const first = Collect.collect(document, { skip });
    expect(first.length).toBe(3);
    // 标记文本节点 + input 的 title(不影响 placeholder)
    Collect.markSkipped(skip, first[0].node, 'text');
    Collect.markSkipped(skip, first[1].node, 'attr:title');
    const second = Collect.collect(document, { skip });
    expect(second.map((i) => i.text)).toEqual(['Fill']);
    Collect.unmarkSkipped(skip, first[1].node, 'attr:title');
    expect(Collect.collect(document, { skip }).map((i) => i.text)).toEqual(['Tip', 'Fill']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/collect.test.js`
Expected: FAIL — `globalThis.Ext.collect` 未定义。

- [ ] **Step 3: 实现 src/content/collect.js**

```js
(function (global) {
  'use strict';

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA',
    'CODE', 'PRE', 'KBD', 'SAMP', 'IFRAME'
  ]);
  const ATTR_NAMES = ['placeholder', 'title', 'aria-label', 'alt'];
  const ATTR_SELECTOR = 'input[placeholder], textarea[placeholder], [title], [aria-label], img[alt]';
  // DOM NodeFilter 数值常量(避免依赖全局 NodeFilter):SHOW_TEXT=4, ACCEPT=1, REJECT=2
  const SHOW_TEXT = 4;
  const FILTER_ACCEPT = 1;
  const FILTER_REJECT = 2;

  function makeSkipMap() { return new WeakMap(); }

  function skipKey(kind, attr) { return kind === 'text' ? 'text' : 'attr:' + attr; }

  function isSkipped(map, node, key) {
    const s = map.get(node);
    return !!(s && s.has(key));
  }

  function markSkipped(map, node, key) {
    let s = map.get(node);
    if (!s) { s = new Set(); map.set(node, s); }
    s.add(key);
  }

  function unmarkSkipped(map, node, key) {
    const s = map.get(node);
    if (!s) return;
    s.delete(key);
    if (!s.size) map.delete(node);
  }

  function collect(root, options) {
    const skipMap = options && options.skip;
    const doc = root.nodeType === 9 ? root : root.ownerDocument;
    const scope = root.nodeType === 9 ? (root.body || root.documentElement) : root;
    const items = [];

    if (doc && scope) {
      const walker = doc.createTreeWalker(scope, SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent) return FILTER_REJECT;
          if (SKIP_TAGS.has(parent.tagName)) return FILTER_REJECT;
          if (!node.nodeValue || !node.nodeValue.trim()) return FILTER_REJECT;
          if (skipMap && isSkipped(skipMap, node, 'text')) return FILTER_REJECT;
          return FILTER_ACCEPT;
        }
      });
      while (walker.nextNode()) {
        const node = walker.currentNode;
        items.push({ node, kind: 'text', attr: null, text: node.nodeValue.trim() });
      }
    }

    if (doc) {
      const attrScope = root.nodeType === 9 ? doc : root;
      attrScope.querySelectorAll(ATTR_SELECTOR).forEach((el) => {
        if (SKIP_TAGS.has(el.tagName)) return;
        ATTR_NAMES.forEach((name) => {
          if (!el.hasAttribute(name)) return;
          const value = el.getAttribute(name) || '';
          if (!value.trim() || !/\p{L}/u.test(value)) return;
          const key = skipKey('attr', name);
          if (skipMap && isSkipped(skipMap, el, key)) return;
          items.push({ node: el, kind: 'attr', attr: name, text: value.trim() });
        });
      });
    }

    items.forEach((item, i) => { item.id = 'i' + i; });
    return items;
  }

  const ExtCollect = { makeSkipMap, skipKey, isSkipped, markSkipped, unmarkSkipped, collect };
  global.Ext = global.Ext || {};
  global.Ext.collect = ExtCollect;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtCollect;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/collect.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/content/collect.js test/collect.test.js
git commit -m "feat: DOM text node and attribute collection with skip map"
```

---

### Task 8: 替换与还原 (src/content/apply.js)

**Files:**
- Create: `src/content/apply.js`
- Test: `test/apply.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/content/apply.js';

const Apply = globalThis.Ext.apply;

beforeEach(() => { document.body.innerHTML = ''; });

describe('applyTranslations', () => {
  it('replaces text node values, preserving surrounding whitespace', () => {
    const node = document.createTextNode('  Hello  ');
    document.body.appendChild(node);
    const records = Apply.applyTranslations(
      [{ id: 'a', node, kind: 'text', attr: null, text: 'Hello' }],
      { a: '你好' }
    );
    expect(node.nodeValue).toBe('  你好  ');
    expect(records.length).toBe(1);
    expect(records[0].original).toBe('  Hello  ');
  });

  it('replaces attribute values', () => {
    const el = document.createElement('input');
    el.setAttribute('placeholder', 'Search here');
    document.body.appendChild(el);
    const records = Apply.applyTranslations(
      [{ id: 'b', node: el, kind: 'attr', attr: 'placeholder', text: 'Search here' }],
      { b: '搜索' }
    );
    expect(el.getAttribute('placeholder')).toBe('搜索');
    expect(records[0].original).toBe('Search here');
  });

  it('ignores missing translations and identical texts', () => {
    const node = document.createTextNode('Same');
    document.body.appendChild(node);
    const records = Apply.applyTranslations(
      [
        { id: 'x', node, kind: 'text', attr: null, text: 'Same' },
        { id: 'y', node, kind: 'text', attr: null, text: 'Same' }
      ],
      { x: 'Same', y: 'Other' }
    );
    expect(records.map((r) => r.id)).toEqual(['y']);
  });
});

describe('restoreAll', () => {
  it('restores originals in reverse order', () => {
    const n1 = document.createTextNode('One');
    const el = document.createElement('input');
    el.setAttribute('title', 'Title');
    document.body.appendChild(n1);
    document.body.appendChild(el);
    const records = [
      ...Apply.applyTranslations([{ id: 'a', node: n1, kind: 'text', attr: null, text: 'One' }], { a: '一' }),
      ...Apply.applyTranslations([{ id: 'b', node: el, kind: 'attr', attr: 'title', text: 'Title' }], { b: '标题' })
    ];
    Apply.restoreAll(records);
    expect(n1.nodeValue).toBe('One');
    expect(el.getAttribute('title')).toBe('Title');
  });

  it('does not throw for detached nodes', () => {
    const detached = document.createTextNode('gone');
    Apply.restoreAll([{ id: 'd', node: detached, kind: 'text', attr: null, original: 'gone', translated: '没了' }]);
    expect(detached.nodeValue).toBe('gone');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/apply.test.js`
Expected: FAIL — `globalThis.Ext.apply` 未定义。

- [ ] **Step 3: 实现 src/content/apply.js**

```js
(function (global) {
  'use strict';

  function applyTranslations(items, translations) {
    const records = [];
    (items || []).forEach((item) => {
      const t = translations ? translations[item.id] : undefined;
      if (typeof t !== 'string' || !t.length || t === item.text) return;
      const node = item.node;
      if (!node) return;
      try {
        if (item.kind === 'text' && node.nodeType === 3) {
          const original = node.nodeValue;
          if (original == null || !original.includes(item.text)) return;
          node.nodeValue = original === item.text ? t : original.replace(item.text, t);
          records.push({ id: item.id, node, kind: 'text', attr: null, original, translated: t });
        } else if (item.kind === 'attr' && typeof node.setAttribute === 'function') {
          const original = node.getAttribute(item.attr);
          if (original == null) return;
          node.setAttribute(item.attr, t);
          records.push({ id: item.id, node, kind: 'attr', attr: item.attr, original, translated: t });
        }
      } catch (e) { /* 单点失败不影响其余节点 */ }
    });
    return records;
  }

  function restoreAll(records) {
    (records || []).slice().reverse().forEach((r) => {
      try {
        if (r.kind === 'text' && r.node.nodeType === 3) r.node.nodeValue = r.original;
        else if (r.kind === 'attr' && typeof r.node.setAttribute === 'function') {
          r.node.setAttribute(r.attr, r.original);
        }
      } catch (e) { /* 节点已脱离文档;忽略 */ }
    });
  }

  const ExtApply = { applyTranslations, restoreAll };
  global.Ext = global.Ext || {};
  global.Ext.apply = ExtApply;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtApply;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/apply.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/content/apply.js test/apply.test.js
git commit -m "feat: apply and restore translations on DOM"
```

---

### Task 9: 防抖 MutationObserver (src/content/observer.js)

**Files:**
- Create: `src/content/observer.js`
- Test: `test/observer.test.js`

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../src/content/observer.js';

const Observer = globalThis.Ext.observer;

beforeEach(() => { document.body.innerHTML = ''; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('start', () => {
  it('debounces a burst of mutations into one callback', async () => {
    const calls = [];
    const handle = Observer.start(document.body, { debounceMs: 500, onNewNodes: (roots) => calls.push(roots) });
    const div = document.createElement('div');
    document.body.appendChild(div);
    div.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(499);
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(1);
    // 回调给出新增子树根
    expect(calls[0].some((n) => n === div)).toBe(true);
    handle.stop();
  });

  it('reports characterData changes as their parent element', async () => {
    const p = document.createElement('p');
    p.textContent = 'seed';
    document.body.appendChild(p);
    const calls = [];
    const handle = Observer.start(document.body, { debounceMs: 100, onNewNodes: (roots) => calls.push(roots) });
    p.firstChild.nodeValue = 'changed';
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(p);
    handle.stop();
  });

  it('stop() prevents further callbacks', async () => {
    const calls = [];
    const handle = Observer.start(document.body, { debounceMs: 100, onNewNodes: (roots) => calls.push(roots) });
    handle.stop();
    document.body.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/observer.test.js`
Expected: FAIL — `globalThis.Ext.observer` 未定义。

- [ ] **Step 3: 实现 src/content/observer.js**

```js
(function (global) {
  'use strict';

  function start(root, options) {
    const debounceMs = (options && options.debounceMs) || 500;
    const onNewNodes = options && options.onNewNodes;
    let timer = null;
    let pending = new Set();

    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'childList') {
          m.addedNodes.forEach((n) => {
            if (n.nodeType === 1) pending.add(n);
            else if (n.nodeType === 3 && n.parentElement) pending.add(n.parentElement);
          });
        } else if (m.type === 'characterData' && m.target.parentElement) {
          pending.add(m.target.parentElement);
        }
      }
      if (pending.size && timer === null) {
        timer = setTimeout(() => {
          timer = null;
          const roots = Array.from(pending);
          pending = new Set();
          onNewNodes(roots);
        }, debounceMs);
      }
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });

    return {
      stop() {
        mo.disconnect();
        if (timer !== null) { clearTimeout(timer); timer = null; }
      }
    };
  }

  const ExtObserver = { start };
  global.Ext = global.Ext || {};
  global.Ext.observer = ExtObserver;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtObserver;
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run test/observer.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/content/observer.js test/observer.test.js
git commit -m "feat: debounced MutationObserver for dynamic content"
```

---

### Task 10: options 配置页

**Files:**
- Create: `src/options/options.html`, `src/options/options.js`, `src/options/options.css`
- Test: `test/options.test.js`

- [ ] **Step 1: 写失败测试(纯函数与表单转换)**

```js
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/options/options.js';

const Options = globalThis.Ext.options;

beforeEach(() => {
  document.body.innerHTML = `
    <form id="f">
      <input name="baseUrl"><input name="apiKey"><input name="model">
      <select name="targetLang"><option value="zh-CN">简体中文</option><option value="en">English</option></select>
    </form>`;
});

function form() { return document.getElementById('f'); }

describe('validateConfig', () => {
  it('passes when all fields present', () => {
    expect(Options.validateConfig({ baseUrl: 'https://x', apiKey: 'k', model: 'm', targetLang: 'zh-CN' }))
      .toEqual({ ok: true, missing: [] });
  });
  it('lists missing fields', () => {
    const v = Options.validateConfig({ baseUrl: '', apiKey: '', model: '', targetLang: '' });
    expect(v.ok).toBe(false);
    expect(v.missing).toEqual(['baseUrl', 'apiKey', 'model', 'targetLang']);
  });
});

describe('configFromForm / fillForm round-trip', () => {
  it('reads fields into a config and back', () => {
    const f = form();
    f.elements.baseUrl.value = 'https://api.test/v1';
    f.elements.apiKey.value = 'sk-1';
    f.elements.model.value = 'm1';
    f.elements.targetLang.value = 'en';
    const cfg = Options.configFromForm(f);
    expect(cfg).toEqual({ baseUrl: 'https://api.test/v1', apiKey: 'sk-1', model: 'm1', targetLang: 'en' });
    f.elements.baseUrl.value = '';
    f.elements.apiKey.value = '';
    f.elements.model.value = '';
    f.elements.targetLang.value = 'zh-CN';
    Options.fillForm(f, cfg);
    expect(f.elements.baseUrl.value).toBe('https://api.test/v1');
    expect(f.elements.targetLang.value).toBe('en');
  });
});

describe('saveConfigFrom', () => {
  it('rejects invalid config without writing storage', async () => {
    const writes = [];
    const storage = { set: async (obj) => writes.push(obj) };
    const res = await Options.saveConfigFrom(form(), storage);
    expect(res.ok).toBe(false);
    expect(writes.length).toBe(0);
  });

  it('writes valid config under STORAGE_KEYS.CONFIG', async () => {
    const writes = [];
    const storage = { set: async (obj) => writes.push(obj) };
    const f = form();
    f.elements.baseUrl.value = 'https://api.test/v1';
    f.elements.apiKey.value = 'sk-1';
    f.elements.model.value = 'm1';
    f.elements.targetLang.value = 'zh-CN';
    const res = await Options.saveConfigFrom(f, storage);
    expect(res.ok).toBe(true);
    expect(writes[0].config.apiKey).toBe('sk-1');
  });
});

describe('wirePage', () => {
  it('loads saved config into the form and test button shows result', async () => {
    document.body.innerHTML += `
      <button id="save"></button><button id="test"></button><span id="status"></span>`;
    const saved = { config: { baseUrl: 'https://saved/v1', apiKey: 'sk-saved', model: 'm-saved', targetLang: 'en' } };
    const storage = {
      get: async (k) => (saved[k] ? { [k]: saved[k] } : {}),
      set: async () => {}
    };
    const runtime = { sendMessage: async () => ({ ok: true, sample: '你好' }) };
    const f = form();
    Options.wirePage(document, storage, runtime);
    // loadConfigInto 由 wirePage 内部触发,表单应已填充
    await Options.loadConfigInto(f, storage);
    expect(f.elements.baseUrl.value).toBe('https://saved/v1');
    expect(f.elements.targetLang.value).toBe('en');
    document.getElementById('test').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.getElementById('status').textContent).toContain('OK');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run test/options.test.js`
Expected: FAIL — `globalThis.Ext.options` 未定义。

- [ ] **Step 3: 写 src/options/options.html 与 options.css**

`options.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>LLM Page Translator — Settings</title>
  <link rel="stylesheet" href="options.css">
</head>
<body>
  <h1>LLM Page Translator</h1>
  <form id="options-form">
    <label>API Base URL
      <input name="baseUrl" type="url" placeholder="https://api.openai.com/v1" required>
    </label>
    <label>API Key
      <input name="apiKey" type="password" autocomplete="off" required>
    </label>
    <label>Model
      <input name="model" type="text" placeholder="gpt-4o-mini" required>
    </label>
    <label>Target language
      <select name="targetLang">
        <option value="zh-CN">简体中文</option>
        <option value="zh-TW">繁體中文</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
        <option value="ko">한국어</option>
        <option value="de">Deutsch</option>
        <option value="fr">Français</option>
        <option value="es">Español</option>
        <option value="ru">Русский</option>
      </select>
    </label>
    <div class="actions">
      <button type="submit" id="save">Save</button>
      <button type="button" id="test">Test connection</button>
      <span id="status"></span>
    </div>
  </form>
  <p class="hint">Works with any OpenAI-compatible /chat/completions endpoint (OpenAI, DeepSeek, Qwen, Ollama…). The key is stored only in your browser (chrome.storage.local).</p>
  <script src="options.js"></script>
</body>
</html>
```

`options.css`:

```css
body { font-family: system-ui, sans-serif; margin: 24px auto; max-width: 480px; }
label { display: block; margin: 12px 0; }
input, select { display: block; width: 100%; box-sizing: border-box; padding: 6px; margin-top: 4px; }
.actions { display: flex; gap: 8px; align-items: center; margin-top: 16px; }
#status.ok { color: #0a7a0a; }
#status.error { color: #b00020; }
.hint { color: #666; font-size: 13px; }
```

- [ ] **Step 4: 实现 src/options/options.js**

```js
(function (global) {
  'use strict';
  const C = global.EXT_CONSTANTS;
  const FIELDS = ['baseUrl', 'apiKey', 'model', 'targetLang'];

  function configFromForm(form) {
    const cfg = {};
    FIELDS.forEach((name) => { cfg[name] = String(form.elements[name].value || '').trim(); });
    return cfg;
  }

  function fillForm(form, cfg) {
    FIELDS.forEach((name) => {
      if (form.elements[name]) form.elements[name].value = (cfg && cfg[name]) || '';
    });
  }

  function validateConfig(cfg) {
    const missing = FIELDS.filter((name) => !cfg || !cfg[name]);
    return { ok: missing.length === 0, missing };
  }

  async function loadConfigInto(form, storage) {
    const data = await storage.get(C.STORAGE_KEYS.CONFIG);
    fillForm(form, (data && data[C.STORAGE_KEYS.CONFIG]) || {});
  }

  async function saveConfigFrom(form, storage) {
    const cfg = configFromForm(form);
    const v = validateConfig(cfg);
    if (!v.ok) return v;
    const obj = {};
    obj[C.STORAGE_KEYS.CONFIG] = cfg;
    await storage.set(obj);
    return v;
  }

  function setStatus(status, text, cls) {
    status.textContent = text;
    status.className = cls || '';
  }

  function wirePage(doc, storage, runtime) {
    const form = doc.getElementById('options-form');
    const status = doc.getElementById('status');
    const missingMsg = (v) => 'Missing: ' + v.missing.join(', ');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = validateConfig(configFromForm(form));
      if (!v.ok) { setStatus(status, missingMsg(v), 'error'); return; }
      await saveConfigFrom(form, storage);
      setStatus(status, 'Saved ✓', 'ok');
    });

    doc.getElementById('test').addEventListener('click', async () => {
      const cfg = configFromForm(form);
      const v = validateConfig(cfg);
      if (!v.ok) { setStatus(status, missingMsg(v), 'error'); return; }
      setStatus(status, 'Testing…', '');
      try {
        const res = await runtime.sendMessage({ type: C.MSG.TEST_CONNECTION, config: cfg });
        if (res && res.ok) setStatus(status, 'OK ✓ sample: ' + res.sample, 'ok');
        else setStatus(status, 'Failed: ' + ((res && res.error) || 'unknown'), 'error');
      } catch (err) {
        setStatus(status, 'Failed: ' + err.message, 'error');
      }
    });

    loadConfigInto(form, storage);
  }

  const api = { FIELDS, configFromForm, fillForm, validateConfig, loadConfigInto, saveConfigFrom, wirePage };
  global.Ext = global.Ext || {};
  global.Ext.options = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.storage) {
    document.addEventListener('DOMContentLoaded', () => wirePage(document, chrome.storage.local, chrome.runtime));
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
```

注意:wrapper 里 `C = global.EXT_CONSTANTS` 依赖 constants.js 先加载;options 页 HTML 里 options.js 单独引用,页面无 constants.js!修正:`options.html` 中在 `<script src="options.js">` 之前加 `<script src="../shared/constants.js"></script>`。测试文件里也已先 import constants ✓。**执行时在 options.html 的 script 处写两行**:

```html
  <script src="../shared/constants.js"></script>
  <script src="options.js"></script>
```

- [ ] **Step 5: 运行确认通过**

Run: `npx vitest run test/options.test.js`
Expected: `Test Files 1 passed`

- [ ] **Step 6: Commit**

```bash
git add src/options/options.html src/options/options.js src/options/options.css test/options.test.js
git commit -m "feat: options page for API configuration"
```

---

### Task 11: content 编排入口 (main.js) + 手动端到端验收

**Files:**
- Create: `src/content/main.js`

- [ ] **Step 1: 实现 src/content/main.js(薄编排层,不写单测,由 Task 12 手动验收覆盖)**

```js
(function () {
  'use strict';
  const C = globalThis.EXT_CONSTANTS;
  const Collect = globalThis.Ext.collect;
  const Apply = globalThis.Ext.apply;
  const Detect = globalThis.Ext.detect;
  const Obs = globalThis.Ext.observer;

  let skipMap = new WeakMap();
  let applied = [];
  let translating = false;
  let active = false;
  let observerHandle = null;

  function send(msg) {
    return chrome.runtime.sendMessage(msg).then((res) => {
      if (!res) throw new Error('No response from background');
      if (!res.ok) throw new Error(res.error || 'Background error');
      return res;
    });
  }

  async function loadTargetLang() {
    const data = await chrome.storage.local.get(C.STORAGE_KEYS.CONFIG);
    const cfg = Object.assign({}, C.DEFAULT_CONFIG, (data && data[C.STORAGE_KEYS.CONFIG]) || {});
    return cfg.targetLang;
  }

  async function resolvePageLang(targetLang) {
    let lang = Detect.pageLang(document);
    if (!lang) {
      try {
        const res = await send({ type: C.MSG.DETECT_LANGUAGE, text: Detect.sampleText(document) });
        lang = res.language;
      } catch (e) { lang = null; }
    }
    return { same: !!(lang && Detect.langMatches(lang, targetLang)), lang };
  }

  function keyOf(rec) { return Collect.skipKey(rec.kind, rec.attr); }

  async function translateRoots(roots, targetLang) {
    const items = [];
    roots.forEach((root) => {
      if (root && root.nodeType === 1 || root.nodeType === 9) {
        items.push(...Collect.collect(root, { skip: skipMap }));
      }
    });
    if (!items.length) return 0;
    const res = await send({
      type: C.MSG.TRANSLATE_BATCH,
      items: items.map((it) => ({ id: it.id, text: it.text })),
      targetLang
    });
    const appliedNow = Apply.applyTranslations(items, res.translations);
    appliedNow.forEach((rec) => {
      applied.push(rec);
      Collect.markSkipped(skipMap, rec.node, keyOf(rec));
    });
    return appliedNow.length;
  }

  function startObserver(targetLang) {
    if (observerHandle) return;
    observerHandle = Obs.start(document, {
      debounceMs: C.DEBOUNCE_MS,
      onNewNodes: (roots) => {
        if (!active || translating) return;
        translating = true;
        translateRoots(roots, targetLang)
          .catch(() => { /* 动态补翻失败静默,保持原文 */ })
          .finally(() => { translating = false; });
      }
    });
  }

  async function translatePage() {
    if (translating || active) return;
    translating = true;
    try {
      const targetLang = await loadTargetLang();
      const { same } = await resolvePageLang(targetLang);
      if (!same) {
        const n = await translateRoots([document], targetLang);
        if (n > 0) startObserver(targetLang);
      }
      active = true;
    } catch (err) {
      console.warn('[LLM Page Translator]', err.message || err);
    } finally {
      translating = false;
    }
  }

  function restorePage() {
    if (observerHandle) { observerHandle.stop(); observerHandle = null; }
    Apply.restoreAll(applied);
    applied.forEach((rec) => Collect.unmarkSkipped(skipMap, rec.node, keyOf(rec)));
    applied = [];
    active = false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== C.MSG.TOGGLE) return;
    if (active) restorePage(); else translatePage();
  });
})();
```

注意:第 6 步对 translateRoots 中 `if (root && root.nodeType === 1 || root.nodeType === 9)` 的运算符优先级是刻意的——按 `root && (nodeType===1 || nodeType===9)` 求值,但为了可读性,执行时写成:

```js
roots.forEach((root) => {
  const type = root && root.nodeType;
  if (type === 1 || type === 9) {
    items.push(...Collect.collect(root, { skip: skipMap }));
  }
});
```

- [ ] **Step 2: 运行全量单测确认无回归**

Run: `npx vitest run`
Expected: 全部测试文件 passed(manifest.test 中 content js 文件此时已全部存在)。

- [ ] **Step 3: Commit**

```bash
git add src/content/main.js
git commit -m "feat: content script orchestration with toggle and observer"
```

- [ ] **Step 4: Chrome 手动端到端验收**

前置:需要一个可用的 OpenAI 兼容 API key(用户提供)。

1. Chrome 打开 `chrome://extensions` → 开启"开发者模式" → "加载已解压的扩展程序" → 选择本目录
2. 扩展卡片 → "服务选项/选项" → 填 Base URL / API Key / Model → Save(显示 Saved ✓)→ Test connection(显示 OK ✓)
3. 打开 `https://en.wikipedia.org/wiki/Google_Chrome` → 点工具栏扩展图标 → 页面文本原地变为中文,布局不乱
4. 再点一次图标 → 文本恢复英文原文
5. 打开一个无限滚动页面(如 `https://news.ycombinator.com`)→ 点图标翻译 → 向下滚动加载新内容 → 新增条目数秒内自动变中文
6. 打开已配置语言为中文的目标语言且页面本身是中文的页面(如 `https://zh.wikipedia.org`)→ 点图标 → 无变化(console 无请求)——验证同语言跳过
7. 扩展详情 → "service worker" 点开 DevTools → console 无红色错误

Expected: 以上 7 步全部符合;任何一步失败回到对应模块修复并重跑该步。

- [ ] **Step 5: 记录验收结果并 Commit(如有小修一并提交)**

```bash
git add -A
git commit -m "chore: manual e2e acceptance pass"
```

---

### Task 12: README + 全量回归收尾

**Files:**
- Create: `README.md`

- [ ] **Step 1: 写 README.md**

```markdown
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

相邻文本合并进同一请求(每批最多 50 条 / 2000 字符),同一批内重复文本去重;失败自动重试 2 次(1s/2s 退避)。

## 开发

```bash
npm install
npm test        # Vitest + jsdom 单元测试
```

修改代码后在 `chrome://extensions` 点扩展卡片上的刷新按钮即可生效。

## 已知边界

- `<code>/<pre>/<textarea>` 等代码类内容不翻译(保持原样)
- 极少数站点脚本持有原文本引用,替换后其内部状态可能不同步——再点一次图标还原即可
- API key 仅存于本机 `chrome.storage.local`,请求仅发往你配置的 Base URL
```

- [ ] **Step 2: 全量回归**

Run: `npx vitest run`
Expected: 全部 `Test Files passed`,0 failed。

- [ ] **Step 3: 最终检查工作区干净(无 scratch 文件)并 Commit**

```bash
git status --short
git add README.md
git commit -m "docs: README with install, configuration and usage"
```

Expected: `git status --short` 除预期外无多余文件;`node_modules/` 已被 .gitignore 排除。

---

## 自审记录(writing-plans Self-Review)

1. **Spec 覆盖**:决议 6 项 → LLM 可配引擎(Task 4/5/10)、全部文本节点+属性(Task 7)、原文替换可还原(Task 8/11)、目标语言可选+检测跳过(Task 6/10/11)、Observer 持续补翻(Task 9/11)、批合并+缓存+防重翻(Task 2/3/5/7 skip map)。无缺口。
2. **占位符扫描**:所有代码步骤均含完整代码与命令;无 TBD/TODO/"适当处理"。
3. **类型一致性**:`globalThis.Ext.{batch,cache,llm,sw,detect,collect,apply,observer,options}` 与 `EXT_CONSTANTS.MSG.{TOGGLE,TRANSLATE_BATCH,DETECT_LANGUAGE,TEST_CONNECTION}` 在各 Task 间引用一致;`translateViaLlm(config, payload, fetchImpl)` 签名在 Task 4 定义、Task 5 调用一致;`applyTranslations(items, translations)→records{node,kind,attr,original}` 与 main.js 消费一致;options.html 需在 options.js 之前先引 `../shared/constants.js`(Task 10 Step 4 已注明修正)。
4. **已知取舍**:`response_format: json_object` 未启用(部分兼容端点不支持,靠 prompt 约束 + `parseResponse` 容错);缓存 64bit hash 且读时校验原文防碰撞;service worker 并发为串行批处理(逐批 await),限流最简实现。

## 风险与回退

- npm 无法联网 → 阻塞(DOM 测试依赖 jsdom),需用户环境支持 npm registry。
- LLM 返回缺项/格式漂移 → 对应节点保持原文,不影响其它节点;`parseResponse` 容错围栏。
- 站点脚本与替换冲突 → 还原按钮兜底(Task 11 验收第 4 步)。
