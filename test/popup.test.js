import { describe, it, expect, beforeEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/i18n.js';
import '../src/shared/lang-select.js';
import '../src/popup/popup.js';

const Popup = globalThis.Ext.popup;
const C = globalThis.EXT_CONSTANTS;

beforeEach(() => {
  document.body.innerHTML = '<button id="toggle"></button><button id="open-options"></button><div id="status"></div>';
});

function statusText() { return document.getElementById('status').textContent; }

describe('activeTabId', () => {
  it('returns the active tab id', async () => {
    const tabs = { query: async () => [{ id: 7 }] };
    expect(await Popup.activeTabId(tabs)).toBe(7);
  });

  it('returns null when there is no active tab', async () => {
    expect(await Popup.activeTabId({ query: async () => [] })).toBe(null);
  });
});

describe('describeResult', () => {
  it('reports translated / restored counts', () => {
    expect(Popup.describeResult({ ok: true, reason: 'translated', translated: 12 }).text).toBe('Translated 12 text pieces');
    expect(Popup.describeResult({ ok: true, reason: 'restored', restored: 12 }).text).toBe('Restored 12 original text pieces');
    expect(Popup.describeResult({ ok: true, reason: 'already-translated' }).cls).toBe('ok');
  });

  it('flags partial results without treating them as failures', () => {
    const partial = Popup.describeResult({ ok: true, reason: 'translated', translated: 5, partial: true });
    expect(partial.text).toContain('Translated 5 text pieces');
    expect(partial.text).toContain('some content failed');
    expect(partial.cls).not.toBe('error');
  });

  it('enriches the translated message with char count and duration', () => {
    const res = Popup.describeResult({ ok: true, reason: 'translated', translated: 12, chars: 340, ms: 2300 });
    expect(res.text).toBe('Translated 12 text pieces, 340 characters, took 2.3 s');
  });

  it('falls back to the plain message when stats are absent', () => {
    expect(Popup.describeResult({ ok: true, reason: 'translated', translated: 12 }).text).toBe('Translated 12 text pieces');
  });

  it('treats a same-language skip as a notice, not a failure', () => {
    const same = Popup.describeResult({
      ok: false,
      reason: 'same-language',
      state: C.STATE.SKIPPED_SAME_LANGUAGE,
      message: 'The page is in en, which matches the target language zh-CN, so there is nothing to translate'
    });
    expect(same.cls).toBe('info');
    expect(same.text).toContain('nothing to translate');
    const noText = Popup.describeResult({ ok: false, reason: 'no-text', message: 'No translatable text found' });
    expect(noText.text).toContain('No translatable text');
    expect(noText.cls).toBe('error');
  });

  it('falls back to error/unknown payloads', () => {
    expect(Popup.describeResult({ ok: false, error: 'boom' }).text).toBe('boom');
    expect(Popup.describeResult(null).cls).toBe('error');
  });

  it('keeps the translated count for partial failures (streamed content is restorable)', () => {
    // main.js 在"流式已上屏、整包失败"时返回 ok:false + state=TRANSLATED + 数量:
    // 只显示错误原文会把数量吞掉,用户看不到"已有 N 处上屏、可以还原"
    const res = Popup.describeResult({
      ok: false,
      reason: 'error',
      state: C.STATE.TRANSLATED,
      translated: 3,
      chars: 120,
      ms: 1500,
      partial: true,
      message: 'No response from background'
    });
    expect(res.cls).toBe('error'); // 仍是失败态,不误导为成功
    expect(res.text).toContain('Translated 3 text pieces'); // 但已译数量保留
    expect(res.text).toContain('120 characters');
    expect(res.text).toContain('No response from background');
  });
});

describe('formatDuration', () => {
  it('formats sub-second and second durations with one decimal', () => {
    expect(Popup.formatDuration(0)).toBe('0.0 s');
    expect(Popup.formatDuration(350)).toBe('0.4 s');
    expect(Popup.formatDuration(1230)).toBe('1.2 s');
  });

  it('switches to minutes above one minute', () => {
    expect(Popup.formatDuration(60000)).toBe('1 min 0 s');
    expect(Popup.formatDuration(65400)).toBe('1 min 5 s');
  });
});

describe('labelFor / hintFor', () => {
  it('labels the toggle button from the page state', () => {
    expect(Popup.labelFor(C.STATE.TRANSLATED)).toBe('Restore this page');
    expect(Popup.labelFor(C.STATE.IDLE)).toBe('Translate this page');
    expect(Popup.labelFor(C.STATE.SKIPPED_SAME_LANGUAGE)).toBe('Translate this page');
    expect(Popup.labelFor(null)).toBe('Translate this page');
  });

  it('describes each state for the status line', () => {
    expect(Popup.hintFor({ state: C.STATE.TRANSLATED, translated: 12 })).toEqual({ text: 'Translated 12 text pieces', cls: 'ok' });
    const skipped = Popup.hintFor({ state: C.STATE.SKIPPED_SAME_LANGUAGE, lang: 'en', targetLang: 'zh-CN' });
    expect(skipped.cls).toBe('info');
    expect(skipped.text).toContain('en');
    // 未翻译是默认状态,不占用状态栏
    expect(Popup.hintFor({ state: C.STATE.IDLE }).text).toBe('');
    expect(Popup.hintFor(null).text).toBe('');
  });

  it('includes cumulative stats in the translated hint', () => {
    const hint = Popup.hintFor({ state: C.STATE.TRANSLATED, translated: 12, chars: 340, ms: 2300 });
    expect(hint.text).toContain('340 characters');
    expect(hint.text).toContain('2.3 s');
  });
});

describe('refreshState', () => {
  it('queries the active tab and renders the label plus status', async () => {
    const sent = [];
    const runtime = { sendMessage: async (msg) => { sent.push(msg); return { ok: true, state: C.STATE.TRANSLATED, translated: 9 }; } };
    const res = await Popup.refreshState(document, runtime, { query: async () => [{ id: 3 }] });
    expect(sent).toEqual([{ type: C.MSG.GET_STATE, tabId: 3 }]);
    expect(res.ok).toBe(true);
    expect(document.getElementById('toggle').textContent).toBe('Restore this page');
    expect(statusText()).toBe('Translated 9 text pieces');
  });

  it('resets to the default label when the page is unavailable', async () => {
    const runtime = { sendMessage: async () => { throw new Error('no receiver'); } };
    const res = await Popup.refreshState(document, runtime, { query: async () => [] });
    expect(res.ok).toBe(false);
    expect(document.getElementById('toggle').textContent).toBe('Translate this page');
  });

  it('keeps the default label when the content script does not answer', async () => {
    const runtime = { sendMessage: async () => { throw new Error('Could not establish connection'); } };
    const res = await Popup.refreshState(document, runtime, { query: async () => [{ id: 3 }] });
    expect(res.ok).toBe(false);
    expect(document.getElementById('toggle').textContent).toBe('Translate this page');
  });
});

describe('runToggle', () => {
  it('sends TOGGLE_TAB and shows the translated count', async () => {
    const sent = [];
    const runtime = { sendMessage: async (msg) => { sent.push(msg); return { ok: true, reason: 'translated', translated: 7 }; } };
    const tabs = { query: async () => [{ id: 5 }] };
    const res = await Popup.runToggle(document, runtime, tabs);
    expect(res.ok).toBe(true);
    expect(sent).toEqual([{ type: C.MSG.TOGGLE_TAB, tabId: 5 }]);
    expect(statusText()).toBe('Translated 7 text pieces');
  });

  it('shows the content-side same-language skip as a notice, and keeps the translate label', async () => {
    const runtime = {
      sendMessage: async () => ({
        ok: false,
        reason: 'same-language',
        state: C.STATE.SKIPPED_SAME_LANGUAGE,
        message: 'The page is in zh, which matches the target language zh-CN, so there is nothing to translate'
      })
    };
    const tabs = { query: async () => [{ id: 5 }] };
    const res = await Popup.runToggle(document, runtime, tabs);
    expect(res.ok).toBe(true);
    expect(statusText()).toContain('nothing to translate');
    expect(document.getElementById('toggle').textContent).toBe('Translate this page');
  });

  it('updates the button label from the state returned by the content script', async () => {
    const runtime = { sendMessage: async () => ({ ok: true, reason: 'restored', state: C.STATE.IDLE, restored: 4 }) };
    const res = await Popup.runToggle(document, runtime, { query: async () => [{ id: 5 }] });
    expect(res.ok).toBe(true);
    expect(statusText()).toBe('Restored 4 original text pieces');
    expect(document.getElementById('toggle').textContent).toBe('Translate this page');
  });

  it('reports background errors without throwing', async () => {
    const runtime = { sendMessage: async () => ({ ok: false, error: 'API key is not configured' }) };
    const tabs = { query: async () => [{ id: 5 }] };
    const res = await Popup.runToggle(document, runtime, tabs);
    expect(res.ok).toBe(false);
    expect(statusText()).toContain('API key is not configured');
  });

  it('handles a missing active tab gracefully', async () => {
    const runtime = { sendMessage: async () => ({ ok: true }) };
    const res = await Popup.runToggle(document, runtime, { query: async () => [] });
    expect(res.ok).toBe(false);
    expect(statusText()).toContain('not available');
  });
});

describe('wirePage', () => {
  it('opens the options page from the settings button', () => {
    let opened = 0;
    const runtime = { openOptionsPage: () => { opened += 1; } };
    // jsdom 的 window.close 会真的关闭 document,连累该用例之后的其余用例;
    // 测试环境把它置为非函数,只验证 openOptionsPage 被调用
    const realClose = globalThis.close;
    globalThis.close = undefined;
    try {
      Popup.wirePage(document, runtime, { query: async () => [] });
      document.getElementById('open-options').click();
      expect(opened).toBe(1);
    } finally {
      globalThis.close = realClose;
    }
  });
});

describe('target language select', () => {
  beforeEach(() => {
    document.body.innerHTML += '<select id="target-lang"></select>';
  });

  it('populates the select from the shared language list', () => {
    const sel = document.getElementById('target-lang');
    Popup.populateLangSelect(sel);
    expect(sel.options.length).toBe(C.LANGUAGES.length);
    expect(sel.options[0].value).toBe('zh-CN');
    expect(sel.options[0].textContent).toBe(C.LANGUAGES[0].label);
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(C.LANGUAGES.map((l) => l.code));
  });

  it('ensureLangOption appends options missing from the shared list', () => {
    const sel = document.getElementById('target-lang');
    Popup.populateLangSelect(sel);
    Popup.ensureLangOption(sel, 'xx');
    sel.value = 'xx';
    expect(sel.value).toBe('xx'); // 未知语言可选,不静默回落到第一项
    expect(sel.options.length).toBe(C.LANGUAGES.length + 1);
    Popup.ensureLangOption(sel, 'zh-CN');
    expect(sel.options.length).toBe(C.LANGUAGES.length + 1); // 已存在不重复
  });

  it('loads the stored target language, falling back to the default', async () => {
    const storage = { get: async () => ({ config: { targetLang: 'ja' } }) };
    expect(await Popup.loadTargetLang(storage)).toBe('ja');
    expect(await Popup.loadTargetLang({ get: async () => ({}) })).toBe(C.DEFAULT_CONFIG.targetLang);
  });

  it('saves the chosen language while preserving the rest of the config', async () => {
    const writes = [];
    const storage = {
      get: async () => ({ config: { baseUrl: 'https://x', apiKey: 'sk-1', model: 'm', targetLang: 'zh-CN' } }),
      set: async (obj) => writes.push(obj)
    };
    await Popup.saveTargetLang(storage, 'de');
    expect(writes[0].config.targetLang).toBe('de');
    expect(writes[0].config.apiKey).toBe('sk-1');
    expect(writes[0].config.baseUrl).toBe('https://x');
  });

  it('persists the selection when the select changes', async () => {
    const writes = [];
    const storage = {
      get: async () => ({ config: { targetLang: 'zh-CN' } }),
      set: async (obj) => writes.push(obj)
    };
    const runtime = { sendMessage: async () => ({ ok: true, state: C.STATE.IDLE }), openOptionsPage: () => {} };
    Popup.wirePage(document, runtime, { query: async () => [{ id: 1 }] }, storage);
    const sel = document.getElementById('target-lang');
    await new Promise((r) => setTimeout(r, 0)); // 等 loadTargetLang 回填
    expect(sel.value).toBe('zh-CN');
    sel.value = 'fr';
    sel.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));
    expect(writes[0].config.targetLang).toBe('fr');
  });
});
