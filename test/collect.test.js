import { describe, it, expect, beforeEach } from 'vitest';
import '../src/content/collect.js';

const Collect = globalThis.Ext.collect;

beforeEach(() => { document.body.innerHTML = ''; });

describe('collect', () => {
  it('collects visible text nodes, excluding script/style/whitespace', () => {
    document.body.innerHTML = `
      <p>Hello world</p>
      <p>   </p>
      <script>var no = 'translate me';</script>
      <style>.x { content: 'nope' }</style>
      <pre>keep code</pre>
      <span>Second text</span>
    `;
    const items = Collect.collect(document, {});
    const texts = items.filter((i) => i.kind === 'text').map((i) => i.text);
    expect(texts).toContain('Hello world');
    expect(texts).toContain('Second text');
    expect(texts).not.toContain('translate me');
    expect(texts).not.toContain('keep code');
    expect(items.every((i) => i.id && i.id.length > 0)).toBe(true);
  });

  it('collects translatable attributes', () => {
    document.body.innerHTML = `
      <input placeholder="Type your name">
      <a href="/x" title="Read more">link</a>
      <div aria-label="Close menu"></div>
      <img src="a.png" alt="A red apple">
      <input placeholder="12345">
      <img src="b.png" alt="">
    `;
    const items = Collect.collect(document, {});
    const attrs = items.filter((i) => i.kind === 'attr').map((i) => i.attr);
    expect(attrs).toContain('placeholder');
    expect(attrs).toContain('title');
    expect(attrs).toContain('aria-label');
    expect(attrs).toContain('alt');
    // 纯数字与空属性不收
    expect(items.filter((i) => i.kind === 'attr' && i.text === '12345').length).toBe(0);
  });

  it('assigns unique ids', () => {
    document.body.innerHTML = '<p>a</p><p>b</p><input title="c">';
    const items = Collect.collect(document, {});
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('skips nodes marked in the skip map, per key', () => {
    document.body.innerHTML = '<p>First</p><input title="Tip"><input placeholder="Fill">';
    const skip = Collect.makeSkipMap();
    const first = Collect.collect(document, { skip });
    expect(first.length).toBe(3);
    // 标记文本节点 + input 的 title(不影响 placeholder)
    Collect.markSkipped(skip, first[0].node, 'text');
    Collect.markSkipped(skip, first[1].node, 'attr:title');
    const second = Collect.collect(document, { skip });
    expect(second.map((i) => i.text)).toEqual(['Fill']);
    Collect.unmarkSkipped(skip, first[1].node, 'attr:title');
    expect(Collect.collect(document, { skip }).map((i) => i.text)).toEqual(['Tip', 'Fill']);
  });

  it('rejects text nested inside a skip-tag container (e.g. <pre><div>text</div></pre>)', () => {
    document.body.innerHTML = '<pre><div>code sample</div></pre>';
    const items = Collect.collect(document, {});
    expect(items.filter((i) => i.kind === 'text').map((i) => i.text)).not.toContain('code sample');
  });
});

describe('collectMany', () => {
  it('assigns globally unique ids across multiple roots (no per-root i0 collision)', () => {
    document.body.innerHTML = '<div id="a">Alpha</div><div id="b">Bravo</div><div id="c">Charlie</div>';
    const roots = ['a', 'b', 'c'].map((id) => document.getElementById(id));
    const items = Collect.collectMany(roots, {});
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const byText = new Map(items.map((i) => [i.text, i.id]));
    expect(byText.get('Alpha')).not.toBe(byText.get('Bravo'));
    expect(byText.get('Bravo')).not.toBe(byText.get('Charlie'));
  });

  it('skips non-element roots and returns empty for empty input', () => {
    document.body.innerHTML = '<p>Only</p>';
    expect(Collect.collectMany([], {})).toEqual([]);
    expect(Collect.collectMany([null, document.createTextNode('x')], {})).toEqual([]);
    expect(Collect.collectMany([document.body], {}).map((i) => i.text)).toEqual(['Only']);
  });
});
