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

  it('reports attribute changes for the configured filter', async () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const calls = [];
    const handle = Observer.start(document.body, {
      debounceMs: 100,
      attributeFilter: ['placeholder', 'title'],
      onNewNodes: (roots) => calls.push(roots)
    });
    el.setAttribute('title', 'Tip');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(el);
    handle.stop();
  });

  it('ignores attributes outside the filter, and all attributes without a filter', async () => {
    const el = document.createElement('input');
    document.body.appendChild(el);
    const calls = [];
    const filtered = Observer.start(document.body, {
      debounceMs: 100,
      attributeFilter: ['title'],
      onNewNodes: (roots) => calls.push(roots)
    });
    el.setAttribute('placeholder', 'Search');
    el.setAttribute('data-x', '1');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(0);
    filtered.stop();

    const unfiltered = Observer.start(document.body, { debounceMs: 100, onNewNodes: (roots) => calls.push(roots) });
    el.setAttribute('title', 'Tip');
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(0);
    unfiltered.stop();
  });

  it('re-queues and retries later when the callback reports the nodes are not ready', async () => {
    let busy = true;
    const calls = [];
    const handle = Observer.start(document.body, {
      debounceMs: 100,
      onNewNodes: (roots) => {
        calls.push(roots);
        return busy ? false : undefined;
      }
    });
    const div = document.createElement('div');
    document.body.appendChild(div);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(1); // 首次尝试被回绝
    busy = false;
    await vi.advanceTimersByTimeAsync(100); // 重新入队后重试
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain(div); // 节点没有在忙碌期间被丢弃
    await vi.advanceTimersByTimeAsync(500);
    expect(calls.length).toBe(2); // 成功处理后排空,不再重试
    handle.stop();
  });

  it('re-queues nodes when the callback throws, instead of losing them', async () => {
    let shouldThrow = true;
    const calls = [];
    const handle = Observer.start(document.body, {
      debounceMs: 100,
      onNewNodes: (roots) => {
        calls.push(roots);
        if (shouldThrow) throw new Error('boom');
        return undefined;
      }
    });
    const div = document.createElement('div');
    document.body.appendChild(div);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(1); // 异常被吞掉,不向外抛、不破坏计时器状态
    shouldThrow = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(2);
    expect(calls[1]).toContain(div); // 节点被重新入队重试
    handle.stop();
  });

  it('drops the batch after maxErrors consecutive callback failures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls = [];
    const handle = Observer.start(document.body, {
      debounceMs: 100,
      maxErrors: 3,
      onNewNodes: (roots) => { calls.push(roots); throw new Error('persistent bug'); }
    });
    const div = document.createElement('div');
    document.body.appendChild(div);
    // 首次 + 3 次重试(共 4 次调用)后放弃:透支上限的那一次直接丢弃不再排队
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls.length).toBe(4); // 已放弃,不再空转
    expect(warn).toHaveBeenCalled(); // 每次失败与放弃都有告警,不再静默
    warn.mockRestore();
    handle.stop();
  });

  it('keeps re-queuing busy backpressure without a retry cap', async () => {
    let busy = true;
    const calls = [];
    const handle = Observer.start(document.body, {
      debounceMs: 100,
      maxErrors: 2, // 上限只约束"抛异常",忙背压不受影响——慢翻译中丢节点不可接受
      onNewNodes: (roots) => {
        calls.push(roots);
        return busy ? false : undefined;
      }
    });
    const div = document.createElement('div');
    document.body.appendChild(div);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(3); // 忙等待持续重试,不被 maxErrors 截断
    busy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.length).toBe(4);
    expect(calls[3]).toContain(div);
    handle.stop();
  });
});
