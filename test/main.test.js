// Content 侧流式上屏:TRANSLATE_BATCH 请求发出后,每收到一批 RESULT_BATCH 立即应用,
// 而不是等全部批次返回后一次性渲染。通过可控制的 chrome 消息总线驱动真实 main.js。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../src/shared/constants.js';

const stub = vi.hoisted(() => {
  const listeners = [];
  const Chrome = {
    // 复用 test/setup.js 注入的 chrome.i18n(hoisted 会整体替换 globalThis.chrome)
    i18n: globalThis.chrome && globalThis.chrome.i18n,
    runtime: {
      onMessage: {
        addListener(fn) { listeners.push(fn); },
        removeListener(fn) {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        }
      },
      sendMessage: () => Promise.resolve({ ok: false, error: 'unhandled' })
    },
    storage: { local: { get: async () => ({}) } }
  };
  globalThis.chrome = Chrome;
  return {
    listeners,
    dispatch(msg) { listeners.slice().forEach((fn) => fn(msg, null, () => {})); },
    setSend(fn) { Chrome.runtime.sendMessage = fn; },
    setStoredConfig(cfg) {
      Chrome.storage.local.get = async () => ({ [globalThis.EXT_CONSTANTS.STORAGE_KEYS.CONFIG]: cfg });
    }
  };
});

// vi.hoisted 之后按依赖顺序加载 content 脚本;main.js 注册的运行时监听器会进 stub.listeners
import '../src/shared/i18n.js';
import '../src/content/collect.js';
import '../src/content/apply.js';
import '../src/content/detect.js';
import '../src/content/observer.js';
import '../src/content/main.js';

const C = globalThis.EXT_CONSTANTS;

// 挂起的 TRANSLATE_BATCH 响应(测试中途断言失败时也要在 afterEach 里 resolve,
// 否则 translatePage 永远卡在 await,translating 泄漏到下一个用例)
let pendingTranslate = null;

// 向 content 的运行时监听器发一次 TOGGLE,返回最终 sendResponse 的 Promise
function toggle() {
  const handler = stub.listeners[0];
  return new Promise((resolve) => handler({ type: C.MSG.TOGGLE }, null, resolve));
}

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  stub.setStoredConfig({ baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm', targetLang: 'zh-CN' });
  stub.setSend(() => Promise.resolve({ ok: false, error: 'unhandled' }));
});

afterEach(async () => {
  if (pendingTranslate) {
    pendingTranslate.resolve({ ok: true, translations: {}, partial: false });
    pendingTranslate = null;
  }
  // translated 状态下再点一次 = 还原页面,顺便停掉 MutationObserver,避免遗留到下一用例
  await toggle();
  document.body.innerHTML = '';
});

describe('streaming translation into the page', () => {
  it('applies each batch as soon as its result arrives, not only after all batches respond', async () => {
    document.body.innerHTML = '<div id="x1">Hello</div><div id="x2">World</div>';
    let translateMsg = null;
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        translateMsg = msg;
        return new Promise((resolve) => { pendingTranslate = { resolve, msg }; });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });

    const done = toggle(); // 开始翻译,内部 await TRANSLATE_BATCH 的响应
    await nextTick();
    expect(translateMsg).not.toBeNull();
    expect(translateMsg.items.length).toBe(2);

    const helloId = translateMsg.items.find((i) => i.text === 'Hello').id;
    const worldId = translateMsg.items.find((i) => i.text === 'World').id;

    // 第一批先回来:只含 Hello 的译文 → 该节点立即上屏,World 仍是原文
    stub.dispatch({ type: C.MSG.RESULT_BATCH, translations: { [helloId]: '你好' } });
    expect(document.getElementById('x1').textContent).toBe('你好');
    expect(document.getElementById('x2').textContent).toBe('World');

    // 最终响应补齐剩余译文
    pendingTranslate.resolve({ ok: true, translations: { [helloId]: '你好', [worldId]: '世界' }, partial: false });
    pendingTranslate = null;
    const res = await done;
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('translated');
    expect(res.translated).toBe(2);
    expect(document.getElementById('x2').textContent).toBe('世界');
  });

  it('applies everything from the final response when no batch push arrives (fallback)', async () => {
    document.body.innerHTML = '<p>Hello</p>';
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        return Promise.resolve({ ok: true, translations: { i0: '你好' }, partial: false });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    const res = await toggle();
    expect(res.ok).toBe(true);
    expect(res.reason).toBe('translated');
    expect(res.translated).toBe(1);
    expect(document.body.textContent).toBe('你好');
  });

  it('keeps streamed translations restorable when the full response never arrives', async () => {
    document.body.innerHTML = '<div id="x1">Hello</div><div id="x2">World</div>';
    let translateMsg = null;
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        translateMsg = msg;
        return new Promise((resolve, reject) => { pendingTranslate = { resolve, reject, msg }; });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    const done = toggle();
    await nextTick();
    const helloId = translateMsg.items.find((i) => i.text === 'Hello').id;
    stub.dispatch({ type: C.MSG.RESULT_BATCH, translations: { [helloId]: '你好' } });
    expect(document.getElementById('x1').textContent).toBe('你好');
    // 整包响应永远不回(如 SW 被回收):reject
    pendingTranslate.reject(new Error('No response from background'));
    pendingTranslate = null;
    const res = await done;
    expect(res.ok).toBe(false); // 错误照常上报
    expect(res.state).toBe(C.STATE.TRANSLATED); // 但状态与 DOM 一致,保持"已翻译"
    expect(res.translated).toBe(1);
    // 再点一次 = 还原,已上屏的译文可以被撤掉
    const restored = await toggle();
    expect(restored.ok).toBe(true);
    expect(restored.restored).toBe(1);
    expect(document.getElementById('x1').textContent).toBe('Hello');
    // 还原后状态归 idle,避免 afterEach 的 toggle 再触发一次翻译流程
    stub.setSend(() => Promise.resolve({ ok: false, error: 'unhandled' }));
  });

  it('discards in-flight batch results that arrive after a restore (generation guard)', async () => {
    document.body.innerHTML = '<p>First</p>';
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        return Promise.resolve({ ok: true, translations: { i0: '翻译' }, partial: false });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    await toggle();
    expect(document.body.textContent).toBe('翻译');
    // 动态补翻:新增节点触发观察器补翻,响应挂起
    let dynamicResolve = null;
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        return new Promise((resolve) => { dynamicResolve = resolve; });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    const p = document.createElement('p');
    p.textContent = 'Second';
    document.body.appendChild(p);
    await new Promise((r) => setTimeout(r, 700)); // 等观察器防抖并触发补翻
    expect(dynamicResolve).not.toBeNull();
    // 补翻进行中点击还原
    const restored = await toggle();
    expect(restored.ok).toBe(true);
    expect(document.body.textContent).toBe('FirstSecond');
    // 在途回包此时到达:不得把译文重新写回已还原的页面
    dynamicResolve({ ok: true, translations: { i0: '翻译' }, partial: false });
    await nextTick();
    expect(p.textContent).toBe('Second');
    // 还原后状态归 idle,避免 afterEach 的 toggle 再触发一次翻译流程
    stub.setSend(() => Promise.resolve({ ok: false, error: 'unhandled' }));
  });

  it('excludes noop records from user-facing counts, but keeps them skippable', async () => {
    // 'Same' 的译文与原文相同 → noop:DOM 不改,但要标记 skip,计数不得虚高
    document.body.innerHTML = '<p>Hello</p><p>Same</p>';
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        return Promise.resolve({ ok: true, translations: { i0: '你好', i1: 'Same' }, partial: false });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    const res = await toggle();
    expect(res.ok).toBe(true);
    expect(res.translated).toBe(1); // 只有真正写回的 Hello
    expect(res.chars).toBe(5); // noop 的 4 个字符不计入"共 X 字"
    expect(document.body.textContent).toBe('你好Same');
  });

  it('reports no-text for an empty page without starting translation', async () => {
    document.body.innerHTML = '';
    let translateCalls = 0;
    stub.setSend((msg) => {
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        translateCalls += 1;
        return Promise.resolve({ ok: true, translations: {}, partial: false });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    const res = await toggle();
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no-text');
    expect(translateCalls).toBe(0); // 无文本直接返回,不发翻译请求
    // 空页面也走了"翻译失败保持 idle"分支:观察器已停,可直接重试
    stub.setSend(() => Promise.resolve({ ok: false, error: 'unhandled' }));
  });

  it('restores and retranslates in one toggle when the target language changed', async () => {
    document.body.innerHTML = '<p>Hello</p>';
    const calls = [];
    stub.setSend((msg) => {
      calls.push(msg);
      if (msg.type === C.MSG.DETECT_LANGUAGE) return Promise.resolve({ ok: true, language: 'fr' });
      if (msg.type === C.MSG.TRANSLATE_BATCH) {
        const target = msg.targetLang;
        return Promise.resolve({ ok: true, translations: { i0: target === 'zh-CN' ? '你好' : 'Hallo' }, partial: false });
      }
      return Promise.resolve({ ok: false, error: 'unexpected ' + msg.type });
    });
    const first = await toggle();
    expect(first.reason).toBe('translated');
    expect(document.body.textContent).toBe('你好');

    stub.setStoredConfig({ baseUrl: 'https://api.test/v1', apiKey: 'sk-test', model: 'm', targetLang: 'de' });
    const switched = await toggle();
    expect(switched.reason).toBe('translated');
    expect(document.body.textContent).toBe('Hallo');
    expect(calls.filter((msg) => msg.type === C.MSG.TRANSLATE_BATCH).map((msg) => msg.targetLang))
      .toEqual(['zh-CN', 'de']);
  });
});
