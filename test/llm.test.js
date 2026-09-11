import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/shared/i18n.js';
import '../src/background/llm.js';

const Llm = globalThis.Ext.llm;
const config = { baseUrl: 'https://api.test/v1/', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN' };

// 未显式传入 logger 的用例走默认 console:静默掉,避免日志刷屏测试输出
let consoleSpies;
beforeEach(() => {
  consoleSpies = ['log', 'warn'].map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleSpies.forEach((s) => s.mockRestore());
});

describe('joinUrl / chatCompletionsUrl', () => {
  it('joins base and path trimming trailing slashes', () => {
    expect(Llm.joinUrl('https://api.test/v1/', '/chat/completions')).toBe('https://api.test/v1/chat/completions');
    expect(Llm.joinUrl('https://api.test/v1', '/chat/completions')).toBe('https://api.test/v1/chat/completions');
  });

  it('does not duplicate /chat/completions when the base URL already contains it', () => {
    expect(Llm.chatCompletionsUrl('https://api.test/v1')).toBe('https://api.test/v1/chat/completions');
    expect(Llm.chatCompletionsUrl('https://api.test/v1/')).toBe('https://api.test/v1/chat/completions');
    expect(Llm.chatCompletionsUrl('https://api.test/v1/chat/completions')).toBe('https://api.test/v1/chat/completions');
    expect(Llm.chatCompletionsUrl('  https://api.test/v1/chat/completions/  ')).toBe('https://api.test/v1/chat/completions');
  });
});

describe('buildRequestBody', () => {
  it('contains model, zero temperature and translated system prompt', () => {
    const body = Llm.buildRequestBody(config, { '0': 'Hello' });
    expect(body.model).toBe('m1');
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toContain('zh-CN');
    expect(body.messages[1].role).toBe('user');
    expect(JSON.parse(body.messages[1].content)).toEqual({ '0': 'Hello' });
  });
});

describe('extractContent', () => {
  it('extracts choices[0].message.content', () => {
    expect(Llm.extractContent({ choices: [{ message: { content: '{"0":"你好"}' } }] })).toBe('{"0":"你好"}');
  });
  it('throws on unexpected shape', () => {
    expect(() => Llm.extractContent({})).toThrow();
    expect(() => Llm.extractContent(null)).toThrow();
  });
});

describe('translateViaLlm', () => {
  const okBody = JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] });

  it('posts to base/chat/completions with bearer auth and returns content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => okBody });
    const raw = await Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl);
    expect(raw).toBe('{"0":"你好"}');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('throws with HTTP status, request URL and body excerpt on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    await expect(Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl))
      .rejects.toThrow('LLM API HTTP 401 (https://api.test/v1/chat/completions): bad key');
  });

  it('explains HTML responses (wrong Base URL) instead of a raw JSON parse error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<!doctype html><html><head><title>Just a moment...</title></head></html>'
    });
    const err = await Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl).then(
      () => { throw new Error('should have rejected'); },
      (e) => e
    );
    expect(err.message).toContain('Non-JSON response');
    expect(err.message).toContain('https://api.test/v1/chat/completions');
    expect(err.message).toContain('<!doctype html>');
    expect(err.message).toContain('Base URL');
  });

  it('falls back to global fetch when fetchImpl is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => okBody });
    vi.stubGlobal('fetch', fetchMock);
    const raw = await Llm.translateViaLlm(config, { '0': 'Hello' });
    expect(raw).toBe('{"0":"你好"}');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('aborts with a timeout error when the endpoint never responds', async () => {
    // 永不 resolve 的 fetch,只能靠 AbortSignal 结束(模拟地址不可达挂起)
    const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
    await expect(Llm.translateViaLlm({ ...config, timeoutMs: 10 }, { '0': 'Hello' }, fetchImpl))
      .rejects.toThrow('Request timed out');
  });

  it('reports a network failure together with the request URL', async () => {
    const fetchImpl = async () => { throw new Error('Failed to fetch'); };
    await expect(Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl))
      .rejects.toThrow(/Request failed.*api\.test/);
  });
});

describe('request/response logging', () => {
  const okBody = JSON.stringify({ choices: [{ message: { content: '{"0":"你好"}' } }] });
  const makeLogger = () => ({ log: vi.fn(), warn: vi.fn() });

  it('logs the request body and the raw response body', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => okBody });
    await Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl, logger);

    const requestLine = logger.log.mock.calls.find((c) => String(c[0]).includes('→ POST'));
    expect(String(requestLine[0])).toContain('https://api.test/v1/chat/completions');
    expect(String(requestLine[1])).toContain('Hello');

    const responseLine = logger.log.mock.calls.find((c) => String(c[0]).includes('← HTTP'));
    expect(String(responseLine[0])).toContain('← HTTP 200');
    expect(String(responseLine[1])).toContain('你好');
  });

  it('never logs the API key', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => okBody });
    await Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl, logger);
    const output = [...logger.log.mock.calls, ...logger.warn.mock.calls]
      .map((c) => JSON.stringify(c)).join('\n');
    expect(output).not.toContain('sk-test');
  });

  it('logs the HTTP status and body when the response is an error', async () => {
    const logger = makeLogger();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    await expect(Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl, logger)).rejects.toThrow();
    const responseLine = logger.log.mock.calls.find((c) => String(c[0]).includes('← HTTP'));
    expect(String(responseLine[0])).toContain('← HTTP 401');
    expect(String(responseLine[1])).toContain('bad key');
  });

  it('logs the request first, then warns with the URL on timeout', async () => {
    const logger = makeLogger();
    const fetchImpl = (url, opts) => new Promise((resolve, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      }
    });
    await expect(Llm.translateViaLlm({ ...config, timeoutMs: 10 }, { '0': 'Hello' }, fetchImpl, logger))
      .rejects.toThrow('Request timed out');
    expect(logger.log.mock.calls.some((c) => String(c[0]).includes('→ POST'))).toBe(true);
    const warnLine = logger.warn.mock.calls.find((c) => String(c[0]).includes('request timed out'));
    expect(String(warnLine[0])).toContain('https://api.test/v1/chat/completions');
  });
});
