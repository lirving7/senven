import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock, LLM_FEATURE, LLM_USAGE_STATUS } from '../src/ports/index.ts';
import type { LLMProvider, LlmTokenUsage } from '../src/llm/provider.ts';
import type { ActionPlanRepository } from '../src/ports/index.ts';
import {
  createCreateActionPlanHandler,
  createListActionPlansHandler,
  createGetActionPlanHandler,
  createRegenerateActionPlanHandler,
  createUpdateActionStepHandler,
} from '../src/http/handlers/action-plans.ts';

/**
 * QA · T2-A1~A7 岗位行动计划「独立验收」
 *
 * 独立性声明（与 tests/qa-t2-acceptance.test.ts 同规格）：
 *   - **不复用**开发者测试文件（tests/t2-action-plan-api.test.ts）与其 fakes / PlanProvider；
 *   - 本文件自带 Provider 与请求构造；
 *   - 真实 Prisma 仓储 + 真实 handler，ActionPlan/ActionStep 走真实事务。
 *
 * 覆盖：
 *   T2-A1 主动触发：有 MatchRun 也不会自动生成，仅显式 POST 才创建（且才调用 LLM）
 *   T2-A2 所属权：跨用户 / 不存在 → 404；body 携带 userId → 400；跨用户读 plan / 改 step → 404
 *   T2-A3 事务：provider 崩溃 / LLM 结构错误 / 写库失败 → 绝不留下半个 ActionPlan / ActionStep
 *   T2-A4 配额：Gate 在 Provider 之前，不足 → 429 且 provider 零调用，记 QUOTA_REJECTED(requestCount=0)
 *   T2-A5 事实安全：have 只来自 CONFIRMED 能力；gaps 只来自 MatchRun 缺口；LLM 编造被服务端覆盖
 *   T2-A6 三类结果契约：have / gaps / actions 齐备且字段完整
 *   T2-A7 查看 / 单步继续（含持久化与非法枚举）/ 刷新（重新生成，整体替换且不新增计划）
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

// 文件级唯一标记：仅用 Date.now() 会与其他文件并行加载时撞号，导致清理误删他人 fixture
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);

/* ─────────── QA 自带 Provider（独立于开发者 fakes） ─────────── */

type Behavior = { kind: 'ok' | 'crash'; payload?: unknown };

class QaProvider implements LLMProvider {
  readonly name = 'qa-action-plan-provider';
  calls = 0;
  private behavior: Behavior;

  constructor(behavior: Behavior) {
    this.behavior = behavior;
  }

  private record(): unknown {
    this.calls += 1;
    if (this.behavior.kind === 'crash') throw new Error('QA 注入：provider 崩溃');
    return this.behavior.payload;
  }

  async json<T>(): Promise<T> {
    return this.record() as T;
  }

  async text(): Promise<string> {
    return 'qa';
  }

  async jsonWithUsage<T>(): Promise<{ value: T; usage?: LlmTokenUsage }> {
    const value = this.record() as T;
    return { value, usage: { inputTokens: 11, outputTokens: 22, totalTokens: 33 } };
  }
}

/* ─────────── 装配 ─────────── */

function makeDeps(provider: LLMProvider, actionPlansOverride?: ActionPlanRepository) {
  return {
    auth: createAuthService({
      users: repos.users,
      sessions: repos.sessions,
      failures: createInMemoryFailureLimiter(systemClock),
      clock: systemClock,
    }),
    provider,
    matchRepo: repos.matches,
    capabilities: repos.capabilities,
    jdRepo: repos.jds,
    actionPlans: actionPlansOverride ?? repos.actionPlans,
    usage: repos.llmUsage,
    clock: systemClock,
  };
}

function handlersOf(deps: ReturnType<typeof makeDeps>) {
  return {
    create: createCreateActionPlanHandler(deps),
    list: createListActionPlansHandler(deps),
    get: createGetActionPlanHandler(deps),
    regen: createRegenerateActionPlanHandler(deps),
    step: createUpdateActionStepHandler(deps),
  };
}

const request = (method: string, url: string, body: unknown, token?: string) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { cookie: `jp_session=${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type AnyBody = { data?: any; error?: { code?: string; message?: string } };
const body = async (r: Response): Promise<AnyBody> => (await r.json()) as AnyBody;

async function signUp(tag: string) {
  const r = await makeDeps(new QaProvider({ kind: 'ok', payload: {} })).auth.register({
    email: `qa_t2ap_${tag}_${stamp}@example.com`,
    password: 'password-1234',
  });
  return { token: r.token, userId: r.user.id };
}

/** 播种：JD（真实仓储）+ 简历 + MatchRun（含 MISSING 项，供 gaps 派生）+ 可选 CONFIRMED 能力 */
async function seedRun(userId: string, opts: { withConfirmedCapability?: boolean; capabilityLabel?: string } = {}) {
  const jd = await repos.jds.createWithRequirements({
    userId,
    rawText: 'QA JD：AI 应用工程师',
    title: 'AI 应用工程师',
    company: 'QA 公司',
    contentHash: `qa_t2ap_${stamp}_${Math.random().toString(36).slice(2, 10)}`,
    reqs: {
      create: [
        { text: '精通 Python', category: 'TECH', criticality: 'MUST' },
        { text: '熟悉 Kubernetes', category: 'TECH', criticality: 'MUST' },
      ],
    },
  });
  const resume = await prisma.resume.create({
    data: { userId, rawText: 'QA 简历', sourceType: 'TEXT' },
    select: { id: true },
  });
  const run = await prisma.matchRun.create({
    data: {
      userId,
      resumeId: resume.id,
      jdId: jd.id,
      summary: { total: 2, have: 1, enhance: 0, missing: 1, mustTotal: 2, mustHave: 1 },
      items: {
        create: [
          {
            reqText: '精通 Python',
            status: 'HAVE',
            category: 'TECH',
            criticality: 'MUST',
            reason: 'QA 夹具',
            basisType: 'FACT',
            basisDetail: 'QA 夹具',
            evidenceRefs: [],
          },
          {
            reqText: '熟悉 Kubernetes',
            status: 'MISSING',
            category: 'TECH',
            criticality: 'MUST',
            reason: 'QA 夹具',
            basisType: 'GAP',
            basisDetail: 'QA 夹具',
            evidenceRefs: [],
          },
        ],
      },
    },
    select: { id: true },
  });

  if (opts.withConfirmedCapability) {
    const ev = await prisma.evidence.create({
      data: { source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: 'QA 夹具证据' },
      select: { id: true },
    });
    await prisma.capability.create({
      data: {
        userId,
        key: `qa_${Math.random().toString(36).slice(2, 10)}`,
        label: opts.capabilityLabel ?? 'Python',
        level: '熟练',
        status: 'CONFIRMED',
        source: 'MANUAL',
        evidence: { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: 'QA 夹具证据', resumeEvidenceId: ev.id }] },
      },
    });
  }

  return { runId: run.id, jdId: jd.id };
}

const OK_PAYLOAD = {
  have: [],
  gaps: [],
  actions: [{ title: '补 Kubernetes', desc: '动手用 minikube 部署 demo', type: 'PRACTICE', targetRequirement: '熟悉 Kubernetes' }],
};

/** LLM「编造」的 have / gaps：必须被服务端覆盖丢弃（A5 的反例） */
const FABRICATED_PAYLOAD = {
  have: [{ id: 'fake', key: 'kubernetes', label: 'Kubernetes', level: '专家' }],
  gaps: [{ requirement: 'FAKE_GAP', category: 'OTHER', criticality: 'BONUS' }],
  actions: [{ title: '完成 K8s 实战', desc: 'minikube 部署 3 服务 demo', type: 'LEARN', targetRequirement: '熟悉 Kubernetes' }],
};

/* ═══════════ A1 主动触发 ═══════════ */

test('QA-T2AP-A1 主动触发：有 MatchRun 也不自动生成，仅显式 POST 才创建并调用 LLM', { skip }, async () => {
  const a = await signUp('a1');
  const { runId } = await seedRun(a.userId);
  const provider = new QaProvider({ kind: 'ok', payload: OK_PAYLOAD });
  const h = handlersOf(makeDeps(provider));

  const before = await h.list(request('GET', 'http://qa/api/action-plans', undefined, a.token));
  assert.equal(before.status, 200);
  assert.equal((await body(before)).data?.items?.length, 0, '有 MatchRun 也不得自动生成');
  assert.equal(provider.calls, 0, '用户未点击前不得调用 LLM');

  const created = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(created.status, 201);
  assert.equal(provider.calls, 1, '显式 POST 才走 LLM');

  const after = await h.list(request('GET', 'http://qa/api/action-plans', undefined, a.token));
  assert.equal((await body(after)).data?.items?.length, 1);
});

/* ═══════════ A2 所属权 ═══════════ */

test('QA-T2AP-A2 所属权：跨用户/不存在/注入 userId 全部拒绝，跨用户读改 404', { skip }, async () => {
  const a = await signUp('a2a');
  const b = await signUp('a2b');
  const { runId } = await seedRun(a.userId);
  const provider = new QaProvider({ kind: 'ok', payload: OK_PAYLOAD });
  const h = handlersOf(makeDeps(provider));

  const cross = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, b.token));
  assert.equal(cross.status, 404, '对非本人 MatchRun 必须 404（不泄露存在性）');

  const missing = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: 'qa-no-such-run' }, a.token));
  assert.equal(missing.status, 404);

  const injected = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId, userId: b.userId }, a.token));
  assert.equal(injected.status, 400, 'body 携带 userId 必须被 strict 拒绝');

  const ok = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(ok.status, 201);
  const plan = (await body(ok)).data;

  const crossRead = await h.get(request('GET', `http://qa/api/action-plans/${plan.id}`, undefined, b.token), plan.id);
  assert.equal(crossRead.status, 404, '跨用户读他人计划 → 404');

  const stepId = plan.actions[0].id;
  const crossStep = await h.step(
    request('PATCH', `http://qa/api/action-plans/${plan.id}/steps/${stepId}`, { status: 'DONE' }, b.token),
    plan.id,
    stepId,
  );
  assert.equal(crossStep.status, 404, '跨用户改他人步骤 → 404');
});

/* ═══════════ A3 事务原子性 ═══════════ */

test('QA-T2AP-A3a provider 崩溃 → 500，不留半个 Plan/Step，且留痕 FAILED', { skip }, async () => {
  const a = await signUp('a3a');
  const { runId } = await seedRun(a.userId);
  const provider = new QaProvider({ kind: 'crash' });
  const h = handlersOf(makeDeps(provider));

  const res = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 500);
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0, '不得留下 ActionPlan');
  assert.equal(await prisma.actionStep.count({ where: { plan: { userId: a.userId } } }), 0, '不得留下 ActionStep');

  const rows = await prisma.llmUsage.findMany({
    where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.FAILED },
  });
  assert.equal(rows.length, 1, '失败同样必须留痕');
  assert.equal(rows[0].requestCount, 1);
});

test('QA-T2AP-A3b LLM 结构不符（缺 actions）→ 502，不留半个 Plan/Step', { skip }, async () => {
  const a = await signUp('a3b');
  const { runId } = await seedRun(a.userId);
  const provider = new QaProvider({ kind: 'ok', payload: {} });
  const h = handlersOf(makeDeps(provider));

  const res = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 502, '结构化校验失败必须 502');
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0);
  assert.equal(await prisma.actionStep.count({ where: { plan: { userId: a.userId } } }), 0);
});

test('QA-T2AP-A3c 写库失败（独立注入）→ 500，不留半个 Plan/Step', { skip }, async () => {
  const a = await signUp('a3c');
  const { runId } = await seedRun(a.userId);
  const provider = new QaProvider({ kind: 'ok', payload: OK_PAYLOAD });
  const failing: ActionPlanRepository = {
    ...repos.actionPlans,
    createPlanWithSteps: async () => {
      throw new Error('QA 注入：事务写失败');
    },
  };
  const h = handlersOf(makeDeps(provider, failing));

  const res = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 500);
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0);
  assert.equal(await prisma.actionStep.count({ where: { plan: { userId: a.userId } } }), 0);

  const okRows = await prisma.llmUsage.findMany({
    where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.OK },
  });
  assert.equal(okRows.length, 1, 'provider 成功应留痕 OK');
});

/* ═══════════ A4 配额 ═══════════ */

test('QA-T2AP-A4 配额不足 → 429，provider 零调用，记 QUOTA_REJECTED(requestCount=0)', { skip }, async () => {
  const a = await signUp('a4');
  const { runId } = await seedRun(a.userId);
  const provider = new QaProvider({ kind: 'ok', payload: OK_PAYLOAD });
  const h = handlersOf(makeDeps(provider));

  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '0';
  try {
    const res = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
    assert.equal(res.status, 429);
    assert.equal(provider.calls, 0, 'Gate 必须在 provider 之前，provider 零调用');

    const rows = await prisma.llmUsage.findMany({
      where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.QUOTA_REJECTED },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requestCount, 0, '配额事件不得伪装成一次 provider 调用');
    assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0);
  } finally {
    delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
  }
});

/* ═══════════ A5 事实安全 ═══════════ */

test('QA-T2AP-A5 事实安全：have 只来自 CONFIRMED，gaps 只来自 MatchRun，LLM 编造被覆盖', { skip }, async () => {
  const a = await signUp('a5');
  const { runId } = await seedRun(a.userId, { withConfirmedCapability: true, capabilityLabel: 'Python' });
  const provider = new QaProvider({ kind: 'ok', payload: FABRICATED_PAYLOAD });
  const h = handlersOf(makeDeps(provider));

  const res = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const { have, gaps, actions } = (await body(res)).data;

  assert.ok(have.find((x: any) => x.label === 'Python'), 'have 必须包含已确认能力');
  assert.equal(have.find((x: any) => x.label === 'Kubernetes'), undefined, 'LLM 编造的 kubernetes 必须被丢弃');
  assert.equal(have.length, 1, 'have 只应含 1 条已确认能力');

  assert.deepEqual(gaps.map((g: any) => g.requirement), ['熟悉 Kubernetes'], 'gaps 只来自 MatchRun 的 MISSING/ENHANCE');
  assert.equal(gaps.find((g: any) => g.requirement === 'FAKE_GAP'), undefined, 'LLM 编造的 FAKE_GAP 必须被丢弃');

  assert.equal(actions.length, FABRICATED_PAYLOAD.actions.length, 'actions 是 LLM 唯一可创造性产出的部分');
  assert.match(actions[0].title, /K8s/, 'LLM 的 actions 应被保留');
});

/* ═══════════ A6 三类结果契约 ═══════════ */

test('QA-T2AP-A6 三类结果契约：have / gaps / actions 齐备、字段完整、初始 TODO', { skip }, async () => {
  const a = await signUp('a6');
  const { runId } = await seedRun(a.userId, { withConfirmedCapability: true, capabilityLabel: 'Python' });
  const provider = new QaProvider({ kind: 'ok', payload: OK_PAYLOAD });
  const h = handlersOf(makeDeps(provider));

  const res = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const plan = (await body(res)).data;

  assert.ok(Array.isArray(plan.have) && plan.have.length >= 1, '① 已有能力非空');
  assert.ok(plan.have.every((x: any) => typeof x.label === 'string' && x.label.length > 0));
  assert.ok(Array.isArray(plan.gaps) && plan.gaps.length >= 1, '② 能力缺口非空');
  assert.ok(plan.gaps.every((g: any) => typeof g.requirement === 'string' && g.requirement.length > 0));
  assert.ok(Array.isArray(plan.actions) && plan.actions.length >= 1, '③ 建议行动非空');
  assert.ok(
    plan.actions.every((s: any) => s.id && typeof s.order === 'number' && s.title && s.desc && s.status && 'targetRequirement' in s),
    '动作字段必须完整',
  );
  assert.equal(plan.goal, 'AI 应用工程师', 'goal 取自 JD 标题');
  assert.ok(plan.actions.every((s: any) => s.status === 'TODO'), '新建动作必须为 TODO');
});

/* ═══════════ A7 查看 / 单步继续 / 刷新 ═══════════ */

test('QA-T2AP-A7 查看(200/404) / 单步继续(持久化+非法枚举400) / 刷新(整体替换不新增)', { skip }, async () => {
  const a = await signUp('a7');
  const { runId } = await seedRun(a.userId, { withConfirmedCapability: true });
  const provider = new QaProvider({ kind: 'ok', payload: OK_PAYLOAD });
  const h = handlersOf(makeDeps(provider));

  const created = await h.create(request('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(created.status, 201);
  const plan = (await body(created)).data;

  // A7 · 查看
  const viewed = await h.get(request('GET', `http://qa/api/action-plans/${plan.id}`, undefined, a.token), plan.id);
  assert.equal(viewed.status, 200);
  assert.equal((await body(viewed)).data?.id, plan.id);

  const absent = await h.get(request('GET', 'http://qa/api/action-plans/qa-absent', undefined, a.token), 'qa-absent');
  assert.equal(absent.status, 404, '不存在 → 404（前端 ErrorState 路径）');

  // A7 · 单步继续
  const stepId = plan.actions[0].id;
  const patched = await h.step(
    request('PATCH', `http://qa/api/action-plans/${plan.id}/steps/${stepId}`, { status: 'DONE' }, a.token),
    plan.id,
    stepId,
  );
  assert.equal(patched.status, 200);
  assert.equal((await body(patched)).data?.status, 'DONE');

  const reread = await h.get(request('GET', `http://qa/api/action-plans/${plan.id}`, undefined, a.token), plan.id);
  const persisted = (await body(reread)).data?.actions?.find((s: any) => s.id === stepId);
  assert.equal(persisted?.status, 'DONE', '状态必须以服务端持久化为准，非前端伪造');

  const illegal = await h.step(
    request('PATCH', `http://qa/api/action-plans/${plan.id}/steps/${stepId}`, { status: 'FINISHED' }, a.token),
    plan.id,
    stepId,
  );
  assert.equal(illegal.status, 400, '非法状态枚举必须 400');

  // A7 · 刷新（重新生成）
  const beforeIds = plan.actions.map((s: any) => s.id);
  const regenerated = await h.regen(request('POST', `http://qa/api/action-plans/${plan.id}/regenerate`, {}, a.token), plan.id);
  assert.equal(regenerated.status, 200, '重新生成必须成功（有已确认能力时同样成立）');
  const next = (await body(regenerated)).data;
  assert.ok(next.actions.length >= 1);
  assert.ok(next.actions.every((s: any) => !beforeIds.includes(s.id)), 'steps 应整体替换');
  assert.ok(next.actions.every((s: any) => s.status === 'TODO'), '重新生成后状态重置');
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 1, '刷新不新增计划');
});

/* ═══════════ 清理 ═══════════ */

test('QA-T2AP-99 清理', { skip }, async () => {
  // 只清理本文件自己的数据：以 stamp 精确定位
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `qa_t2ap_${stamp}` } } });
  await prisma.$disconnect();
});
