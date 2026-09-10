import { describe, it, expect, beforeEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/options/options.js';

const Options = globalThis.Ext.options;

beforeEach(() => {
  document.body.innerHTML = `
    <form id="options-form">
      <input name="baseUrl"><input name="apiKey"><input name="model">
      <select name="targetLang"><option value="zh-CN">简体中文</option><option value="en">English</option></select>
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
