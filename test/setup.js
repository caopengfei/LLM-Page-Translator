// 单测里没有扩展运行时。用 _locales/en/messages.json 模拟 chrome.i18n.getMessage,
// 让 src/shared/i18n.js 的 t() 取到真实英文文案,而不是回退成 key。
// 刻意不提供 getUILanguage:defaultTargetLang() 因此走 DEFAULT_CONFIG 兜底,测试保持确定性。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = JSON.parse(readFileSync(resolve(root, '_locales/en/messages.json'), 'utf8'));

// 复刻 Chrome 的替换规则:$1..$9 依次取 substitutions,$$ 表示字面量 $
export function substitute(message, subs) {
  const list = subs == null ? [] : (Array.isArray(subs) ? subs : [subs]);
  const DOLLAR = '\u0000';
  return String(message)
    .replace(/\$\$/g, DOLLAR)
    .replace(/\$(\d)/g, (m, d) => {
      const v = list[Number(d) - 1];
      return v == null ? '' : String(v);
    })
    .replace(new RegExp(DOLLAR, 'g'), '$');
}

export function chromeI18n() {
  return {
    getMessage(key, subs) {
      const entry = catalog[key];
      if (!entry || typeof entry.message !== 'string') return '';
      return substitute(entry.message, subs);
    }
  };
}

const chrome = globalThis.chrome || {};
chrome.i18n = chromeI18n();
globalThis.chrome = chrome;
