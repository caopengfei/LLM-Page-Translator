(function (global) {
  'use strict';

  const LOG_PREFIX = '[LLM Page Translator]';

  // 文案查找走惰性解析:llm.js 既被 service worker 以 ESM 引入,也被单测直接 import,
  // 两处的加载顺序不同,引用时再取 globalThis.Ext.i18n 最稳妥
  function tr(key, subs) {
    const i18n = global.Ext && global.Ext.i18n;
    return i18n ? i18n.t(key, subs) : key;
  }

  // 单条日志正文上限:Base URL 误配时响应可能是整页 HTML,不截断会刷屏
  const LOG_MAX_CHARS = 4000;

  function preview(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    return s.slice(0, max) + ' …(truncated, ' + (s.length - max) + ' more chars)';
  }

  // 日志走可注入的 logger,默认 console(service worker 控制台可见);
  // 测试传静默 stub,既不污染测试输出又能断言输出内容
  function emit(logger, level, args) {
    const target = logger || console;
    const fn = target && typeof target[level] === 'function' ? target[level] : null;
    if (fn) fn.apply(target, args);
  }

  function joinUrl(base, path) {
    return String(base || '').replace(/\/+$/, '') + path;
  }

  // 容错:Base URL 若已包含 /chat/completions(常见粘贴整段端点的误配),不再重复拼接
  function chatCompletionsUrl(baseUrl) {
    const base = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(base)) return base;
    return base + '/chat/completions';
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

  const DEFAULT_TIMEOUT_MS = 30000;

  // 单次请求超时:目标地址不可达时 fetch 会挂到 TCP 超时(可达分钟级),
  // 没有超时会导致"翻译中"状态永久不释放
  async function translateViaLlm(config, payload, fetchImpl, logger) {
    const doFetch = fetchImpl || ((url, opts) => fetch(url, opts));
    const url = chatCompletionsUrl(config.baseUrl);
    const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    // 请求体只构建一次:既用于 fetch,也用于日志。日志只输出 body,
    // 绝不输出 headers(Authorization 里是 API Key)
    const requestJson = JSON.stringify(buildRequestBody(config, payload));
    emit(logger, 'log', [LOG_PREFIX + ' → POST ' + url, requestJson]);
    const startedAt = Date.now();
    let res;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
        body: requestJson,
        ...(controller ? { signal: controller.signal } : {})
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        const timeoutErr = new Error(tr('error_timeout', [timeoutMs, url]));
        timeoutErr.code = 'TIMEOUT'; // 上层据此放弃重试:不可达不是瞬时抖动
        emit(logger, 'warn', [LOG_PREFIX + ' ✖ request timed out (' + timeoutMs + 'ms): ' + url]);
        throw timeoutErr;
      }
      const reason = String((err && err.message) || err);
      const netErr = new Error(tr('error_network', [url, reason]));
      netErr.code = 'NETWORK';
      emit(logger, 'warn', [LOG_PREFIX + ' ✖ request failed: ' + url + ' — ' + reason]);
      throw netErr;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const bodyText = await safeErrorText(res);
    // 成功与非 2xx 都打印原始响应体,便于对照报错
    emit(logger, 'log', [
      LOG_PREFIX + ' ← HTTP ' + res.status + ' ' + url + ' (' + (Date.now() - startedAt) + 'ms)',
      preview(bodyText, LOG_MAX_CHARS)
    ]);
    if (!res.ok) {
      throw new Error('LLM API HTTP ' + res.status + ' (' + url + ')' + (bodyText ? ': ' + bodyText.slice(0, 200) : ''));
    }
    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (e) {
      // 典型误配:Base URL 指向网页而非 API(返回 HTML),或缺少 /v1 被重定向到首页
      throw new Error(tr('error_non_json', [url, res.status, JSON.stringify(bodyText.slice(0, 120))]));
    }
    return extractContent(data);
  }

  const ExtLlm = { joinUrl, chatCompletionsUrl, systemPrompt, buildRequestBody, extractContent, translateViaLlm, DEFAULT_TIMEOUT_MS };
  global.Ext = global.Ext || {};
  global.Ext.llm = ExtLlm;
  if (typeof module !== 'undefined' && module.exports) module.exports = ExtLlm;
})(typeof globalThis !== 'undefined' ? globalThis : self);
