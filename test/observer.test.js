import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../src/content/observer.js';

const Observer = globalThis.Ext.observer;

beforeEach(() => { document.body.innerHTML = ''; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('start', () => {
  it('debounces a burst of mutations into one callback', async () => {
    const calls = [];
    const handle = Observer.start(document.body, { debounceMs: 500, onNewNodes: (roots) => calls.push(roots) });
    const div = document.createElement('div');
    document.body.appendChild(div);
    div.appendChild(document.createElement('span'));
    await vi.advanceTimersByTimeAsync(499);
    expect(calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.length).toBe(1);
    // 回调给出新增子树根
    expect(calls[0].some((n) => n === div)).toBe(true);
    handle.stop();
  });

  it('reports characterData changes as their parent element', async () => {
    const p = document.createElement('p');
    p.textContent = 'seed';
    document.body.appendChild(p);
    const calls = [];
    const handle = Observer.start(document.body, { debounceMs: 100, onNewNodes: (roots) => calls.push(roots) });
    p.firstChild.nodeValue = 'changed';
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(p);
    handle.stop();
  });

  it('stop() prevents further callbacks', async () => {
    const calls = [];
    const handle = Observer.start(document.body, { debounceMs: 100, onNewNodes: (roots) => calls.push(roots) });
    handle.stop();
    document.body.appendChild(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(0);
  });
});