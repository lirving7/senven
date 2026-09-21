/**
 * T5-B-2B0 —— AGENT Quota Slot 专项测试（第 9 个 LLM feature slot）
 *
 * 依据：ADR-017 §3（`T5B-F-10` 第 9 槽 / `T5B-F-11` 每 Run ≤1 次 provider call /
 *       `T5B-F-12` 计费规则 / `T5B-F-13` 无二次计费）。
 *
 * 本文件**只验证配额注册与既有 gate 语义**：
 *   - feature 注册 + 完整集合第 9 项；
 *   - 默认额度 10、rolling 24h 复用既有窗口机制；
 *   - 配额耗尽 → `QUOTA_REJECTED` 且 **provider 调用 0 次**；
 *   - 既有 8 个 feature 的额度与 gate 行为 **零变化**；
 *   - 零迁移（migration 恒 14）。
 *
 * ⚠️ 本阶段**不实现**任何 Agent Runtime（授权书 §七/§九）：不创建 AgentRun / AgentProposal，
 *    不建立生产 Agent 调用链，不调用真实 provider —— 仅用既有 `usage-gate` + 计数探针 provider。
 *
 * 前置：数据库必须可达（fail-fast，禁止静默 skip）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { LLM_FEATURE, LLM_USAGE_STATUS } from '../src/ports/index.ts';
import { DEFAULT_QUOTA_WINDOW_MS, quotaLimitFor, quotaWindowMs } from '../src/llm/quota.ts';
import { generateJsonWithUsage } from '../src/llm/usage-gate.ts';
import type { JsonRequest, LlmTokenUsage, LLMProvider, TextRequest } from '../src/llm/provider.ts';
import { FixedClock } from './fakes.ts';

/** ADR-017 §3 冻结的 AGENT 额度 */
const AGENT_DAILY_LIMIT = 10;

/** 既有 8 个 feature 的额度基线（本阶段必须零变化） */
const EXISTING_LIMITS: Array<[string, number]> = [
  ['RESUME', 20],
  ['JD', 20],
  ['MATCH', 20],
  ['ACTION_PLAN', 5],
  ['LEARNING', 10],
  ['PROJECT_MENTOR', 10],
  ['PORTFOLIO', 5],
  ['INTERVIEW', 10],
];

const ALL_FEATURES = [
  'RESUME',
  'JD',
  'MATCH',
  'ACTION_PLAN',
  'LEARNING',
  'PROJECT_MENTOR',
  'PORTFOLIO',
  'INTERVIEW',
  'AGENT',
];

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);
const createdEmails: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const email = `qa_agentquota_${tag}_${stamp}@example.com`;
  createdEmails.push(email);
  const u = await prisma.user.create({ data: { email, passwordHash: 'x' } });
  return u.id;
}

/** 计数探针：实现 json/jsonWithUsage/text，记录**真实** provider 调用次数 */
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

const REQ: JsonRequest = { prompt: 'agent-plan', schema: { type: 'object' } };

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), 'utf8');
}

after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.$disconnect();
});

test('前置：数据库必须可达（禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

// ─── 1. Feature 注册 ────────────────────────────────────────────────────

test('[1] feature 注册：LLM_FEATURE.AGENT === "AGENT" 且为完整集合第 9 项', () => {
  assert.equal(LLM_FEATURE.AGENT, 'AGENT');

  const keys = Object.keys(LLM_FEATURE);
  assert.equal(keys.length, 9, `feature 总数必须为 9，实际 ${keys.length}`);
  assert.deepEqual(keys, ALL_FEATURES, '完整 feature 集合与顺序必须与 ADR-017 §3 一致');
  assert.equal(keys[8], 'AGENT', 'AGENT 必须是第 9 项');
});

test('[1b] feature 注册：源码层 `LLM_FEATURE.AGENT` 为唯一来源（无平行常量）', () => {
  const ports = read('src/ports/index.ts');
  assert.ok(/AGENT:\s*'AGENT'/.test(ports), 'ports/index.ts 必须声明 AGENT 槽位');

  // 不得出现「第二套 feature 分类法」（授权书采纳方案 A：单一真身）
  const quota = read('src/llm/quota.ts');
  assert.equal(/AGENT_QUOTA_FEATURE|const AGENT_FEATURE/.test(quota), false, '不得另立平行 feature 常量');
  assert.ok(/\[LLM_FEATURE\.AGENT\]/.test(quota), 'quota.ts 必须以 LLM_FEATURE.AGENT 为键');
});

// ─── 2. Default limit ───────────────────────────────────────────────────

test('[2] default limit：AGENT = 10', () => {
  assert.equal(quotaLimitFor(LLM_FEATURE.AGENT), AGENT_DAILY_LIMIT);
});

test('[2b] default limit：环境变量 LLM_QUOTA_AGENT_PER_DAY 优先，非法值回退 10', () => {
  process.env.LLM_QUOTA_AGENT_PER_DAY = '3';
  assert.equal(quotaLimitFor(LLM_FEATURE.AGENT), 3);
  process.env.LLM_QUOTA_AGENT_PER_DAY = '0';
  assert.equal(quotaLimitFor(LLM_FEATURE.AGENT), 0);
  for (const bad of ['', 'abc', '-1']) {
    process.env.LLM_QUOTA_AGENT_PER_DAY = bad;
    assert.equal(quotaLimitFor(LLM_FEATURE.AGENT), AGENT_DAILY_LIMIT, `非法值 ${JSON.stringify(bad)} 应回退 10`);
  }
  delete process.env.LLM_QUOTA_AGENT_PER_DAY;
  assert.equal(quotaLimitFor(LLM_FEATURE.AGENT), AGENT_DAILY_LIMIT);
});

// ─── 3. Rolling 24h ─────────────────────────────────────────────────────

test('[3] rolling 24h：复用既有窗口机制（无 AGENT 专属实现）', () => {
  assert.equal(DEFAULT_QUOTA_WINDOW_MS, 24 * 60 * 60 * 1000);
  assert.equal(quotaWindowMs(), DEFAULT_QUOTA_WINDOW_MS);

  // AGENT 与其它 feature 走同一函数、同一窗口 —— 无分支特判
  const quota = read('src/llm/quota.ts');
  assert.equal(/if\s*\(\s*feature\s*===\s*LLM_FEATURE\.AGENT/.test(quota), false, '不得对 AGENT 特判');

  const gate = read('src/llm/usage-gate.ts');
  assert.ok(/quotaWindowMs\(\)/.test(gate) && /countSince\(userId, feature, since\)/.test(gate));
  assert.equal(/AGENT/.test(gate), false, 'usage-gate 不得出现 AGENT 特判（自然复用 LlmFeature）');
});

test('[3b] rolling 24h：24h 窗口外的历史用量不再计入（端到端，AGENT）', async () => {
  const userId = await makeUser('roll');
  const clock = new FixedClock('2026-09-19T00:00:00.000Z');

  // 造 10 条「25 小时前」的 AGENT 成功用量 → 已滑出窗口 → 不应触发拒绝
  const old = new Date(clock.now().getTime() - 25 * 60 * 60 * 1000);
  await prisma.llmUsage.createMany({
    data: Array.from({ length: 10 }, () => ({
      userId,
      feature: LLM_FEATURE.AGENT,
      requestCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cost: 0,
      status: LLM_USAGE_STATUS.OK,
      createdAt: old,
    })),
  });

  const provider = new SpyProvider();
  const out = await generateJsonWithUsage<{ ok: boolean }>(
    { usage: repos.llmUsage, clock },
    { userId, feature: LLM_FEATURE.AGENT, provider, request: REQ },
  );
  assert.deepEqual(out, { ok: true });
  assert.equal(provider.calls, 1, '窗口外的历史用量不应阻塞本次调用');
});

// ─── 4. Quota exhausted ─────────────────────────────────────────────────

test('[4] quota exhausted：AGENT 额度耗尽 → QUOTA_REJECTED + provider 调用 0 次', async () => {
  const userId = await makeUser('exhaust');
  const clock = new FixedClock('2026-09-19T00:00:00.000Z');

  // 窗口内灌满 10 次（= 上限）
  await prisma.llmUsage.createMany({
    data: Array.from({ length: AGENT_DAILY_LIMIT }, () => ({
      userId,
      feature: LLM_FEATURE.AGENT,
      requestCount: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cost: 0,
      status: LLM_USAGE_STATUS.OK,
      createdAt: clock.now(),
    })),
  });

  const provider = new SpyProvider();
  let code = '';
  try {
    await generateJsonWithUsage(
      { usage: repos.llmUsage, clock },
      { userId, feature: LLM_FEATURE.AGENT, provider, request: REQ },
    );
    assert.fail('应抛出配额错误');
  } catch (err) {
    code = (err as { code?: string }).code ?? '';
  }

  assert.equal(code, 'LLM_QUOTA_EXCEEDED');
  assert.equal(provider.calls, 0, 'provider 调用次数必须为 0');

  const rows = await prisma.llmUsage.findMany({
    where: { userId, feature: LLM_FEATURE.AGENT, status: LLM_USAGE_STATUS.QUOTA_REJECTED },
  });
  assert.equal(rows.length, 1, '必须留下一条 QUOTA_REJECTED 配额事件');
  assert.equal(rows[0]!.requestCount, 0, 'QUOTA_REJECTED 的 providerCalls 必须为 0');
  assert.equal(rows[0]!.totalTokens, 0);
  assert.equal(rows[0]!.cost, 0);
});

test('[4b] quota exhausted：11 次连续调用中第 11 次被拒（10 次成功 / 1 次拒绝 / provider 调用 10）', async () => {
  const userId = await makeUser('boundary');
  const clock = new FixedClock('2026-09-19T00:00:00.000Z');
  const provider = new SpyProvider();
  const deps = { usage: repos.llmUsage, clock };

  let ok = 0;
  let rejected = 0;
  for (let i = 0; i < AGENT_DAILY_LIMIT + 1; i++) {
    try {
      await generateJsonWithUsage(deps, { userId, feature: LLM_FEATURE.AGENT, provider, request: REQ });
      ok += 1;
    } catch {
      rejected += 1;
    }
  }

  assert.equal(ok, AGENT_DAILY_LIMIT, `前 ${AGENT_DAILY_LIMIT} 次必须成功`);
  assert.equal(rejected, 1, '第 11 次必须被拒');
  assert.equal(provider.calls, AGENT_DAILY_LIMIT, 'provider 调用次数必须等于成功次数（拒绝不调用 provider）');

  const rejectedRows = await prisma.llmUsage.count({
    where: { userId, feature: LLM_FEATURE.AGENT, status: LLM_USAGE_STATUS.QUOTA_REJECTED },
  });
  assert.equal(rejectedRows, 1);
  // 配额事件不伪装成 provider 调用：记 provider 调用的行数 = 10
  const attempted = await prisma.llmUsage.count({
    where: { userId, feature: LLM_FEATURE.AGENT, requestCount: 1 },
  });
  assert.equal(attempted, AGENT_DAILY_LIMIT);
});

test('[4c] FAILED 语义保持：provider 失败仍计 1 次 provider 调用（AGENT 槽不特殊）', async () => {
  const userId = await makeUser('failed');
  const clock = new FixedClock('2026-09-19T00:00:00.000Z');
  const provider = new SpyProvider();
  provider.fail = true;

  await assert.rejects(() =>
    generateJsonWithUsage(
      { usage: repos.llmUsage, clock },
      { userId, feature: LLM_FEATURE.AGENT, provider, request: REQ },
    ),
  );
  assert.equal(provider.calls, 1);

  const rows = await prisma.llmUsage.findMany({
    where: { userId, feature: LLM_FEATURE.AGENT, status: LLM_USAGE_STATUS.FAILED },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.requestCount, 1, 'FAILED 必须记为一次 provider 调用');
});

// ─── 5. Existing 8-feature regression ───────────────────────────────────

test('[5] existing-8 regression：8 个既有 feature 的默认额度零变化', () => {
  for (const [name, expected] of EXISTING_LIMITS) {
    assert.equal(
      quotaLimitFor(LLM_FEATURE[name as keyof typeof LLM_FEATURE]),
      expected,
      `${name} 默认额度必须仍为 ${expected}`,
    );
  }
});

test('[5b] existing-8 regression：既有 feature 的 gate 行为零变化（ACTION_PLAN 端到端）', async () => {
  const userId = await makeUser('regress');
  const clock = new FixedClock('2026-09-19T00:00:00.000Z');
  const provider = new SpyProvider();
  const deps = { usage: repos.llmUsage, clock };

  // ACTION_PLAN 默认 5：应恰好允许 5 次
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    await generateJsonWithUsage(deps, { userId, feature: LLM_FEATURE.ACTION_PLAN, provider, request: REQ });
    ok += 1;
  }
  assert.equal(ok, 5);

  const before = provider.calls;
  await assert.rejects(() =>
    generateJsonWithUsage(deps, { userId, feature: LLM_FEATURE.ACTION_PLAN, provider, request: REQ }),
  );
  assert.equal(provider.calls, before, 'ACTION_PLAN 被拒时 provider 不得被调用');

  // 槽位隔离：AGENT 用量不受 ACTION_PLAN 用量影响
  await generateJsonWithUsage(deps, { userId, feature: LLM_FEATURE.AGENT, provider, request: REQ });
  const agentRows = await prisma.llmUsage.count({ where: { userId, feature: LLM_FEATURE.AGENT } });
  assert.equal(agentRows, 1, 'AGENT 与既有 feature 互不串账');
});

test('[5c] existing-8 regression：各 feature 的 LLM_USAGE_STATUS 语义与窗口常量未变', () => {
  assert.deepEqual(
    { ...LLM_USAGE_STATUS },
    { OK: 'OK', FAILED: 'FAILED', QUOTA_REJECTED: 'QUOTA_REJECTED' },
  );
  assert.equal(DEFAULT_QUOTA_WINDOW_MS, 86400000);

  // 既有 gate 顺序未被本阶段触碰：仍「先查配额、后调 provider」
  const gate = read('src/llm/usage-gate.ts');
  const iQuota = gate.indexOf('countSince');
  const iProvider = gate.indexOf('provider.jsonWithUsage');
  assert.ok(iQuota > 0 && iProvider > iQuota, '必须先配额、后 provider（T2-A4 顺序不变）');
});

// ─── 6. No migration ────────────────────────────────────────────────────

test('[6] 零迁移：migration 恒 18 且 #10–#17 文件未变（T6-4-A 授权 #17 + 2026-09-20 授权 #18 头像）', () => {
  const migDir = path.join(process.cwd(), 'prisma/migrations');
  const dirs = readdirSync(migDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  assert.equal(dirs.length, 19, `migration 必须为 19（#18 头像列 + #19 用户 LLM API Key），实际 ${dirs.length}`);
  assert.equal(dirs[13], '20260919025710_agent_domain_persistence');
  assert.equal(dirs[12], '20260919000100_rag_knowledge_base');
  assert.equal(dirs[17], '20260920210000_user_avatar_url');
  assert.equal(dirs[18], '20260921000000_user_llm_api_key');
});

// ─── 7. 无 Runtime 机械检查 ─────────────────────────────────────────────

test('[7] 无 Runtime 直连：Agent API 6 路由（T5-B-2C 3 + T6-4-A 3），quota/usage 文件零 Runtime 符号', () => {
  // T5-B-2C 基线同步：app/api/agent 存在但仅 3 个 route 文件（method 白名单见 agent-guards）
  const agentRoutes: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.name === 'route.ts') agentRoutes.push(e.name);
    }
  })(path.join(process.cwd(), 'app/api/agent'));
  assert.deepEqual(agentRoutes.sort(), ['route.ts', 'route.ts', 'route.ts', 'route.ts', 'route.ts', 'route.ts']);
  assert.equal(existsSync(path.join(process.cwd(), 'app/api/agent/runs')), true);

  for (const rel of ['src/llm/quota.ts', 'src/llm/usage-gate.ts']) {
    const code = read(rel);
    for (const banned of ['AgentRun', 'AgentProposal', 'PLANNING', 'PROPOSED', 'schemaInPrompt', 'dispatch', 'toolCall']) {
      assert.equal(code.includes(banned), false, `${rel} 不得出现 Runtime 相关符号 ${banned}`);
    }
  }
});
