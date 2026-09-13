// popup 与 options 共用的语言下拉逻辑:可选项一致、未知语言补选项不回落。
// (回归:两处曾各写一份,改一处漏一处)
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/lang-select.js';

const LangSelect = globalThis.Ext.langSelect;
const C = globalThis.EXT_CONSTANTS;

beforeEach(() => {
  document.body.innerHTML = '<select id="lang"></select>';
});

function sel() { return document.getElementById('lang'); }

describe('populate', () => {
  it('fills the select from the shared language list', () => {
    LangSelect.populate(sel());
    expect(sel().options.length).toBe(C.LANGUAGES.length);
    expect(Array.from(sel().options).map((o) => o.value)).toEqual(C.LANGUAGES.map((l) => l.code));
    expect(sel().options[0].textContent).toBe(C.LANGUAGES[0].label);
  });

  it('ignores a missing select', () => {
    expect(() => LangSelect.populate(null)).not.toThrow();
  });
});

describe('ensureOption', () => {
  it('appends values missing from the shared list, without duplicating existing ones', () => {
    LangSelect.populate(sel());
    LangSelect.ensureOption(sel(), 'xx');
    sel().value = 'xx';
    expect(sel().value).toBe('xx'); // 未知语言可选,不静默回落到第一项
    expect(sel().options.length).toBe(C.LANGUAGES.length + 1);
    LangSelect.ensureOption(sel(), 'zh-CN');
    expect(sel().options.length).toBe(C.LANGUAGES.length + 1); // 已存在不重复
  });

  it('ignores empty values and missing selects', () => {
    LangSelect.populate(sel());
    const before = sel().options.length;
    LangSelect.ensureOption(sel(), '');
    LangSelect.ensureOption(null, 'xx');
    expect(sel().options.length).toBe(before);
  });
});
