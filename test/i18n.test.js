// i18n 运行时:文案查找、占位符替换、DOM 填充,以及 _locales 各语言表的一致性。
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/shared/constants.js';
import '../src/shared/i18n.js';

const I18n = globalThis.Ext.i18n;
const testDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(testDir, '..', '_locales');

describe('t', () => {
  it('resolves a message from the active catalog', () => {
    expect(I18n.t('popup_btn_translate')).toBe('Translate this page');
    expect(I18n.t('ext_name')).toBe('LLM Page Translator');
  });

  it('substitutes positional placeholders in order', () => {
    expect(I18n.t('popup_status_translated', [3])).toBe('Translated 3 text pieces');
    expect(I18n.t('popup_duration_minutes', [1, 5])).toBe('1 min 5 s');
    expect(I18n.t('error_network', ['https://x', 'boom'])).toBe('Request failed: https://x — boom');
  });

  it('echoes the key when it is missing, so gaps are visible', () => {
    expect(I18n.t('no_such_key')).toBe('no_such_key');
    expect(I18n.t('')).toBe('');
    expect(I18n.t(null)).toBe('');
  });
});

describe('apply', () => {
  it('fills data-i18n variants in the document', () => {
    document.body.innerHTML = `
      <span id="a" data-i18n="popup_settings"></span>
      <button id="b" data-i18n-title="popup_settings" data-i18n-aria-label="popup_settings"></button>
      <input id="c" data-i18n-placeholder="options_field_target_language">
      <p id="d" data-i18n-html="options_hint_base_url"></p>`;
    I18n.apply(document);
    expect(document.getElementById('a').textContent).toBe('Settings');
    expect(document.getElementById('b').getAttribute('title')).toBe('Settings');
    expect(document.getElementById('b').getAttribute('aria-label')).toBe('Settings');
    expect(document.getElementById('c').getAttribute('placeholder')).toBe('Target language');
    // 说明段落的 <b>/<code> 排版标签要保留
    const html = document.getElementById('d').innerHTML;
    expect(html).toContain('<b>API root address</b>');
    expect(html).toContain('/chat/completions');
  });
});

describe('_locales catalogs', () => {
  const en = JSON.parse(readFileSync(resolve(localesDir, 'en/messages.json'), 'utf8'));
  const enKeys = Object.keys(en);
  const dirs = readdirSync(localesDir);
  const placeholders = (msg) => (msg.match(/\$\d/g) || []).sort().join(',');

  it('covers every supported target-language locale', () => {
    const expected = globalThis.EXT_CONSTANTS.LANGUAGES.map((l) => l.code.replace('-', '_'));
    expect(dirs.slice().sort()).toEqual(expected.slice().sort());
  });

  it('every locale defines exactly the same key set', () => {
    dirs.forEach((d) => {
      const cat = JSON.parse(readFileSync(resolve(localesDir, d, 'messages.json'), 'utf8'));
      expect(Object.keys(cat).sort(), `${d} keys`).toEqual(enKeys.slice().sort());
    });
  });

  it('every locale keeps the same placeholders as the English source', () => {
    dirs.forEach((d) => {
      const cat = JSON.parse(readFileSync(resolve(localesDir, d, 'messages.json'), 'utf8'));
      enKeys.forEach((k) => {
        expect(placeholders(cat[k].message), `${d}.${k}`).toBe(placeholders(en[k].message));
      });
    });
  });

  it('no message is left empty or untranslated', () => {
    dirs.forEach((d) => {
      const cat = JSON.parse(readFileSync(resolve(localesDir, d, 'messages.json'), 'utf8'));
      Object.entries(cat).forEach(([k, v]) => {
        expect(typeof v.message, `${d}.${k}`).toBe('string');
        expect(v.message.trim().length, `${d}.${k}`).toBeGreaterThan(0);
      });
    });
  });

  it('every key referenced in src/ (t()/tr() and data-i18n*) is defined', () => {
    const srcDir = resolve(testDir, '..', 'src');
    const files = [];
    (function walk(dir) {
      readdirSync(dir, { withFileTypes: true }).forEach((e) => {
        const p = resolve(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|html)$/.test(e.name)) files.push(p);
      });
    })(srcDir);

    const used = new Set();
    files.forEach((f) => {
      const text = readFileSync(f, 'utf8');
      // 只认字面量 key,避免把变量调用误当 key
      for (const m of text.matchAll(/\btr?\(\s*'([A-Za-z0-9_]+)'/g)) used.add(m[1]);
      for (const m of text.matchAll(/data-i18n(?:-html|-title|-aria-label|-placeholder)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
    });
    expect(used.size).toBeGreaterThan(10); // 扫描本身要有效,别因为正则失效而空跑
    const missing = [...used].filter((k) => !(k in en));
    expect(missing, `undefined keys: ${missing.join(', ')}`).toEqual([]);
  });
});
