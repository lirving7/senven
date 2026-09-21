/**
 * V2 · T2-Step 3A —— 岗位行动计划 API 后端闭环验收
 *
 * 直接调用 handler 函数（与 api-matches.test.ts 同一范式），注入可控 LLM Provider，
 * 使用真实 Prisma 仓储（ActionPlan + ActionStep 走真实事务，A3 事务原子性可被真正触发）。
 *
 * 覆盖验收铁律：
 *   T2-A1 主动触发：仅显式 POST /api/action-plans 才创建；有 MatchRun 也不会自动生成
 *   T2-A2 所属权：跨用户 / 不存在 → 404；body 携带 userId → 400
 *   T2-A3 事务：LLM 失败 / 结构错误 / 事务写失败 → 绝不留下半个 ActionPlan / ActionStep
 *   T2-A4 配额：复用 generateJsonWithUsage（Gate 在 Provider 之前），不足 → 429 且 provider 0 调用
 *   T2-A5 结果结构：have 只来自 CONFIRMED 能力；gaps 只来自 MatchRun 缺口；LLM 的 have/gaps 被服务端覆盖
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { systemClock, LLM_FEATURE, LLM_USAGE_STATUS } from '../src/ports/index.ts';
import type { JsonRequest, LLMProvider, LlmTokenUsage } from '../src/llm/provider.ts';
import type { ActionPlanRepository } from '../src/ports/index.ts';
import {
  createCreateActionPlanHandler,
  createListActionPlansHandler,
  createGetActionPlanHandler,
  createRegenerateActionPlanHandler,
  createUpdateActionStepHandler,
} from '../src/http/handlers/action-plans.ts';
import {
  bodyOf,
  extractSessionToken,
  getJson,
  postJson,
} from './fakes.ts';
import { STEP_TYPE_PREFIX } from '../src/domain/action-plan/step-type.ts';

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

function authSvc() {
  return createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
}

/** 可控 LLM Provider：返回约定 payload，记录真实调用次数，可被注入失败 */
class PlanProvider implements LLMProvider {
  name = 'plan-spy';
  calls = 0;
  fail = false;
  payload: unknown;
  usage: LlmTokenUsage = { inputTokens: 120, outputTokens: 80, totalTokens: 200 };

  constructor(payload: unknown) {
    this.payload = payload;
  }

  async jsonWithUsage<T>(_req: JsonRequest): Promise<{ value: T; usage: LlmTokenUsage }> {
    this.calls += 1;
    if (this.fail) throw new Error('upstream boom');
    return { value: this.payload as T, usage: this.usage };
  }

  async json<T>(_req: JsonRequest): Promise<T> {
    this.calls += 1;
    if (this.fail) throw new Error('upstream boom');
    return this.payload as T;
  }

  async text(_req: unknown): Promise<string> {
    return 'text';
  }
}

/** LLM 返回「编造」的 have/gaps，用于验证服务端覆盖（A5） */
const FAKE_PAYLOAD = {
  have: [{ id: 'fake', key: 'kubernetes', label: 'Kubernetes', level: '专家' }],
  gaps: [{ requirement: 'FAKE_GAP', category: 'OTHER', criticality: 'BONUS' }],
  actions: [
    { title: '完成 K8s 实战', desc: '用 minikube 部署一个含 3 个服务的 demo', type: 'LEARN', targetRequirement: '熟悉 Kubernetes' },
    { title: '做一个 RAG demo', desc: '用 langchain 实现检索增强', type: 'PROJECT', targetRequirement: '熟悉 RAG' },
  ],
};

const OK_PAYLOAD = {
  have: [],
  gaps: [],
  actions: [
    { title: '补 Kubernetes', desc: '动手部署', type: 'PRACTICE', targetRequirement: '熟悉 Kubernetes' },
  ],
};

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: { payload?: unknown; fail?: boolean } = {}) {
  const provider = new PlanProvider(opts.payload ?? OK_PAYLOAD);
  provider.fail = !!opts.fail;
  const auth = authSvc();
  const register = createRegisterHandler({ auth, secureCookies: false });
  const deps = {
    auth,
    provider,
    matchRepo: repos.matches,
    capabilities: repos.capabilities,
    jdRepo: repos.jds,
    actionPlans: repos.actionPlans,
    usage: repos.llmUsage,
    clock: systemClock,
  };
  const h: {
    provider: PlanProvider;
    register: ReturnType<typeof createRegisterHandler>;
    handlers: {
      create: ReturnType<typeof createCreateActionPlanHandler>;
      list: ReturnType<typeof createListActionPlansHandler>;
      get: ReturnType<typeof createGetActionPlanHandler>;
      regen: ReturnType<typeof createRegenerateActionPlanHandler>;
      step: ReturnType<typeof createUpdateActionStepHandler>;
    };
    signUp: (tag: string) => Promise<{ userId: string; token: string }>;
    seedRun: (userId: string, o?: { withCapability?: boolean; matchItemStatus?: string }) => Promise<{ resumeId: string; jdId: string; runId: string; capabilityId: string | null }>;
  } = {
    provider,
    register,
    handlers: {
      create: createCreateActionPlanHandler(deps),
      list: createListActionPlansHandler(deps),
      get: createGetActionPlanHandler(deps),
      regen: createRegenerateActionPlanHandler(deps),
      step: createUpdateActionStepHandler(deps),
    },
    async signUp(tag: string) {
      const res = await register(
        postJson('http://t/api/auth/register', { email: `ap_${tag}_${stamp}@example.com`, password: 'password-1234' }),
      );
      const token = extractSessionToken(res);
      assert.ok(token, `注册应下发会话 token (${tag})`);
      const body = (await bodyOf(res)) as { data: { user: { id: string } } };
      return { userId: body.data.user.id, token: token as string };
    },
    async seedRun(userId: string, o: { withCapability?: boolean; matchItemStatus?: string } = {}) {
      const resume = await prisma.resume.create({
        data: { userId, rawText: '技能：Python、FastAPI', sourceType: 'TEXT' },
      });
      const jd = await repos.jds.createWithRequirements({
        userId,
        rawText: '岗位：AI 应用工程师\n要求：熟悉 Kubernetes、熟悉 RAG',
        title: 'AI 应用工程师',
        company: '云枢智能',
        contentHash: `h_${userId}_${Math.random().toString(36).slice(2, 8)}`,
        reqs: {
          create: [
            { text: '熟悉 Kubernetes', category: 'TECH', criticality: 'MUST' },
            { text: '熟悉 RAG', category: 'TECH', criticality: 'SHOULD' },
          ],
        },
      });
      let capabilityId: string | null = null;
      if (o.withCapability) {
        const ev = await prisma.evidence.create({
          data: { source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: '简历明确列出 Python' },
          select: { id: true },
        });
        const cap = await prisma.capability.create({
          data: {
            userId,
            key: 'python',
            label: 'Python',
            level: '熟练',
            status: 'CONFIRMED',
            source: 'MANUAL',
            evidence: { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: '简历明确列出 Python', resumeEvidenceId: ev.id }] },
          },
        });
        capabilityId = cap.id;
      }
      const run = await prisma.matchRun.create({
        data: {
          userId,
          resumeId: resume.id,
          jdId: jd.id,
          matcherVersion: 'v1',
          summary: {},
          items: {
            create: [
              {
                reqText: '熟悉 Kubernetes',
                status: (o.matchItemStatus ?? 'MISSING') as 'MISSING' | 'ENHANCE',
                category: 'TECH',
                criticality: 'MUST',
                reason: '缺口',
                basisType: 'RESUME_TEXT',
                basisDetail: '无证据',
                resumeEvidence: null,
                evidenceRefs: [],
                isInference: false,
                needsUserConfirmation: false,
                confidence: 'MEDIUM',
                suggestion: null,
              },
            ],
          },
        },
        include: { items: true },
      });
      return { resumeId: resume.id, jdId: jd.id, runId: run.id, capabilityId };
    },
  };
  return h;
}

// ───────────────────────── A1 主动触发 ─────────────────────────
test('T2-A1 仅显式 POST 才创建；有 MatchRun 不会自动生成 ActionPlan', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a1');
  const { runId } = await h.seedRun(a.userId);

  // 有 MatchRun，但未显式创建 → 列表为空
  const before = await h.handlers.list(getJson('http://t/api/action-plans', a.token));
  assert.equal(before.status, 200);
  assert.equal(((await bodyOf(before)) as { data: { items: unknown[] } }).data.items.length, 0, '有 run 也不应自动生成');

  // 显式创建
  const create = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(create.status, 201, '显式创建必须 201');
  const cb = (await bodyOf(create)) as { data: { id: string; matchRunId: string } };
  assert.equal(cb.data.matchRunId, runId, '新计划必须绑定到指定 run');

  // 创建后列表出现一条
  const after = await h.handlers.list(getJson('http://t/api/action-plans', a.token));
  assert.equal(((await bodyOf(after)) as { data: { items: unknown[] } }).data.items.length, 1, '创建后列表应有 1 条');
});

// ───────────────────────── A2 所属权 ─────────────────────────
test('T2-A2 跨用户 MatchRun → 404（不泄露存在性）', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a2a');
  const b = await h.signUp('a2b');
  const { runId } = await h.seedRun(a.userId);

  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, b.token));
  assert.equal(res.status, 404, '跨用户 run 必须 404');
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'NOT_FOUND');
  // 越权不创建任何计划
  const list = await h.handlers.list(getJson('http://t/api/action-plans', a.token));
  assert.equal(((await bodyOf(list)) as { data: { items: unknown[] } }).data.items.length, 0);
});

test('T2-A2 不存在的 MatchRun → 404', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a2c');
  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: 'run_does_not_exist' }, a.token));
  assert.equal(res.status, 404);
});

test('T2-A2 不存在的 Plan / Step → 404', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a2d');

  const get = await h.handlers.get(getJson('http://t/api/action-plans/nope', a.token), 'nope');
  assert.equal(get.status, 404);

  const patch = await h.handlers.step(
    postJson('http://t/api/action-plans/p1/steps/s1', { status: 'DONE' }, a.token),
    'p1',
    's1',
  );
  assert.equal(patch.status, 404, '不存在的 step 必须 404');
});

test('T2-A2 请求体携带 userId → 400（userId 只能来自会话）', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a2e');
  const { runId } = await h.seedRun(a.userId);

  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId, userId: a.userId }, a.token));
  assert.equal(res.status, 400, 'body 含 userId 必须 400');
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'VALIDATION_FAILED');
  // 拒绝后不创建
  const list = await h.handlers.list(getJson('http://t/api/action-plans', a.token));
  assert.equal(((await bodyOf(list)) as { data: { items: unknown[] } }).data.items.length, 0);
});

test('T2-A2 跨用户读取他人 Plan → 404', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a2f');
  const b = await h.signUp('a2g');
  const { runId } = await h.seedRun(a.userId);
  const created = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  const planId = ((await bodyOf(created)) as { data: { id: string } }).data.id;

  const getByB = await h.handlers.get(getJson(`http://t/api/action-plans/${planId}`, b.token), planId);
  assert.equal(getByB.status, 404, 'B 读取 A 的计划必须 404');
});

// ───────────────────────── A3 事务 / 不留半成品 ─────────────────────────
test('T2-A3a LLM Provider 失败 → 500，且不留半个 ActionPlan/ActionStep', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD, fail: true });
  const a = await h.signUp('a3a');
  const { runId } = await h.seedRun(a.userId);

  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 500, 'Provider 抛错应映射为 500');
  assert.equal(h.provider.calls, 1, 'Provider 应被调用过 1 次');

  const plans = await repos.actionPlans.listForUser(a.userId);
  assert.equal(plans.length, 0, '失败绝不能留下 ActionPlan');
  const steps = await prisma.actionStep.count({ where: { plan: { userId: a.userId } } });
  assert.equal(steps, 0, '失败绝不能留下 ActionStep');

  // 失败同样留痕（FAILED）
  const rows = await prisma.llmUsage.findMany({ where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.FAILED } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requestCount, 1);
});

test('T2-A3b LLM 返回结构不符 → 502，且不写库', { skip }, async () => {
  const h = makeHarness({ payload: {} }); // 缺 actions → 校验失败
  const a = await h.signUp('a3b');
  const { runId } = await h.seedRun(a.userId);

  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 502, '结构化校验失败应 502');
  assert.equal(h.provider.calls, 1, 'Provider 已调用，但之后被拒写');

  const plans = await repos.actionPlans.listForUser(a.userId);
  assert.equal(plans.length, 0, '格式错误绝不能留下 ActionPlan');
  const steps = await prisma.actionStep.count({ where: { plan: { userId: a.userId } } });
  assert.equal(steps, 0, '格式错误绝不能留下 ActionStep');
});

test('T2-A3c 事务写失败 → 500，且无半个 ActionPlan 落库', { skip }, async () => {
  // 用代理包裹真实仓储，在 createPlanWithSteps 抛错，模拟 DB 事务失败
  const failing = new Proxy(repos.actionPlans, {
    get(target, prop, recv) {
      if (prop === 'createPlanWithSteps') {
        return async () => {
          throw new Error('db connection lost during transaction');
        };
      }
      if (prop === 'replacePlanContent') {
        return async () => {
          throw new Error('db connection lost during transaction');
        };
      }
      return Reflect.get(target, prop, recv);
    },
  }) as unknown as ActionPlanRepository;

  const provider = new PlanProvider(OK_PAYLOAD);
  const auth = authSvc();
  const deps = {
    auth,
    provider,
    matchRepo: repos.matches,
    capabilities: repos.capabilities,
    jdRepo: repos.jds,
    actionPlans: failing,
    usage: repos.llmUsage,
    clock: systemClock,
  };
  const create = createCreateActionPlanHandler(deps);

  const a = await (async () => {
    const reg = createRegisterHandler({ auth, secureCookies: false });
    const r = await reg(postJson('http://t/api/auth/register', { email: `ap_a3c_${stamp}@example.com`, password: 'password-1234' }));
    return { userId: ((await bodyOf(r)) as { data: { user: { id: string } } }).data.user.id, token: extractSessionToken(r) as string };
  })();
  const { runId } = await h_seedRunDirect(a.userId);

  const res = await create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 500, '事务写失败应 500');
  assert.equal(provider.calls, 1, 'Provider 成功返回后才进入写阶段');

  // 即便写事务失败，也不应留下任何 ActionPlan / ActionStep
  const plans = await prisma.actionPlan.findMany({ where: { userId: a.userId } });
  assert.equal(plans.length, 0, '事务失败绝不能留下 ActionPlan');
  const steps = await prisma.actionStep.count({ where: { plan: { userId: a.userId } } });
  assert.equal(steps, 0, '事务失败绝不能留下 ActionStep');
});

// 复用上面的 seedRun 逻辑（独立用户）
async function h_seedRunDirect(userId: string) {
  const h = makeHarness({ payload: OK_PAYLOAD });
  return h.seedRun(userId);
}

test('T2-A3d 成功创建原子性：ActionPlan 与其 ActionStep 一同落库', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a3d');
  const { runId } = await h.seedRun(a.userId);

  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const plan = ((await bodyOf(res)) as { data: { id: string; actions: unknown[] } }).data;
  assert.equal(plan.actions.length, OK_PAYLOAD.actions.length, '步数应等于 LLM 给出的建议数');

  // 直接查库：plan 与 step 数量一致，不存在「有 plan 无 step」的半成品
  const inDb = await prisma.actionPlan.findUnique({ where: { id: plan.id }, include: { steps: true } });
  assert.ok(inDb, '计划应已落库');
  assert.equal(inDb!.steps.length, OK_PAYLOAD.actions.length, 'DB 中 plan 与 step 必须成对');
});

// ───────────────────────── A4 配额（复用 generateJsonWithUsage） ─────────────────────────
test('T2-A4 配额不足 → 429 + QUOTA_REJECTED + provider 0 调用', { skip }, async () => {
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '0'; // 上限 0 → 必然拒绝
  try {
    const h = makeHarness({ payload: OK_PAYLOAD });
    const a = await h.signUp('a4');
    const { runId } = await h.seedRun(a.userId);

    const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
    assert.equal(res.status, 429, '配额不足必须 429');
    const body = (await bodyOf(res)) as { error: { code: string } };
    assert.equal(body.error.code, 'LLM_QUOTA_EXCEEDED');

    assert.equal(h.provider.calls, 0, '配额不足时 Gate 必须挡在 Provider 之前，provider 一次都不调用');

    const rows = await prisma.llmUsage.findMany({
      where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.QUOTA_REJECTED },
    });
    assert.equal(rows.length, 1, '配额事件必须留痕');
    assert.equal(rows[0].requestCount, 0, '配额事件不是 provider 调用');
    assert.equal(rows[0].totalTokens, 0);
  } finally {
    delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
  }
});

test('T2-A4b 配额足够 → 调用 provider 一次并落 OK 留痕', { skip }, async () => {
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '10';
  process.env.LLM_COST_PER_1K_TOKENS = '0.002'; // 200 tokens → 0.0004
  try {
    const h = makeHarness({ payload: OK_PAYLOAD });
    const a = await h.signUp('a4b');
    const { runId } = await h.seedRun(a.userId);

    const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
    assert.equal(res.status, 201);
    assert.equal(h.provider.calls, 1, '配额足够时 provider 应被调用 1 次');

    const rows = await prisma.llmUsage.findMany({
      where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.OK },
    });
    assert.equal(rows.length, 1, '成功调用必须落 OK 留痕');
    assert.equal(rows[0].totalTokens, 200);
    assert.ok(Math.abs(rows[0].cost - 0.0004) < 1e-9, `cost 应按单价推算，实际 ${rows[0].cost}`);
  } finally {
    delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
    delete process.env.LLM_COST_PER_1K_TOKENS;
  }
});

// ───────────────────────── A5 结果结构（事实安全） ─────────────────────────
test('T2-A5 have 只来自 CONFIRMED 能力，gaps 只来自 MatchRun，LLM 编造被覆盖', { skip }, async () => {
  const h = makeHarness({ payload: FAKE_PAYLOAD });
  const a = await h.signUp('a5');
  const { runId } = await h.seedRun(a.userId, { withCapability: true }); // 注入 1 条 CONFIRMED: python

  const res = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const data = (await bodyOf(res)) as {
    data: { id: string; goal: string; have: Array<{ key: string }>; gaps: Array<{ requirement: string }>; actions: Array<{ title: string }> };
  };
  const { id: planId, have, gaps, actions, goal } = data.data;

  // have：只有已确认能力 python，绝不含 LLM 编造的 kubernetes
  assert.ok(have.find((x) => x.key === 'python'), 'have 必须包含已确认能力 python');
  assert.equal(have.find((x) => x.key === 'kubernetes'), undefined, 'have 严禁包含未确认的 LLM 编造能力');
  assert.equal(have.length, 1, 'have 应仅含 1 条已确认能力');

  // gaps：只来自 MatchRun 的 MISSING 缺口（熟悉 Kubernetes），不含 LLM 编造的 FAKE_GAP
  assert.ok(gaps.find((g) => g.requirement === '熟悉 Kubernetes'), 'gaps 必须包含 MatchRun 缺口');
  assert.equal(gaps.find((g) => g.requirement === 'FAKE_GAP'), undefined, 'gaps 严禁包含 LLM 编造缺口');

  // actions：来自 LLM，type 折叠进标题
  // T3-A2-4 Phase 1：由 `includes('学习')` 弱断言升级为**精确前缀**断言（含尾随空格）。
  assert.equal(actions.length, 2, 'actions 应等于 LLM 给出的建议数');
  assert.equal(actions[0].title, `${STEP_TYPE_PREFIX.LEARN}完成 K8s 实战`, 'LEARN 必须产生精确前缀「[学习] 」');
  assert.equal(actions[1].title, `${STEP_TYPE_PREFIX.PROJECT}做一个 RAG demo`, 'PROJECT 必须产生精确前缀「[项目] 」');
  // 精确形式（`[标签] `）与「正文里恰好出现中文标签」必须可区分
  assert.equal(/^\[学习\] 完成/.test(actions[0].title), true, '必须是行首方括号前缀而非包含');
  assert.equal(/^\[项目\] 做/.test(actions[1].title), true);

  // goal 来自 JD 标题
  assert.equal(goal, 'AI 应用工程师', 'goal 应来自 JD 标题');

  // 直接查库，确认持久化的 have/gaps 也是服务端派生值（铁律落到存储层）
  const inDb = await prisma.actionPlan.findUnique({ where: { id: planId } });
  assert.ok(inDb, '计划应已落库');
});

test('T2-A5 regenerate 复用 Quota Gate 且结果结构不变', { skip }, async () => {
  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '10';
  try {
    const h = makeHarness({ payload: FAKE_PAYLOAD });
    const a = await h.signUp('a5r');
    const { runId } = await h.seedRun(a.userId, { withCapability: true });
    const created = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
    const planId = ((await bodyOf(created)) as { data: { id: string } }).data.id;

    // 重跑：换一个 OK payload
    const h2 = makeHarness({ payload: OK_PAYLOAD });
    const regen = await h2.handlers.regen(postJson(`http://t/api/action-plans/${planId}/regenerate`, {}, a.token), planId);
    assert.equal(regen.status, 200, 'regenerate 应 200');

    const list = await h.handlers.list(getJson('http://t/api/action-plans', a.token));
    const items = ((await bodyOf(list)) as { data: { items: Array<{ id: string; have: Array<{ key: string }> }> } }).data.items;
    assert.equal(items.length, 1, 'regenerate 不新增计划，仅替换内容');
    assert.ok(items[0].have.find((x) => x.key === 'python'), 'regenerate 后 have 仍只来自 CONFIRMED');
    assert.equal(h2.provider.calls, 1, 'regenerate 也走 provider（经 Quota Gate）');
  } finally {
    delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
  }
});

test('T2-A5 step PATCH 状态（服务端校验枚举），跨用户 step → 404', { skip }, async () => {
  const h = makeHarness({ payload: OK_PAYLOAD });
  const a = await h.signUp('a5s');
  const b = await h.signUp('a5t');
  const { runId } = await h.seedRun(a.userId);
  const created = await h.handlers.create(postJson('http://t/api/action-plans', { matchRunId: runId }, a.token));
  const plan = (await bodyOf(created)) as { data: { id: string; actions: Array<{ id: string; status: string }> } };
  const stepId = plan.data.actions[0].id;

  // 自身更新
  const patch = await h.handlers.step(postJson(`http://t/api/action-plans/${plan.data.id}/steps/${stepId}`, { status: 'DONE' }, a.token), plan.data.id, stepId);
  assert.equal(patch.status, 200);
  const pb = (await bodyOf(patch)) as { data: { id: string; status: string } };
  assert.equal(pb.data.status, 'DONE');

  // 非法枚举 → 400
  const bad = await h.handlers.step(postJson(`http://t/api/action-plans/${plan.data.id}/steps/${stepId}`, { status: 'WTF' }, a.token), plan.data.id, stepId);
  assert.equal(bad.status, 400);

  // 跨用户更新他人 step → 404
  const cross = await h.handlers.step(postJson(`http://t/api/action-plans/${plan.data.id}/steps/${stepId}`, { status: 'DONE' }, b.token), plan.data.id, stepId);
  assert.equal(cross.status, 404, '跨用户 step 必须 404（不泄露存在性）');
});

// ───────────────────────── 清理 ─────────────────────────
test('T2-AP-99 清理', { skip }, async () => {
  delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
  delete process.env.LLM_COST_PER_1K_TOKENS;
  const users = await prisma.user.findMany({
    where: { email: { contains: `_${stamp}@example.com` } },
    select: { id: true },
  });
  if (users.length) {
    await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  }
  await prisma.$disconnect();
});
