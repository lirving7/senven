import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock, LLM_FEATURE, LLM_USAGE_STATUS } from '../src/ports/index.ts';
import type { JsonRequest, LlmTokenUsage, LLMProvider, TextRequest } from '../src/llm/provider.ts';
import { generateJsonWithUsage } from '../src/llm/usage-gate.ts';
import { FixedClock } from './fakes.ts';

/**
 * V2 T2-Step2：用量闸门
 *  T2-A4：配额不足时 provider 调用次数必须为 0（Gate 在 Provider 之前）
 *  T2-A5：每次进入 generation 流程都落 LlmUsage（token / cost / status）
 */

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();
const skip = dbUp ? false : 'PostgreSQL 不可达';
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);
const auth = () =>
  createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });

async function signUp(tag: string) {
  const r = await auth().register({ email: `u2_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return r.user.id;
}

/** 计数探针：同时实现 json 与 jsonWithUsage，记录真实调用次数 */
class SpyProvider implements LLMProvider {
  name = 'spy';
  calls = 0;
  usage: LlmTokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };
  fail = false;

  async json<T>(_req: JsonRequest): Promise<T> {
    this.calls += 1;
    if (this.fail) throw new Error('upstream boom');
    return { ok: true } as T;
  }
  async jsonWithUsage<T>(_req: JsonRequest): Promise<{ value: T; usage: LlmTokenUsage }> {
    this.calls += 1;
    if (this.fail) throw new Error('upstream boom');
    return { value: { ok: true } as T, usage: this.usage };
  }
  async text(_req: TextRequest): Promise<string> {
    this.calls += 1;
    return 'text';
  }
}

const REQ: JsonRequest = { prompt: 'plan', schema: { type: 'object' } };

test('T2-A4 配额不足 → provider 调用 0 次 + 429 + QUOTA_REJECTED 事件', { skip }, async () => {
  const userId = await signUp('a4');
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '0'; // 上限 0 → 必然拒绝

  const provider = new SpyProvider();
  const deps = { usage: repos.llmUsage, clock: new FixedClock() };

  let code = '';
  try {
    await generateJsonWithUsage(deps, {
      userId,
      feature: LLM_FEATURE.ACTION_PLAN,
      provider,
      request: REQ,
    });
  } catch (e) {
    code = (e as { code?: string }).code ?? '';
  }

  assert.equal(code, 'LLM_QUOTA_EXCEEDED', '必须抛配额错误');
  assert.equal(provider.calls, 0, '配额不足时 provider 绝对不能被调用');

  // 配额事件留痕：requestCount=0，状态 QUOTA_REJECTED
  const rows = await prisma.llmUsage.findMany({ where: { userId, feature: LLM_FEATURE.ACTION_PLAN } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, LLM_USAGE_STATUS.QUOTA_REJECTED);
  assert.equal(rows[0].requestCount, 0, '配额事件不是 provider 调用');
  assert.equal(rows[0].totalTokens, 0);
});

test('T2-A5 成功后落 LlmUsage：用户/功能/token/成本/状态', { skip }, async () => {
  const userId = await signUp('a5');
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '10';
  process.env.LLM_COST_PER_1K_TOKENS = '0.002'; // 150 tokens → 0.0003

  const provider = new SpyProvider();
  const value = await generateJsonWithUsage<{ ok: boolean }>(deps_(), {
    userId,
    feature: LLM_FEATURE.ACTION_PLAN,
    provider,
    request: REQ,
  });

  assert.deepEqual(value, { ok: true });
  assert.equal(provider.calls, 1);

  const rows = await prisma.llmUsage.findMany({
    where: { userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.OK },
  });
  assert.equal(rows.length, 1, '成功调用必须留痕');
  const row = rows[0];
  assert.equal(row.requestCount, 1);
  assert.equal(row.inputTokens, 100);
  assert.equal(row.outputTokens, 50);
  assert.equal(row.totalTokens, 150);
  assert.ok(Math.abs(row.cost - 0.0003) < 1e-9, `cost 应按单价推算，实际 ${row.cost}`);
});

test('T2-A5 LLM 失败同样留痕（status=FAILED），且错误向外抛出', { skip }, async () => {
  const userId = await signUp('a5f');
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '10';

  const provider = new SpyProvider();
  provider.fail = true;

  await assert.rejects(
    () =>
      generateJsonWithUsage(deps_(), {
        userId,
        feature: LLM_FEATURE.ACTION_PLAN,
        provider,
        request: REQ,
      }),
    /upstream boom/,
  );

  const rows = await prisma.llmUsage.findMany({
    where: { userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.FAILED },
  });
  assert.equal(rows.length, 1, '失败调用也必须留痕');
  assert.equal(rows[0].requestCount, 1);
});

test('T2-A4b 配额足够时才调用 provider（顺序正确）', { skip }, async () => {
  const userId = await signUp('a4b');
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '2';

  const provider = new SpyProvider();
  const d = deps_();
  await generateJsonWithUsage(d, { userId, feature: LLM_FEATURE.ACTION_PLAN, provider, request: REQ });
  assert.equal(provider.calls, 1);

  // 第二次仍在额度内
  await generateJsonWithUsage(d, { userId, feature: LLM_FEATURE.ACTION_PLAN, provider, request: REQ });
  assert.equal(provider.calls, 2);

  // 第三次超出 → 拒绝且不再调用
  await assert.rejects(
    () => generateJsonWithUsage(d, { userId, feature: LLM_FEATURE.ACTION_PLAN, provider, request: REQ }),
    (e: unknown) => (e as { code?: string }).code === 'LLM_QUOTA_EXCEEDED',
  );
  assert.equal(provider.calls, 2, '超限后 provider 未被调用');
});

function deps_() {
  return { usage: repos.llmUsage, clock: new FixedClock() };
}

test('T2-99 清理', { skip }, async () => {
  delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
  delete process.env.LLM_COST_PER_1K_TOKENS;
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.$disconnect();
});
