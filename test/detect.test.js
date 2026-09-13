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
  it('compares primary subtags for non-Chinese languages', () => {
    expect(Detect.langMatches('en', 'en-US')).toBe(true);
    expect(Detect.langMatches('en-US', 'en')).toBe(true);
    expect(Detect.langMatches('en', 'zh-CN')).toBe(false);
    expect(Detect.langMatches(null, 'zh-CN')).toBe(false);
  });

  it('distinguishes simplified and traditional Chinese variants', () => {
    expect(Detect.langMatches('zh-CN', 'zh-Hans')).toBe(true);
    expect(Detect.langMatches('zh-Hans', 'zh-SG')).toBe(true);
    expect(Detect.langMatches('zh-TW', 'zh-Hant')).toBe(true);
    expect(Detect.langMatches('zh-HK', 'zh-TW')).toBe(true);
    expect(Detect.langMatches('zh-CN', 'zh-TW')).toBe(false);
    expect(Detect.langMatches('zh-Hans', 'zh-Hant')).toBe(false);
  });
});

describe('sampleText', () => {
  it('collapses whitespace and truncates', () => {
    document.body.innerHTML = '<p>  Hello   world  </p><p>Second</p>';
    const sample = Detect.sampleText(document, 10);
    expect(sample).toBe('Hello worl');
  });
});
