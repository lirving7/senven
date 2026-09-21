import test from 'node:test';
import assert from 'node:assert/strict';

import { LLMError, LLMFormatError, LLMTimeoutError, DEFAULT_TIMEOUT_MS } from '../src/llm/provider.ts';
import type { LLMProvider } from '../src/llm/provider.ts';
import { FakeValidProvider, FakeInvalidJsonProvider } from '../src/llm/fake-providers.ts';
import { DeepSeekProvider, DEEPSEEK_BASE_URL } from '../src/llm/deepseek-provider.ts';
import { QwenProvider, QWEN_BASE_URL } from '../src/llm/qwen-provider.ts';

const SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
};

const VALID_PAYLOAD = { ok: true };

function makeMockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  const fn = async (input: unknown, init?: unknown): Promise<Response> =>
    handler(String(input), (init ?? {}) as RequestInit);
  return fn as unknown as typeof fetch;
}

function chatResponse(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function providerWithMockedFetch(make: (fetchImpl: typeof fetch) => LLMProvider, content: string) {
  let lastUrl = '';
  let lastInit: RequestInit = {};
  const provider = make(
    makeMockFetch((url, init) => {
      lastUrl = url;
      lastInit = init;
      return chatResponse(content);
    }),
  );
  return {
    provider,
    sent: () => ({ url: lastUrl, init: lastInit }),
  };
}

function runContract(label: string, make: () => LLMProvider, jsonOk: boolean) {
  test(`[契约] ${label}：实现 LLMProvider 最小契约`, async () => {
    const provider = make();
    assert.equal(typeof provider.name, 'string');
    assert.ok(provider.name.length > 0, 'name 不能为空');
    assert.equal(typeof provider.json, 'function');
    assert.equal(typeof provider.text, 'function');

    if (jsonOk) {
      const out = await provider.json<{ ok: boolean }>({ prompt: 'p', schema: SCHEMA });
      assert.equal(typeof out, 'object');
      assert.notEqual(out, null);
    } else {
      await assert.rejects(
        () => provider.json({ prompt: 'p', schema: SCHEMA }),
        (err: unknown) =>
          err instanceof LLMFormatError && err.code === 'FORMAT' && err.provider === provider.name,
      );
    }

    const text = await provider.text({ prompt: 'p' });
    assert.equal(typeof text, 'string');
  });
}

runContract('FakeValidProvider', () => new FakeValidProvider(VALID_PAYLOAD), true);
runContract('FakeInvalidJsonProvider', () => new FakeInvalidJsonProvider(), false);
runContract('DeepSeekProvider(模拟响应)', () => new DeepSeekProvider({ apiKey: 'k', fetchImpl: makeMockFetch(() => chatResponse('{"ok":true}')) }), true);
runContract('QwenProvider(模拟响应)', () => new QwenProvider({ apiKey: 'k', fetchImpl: makeMockFetch(() => chatResponse('{"ok":true}')) }), true);

test('DeepSeekProvider：请求形状正确（端点 / 模型 / json 模式 / 超时信号）', async () => {
  const { provider, sent } = providerWithMockedFetch(
    (fetchImpl) => new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-v4-flash', fetchImpl }),
    '{"ok":true}',
  );
  const out = await provider.json<{ ok: boolean }>({ system: 'sys', prompt: 'hello', schema: SCHEMA });
  assert.deepEqual(out, { ok: true });

  const { url, init } = sent();
  assert.equal(url, `${DEEPSEEK_BASE_URL}/chat/completions`);
  assert.equal(init.method, 'POST');
  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer sk-test');

  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.equal(body.stream, false);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, 'sys');
  assert.equal(messages[1].content, 'hello');
  assert.ok(init.signal, '必须带超时 signal');
});

test('ARCH-1：未 opt-in 时 schema 不注入 system prompt（既有特性默认行为不变）', async () => {
  const { provider, sent } = providerWithMockedFetch(
    (fetchImpl) => new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-v4-flash', fetchImpl }),
    '{"ok":true}',
  );
  await provider.json({ system: 'sys', prompt: 'hello', schema: SCHEMA });
  const body = JSON.parse(String(sent().init.body)) as Record<string, unknown>;
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0].content, 'sys', '未 opt-in 时 system 应原样，不注入 schema');
  assert.equal(messages.length, 2);
});

test('ARCH-1：schemaInPrompt=true 时才把 schema 注入 system prompt（Interview 专属 opt-in）', async () => {
  const { provider, sent } = providerWithMockedFetch(
    (fetchImpl) => new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-v4-flash', fetchImpl }),
    '{"ok":true}',
  );
  await provider.json({ system: 'sys', prompt: 'hello', schema: SCHEMA, schemaInPrompt: true });
  const body = JSON.parse(String(sent().init.body)) as Record<string, unknown>;
  assert.deepEqual(body.response_format, { type: 'json_object' }, '仍用 json_object，不伪装 json_schema');
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.ok(messages[0].content.includes('JSON Schema'), 'opt-in 时应注入 schema 约束');
  assert.ok(messages[0].content.includes('"ok"'), 'opt-in 时应包含 schema 字段');
  assert.equal(messages[1].content, 'hello');
});

test('QwenProvider：默认走百炼 OpenAI 兼容端点', async () => {
  const { provider, sent } = providerWithMockedFetch(
    (fetchImpl) => new QwenProvider({ apiKey: 'sk-q', fetchImpl }),
    '{"ok":true}',
  );
  await provider.json({ prompt: 'p', schema: SCHEMA });
  assert.equal(sent().url, `${QWEN_BASE_URL}/chat/completions`);
  const body = JSON.parse(String(sent().init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'qwen-plus');
});

test('text() 不带 json 模式', async () => {
  const { provider, sent } = providerWithMockedFetch(
    (fetchImpl) => new DeepSeekProvider({ apiKey: 'k', fetchImpl }),
    '纯文本结果',
  );
  const out = await provider.text({ prompt: 'p' });
  assert.equal(out, '纯文本结果');
  const body = JSON.parse(String(sent().init.body)) as Record<string, unknown>;
  assert.equal(body.response_format, undefined);
});

test('坏 JSON → LLMFormatError，不带出半成品', async () => {
  const provider = new DeepSeekProvider({
    apiKey: 'k',
    fetchImpl: makeMockFetch(() => chatResponse('{"skills": [')),
  });
  await assert.rejects(
    () => provider.json({ prompt: 'p', schema: SCHEMA }),
    (err: unknown) => err instanceof LLMFormatError && err.code === 'FORMAT' && err.provider === 'deepseek',
  );
});

test('空 content → LLMFormatError', async () => {
  const provider = new QwenProvider({
    apiKey: 'k',
    fetchImpl: makeMockFetch(() => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }))),
  });
  await assert.rejects(() => provider.json({ prompt: 'p', schema: SCHEMA }), LLMFormatError);
});

test('HTTP 401 → AUTH；HTTP 429 → RATE_LIMIT；HTTP 500 → UPSTREAM', async () => {
  const make = (status: number) =>
    new DeepSeekProvider({
      apiKey: 'k',
      fetchImpl: makeMockFetch(() => new Response('err', { status })),
    });
  await assert.rejects(() => make(401).text({ prompt: 'p' }), (e: unknown) => e instanceof LLMError && e.code === 'AUTH');
  await assert.rejects(() => make(429).text({ prompt: 'p' }), (e: unknown) => e instanceof LLMError && e.code === 'RATE_LIMIT');
  await assert.rejects(() => make(500).text({ prompt: 'p' }), (e: unknown) => e instanceof LLMError && e.code === 'UPSTREAM');
});

test('超时 → LLMTimeoutError（不降级为通用错误）', async () => {
  const timeoutErr = new Error('The operation was aborted due to timeout');
  timeoutErr.name = 'TimeoutError';
  const provider = new DeepSeekProvider({
    apiKey: 'k',
    fetchImpl: makeMockFetch(() => {
      throw timeoutErr;
    }),
  });
  await assert.rejects(
    () => provider.json({ prompt: 'p', schema: SCHEMA, timeoutMs: 1 }),
    (e: unknown) => e instanceof LLMTimeoutError && e.code === 'TIMEOUT' && e.provider === 'deepseek',
  );
});

test('默认超时为 30s', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
});

test('守门：不做 fallback / 多模型路由 / 插件注册表', () => {
  const provider = new DeepSeekProvider({ apiKey: 'k' });
  const names = [
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(provider)),
    ...Object.keys(provider),
  ];
  for (const n of names) {
    assert.ok(!/fallback|route|routing|register|plugin/i.test(n), `出现了 V1 明确不做的能力：${n}`);
  }
});

const liveKey = process.env.DEEPSEEK_API_KEY ?? '';
test(
  '[live] DeepSeek 真实调用（需 DEEPSEEK_API_KEY）',
  { skip: liveKey === '' ? '未设置 DEEPSEEK_API_KEY，跳过真实调用' : false },
  async () => {
    const provider = new DeepSeekProvider({ apiKey: liveKey });
    const out = await provider.json<{ ok: boolean }>({
      prompt: '只返回 JSON：{"ok": true}',
      schema: SCHEMA,
      timeoutMs: 20_000,
    });
    assert.equal(typeof out, 'object');
  },
);
