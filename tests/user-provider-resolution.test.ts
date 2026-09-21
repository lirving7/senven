/**
 * providerFor(userId) · 用户 scoped Provider 解析测试（Migration #19；2026-09-21 授权）。
 *
 * 证明（真实 DB + 全局 fetch 拦截，无真实出站流量）：
 *   A 有 Key   → provider 使用 A_KEY
 *   B 有 Key   → provider 使用 B_KEY
 *   无 Key     → 回落 env Provider（T5B-F-08 默认路径）
 *   解密失败   → 回落 env Provider（按「没有可用 Key」处理）
 *
 * PostgreSQL 不可达时整份 skip。测试通过 stub 全局 fetch 捕获 Authorization 头，
 * 不产生真实 LLM 调用、不消耗真实配额。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { providerFor } from '../src/http/deps.ts';
import { providerFromEnv } from '../src/llm/factory.ts';
import { encryptLlmApiKey } from '../src/llm/key-crypto.ts';

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = dbUp ? false : 'PostgreSQL 不可达，跳过 provider 解析测试';

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);

// 固定测试环境：主密钥 + 假上游 + env 兜底 Key（providerFor 逐调用读取 env，无缓存）
const MASTER_HEX = 'ef'.repeat(32);
const ENV_KEY = 'sk-env-fallback-000000000000';
const KEY_A = 'sk-user-a-key-aaaaaaaaaaaaaaaa';
const KEY_B = 'sk-user-b-key-bbbbbbbbbbbbbbbb';
const FAKE_BASE = 'http://llm-fake.test/v1';

function auth() {
  return createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
}

async function createUser(tag: string): Promise<{ id: string; token: string }> {
  const result = await auth().register({
    email: `prov_${tag}_${stamp}@example.com`,
    password: 'password-1234',
    displayName: null,
  });
  return { id: result.user.id, token: result.token };
}

async function storeUserKey(userId: string, plainKey: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { llmApiKeyCipher: encryptLlmApiKey(plainKey, userId), llmApiKeyLast4: plainKey.slice(-4) },
  });
}

async function storeRawCipher(userId: string, cipher: string): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { llmApiKeyCipher: cipher, llmApiKeyLast4: 'zzzz' } });
}

test('PROV-00 环境准备：env 兜底 Key + 假上游', { skip }, async (t) => {
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  process.env.LLM_BASE_URL = FAKE_BASE;
  process.env.LLM_API_KEY = ENV_KEY;
  delete process.env.LLM_PROVIDER; // 默认 deepseek

  const captured: Array<{ url: string; auth: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown): Promise<Response> => {
    const headers = ((init ?? {}) as { headers?: Record<string, string> }).headers ?? {};
    captured.push({ url: String(input), auth: headers.authorization ?? null });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  t.after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_USER_KEY_MASTER_SECRET;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
  });

  const a = await createUser('a');
  const b = await createUser('b');
  const c = await createUser('c'); // 无 Key
  const d = await createUser('d'); // 主密钥变更 → 解密失败
  const e = await createUser('e'); // 畸形密文

  await storeUserKey(a.id, KEY_A);
  await storeUserKey(b.id, KEY_B);
  await storeUserKey(d.id, 'sk-user-d-key-will-fail-decrypt');
  // 让 D 的密文不可解：换主密钥后重新加密一份「用新主密钥也解不开」的历史密文不可行，
  // 直接写一个合法结构但用其他 AAD 保护的密文（等价于主密钥变更场景：认证失败）
  process.env.LLM_USER_KEY_MASTER_SECRET = 'ab'.repeat(32);
  await storeRawCipher(d.id, encryptLlmApiKey('sk-user-d-key-old', 'some-other-user'));
  process.env.LLM_USER_KEY_MASTER_SECRET = MASTER_HEX;
  await storeRawCipher(e.id, 'v1.!!!.???.$$$');

  // 1. 用户 A（自有 Key）→ provider 携带 A_KEY
  const providerA = await providerFor(a.id);
  await providerA.json({ prompt: 'p', schema: { type: 'object' } });
  assert.equal(captured[0]!.auth, `Bearer ${KEY_A}`, '用户 A 的调用必须使用 A 的 Key');
  assert.ok(captured[0]!.url.startsWith(FAKE_BASE), '端点仍由服务端 env 决定（不开放自定义 base_url 语义不变）');

  // 2. 用户 B（自有 Key）→ B_KEY
  const providerB = await providerFor(b.id);
  await providerB.json({ prompt: 'p', schema: { type: 'object' } });
  assert.equal(captured[1]!.auth, `Bearer ${KEY_B}`, '用户 B 的调用必须使用 B 的 Key');

  // 3. 用户 C（无 Key）→ 回落 env Provider（T5B-F-08 默认路径）
  const providerC = await providerFor(c.id);
  await providerC.json({ prompt: 'p', schema: { type: 'object' } });
  assert.equal(captured[2]!.auth, `Bearer ${ENV_KEY}`, '无 Key 用户必须回落 env Provider');

  // 4. 用户 D（密文不可解）→ 按「没有可用 Key」处理 → 回落 env
  const providerD = await providerFor(d.id);
  await providerD.json({ prompt: 'p', schema: { type: 'object' } });
  assert.equal(captured[3]!.auth, `Bearer ${ENV_KEY}`, '解密失败必须回落 env Provider');

  // 5. 用户 E（畸形密文）→ 回落 env
  const providerE = await providerFor(e.id);
  await providerE.json({ prompt: 'p', schema: { type: 'object' } });
  assert.equal(captured[4]!.auth, `Bearer ${ENV_KEY}`, '畸形密文必须回落 env Provider');

  // 6. 默认行为不变：无 Key 用户的 provider 与 providerFromEnv() 同构（T5B-F-08）
  const resolved = await providerFor(c.id);
  const baseline = providerFromEnv();
  assert.equal(resolved.name, baseline.name, '回落实例与默认构造必须同构（同 provider 名）');

  // 7. 响应体可正常解析（provider.json 的结构化语义未变）
  const out = await resolved.json<{ ok: boolean }>({ prompt: 'p', schema: { type: 'object' } });
  assert.deepEqual(out, { ok: true });
});

test('PROV-99 清理测试数据', { skip }, async () => {
  await prisma.user.deleteMany({ where: { email: { contains: `_${stamp}@example.com` } } });
  await prisma.$disconnect();
});
