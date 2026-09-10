import { describe, it, expect, vi, afterEach } from 'vitest';
import '../src/shared/constants.js';
import '../src/background/llm.js';

const Llm = globalThis.Ext.llm;
const config = { baseUrl: 'https://api.test/v1/', apiKey: 'sk-test', model: 'm1', targetLang: 'zh-CN' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('joinUrl', () => {
  it('joins base and path trimming trailing slashes', () => {
    expect(Llm.joinUrl('https://api.test/v1/', '/chat/completions')).toBe('https://api.test/v1/chat/completions');
    expect(Llm.joinUrl('https://api.test/v1', '/chat/completions')).toBe('https://api.test/v1/chat/completions');
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
  it('posts to base/chat/completions with bearer auth and returns content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"0":"你好"}' } }] }),
      text: async () => ''
    });
    const raw = await Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl);
    expect(raw).toBe('{"0":"你好"}');
    const [url, opts] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('throws with HTTP status and body excerpt on failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' });
    await expect(Llm.translateViaLlm(config, { '0': 'Hello' }, fetchImpl)).rejects.toThrow('LLM API HTTP 401');
  });

  it('falls back to global fetch when fetchImpl is omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"0":"你好"}' } }] }),
      text: async () => ''
    });
    vi.stubGlobal('fetch', fetchMock);
    const raw = await Llm.translateViaLlm(config, { '0': 'Hello' });
    expect(raw).toBe('{"0":"你好"}');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });
});
