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

  it('records the exact string written, not just the translated fragment', () => {
    const node = document.createTextNode('  Hello  ');
    document.body.appendChild(node);
    const records = Apply.applyTranslations(
      [{ id: 'a', node, kind: 'text', attr: null, text: 'Hello' }],
      { a: '你好' }
    );
    expect(records[0].translated).toBe('你好');
    expect(records[0].written).toBe('  你好  ');
    expect(records[0].srcLen).toBe(5);
  });

  it('records the source length of attribute translations', () => {
    const el = document.createElement('input');
    el.setAttribute('placeholder', 'Search here');
    document.body.appendChild(el);
    const records = Apply.applyTranslations(
      [{ id: 'b', node: el, kind: 'attr', attr: 'placeholder', text: 'Search here' }],
      { b: '搜索' }
    );
    expect(records[0].srcLen).toBe(11);
  });
});

describe('reconcile', () => {
  function applyText(text, translation) {
    const node = document.createTextNode(text);
    document.body.appendChild(node);
    const records = Apply.applyTranslations(
      [{ id: 'a', node, kind: 'text', attr: null, text: text.trim() }],
      { a: translation }
    );
    return { node, records };
  }

  it('keeps records still present in the document', () => {
    const { records } = applyText('Hello', '你好');
    const { kept, dropped } = Apply.reconcile(records);
    expect(kept.length).toBe(1);
    expect(dropped.length).toBe(0);
  });

  it('treats a whitespace-preserving write as unchanged', () => {
    const { node, records } = applyText('  Hello  ', '你好');
    expect(node.nodeValue).toBe('  你好  ');
    expect(Apply.reconcile(records).kept.length).toBe(1);
  });

  it('drops records whose node left the document', () => {
    const { node, records } = applyText('Hello', '你好');
    node.remove();
    const { kept, dropped } = Apply.reconcile(records);
    expect(kept.length).toBe(0);
    expect(dropped.length).toBe(1);
  });

  it('drops text records the site overwrote', () => {
    const { node, records } = applyText('Hello', '你好');
    node.nodeValue = 'Bonjour';
    const { kept, dropped } = Apply.reconcile(records);
    expect(kept.length).toBe(0);
    expect(dropped[0].node).toBe(node);
  });

  it('drops attribute records the site overwrote', () => {
    const el = document.createElement('input');
    el.setAttribute('placeholder', 'Search');
    document.body.appendChild(el);
    const records = Apply.applyTranslations(
      [{ id: 'b', node: el, kind: 'attr', attr: 'placeholder', text: 'Search' }],
      { b: '搜索' }
    );
    expect(Apply.reconcile(records).kept.length).toBe(1);
    el.setAttribute('placeholder', 'Find');
    expect(Apply.reconcile(records).dropped.length).toBe(1);
  });

  it('falls back to translated for legacy records without written', () => {
    const node = document.createTextNode('x');
    document.body.appendChild(node);
    const legacy = { id: 'l', node, kind: 'text', attr: null, original: 'Hello', translated: '你好' };
    node.nodeValue = '你好';
    expect(Apply.reconcile([legacy]).kept.length).toBe(1);
    node.nodeValue = 'other';
    expect(Apply.reconcile([legacy]).dropped.length).toBe(1);
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

  it('counts only the records actually written back', () => {
    const live = document.createTextNode('One');
    const dead = document.createTextNode('Two');
    document.body.appendChild(live);
    document.body.appendChild(dead);
    const records = [
      ...Apply.applyTranslations([{ id: 'a', node: live, kind: 'text', attr: null, text: 'One' }], { a: '一' }),
      ...Apply.applyTranslations([{ id: 'b', node: dead, kind: 'text', attr: null, text: 'Two' }], { b: '二' })
    ];
    dead.remove();
    expect(Apply.restoreAll(records)).toBe(1);
  });
});
