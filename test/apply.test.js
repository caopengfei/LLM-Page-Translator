import { describe, it, expect, beforeEach } from 'vitest';
import '../src/content/apply.js';

const Apply = globalThis.Ext.apply;

beforeEach(() => { document.body.innerHTML = ''; });

describe('applyTranslations', () => {
  it('replaces text node values, preserving surrounding whitespace', () => {
    const node = document.createTextNode('  Hello  ');
    document.body.appendChild(node);
    const records = Apply.applyTranslations(
      [{ id: 'a', node, kind: 'text', attr: null, text: 'Hello' }],
      { a: '你好' }
    );
    expect(node.nodeValue).toBe('  你好  ');
    expect(records.length).toBe(1);
    expect(records[0].original).toBe('  Hello  ');
  });

  it('replaces attribute values', () => {
    const el = document.createElement('input');
    el.setAttribute('placeholder', 'Search here');
    document.body.appendChild(el);
    const records = Apply.applyTranslations(
      [{ id: 'b', node: el, kind: 'attr', attr: 'placeholder', text: 'Search here' }],
      { b: '搜索' }
    );
    expect(el.getAttribute('placeholder')).toBe('搜索');
    expect(records[0].original).toBe('Search here');
  });

  it('ignores missing translations and identical texts', () => {
    const node = document.createTextNode('Same');
    document.body.appendChild(node);
    const records = Apply.applyTranslations(
      [
        { id: 'x', node, kind: 'text', attr: null, text: 'Same' },
        { id: 'y', node, kind: 'text', attr: null, text: 'Same' }
      ],
      { x: 'Same', y: 'Other' }
    );
    expect(records.map((r) => r.id)).toEqual(['y']);
  });
});

describe('restoreAll', () => {
  it('restores originals in reverse order', () => {
    const n1 = document.createTextNode('One');
    const el = document.createElement('input');
    el.setAttribute('title', 'Title');
    document.body.appendChild(n1);
    document.body.appendChild(el);
    const records = [
      ...Apply.applyTranslations([{ id: 'a', node: n1, kind: 'text', attr: null, text: 'One' }], { a: '一' }),
      ...Apply.applyTranslations([{ id: 'b', node: el, kind: 'attr', attr: 'title', text: 'Title' }], { b: '标题' })
    ];
    Apply.restoreAll(records);
    expect(n1.nodeValue).toBe('One');
    expect(el.getAttribute('title')).toBe('Title');
  });

  it('does not throw for detached nodes', () => {
    const detached = document.createTextNode('gone');
    Apply.restoreAll([{ id: 'd', node: detached, kind: 'text', attr: null, original: 'gone', translated: '没了' }]);
    expect(detached.nodeValue).toBe('gone');
  });
});
