import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock, LLM_FEATURE, LLM_USAGE_STATUS } from '../src/ports/index.ts';
import type { CapabilityRepository } from '../src/ports/index.ts';
import type { LLMProvider, LlmTokenUsage } from '../src/llm/provider.ts';
import { createConfirmItemHandler } from '../src/http/handlers/resume-items.ts';
import { createListCapabilitiesHandler } from '../src/http/handlers/capabilities.ts';
import {
  createCreateActionPlanHandler,
  createListActionPlansHandler,
  createGetActionPlanHandler,
  createUpdateActionStepHandler,
  createRegenerateActionPlanHandler,
} from '../src/http/handlers/action-plans.ts';
import {
  buildSearchUrl,
  parseStepKind,
  STEP_KIND_GUIDANCE,
  STEP_KIND_LABEL,
  type StepKind,
} from '../app/_lib/step-entry.ts';

/**
 * QA · T2→T3 桥接「独立验收」（B1~B8 + 反向不变量）
 *
 * 独立性声明（与 tests/qa-t2-acceptance.test.ts 同规格）：
 *   - **不复用** C1~C4 的开发者测试与其 fakes；
 *   - 本文件自带 Provider 与请求构造；
 *   - 真实 Prisma 仓储 + 真实 handler（集成层）。
 *
 * 覆盖：
 *   B1 入口不自动生成   B2 归属隔离   B3 事务原子性   B4 配额
 *   B5 事实安全         B6 执行推进   B7 事实投影闭环（B7.1~B7.6）
 *   B8 本文件即独立验收
 *   反向不变量：ActionStep 置 DONE **不得**产生 Capability / 改动 Skill
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

/* ─────────── QA 自带 Provider ─────────── */

const PAYLOAD = {
  have: [],
  gaps: [],
  actions: [
    { title: '完成 K8s 实战', desc: '用 minikube 部署 3 服务 demo', type: 'LEARN', targetRequirement: '熟悉 Kubernetes' },
    { title: '做一个检索 demo', desc: '实现最小检索增强', type: 'PROJECT', targetRequirement: '熟悉 Kubernetes' },
  ],
};

class BridgeQaProvider implements LLMProvider {
  readonly name = 'qa-bridge-provider';
  calls = 0;
  private payload: unknown;
  private crash: boolean;
  constructor(opts: { payload?: unknown; crash?: boolean } = {}) {
    this.payload = opts.payload ?? PAYLOAD;
    this.crash = opts.crash === true;
  }
  async json<T>(): Promise<T> {
    this.calls += 1;
    if (this.crash) throw new Error('QA 注入：provider 崩溃');
    return this.payload as T;
  }
  async text(): Promise<string> {
    return 'qa';
  }
  async jsonWithUsage<T>(): Promise<{ value: T; usage?: LlmTokenUsage }> {
    this.calls += 1;
    if (this.crash) throw new Error('QA 注入：provider 崩溃');
    return { value: this.payload as T, usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 } };
  }
}

/* ─────────── 装配 ─────────── */

const authService = () =>
  createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });

async function signUp(tag: string) {
  const r = await authService().register({ email: `qa_bridge_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

const confirmHandler = (caps?: CapabilityRepository) =>
  createConfirmItemHandler({ auth: authService(), resumes: repos.resumes, capabilities: caps ?? repos.capabilities });

function planDeps(provider: LLMProvider, caps?: CapabilityRepository) {
  return {
    auth: authService(),
    provider,
    matchRepo: repos.matches,
    capabilities: caps ?? repos.capabilities,
    jdRepo: repos.jds,
    actionPlans: repos.actionPlans,
    usage: repos.llmUsage,
    clock: systemClock,
  };
}

const cookieOf = (t: string) => `jp_session=${t}`;
const req = (method: string, url: string, body: unknown, token?: string) =>
  new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { cookie: cookieOf(token) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
type AnyBody = { data?: any; error?: { code?: string } };
const body = async (r: Response): Promise<AnyBody> => (await r.json()) as AnyBody;

/* ─────────── 夹具 ─────────── */

/** 播种：JD + 简历（可含 CONFIRMED/UNCONFIRMED 技能）+ MatchRun（1 条 MISSING） */
async function seed(
  userId: string,
  opts: { confirmedSkill?: boolean; withEvidence?: boolean; unconfirmedSkill?: boolean } = {},
) {
  const jd = await repos.jds.createWithRequirements({
    userId,
    rawText: 'QA JD',
    title: 'AI 应用工程师',
    company: 'QA 公司',
    contentHash: `qa_bridge_${stamp}_${Math.random().toString(36).slice(2, 10)}`,
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });
  const resume = await prisma.resume.create({
    data: { userId, rawText: 'QA 简历', sourceType: 'TEXT' },
    select: { id: true },
  });

  if (opts.confirmedSkill) {
    const s = await prisma.skill.create({
      data: { resumeId: resume.id, key: 'python', label: 'Python', level: '熟练', status: 'CONFIRMED' },
      select: { id: true },
    });
    if (opts.withEvidence !== false) {
      await prisma.evidence.create({
        data: { source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理', skillId: s.id },
      });
    }
  }
  if (opts.unconfirmedSkill) {
    const s = await prisma.skill.create({
      data: { resumeId: resume.id, key: 'docker', label: 'Docker', status: 'UNCONFIRMED' },
      select: { id: true },
    });
    await prisma.evidence.create({
      data: { source: 'RESUME_TEXT', locator: 'resume:line:3', excerpt: 'Docker', skillId: s.id },
    });
  }

  const run = await prisma.matchRun.create({
    data: {
      userId,
      resumeId: resume.id,
      jdId: jd.id,
      summary: { total: 1, have: 0, enhance: 0, missing: 1, mustTotal: 1, mustHave: 0 },
      items: {
        create: [
          {
            reqText: '精通 Python',
            status: 'MISSING',
            category: 'TECH',
            criticality: 'MUST',
            reason: 'QA',
            basisType: 'GAP',
            basisDetail: 'QA',
            evidenceRefs: [],
          },
        ],
      },
    },
    select: { id: true },
  });
  return { runId: run.id, resumeId: resume.id, jdId: jd.id };
}

/** 可确认的条目：UNCONFIRMED + 可用证据 */
async function seedConfirmable(userId: string) {
  const resume = await prisma.resume.create({
    data: { userId, rawText: 'QA 简历', sourceType: 'TEXT' },
    select: { id: true },
  });
  const skill = await prisma.skill.create({
    data: { resumeId: resume.id, key: 'python', label: 'Python', level: '熟练', status: 'UNCONFIRMED' },
    select: { id: true },
  });
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理', skillId: skill.id },
  });
  return { resumeId: resume.id, skillId: skill.id };
}

const capCount = (userId: string) => prisma.capability.count({ where: { userId } });

/* ═══════════ B1 入口不自动生成 ═══════════ */

test('B1 读取不触发投影：仅有 CONFIRMED 历史事实时，纯读取不产生任何 Capability', { skip }, async () => {
  const a = await signUp('b1');
  const { runId } = await seed(a.userId, { confirmedSkill: true }); // 历史：已确认但未投影
  const provider = new BridgeQaProvider();

  assert.equal(await capCount(a.userId), 0, '前置：无 Capability');

  // 纯读取：能力列表 / 计划列表 / 计划详情
  const caps = await createListCapabilitiesHandler({ auth: authService(), capabilities: repos.capabilities })(
    req('GET', 'http://qa/api/capabilities', undefined, a.token),
  );
  assert.equal(caps.status, 200);

  const list = await createListActionPlansHandler(planDeps(provider))(
    req('GET', 'http://qa/api/action-plans', undefined, a.token),
  );
  assert.equal(list.status, 200);

  const absent = await createGetActionPlanHandler(planDeps(provider))(
    req('GET', 'http://qa/api/action-plans/none', undefined, a.token),
    'none',
  );
  assert.equal(absent.status, 404);

  assert.equal(await capCount(a.userId), 0, '纯读取绝不得投影出 Capability');
  assert.equal(provider.calls, 0, '未显式生成计划前不得调用 LLM');
  void runId;
});

/* ═══════════ B7.1 / B7.6 投影存在性与可见性 ═══════════ */

test('B7.1+B7.6 确认事实→投影出 Capability，且 ActionPlan.have 可见', { skip }, async () => {
  const a = await signUp('b71');
  const { resumeId, skillId } = await seedConfirmable(a.userId);
  const { runId } = await seed(a.userId);

  // C2 主路径：确认 → 投影
  const conf = await confirmHandler()(
    req('PATCH', `http://qa/api/resumes/${resumeId}/items/${skillId}`, { kind: 'SKILL', confirm: true }, a.token),
    resumeId,
    skillId,
  );
  assert.equal(conf.status, 200);

  const cap = await prisma.capability.findUnique({
    where: { userId_key: { userId: a.userId, key: 'python' } },
    include: { evidence: true },
  });
  assert.ok(cap, 'B7.1 确认后必须出现 Capability');
  assert.equal(cap!.status, 'CONFIRMED');
  assert.equal(cap!.evidence.length, 1);
  assert.ok((cap!.evidence[0].excerpt ?? '').length > 0, 'B7.3 证据必须可核验');

  // B7.6 可见性
  const provider = new BridgeQaProvider();
  const created = await createCreateActionPlanHandler(planDeps(provider))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  assert.equal(created.status, 201);
  const plan = (await body(created)).data;
  assert.ok(plan.have.find((h: any) => h.key === 'python'), 'B7.6 have 必须包含已投影能力');
});

/* ═══════════ B7.2 幂等 ═══════════ */

test('B7.2 幂等：重复确认 / 重复 reconcile 不产生重复 Capability 与证据', { skip }, async () => {
  const a = await signUp('b72');
  const { resumeId, skillId } = await seedConfirmable(a.userId);
  const { runId } = await seed(a.userId);

  await confirmHandler()(
    req('PATCH', `http://qa/api/resumes/${resumeId}/items/${skillId}`, { kind: 'SKILL', confirm: true }, a.token),
    resumeId,
    skillId,
  );
  const again = await confirmHandler()(
    req('PATCH', `http://qa/api/resumes/${resumeId}/items/${skillId}`, { kind: 'SKILL', confirm: true }, a.token),
    resumeId,
    skillId,
  );
  assert.equal(again.status, 422, '重复确认仍是 422');

  // 多次生成计划（每次都会 reconcile）
  const provider = new BridgeQaProvider();
  await createCreateActionPlanHandler(planDeps(provider))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  await createCreateActionPlanHandler(planDeps(provider))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );

  assert.equal(await capCount(a.userId), 1, 'B7.2 Capability 不得重复');
  const cap = await prisma.capability.findUniqueOrThrow({
    where: { userId_key: { userId: a.userId, key: 'python' } },
    include: { evidence: true },
  });
  assert.equal(cap.evidence.length, 1, 'B7.2 证据不得堆积');

  const reproject = await repos.capabilities.projectConfirmedSkills(a.userId);
  assert.equal(reproject.created, 0);
  assert.equal(reproject.updated, 0);
  assert.equal(reproject.unchanged, 1);
});

/* ═══════════ B7.3 / B7.5 事实安全 ═══════════ */

test('B7.3/B7.5 CONFIRMED 无证据 与 UNCONFIRMED 均不产生 Capability（不得凭空制造）', { skip }, async () => {
  const a = await signUp('b73');
  await seed(a.userId, { confirmedSkill: true, withEvidence: false, unconfirmedSkill: true });
  const provider = new BridgeQaProvider();
  const { runId } = await seed(a.userId);

  const created = await createCreateActionPlanHandler(planDeps(provider))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  assert.equal(created.status, 201);

  assert.equal(await capCount(a.userId), 0, '无有效证据 / 未确认 一律不得产生 Capability');
  assert.equal(
    await prisma.capability.findUnique({ where: { userId_key: { userId: a.userId, key: 'python' } } }),
    null,
  );
  assert.equal(
    await prisma.capability.findUnique({ where: { userId_key: { userId: a.userId, key: 'docker' } } }),
    null,
  );
  assert.equal((await body(created)).data.have.length, 0, 'B7.5 have 不得凭空出现能力');
});

/* ═══════════ B7.4 单向 ═══════════ */

test('B7.4 单向：投影/reconcile 全程不得修改源 Skill', { skip }, async () => {
  const a = await signUp('b74');
  const { resumeId } = await seed(a.userId, { confirmedSkill: true });
  const { runId } = await seed(a.userId);

  const before = await prisma.skill.findMany({
    where: { resumeId },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { key: 'asc' },
  });

  await createCreateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );

  const after = await prisma.skill.findMany({
    where: { resumeId },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { key: 'asc' },
  });
  assert.deepEqual(after, before, 'Skill 必须原样不变');
});

/* ═══════════ B2 归属隔离 ═══════════ */

test('B2 归属隔离：跨用户 404 / body 注入 userId 400', { skip }, async () => {
  const a = await signUp('b2a');
  const b = await signUp('b2b');
  const { resumeId, skillId } = await seedConfirmable(a.userId);
  const { runId } = await seed(a.userId);

  const crossConfirm = await confirmHandler()(
    req('PATCH', `http://qa/api/resumes/${resumeId}/items/${skillId}`, { kind: 'SKILL', confirm: true }, b.token),
    resumeId,
    skillId,
  );
  assert.equal(crossConfirm.status, 404, '跨用户确认必须 404');
  assert.equal(await capCount(a.userId), 0);
  assert.equal(await capCount(b.userId), 0);

  const inject = await createCreateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId, userId: b.userId }, a.token),
  );
  assert.equal(inject.status, 400, 'body 注入 userId 必须 400');

  const okPlan = await createCreateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  const planId = (await body(okPlan)).data.id;
  const crossRead = await createGetActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('GET', `http://qa/api/action-plans/${planId}`, undefined, b.token),
    planId,
  );
  assert.equal(crossRead.status, 404, '跨用户读计划必须 404');
});

/* ═══════════ B6 执行推进 ═══════════ */

test('B6 执行推进：PATCH 状态持久化，非法枚举 400', { skip }, async () => {
  const a = await signUp('b6');
  const { runId } = await seed(a.userId);

  const created = await createCreateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  const plan = (await body(created)).data;
  const stepId = plan.actions[0].id;

  const patched = await createUpdateActionStepHandler(planDeps(new BridgeQaProvider()))(
    req('PATCH', `http://qa/api/action-plans/${plan.id}/steps/${stepId}`, { status: 'DONE' }, a.token),
    plan.id,
    stepId,
  );
  assert.equal(patched.status, 200);

  const reread = await createGetActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('GET', `http://qa/api/action-plans/${plan.id}`, undefined, a.token),
    plan.id,
  );
  const persisted = (await body(reread)).data.actions.find((s: any) => s.id === stepId);
  assert.equal(persisted.status, 'DONE', '状态必须持久化（服务端为准）');

  const illegal = await createUpdateActionStepHandler(planDeps(new BridgeQaProvider()))(
    req('PATCH', `http://qa/api/action-plans/${plan.id}/steps/${stepId}`, { status: 'FINISHED' }, a.token),
    plan.id,
    stepId,
  );
  assert.equal(illegal.status, 400, '非法枚举必须 400');
});

/* ═══════════ 反向不变量（本阶段核心边界） ═══════════ */

test('反向不变量：ActionStep 置 DONE 不得产生 Capability，也不得改动 Skill', { skip }, async () => {
  const a = await signUp('reverse');
  const { resumeId } = await seed(a.userId, { confirmedSkill: true }); // 已投影出一条能力
  const { runId } = await seed(a.userId);

  const created = await createCreateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  const plan = (await body(created)).data;
  const capsBefore = await capCount(a.userId);
  const skillsBefore = await prisma.skill.findMany({
    where: { resumeId },
    select: { id: true, key: true, status: true },
    orderBy: { key: 'asc' },
  });

  // 把全部步骤推成 DONE
  for (const s of plan.actions) {
    const res = await createUpdateActionStepHandler(planDeps(new BridgeQaProvider()))(
      req('PATCH', `http://qa/api/action-plans/${plan.id}/steps/${s.id}`, { status: 'DONE' }, a.token),
      plan.id,
      s.id,
    );
    assert.equal(res.status, 200);
  }

  assert.equal(await capCount(a.userId), capsBefore, '完成任务绝不能产生新的 Capability');
  const skillsAfter = await prisma.skill.findMany({
    where: { resumeId },
    select: { id: true, key: true, status: true },
    orderBy: { key: 'asc' },
  });
  assert.deepEqual(skillsAfter, skillsBefore, '完成任务绝不能改动 Skill');
});

/* ═══════════ B3 事务原子性 ═══════════ */

test('B3 事务：reconcile 失败 → 500 且不落半个 ActionPlan、不伪造 Capability', { skip }, async () => {
  const a = await signUp('b3');
  const { resumeId } = await seed(a.userId, { confirmedSkill: true });
  const { runId } = await seed(a.userId);

  const failing: CapabilityRepository = {
    ...repos.capabilities,
    projectConfirmedSkills: async () => {
      throw new Error('QA 注入：reconcile 失败');
    },
  };

  const res = await createCreateActionPlanHandler(planDeps(new BridgeQaProvider(), failing))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  assert.equal(res.status, 500);
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0, '不得留下半个计划');
  assert.equal(await capCount(a.userId), 0, '不得伪造 Capability');

  const skill = await prisma.skill.findFirstOrThrow({ where: { resumeId }, select: { status: true } });
  assert.equal(skill.status, 'CONFIRMED', '源 Skill 状态不变');
});

/* ═══════════ B4 配额 ═══════════ */

test('B4 配额：Gate 在 provider 之前，不足 → 429 且 provider 零调用', { skip }, async () => {
  const a = await signUp('b4');
  const { runId } = await seed(a.userId);
  const provider = new BridgeQaProvider();

  process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '0';
  try {
    const res = await createCreateActionPlanHandler(planDeps(provider))(
      req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
    );
    assert.equal(res.status, 429);
    assert.equal(provider.calls, 0, '配额拒绝必须在 provider 之前');

    const rows = await prisma.llmUsage.findMany({
      where: { userId: a.userId, feature: LLM_FEATURE.ACTION_PLAN, status: LLM_USAGE_STATUS.QUOTA_REJECTED },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].requestCount, 0, '配额事件不得伪装成一次调用');
    assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0);
  } finally {
    delete process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY;
  }
});

/* ═══════════ B5 文案事实安全（与 C4 入口一致） ═══════════ */

test('B5 入口文案事实安全：不得把"建议"写成"已掌握/已完成"', () => {
  const FORBIDDEN = ['已掌握', '已具备', '已完成', '你已经', '已学会', '熟练掌握', '精通'];
  const kinds: StepKind[] = ['LEARN', 'PRACTICE', 'PROJECT', 'GENERIC'];

  for (const kind of kinds) {
    const text = `${STEP_KIND_LABEL[kind]} ${STEP_KIND_GUIDANCE[kind]}`;
    for (const w of FORBIDDEN) {
      assert.equal(text.includes(w), false, `文案不得出现事实断言「${w}」`);
    }
    assert.ok(STEP_KIND_GUIDANCE[kind].includes('建议'), '必须是行动建议');
  }

  // 前缀识别与降级（fail-safe）
  assert.equal(parseStepKind('[学习] x'), 'LEARN');
  assert.equal(parseStepKind('[实践] x'), 'PRACTICE');
  assert.equal(parseStepKind('[项目] x'), 'PROJECT');
  assert.equal(parseStepKind('无前缀'), 'GENERIC');
  assert.equal(parseStepKind('[未知] x'), 'GENERIC');

  // 辅助入口：无要求不产出链接
  assert.equal(buildSearchUrl(null), null);
  assert.equal(buildSearchUrl('  '), null);
  assert.ok(buildSearchUrl('熟悉 Kubernetes')!.startsWith('https://'));
});

/* ═══════════ regenerate 也覆盖（B7 的一致性） ═══════════ */

test('B7 一致性：regenerate 同样触发 reconcile 且不新增计划', { skip }, async () => {
  const a = await signUp('regen');
  const { runId, resumeId } = await seed(a.userId);

  const first = await createCreateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', 'http://qa/api/action-plans', { matchRunId: runId }, a.token),
  );
  const plan = (await body(first)).data;
  assert.equal(plan.have.length, 0);

  // 计划生成后才出现 CONFIRMED 事实（历史/直写场景）
  const s = await prisma.skill.create({
    data: { resumeId, key: 'python', label: 'Python', status: 'CONFIRMED' },
    select: { id: true },
  });
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理', skillId: s.id },
  });

  const regen = await createRegenerateActionPlanHandler(planDeps(new BridgeQaProvider()))(
    req('POST', `http://qa/api/action-plans/${plan.id}/regenerate`, {}, a.token),
    plan.id,
  );
  assert.equal(regen.status, 200);
  const next = (await body(regen)).data;
  assert.ok(next.have.find((h: any) => h.key === 'python'), 'regenerate 后 have 必须包含新补能力');
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 1, '不得新增计划');
});

/* ═══════════ 清理 ═══════════ */

test('QA-BRIDGE-99 清理', { skip }, async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `qa_bridge_${stamp}` } } });
  await prisma.$disconnect();
});
