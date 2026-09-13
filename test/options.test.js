import { describe, it, expect, beforeEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/i18n.js';
import '../src/shared/lang-select.js';
import '../src/options/options.js';

const Options = globalThis.Ext.options;
const C = globalThis.EXT_CONSTANTS;

beforeEach(() => {
  document.body.innerHTML = `
    <form id="options-form">
      <input name="baseUrl"><input name="apiKey"><input name="model">
      <select name="targetLang"><option value="zh-CN">简体中文</option><option value="en">English</option></select>
      <input name="timeoutSec">
    </form>`;
});

function form() { return document.getElementById('options-form'); }

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

  it.each(['api.test/v1', '/v1', 'ftp://api.test/v1'])('rejects a non-http(s) absolute base URL: %s', (baseUrl) => {
    const v = Options.validateConfig({ baseUrl, apiKey: 'k', model: 'm', targetLang: 'zh-CN' });
    expect(v.ok).toBe(false);
    expect(v.invalidBaseUrl).toBe(true);
  });

  it.each(['https://api.test/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:8080/v1'])('accepts supported base URL: %s', (baseUrl) => {
    expect(Options.validateConfig({ baseUrl, apiKey: 'k', model: 'm', targetLang: 'zh-CN' })).toEqual({ ok: true, missing: [] });
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

  it('preserves pre-existing config fields it does not manage', async () => {
    const writes = [];
    const storage = {
      get: async () => ({ config: { custom: 'keep', apiKey: 'old' } }),
      set: async (obj) => writes.push(obj)
    };
    const f = form();
    f.elements.baseUrl.value = 'https://api.test/v1';
    f.elements.apiKey.value = 'sk-new';
    f.elements.model.value = 'm1';
    f.elements.targetLang.value = 'zh-CN';
    await Options.saveConfigFrom(f, storage);
    expect(writes[0].config.custom).toBe('keep');
    expect(writes[0].config.apiKey).toBe('sk-new');
  });

  it('clears a previously stored timeout when the field is emptied', async () => {
    const writes = [];
    const storage = {
      get: async () => ({ config: { timeoutMs: 45000, apiKey: 'old' } }),
      set: async (obj) => writes.push(obj)
    };
    const f = form();
    f.elements.baseUrl.value = 'https://api.test/v1';
    f.elements.apiKey.value = 'sk-1';
    f.elements.model.value = 'm1';
    f.elements.targetLang.value = 'zh-CN';
    f.elements.timeoutSec.value = '';
    await Options.saveConfigFrom(f, storage);
    expect('timeoutMs' in writes[0].config).toBe(false); // 回到默认超时,不保留旧值
  });
});

describe('timeout field (seconds ↔ config.timeoutMs)', () => {
  it('stores timeoutMs on save and formats it back into the form', async () => {
    const writes = [];
    const storage = { set: async (obj) => writes.push(obj) };
    const f = form();
    f.elements.baseUrl.value = 'https://api.test/v1';
    f.elements.apiKey.value = 'sk-1';
    f.elements.model.value = 'm1';
    f.elements.targetLang.value = 'zh-CN';
    f.elements.timeoutSec.value = '45';
    const res = await Options.saveConfigFrom(f, storage);
    expect(res.ok).toBe(true);
    expect(writes[0].config.timeoutMs).toBe(45000);

    f.elements.timeoutSec.value = '';
    Options.fillForm(f, writes[0].config);
    expect(f.elements.timeoutSec.value).toBe('45');
  });

  it('falls back to the default timeout when the field is blank or invalid', async () => {
    const writes = [];
    const storage = { set: async (obj) => writes.push(obj) };
    const f = form();
    f.elements.baseUrl.value = 'https://api.test/v1';
    f.elements.apiKey.value = 'sk-1';
    f.elements.model.value = 'm1';
    f.elements.targetLang.value = 'zh-CN';
    f.elements.timeoutSec.value = 'abc';
    await Options.saveConfigFrom(f, storage);
    expect('timeoutMs' in writes[0].config).toBe(false); // 交给 DEFAULT_CONFIG 兜底

    Options.fillForm(f, {});
    expect(Number(f.elements.timeoutSec.value)).toBe(120); // 默认 120 秒
  });
});

describe('fillForm with unknown target language', () => {
  it('keeps a stored target language that is not in the shared list', () => {
    const f = form();
    Options.fillForm(f, { targetLang: 'xx-YY' });
    // 不静默回落到第一项:补选项并选中,保存时才不会把用户配置改掉
    expect(f.elements.targetLang.value).toBe('xx-YY');
    const values = Array.from(f.elements.targetLang.options).map((o) => o.value);
    expect(values).toContain('xx-YY');
  });

  it('ensureLangOption appends only missing values', () => {
    const sel = form().elements.targetLang;
    const before = sel.options.length;
    Options.ensureLangOption(sel, 'zh-CN'); // 已存在,不重复添加
    expect(sel.options.length).toBe(before);
    Options.ensureLangOption(sel, 'xx');
    expect(sel.options.length).toBe(before + 1);
    Options.ensureLangOption(sel, ''); // 空值忽略
    Options.ensureLangOption(null, 'xx');
    expect(sel.options.length).toBe(before + 1);
  });
});

describe('language list', () => {
  it('populates the target language select from the shared list', () => {
    const sel = form().elements.targetLang;
    sel.innerHTML = ''; // 清掉 beforeEach 里预设的两个占位选项
    Options.populateLanguages(sel);
    expect(sel.options.length).toBe(C.LANGUAGES.length);
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(C.LANGUAGES.map((l) => l.code));
    expect(sel.options[0].textContent).toBe(C.LANGUAGES[0].label);
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
