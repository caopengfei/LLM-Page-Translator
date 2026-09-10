import { describe, it, expect } from 'vitest';
import '../src/shared/batch.js';

const { splitIntoBatches, buildPayload, parseResponse } = globalThis.Ext.batch;

describe('splitIntoBatches', () => {
  it('returns empty array for empty input', () => {
    expect(splitIntoBatches([], 50, 2000)).toEqual([]);
  });

  it('splits by maxChars boundary', () => {
    const items = [
      { id: 'a', text: 'x'.repeat(900) },
      { id: 'b', text: 'y'.repeat(900) },
      { id: 'c', text: 'z'.repeat(900) }
    ];
    const batches = splitIntoBatches(items, 50, 2000);
    expect(batches.length).toBe(2);
    expect(batches[0].map((i) => i.id)).toEqual(['a', 'b']);
    expect(batches[1].map((i) => i.id)).toEqual(['c']);
  });

  it('splits by maxItems boundary', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, text: 'a' }));
    const batches = splitIntoBatches(items, 50, 2000);
    expect(batches.length).toBe(2);
    expect(batches[0].length).toBe(50);
    expect(batches[1].length).toBe(10);
  });

  it('keeps an oversized single item as its own batch', () => {
    const items = [{ id: 'big', text: 'x'.repeat(5000) }];
    const batches = splitIntoBatches(items, 50, 2000);
    expect(batches.length).toBe(1);
    expect(batches[0][0].id).toBe('big');
  });
});

describe('buildPayload', () => {
  it('maps batch items to a JSON object keyed by index', () => {
    expect(buildPayload([{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }]))
      .toEqual({ '0': 'Hello', '1': 'World' });
  });
});

describe('parseResponse', () => {
  it('parses a plain JSON object', () => {
    expect(parseResponse('{"0":"你好"}')).toEqual({ '0': '你好' });
  });

  it('strips markdown code fences', () => {
    expect(parseResponse('```json\n{"0":"你好"}\n```')).toEqual({ '0': '你好' });
    expect(parseResponse('```\n{"0":"你好"}\n```')).toEqual({ '0': '你好' });
  });

  it('throws on non-JSON and non-object payloads', () => {
    expect(() => parseResponse('not json')).toThrow();
    expect(() => parseResponse('["a"]')).toThrow();
    expect(() => parseResponse('null')).toThrow();
  });
});
