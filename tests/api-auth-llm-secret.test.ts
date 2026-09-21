/**
 * 用户自带 LLM API Key · HTTP 层测试（GET/PUT/DELETE /api/auth/me/llm-secret）。
 *
 * 覆盖：GET 未配置/已配置、PUT 新建/替换/校验失败/写库失败旧 Key 不变、
 * DELETE 幂等、未登录 401、body 混入 userId 被 `.strict()` 拒绝、
 * 响应体永不含完整 Key、以及用户 A/B 的存储级隔离。
 *
 * 无 DB：全部走内存仓储 + 真实 auth service。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDeleteLlmSecretHandler, createGetLlmSecretHandler, createPutLlmSecretHandler } from '../src/http/handlers/llm-secret.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { decryptLlmApiKey } from '../src/llm/key-crypto.ts';
import { FixedClock, InMemoryLlmSecretRepository, InMemorySessionRepository, InMemoryUserRepository, bodyOf } from './fakes.ts';

// 本文件自身进程内的主密钥（key-crypto 逐调用读取，无缓存）
const MASTER_HEX = 'cd'.repeat(32);
process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;

const KEY_A = 'sk-user-a-aaaaaaaaaaaaaaaa-1234';
const KEY_B = 'sk-user-b-bbbbbbbbbbbbbbbb-5678';

class InMemoryFailingSaveLlmSecretRepository extends InMemoryLlmSecretRepository {
  failSave = false;

  override async saveForUser(userId: string, input: { cipher: string; last4: string }): Promise<void> {
    if (this.failSave) throw new Error('db down');
    return super.saveForUser(userId, input);
  }
}

function harness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const llmSecrets = new InMemoryLlmSecretRepository();
  const deps = { auth, llmSecrets };
  return {
    auth,
    users,
    llmSecrets,
    get: createGetLlmSecretHandler(deps),
    put: createPutLlmSecretHandler(deps),
    del: createDeleteLlmSecretHandler(deps),
  };
}

function failingHarness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const llmSecrets = new InMemoryFailingSaveLlmSecretRepository();
  const deps = { auth, llmSecrets };
  return {
    auth,
    llmSecrets,
    get: createGetLlmSecretHandler(deps),
    put: createPutLlmSecretHandler(deps),
    del: createDeleteLlmSecretHandler(deps),
  };
}

async function signUp(auth: ReturnType<typeof createAuthService>, email: string) {
  const result = await auth.register({ email, password: 'pw-12345678', displayName: null });
  return { cookie: `jp_session=${result.token}`, userId: result.user.id };
}

type Method = 'GET' | 'PUT' | 'DELETE';
function req(method: Method, cookie: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`http://t/api/auth/me/llm-secret`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('LLM-SEC-01 未登录：GET / PUT / DELETE 一律 401 UNAUTHENTICATED', async () => {
  const h = harness();
  for (const [handler, method, body] of [
    [h.get, 'GET', undefined],
    [h.put, 'PUT', { apiKey: KEY_A }],
    [h.del, 'DELETE', undefined],
  ] as const) {
    const res = await handler(req(method as Method, null, body));
    assert.equal(res.status, 401, `${method} 未登录必须 401`);
    const data = (await bodyOf(res)) as { error: { code: string } };
    assert.equal(data.error.code, 'UNAUTHENTICATED');
  }
});

test('LLM-SEC-02 未配置：GET 返回 configured=false / last4=null', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'unconfigured@example.com');
  const res = await h.get(req('GET', cookie));
  assert.equal(res.status, 200);
  const data = (await bodyOf(res)) as { data: { configured: boolean; last4: string | null } };
  assert.equal(data.data.configured, false);
  assert.equal(data.data.last4, null);
});

test('LLM-SEC-03 PUT 新 Key：200 + configured + last4；明文不落库、响应不含完整 Key', async () => {
  const h = harness();
  const { cookie, userId } = await signUp(h.auth, 'put@example.com');
  const res = await h.put(req('PUT', cookie, { apiKey: KEY_A }));
  assert.equal(res.status, 200);
  const data = (await bodyOf(res)) as { data: { configured: boolean; last4: string; provider: string } };
  assert.equal(data.data.configured, true);
  assert.equal(data.data.last4, KEY_A.slice(-4));
  assert.ok(data.data.provider === 'deepseek' || data.data.provider === 'qwen', 'provider 标识来自服务端 env');

  // 存的是密文（v1 格式），且与明文不同
  const stored = await h.llmSecrets.findForUser(userId);
  assert.ok(stored, '密文必须已写入');
  assert.match(stored.cipher, /^v1\./);
  assert.ok(!stored.cipher.includes(KEY_A), '密文不得包含明文 Key');

  // 响应体全文不得包含完整 Key
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes(KEY_A), '响应体不得包含完整 API Key');
});

test('LLM-SEC-04 GET 已配置：只返回 configured + last4（+ 服务端 provider 标识）', async () => {
  const h = harness();
  const { cookie } = await signUp(h.auth, 'get@example.com');
  await h.put(req('PUT', cookie, { apiKey: KEY_A }));
  const res = await h.get(req('GET', cookie));
  assert.equal(res.status, 200);
  const data = (await bodyOf(res)) as { data: { configured: boolean; last4: string | null } };
  assert.equal(data.data.configured, true);
  assert.equal(data.data.last4, KEY_A.slice(-4));
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes(KEY_A), 'GET 响应不得包含完整 API Key');
});

test('LLM-SEC-05 PUT 替换：last4 与密文都更新，且密文互不相同', async () => {
  const h = harness();
  const { cookie, userId } = await signUp(h.auth, 'replace@example.com');
  await h.put(req('PUT', cookie, { apiKey: KEY_A }));
  const before = (await h.llmSecrets.findForUser(userId))!;
  const res = await h.put(req('PUT', cookie, { apiKey: KEY_B }));
  assert.equal(res.status, 200);
  const after = (await h.llmSecrets.findForUser(userId))!;
  assert.notEqual(after.cipher, before.cipher, '替换后密文必须更新');
  assert.notEqual(after.last4, before.last4);
  assert.equal(decryptLlmApiKey(after.cipher, userId), KEY_B);
});

test('LLM-SEC-06 PUT 校验失败：过短 / 过长 / 含空白 / 混入 userId → 400 且不落库', async () => {
  const h = harness();
  const { cookie, userId } = await signUp(h.auth, 'invalid@example.com');
  const badBodies: unknown[] = [
    { apiKey: 'short' },                      // 过短
    { apiKey: 'k'.repeat(201) },              // 过长
    { apiKey: 'sk-has space-inside-key-0000' }, // 含空白
    { apiKey: KEY_A, userId },                // 混入 userId → .strict() 拒绝
    {},                                       // 缺字段
  ];
  for (const body of badBodies) {
    const res = await h.put(req('PUT', cookie, body));
    assert.equal(res.status, 400, `非法请求体必须 400：${JSON.stringify(body).slice(0, 60)}`);
    const data = (await bodyOf(res)) as { error: { code: string } };
    assert.equal(data.error.code, 'VALIDATION_FAILED');
  }
  assert.equal(await h.llmSecrets.findForUser(userId), null, '校验失败不得写入任何 Key');
});

test('LLM-SEC-07 PUT 写库失败：500，且旧 Key 保持不变（原子性）', async () => {
  const f = failingHarness();
  const { cookie, userId } = await signUp(f.auth, 'atomic@example.com');
  await f.put(req('PUT', cookie, { apiKey: KEY_A }));
  const before = (await f.llmSecrets.findForUser(userId))!;

  f.llmSecrets.failSave = true;
  const res = await f.put(req('PUT', cookie, { apiKey: KEY_B }));
  assert.equal(res.status, 500, '写库失败必须映射为 500 INTERNAL_ERROR');
  const data = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(data.error.code, 'INTERNAL_ERROR');

  const after = (await f.llmSecrets.findForUser(userId))!;
  assert.equal(after.cipher, before.cipher, '写库失败后旧密文必须保持不变');
  assert.equal(after.last4, before.last4, '写库失败后旧 last4 必须保持不变');
});

test('LLM-SEC-08 DELETE：只删除当前用户；未配置时幂等；删除后 GET 为未配置', async () => {
  const h = harness();
  const a = await signUp(h.auth, 'del-a@example.com');
  const b = await signUp(h.auth, 'del-b@example.com');
  await h.put(req('PUT', a.cookie, { apiKey: KEY_A }));
  await h.put(req('PUT', b.cookie, { apiKey: KEY_B }));

  const res = await h.del(req('DELETE', a.cookie));
  assert.equal(res.status, 200);
  const data = (await bodyOf(res)) as { data: { configured: boolean } };
  assert.equal(data.data.configured, false);

  // B 不受影响
  const bView = (await bodyOf(await h.get(req('GET', b.cookie)))) as { data: { configured: boolean; last4: string } };
  assert.equal(bView.data.configured, true);
  assert.equal(bView.data.last4, KEY_B.slice(-4));

  // 幂等
  const again = await h.del(req('DELETE', a.cookie));
  assert.equal(again.status, 200);
});

test('LLM-SEC-09 用户隔离：A/B 各自独立；A 的密文对 B 的身份不可解；响应互不泄露', async () => {
  const h = harness();
  const a = await signUp(h.auth, 'iso-a@example.com');
  const b = await signUp(h.auth, 'iso-b@example.com');

  await h.put(req('PUT', a.cookie, { apiKey: KEY_A }));
  await h.put(req('PUT', b.cookie, { apiKey: KEY_B }));

  const aView = (await bodyOf(await h.get(req('GET', a.cookie)))) as { data: { last4: string; configured: boolean } };
  const bView = (await bodyOf(await h.get(req('GET', b.cookie)))) as { data: { last4: string; configured: boolean } };
  assert.equal(aView.data.configured, true);
  assert.equal(bView.data.configured, true);
  assert.notEqual(aView.data.last4, bView.data.last4, 'A 与 B 的 last4 必须不同');
  assert.equal(aView.data.last4, KEY_A.slice(-4));

  const cipherA = (await h.llmSecrets.findForUser(a.userId))!;
  const cipherB = (await h.llmSecrets.findForUser(b.userId))!;
  assert.notEqual(cipherA.cipher, cipherB.cipher);
  // 密码学层：AAD 绑定身份 —— 用 B 的身份解 A 的密文必须失败
  assert.throws(() => decryptLlmApiKey(cipherA.cipher, b.userId));
  assert.throws(() => decryptLlmApiKey(cipherB.cipher, a.userId));
  assert.equal(decryptLlmApiKey(cipherA.cipher, a.userId), KEY_A);
  assert.equal(decryptLlmApiKey(cipherB.cipher, b.userId), KEY_B);
});
