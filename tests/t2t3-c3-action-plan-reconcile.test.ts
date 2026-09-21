import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import type { CapabilityRepository } from '../src/ports/index.ts';
import type { LLMProvider, LlmTokenUsage } from '../src/llm/provider.ts';
import {
  createCreateActionPlanHandler,
  createRegenerateActionPlanHandler,
} from '../src/http/handlers/action-plans.ts';

/**
 * V2 · T2→T3 桥接 · C3 —— ActionPlan 前 Capability Reconcile（安全网）
 *
 * 目标链路：
 *   CONFIRMED Skill(+有效证据) 且 Capability 缺失
 *     → 创建/regenerate ActionPlan
 *     → 先 projectConfirmedSkills(userId)  [reconcile]
 *     → 再 listForUser
 *     → ActionPlan.have 能看到该 Capability
 *
 * 定位：**安全网 / consistency reconcile**，不替代 C2 主路径。
 * 覆盖历史数据、直写 DB、以及任何未经 C2 confirm path 的 CONFIRMED 事实。
 *
 * 只验证 C3；C4(页面入口) 不在此覆盖。
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

const OK_PAYLOAD = {
  have: [],
  gaps: [],
  actions: [{ title: '补 Python', desc: '动手做一个小项目', type: 'PRACTICE', targetRequirement: '精通 Python' }],
};

class C3Provider implements LLMProvider {
  readonly name = 'qa-c3-provider';
  private payload: unknown;
  constructor(payload: unknown) {
    this.payload = payload;
  }
  async json<T>(): Promise<T> {
    return this.payload as T;
  }
  async text(): Promise<string> {
    return 'qa';
  }
  async jsonWithUsage<T>(): Promise<{ value: T; usage?: LlmTokenUsage }> {
    return { value: this.payload as T };
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
  const r = await authService().register({ email: `qa_c3_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

function makeDeps(capabilitiesOverride?: CapabilityRepository) {
  return {
    auth: authService(),
    provider: new C3Provider(OK_PAYLOAD),
    matchRepo: repos.matches,
    capabilities: capabilitiesOverride ?? repos.capabilities,
    jdRepo: repos.jds,
    actionPlans: repos.actionPlans,
    usage: repos.llmUsage,
    clock: systemClock,
  };
}

const createPlan = (deps: ReturnType<typeof makeDeps>) => createCreateActionPlanHandler(deps);
const regenPlan = (deps: ReturnType<typeof makeDeps>) => createRegenerateActionPlanHandler(deps);

const post = (url: string, body: unknown, token?: string) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { cookie: `jp_session=${token}` } : {}) },
    body: JSON.stringify(body),
  });

/* ─────────── 夹具 ─────────── */

/**
 * 播种 MatchRun（含 1 条 MISSING 项）+ 一份简历。
 * 技能按需直写：**模拟历史数据 / 直写 DB**（不经 C2 confirm path，因此没有对应 Capability）。
 */
async function seedRun(
  userId: string,
  opts: { confirmedSkill?: boolean; withEvidence?: boolean; unconfirmedSkill?: boolean } = {},
) {
  const jd = await repos.jds.createWithRequirements({
    userId,
    rawText: 'QA JD',
    title: 'AI 应用工程师',
    company: 'QA 公司',
    contentHash: `qa_c3_${stamp}_${Math.random().toString(36).slice(2, 10)}`,
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });

  const resume = await prisma.resume.create({
    data: { userId, rawText: 'QA 简历', sourceType: 'TEXT' },
    select: { id: true },
  });

  if (opts.confirmedSkill) {
    const skill = await prisma.skill.create({
      data: { resumeId: resume.id, key: 'python', label: 'Python', level: '熟练', status: 'CONFIRMED' },
      select: { id: true },
    });
    if (opts.withEvidence !== false) {
      await prisma.evidence.create({
        data: {
          source: 'RESUME_TEXT',
          locator: 'resume:line:2',
          excerpt: '使用 Python 完成数据处理',
          skillId: skill.id,
        },
      });
    }
  }

  if (opts.unconfirmedSkill) {
    const skill = await prisma.skill.create({
      data: { resumeId: resume.id, key: 'docker', label: 'Docker', status: 'UNCONFIRMED' },
      select: { id: true },
    });
    await prisma.evidence.create({
      data: { source: 'RESUME_TEXT', locator: 'resume:line:3', excerpt: 'Docker', skillId: skill.id },
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

  return { runId: run.id, jdId: jd.id, resumeId: resume.id };
}

const capOf = (userId: string, key = 'python') =>
  prisma.capability.findUnique({ where: { userId_key: { userId, key } }, include: { evidence: true } });

/* ═══════════ C3-1 / C3-6：reconcile 显式触发，且顺序正确 ═══════════ */

test('C3-a 历史数据：CONFIRMED Skill(+证据) 无 Capability → create 前自动 reconcile，且本次 have 即生效', { skip }, async () => {
  const a = await signUp('hist');
  const { runId } = await seedRun(a.userId, { confirmedSkill: true });

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0, '前置：Capability 缺失');

  const res = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const plan = (await res.json()) as { data: { have: Array<{ key: string }>; gaps: unknown[]; actions: unknown[] } };

  // C3-1 投影确实执行
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1, 'reconcile 应补出 Capability');
  const cap = await capOf(a.userId);
  assert.ok(cap);
  assert.equal(cap!.status, 'CONFIRMED');
  assert.equal(cap!.evidence.length, 1, '证据应随投影带过来');

  // C3-6 顺序：project 在 listForUser 之前 → 本次 ActionPlan 的 have 就能看到
  assert.ok(plan.data.have.find((h) => h.key === 'python'), '本次 reconcile 出的能力必须出现在 have 中');
});

/* ═══════════ C3-7：regenerate 同样经过 reconcile ═══════════ */

test('C3-b regenerate 也执行 reconcile（计划生成后才出现 CONFIRMED 事实）', { skip }, async () => {
  const a = await signUp('regen');
  const { runId, resumeId } = await seedRun(a.userId); // 起初没有 CONFIRMED 技能

  const first = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(first.status, 201);
  const plan = (await first.json()) as { data: { id: string; have: unknown[] } };
  assert.equal(plan.data.have.length, 0, '前置：此时没有已确认能力');

  // 计划生成后，才出现 CONFIRMED 事实（模拟历史/直写）
  const skill = await prisma.skill.create({
    data: { resumeId, key: 'python', label: 'Python', status: 'CONFIRMED' },
    select: { id: true },
  });
  await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'resume:line:2', excerpt: '使用 Python 完成数据处理', skillId: skill.id },
  });
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0, '前置：仍未投影');

  const res = await regenPlan(makeDeps())(
    post(`http://qa/api/action-plans/${plan.data.id}/regenerate`, {}, a.token),
    plan.data.id,
  );
  assert.equal(res.status, 200);
  const next = (await res.json()) as { data: { have: Array<{ key: string }> } };

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1, 'regenerate 也应 reconcile');
  assert.ok(next.data.have.find((h) => h.key === 'python'), 'regenerate 后的 have 必须包含新补的能力');
});

/* ═══════════ C3-3：事实安全（复用 C1 规则，不新增生成逻辑）═══════════ */

test('C3-c CONFIRMED 但无有效证据 → 不产生 Capability，have 为空', { skip }, async () => {
  const a = await signUp('noev');
  const { runId } = await seedRun(a.userId, { confirmedSkill: true, withEvidence: false });

  const res = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const plan = (await res.json()) as { data: { have: unknown[] } };

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0, '无有效证据不得产生 Capability');
  assert.equal(plan.data.have.length, 0, 'have 不得凭空出现能力');
});

test('C3-d UNCONFIRMED Skill → 不产生 Capability', { skip }, async () => {
  const a = await signUp('unconf');
  const { runId } = await seedRun(a.userId, { unconfirmedSkill: true });

  const res = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0);
  assert.equal(await capOf(a.userId, 'docker'), null);
});

/* ═══════════ C3-4：幂等 ═══════════ */

test('C3-e 重复 create / regenerate → Capability 不重复、Evidence 不堆积', { skip }, async () => {
  const a = await signUp('idem');
  const { runId } = await seedRun(a.userId, { confirmedSkill: true });

  const first = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(first.status, 201);
  const planId = ((await first.json()) as { data: { id: string } }).data.id;

  // 再 create 一次（同一 MatchRun 允许再生成）
  const second = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(second.status, 201);

  const third = await regenPlan(makeDeps())(
    post(`http://qa/api/action-plans/${planId}/regenerate`, {}, a.token),
    planId,
  );
  assert.equal(third.status, 200);

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1, 'Capability 不得重复');
  const cap = await capOf(a.userId);
  assert.equal(cap!.evidence.length, 1, 'CapabilityEvidence 不得堆积');

  // 显式重投：等价于 C1 的 created=0 / updated=0 / unchanged=1
  const again = await repos.capabilities.projectConfirmedSkills(a.userId);
  assert.equal(again.created, 0);
  assert.equal(again.updated, 0);
  assert.equal(again.unchanged, 1);
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 1);
});

/* ═══════════ C3-2 / 隔离 ═══════════ */

test('C3-f 用户隔离：A 的历史 CONFIRMED 技能不得进入 B 的 Capability / have', { skip }, async () => {
  const a = await signUp('isoA');
  const b = await signUp('isoB');
  await seedRun(a.userId, { confirmedSkill: true }); // A 拥有历史 CONFIRMED 技能
  const { runId: runB } = await seedRun(b.userId); // B 无已确认技能

  const res = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runB }, b.token));
  assert.equal(res.status, 201);
  const plan = (await res.json()) as { data: { have: unknown[] } };

  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0, 'A 的能力不得被 B 的请求投影');
  assert.equal(await prisma.capability.count({ where: { userId: b.userId } }), 0);
  assert.equal(plan.data.have.length, 0, 'B 的 have 不得包含 A 的能力');
});

/* ═══════════ C3-5：失败语义（不吞异常、不伪造、不改 Skill）═══════════ */

test('C3-g reconcile 失败 → 不吞异常（按既有错误约定 500）、不伪造 Capability、不落计划、Skill 不变', { skip }, async () => {
  const a = await signUp('fail');
  const { runId, resumeId } = await seedRun(a.userId, { confirmedSkill: true });

  const failing: CapabilityRepository = {
    ...repos.capabilities,
    projectConfirmedSkills: async () => {
      throw new Error('QA 注入：reconcile 失败');
    },
  };

  const res = await createPlan(makeDeps(failing))(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));

  // 遵循既有约定：异常冒泡 → errorResponse → 500 INTERNAL_ERROR（未新增错误码）
  assert.equal(res.status, 500, '不吞异常，按既有约定返回 500');
  assert.equal(await prisma.capability.count({ where: { userId: a.userId } }), 0, '不得伪造 Capability');
  assert.equal(await prisma.actionPlan.count({ where: { userId: a.userId } }), 0, '不得落半个计划');

  const skill = await prisma.skill.findFirstOrThrow({ where: { resumeId }, select: { status: true } });
  assert.equal(skill.status, 'CONFIRMED', '源 Skill 状态不得被改变');
});

/* ═══════════ C3-9 / C3-10：不改 Skill、既有行为不变 ═══════════ */

test('C3-h reconcile 不改动 Skill；既有 ActionPlan 行为（三类结果 / goal / 初始 TODO）保持不变', { skip }, async () => {
  const a = await signUp('stable');
  const { runId, resumeId } = await seedRun(a.userId, { confirmedSkill: true });

  const before = await prisma.skill.findMany({
    where: { resumeId },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { key: 'asc' },
  });

  const res = await createPlan(makeDeps())(post('http://qa/api/action-plans', { matchRunId: runId }, a.token));
  assert.equal(res.status, 201);
  const plan = (await res.json()) as {
    data: { goal: string; have: unknown[]; gaps: unknown[]; actions: Array<{ id: string; order: number; title: string; desc: string; status: string }> };
  };

  const after = await prisma.skill.findMany({
    where: { resumeId },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { key: 'asc' },
  });
  assert.deepEqual(after, before, 'reconcile 只读 Skill，不得修改');

  // 既有行为不变
  assert.equal(plan.data.goal, 'AI 应用工程师', 'goal 仍取自 JD 标题');
  assert.ok(plan.data.gaps.length >= 1, 'gaps 仍来自 MatchRun 缺口');
  assert.ok(plan.data.actions.length >= 1, 'actions 仍来自 LLM');
  assert.ok(plan.data.actions.every((s) => s.status === 'TODO'), '新建动作仍为 TODO');
  assert.ok(plan.data.have.find((h) => (h as { key: string }).key === 'python'));
});

/* ═══════════ 清理 ═══════════ */

test('C3-99 清理', { skip }, async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `qa_c3_${stamp}` } } });
  await prisma.$disconnect();
});
