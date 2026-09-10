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
