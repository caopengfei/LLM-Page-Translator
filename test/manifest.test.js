// Verifies manifest.json structure/referenced files and shared EXT_CONSTANTS.
// (Guards: MV3 keys, every referenced file exists, popup + options_ui entries.)
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/shared/constants.js';

const testDir = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url));
const root = resolve(testDir, '..');
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const C = globalThis.EXT_CONSTANTS;

describe('manifest.json', () => {
  it('is Manifest V3 with required permissions', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining(['storage', 'scripting']));
    expect(manifest.host_permissions).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
  });

  it('all content_scripts js files exist on disk', () => {
    const js = manifest.content_scripts[0].js;
    expect(js[js.length - 1]).toBe('src/content/main.js');
    js.forEach((f) => expect(existsSync(resolve(root, f)), `${f} should exist`).toBe(true));
  });

  it('referenced background service worker and options page exist on disk', () => {
    expect(existsSync(resolve(root, manifest.background.service_worker))).toBe(true);
    expect(existsSync(resolve(root, manifest.options_ui.page))).toBe(true);
  });

  it('declares a popup entry in the toolbar action and the popup files exist', () => {
    expect(typeof manifest.action.default_popup).toBe('string');
    expect(existsSync(resolve(root, manifest.action.default_popup))).toBe(true);
    // popup 与 options 页同样依赖 constants.js 先加载
    expect(existsSync(resolve(root, 'src/shared/constants.js'))).toBe(true);
  });

  it('declares app and action icons that exist on disk', () => {
    Object.values(manifest.icons).forEach((p) => expect(existsSync(resolve(root, p)), `${p} should exist`).toBe(true));
    Object.values(manifest.action.default_icon).forEach((p) => expect(existsSync(resolve(root, p)), `${p} should exist`).toBe(true));
  });

  it('background service worker is an ESM module', () => {
    expect(manifest.background.type).toBe('module');
  });

  it('declares default_locale and resolves name/description/action title from messages', () => {
    expect(manifest.default_locale).toBe('en');
    expect(manifest.name).toBe('__MSG_ext_name__');
    expect(manifest.description).toBe('__MSG_ext_description__');
    expect(manifest.action.default_title).toBe('__MSG_ext_action_title__');
    const en = JSON.parse(readFileSync(resolve(root, '_locales/en/messages.json'), 'utf8'));
    ['ext_name', 'ext_description', 'ext_action_title'].forEach((k) => {
      expect(typeof en[k].message).toBe('string');
      expect(en[k].message.length).toBeGreaterThan(0);
    });
  });

  it('ships one _locales catalog per supported target language', () => {
    const en = JSON.parse(readFileSync(resolve(root, '_locales/en/messages.json'), 'utf8'));
    const enKeys = Object.keys(en).sort();
    C.LANGUAGES.forEach((l) => {
      // Chrome 的目录名用下划线:zh-CN → zh_CN
      const dir = l.code.replace('-', '_');
      const file = resolve(root, `_locales/${dir}/messages.json`);
      expect(existsSync(file), `_locales/${dir}/messages.json should exist`).toBe(true);
      const cat = JSON.parse(readFileSync(file, 'utf8'));
      expect(Object.keys(cat).sort(), `${dir} key set`).toEqual(enKeys);
    });
  });
});

describe('EXT_CONSTANTS', () => {
  it('message types are unique non-empty strings', () => {
    const values = Object.values(C.MSG);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values).size).toBe(values.length);
    values.forEach((v) => expect(typeof v).toBe('string'));
  });

  it('defaults target language to en and has batch limits', () => {
    expect(C.DEFAULT_CONFIG.targetLang).toBe('en');
    expect(C.BATCH_MAX_ITEMS).toBeGreaterThan(0);
    expect(C.BATCH_MAX_CHARS).toBeGreaterThan(0);
  });

  it('declares GET_STATE for the popup state query', () => {
    expect(C.MSG.GET_STATE).toBe('GET_STATE');
  });

  it('defines the three documented page states', () => {
    expect(C.STATE.IDLE).toBe('idle');
    expect(C.STATE.TRANSLATED).toBe('translated');
    expect(C.STATE.SKIPPED_SAME_LANGUAGE).toBe('skipped-same-language');
  });

  it('defines a shared target-language list used by popup and options', () => {
    const langs = C.LANGUAGES;
    expect(Array.isArray(langs)).toBe(true);
    expect(langs.length).toBeGreaterThan(0);
    const codes = langs.map((l) => l.code);
    expect(new Set(codes).size).toBe(codes.length); // 编码不重复
    expect(codes).toContain(C.DEFAULT_CONFIG.targetLang); // 默认值必须是可选项
    langs.forEach((l) => {
      expect(typeof l.code).toBe('string');
      expect(l.code.length).toBeGreaterThan(0);
      expect(typeof l.label).toBe('string');
      expect(l.label.length).toBeGreaterThan(0);
    });
  });

  it('defaults retries to 3 within a sane range', () => {
    expect(C.DEFAULT_CONFIG.retries).toBe(3);
    expect(C.RETRY_MIN).toBe(0); // 0 = 不重试,必须是合法值
    expect(C.RETRY_MAX).toBeGreaterThanOrEqual(C.DEFAULT_CONFIG.retries);
  });
});

describe('normalizeRetries', () => {
  it('falls back to the default for missing or non-numeric values', () => {
    [undefined, null, '', 'abc', NaN, Infinity].forEach((raw) => {
      expect(C.normalizeRetries(raw), String(raw)).toBe(C.DEFAULT_CONFIG.retries);
    });
  });

  it('accepts integers inside the allowed range, including 0', () => {
    expect(C.normalizeRetries(0)).toBe(0);
    expect(C.normalizeRetries(1)).toBe(1);
    expect(C.normalizeRetries(5)).toBe(5);
    expect(C.normalizeRetries('4')).toBe(4); // 表单/storage 里的数字字符串
  });

  it('clamps out-of-range values instead of failing', () => {
    expect(C.normalizeRetries(-3)).toBe(C.RETRY_MIN);
    expect(C.normalizeRetries(999)).toBe(C.RETRY_MAX);
    expect(C.normalizeRetries(2.7)).toBe(2); // 非整数向下取整
  });
});

describe('pickTargetLang / defaultTargetLang', () => {
  it('matches an exact locale, case-insensitively', () => {
    expect(C.pickTargetLang('ja', 'en')).toBe('ja');
    expect(C.pickTargetLang('zh-TW', 'en')).toBe('zh-TW');
    expect(C.pickTargetLang('zh-tw', 'en')).toBe('zh-TW');
  });

  it('falls back to the primary subtag for regional variants', () => {
    expect(C.pickTargetLang('en-US', 'zh-CN')).toBe('en');
    expect(C.pickTargetLang('de-AT', 'en')).toBe('de');
    expect(C.pickTargetLang('es-419', 'en')).toBe('es');
    expect(C.pickTargetLang('pt_BR', 'en')).toBe('pt');
  });

  it('distinguishes simplified from traditional Chinese', () => {
    expect(C.pickTargetLang('zh', 'en')).toBe('zh-CN');
    expect(C.pickTargetLang('zh-CN', 'en')).toBe('zh-CN');
    expect(C.pickTargetLang('zh-Hans', 'en')).toBe('zh-CN');
    expect(C.pickTargetLang('zh-Hant', 'en')).toBe('zh-TW');
    expect(C.pickTargetLang('zh-HK', 'en')).toBe('zh-TW');
  });

  it('uses the fallback for unknown or empty UI languages', () => {
    expect(C.pickTargetLang('xx-YY', 'en')).toBe('en');
    expect(C.pickTargetLang('', 'zh-CN')).toBe('zh-CN');
    expect(C.pickTargetLang(null, 'zh-CN')).toBe('zh-CN');
  });

  it('defaultTargetLang always yields a selectable language', () => {
    const codes = C.LANGUAGES.map((l) => l.code);
    expect(codes).toContain(C.defaultTargetLang());
  });
});
