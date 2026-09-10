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
