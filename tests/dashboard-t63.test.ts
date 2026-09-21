/**
 * T6-3-C —— Dashboard 2.0 Overview API 验收（真实 Prisma + 直接 handler 调用）。
 *
 * 覆盖授权书 §二十：
 *   未登录 401 / 正常 200 / currentGoal / 无 currentGoal / 多 Goal / 无 Goal /
 *   funnel 6 stages / Application=0 / recentApplications limit 5 / sorting /
 *   goalScoped / activity 7d / 30d / lastAppliedAt / staleOver7Days /
 *   REJECTED 排除 / WITHDRAWN 排除 / reminder 结构 / userId 参数被忽略 /
 *   cross-user isolation / Agent 隔离（零 AgentRun / 零 Provider / 零 quota）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import type { Clock } from '../src/ports/index.ts';
import { createGetDashboardOverviewHandler } from '../src/http/handlers/dashboard.ts';
import { createListApplicationsHandler } from '../src/http/handlers/applications.ts';
import { bodyOf, extractSessionToken, postJson } from './fakes.ts';

/** 固定时钟：所有 7d/30d/stale 边界确定性可断言 */
const T0 = new Date('2026-09-19T08:00:00.000Z');
const fixedClock: Clock = { now: () => T0 };
const DAY = 24 * 60 * 60 * 1000;

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createdUserIds: string[] = [];

const auth = createAuthService({
  users: repos.users,
  sessions: repos.sessions,
  failures: createInMemoryFailureLimiter(fixedClock),
  clock: fixedClock,
});
const register = createRegisterHandler({ auth, secureCookies: false });
const deps = {
  auth,
  careerGoals: repos.careerGoals,
  applications: repos.applications,
  // Interview V2-A（§五）：只读 Interview 统计依赖
  interviews: repos.interviews,
  clock: fixedClock,
};
const overview = createGetDashboardOverviewHandler(deps);
const appList = createListApplicationsHandler({ ...deps, jdRepo: repos.jds, resumeVersions: repos.resumeVersions });

async function callApplications(token: string, query = ''): Promise<{ status: number; data: { counts: { total: number; applied: number; screening: number; interviewing: number; offer: number; rejected: number; withdrawn: number }; items: Array<{ id: string; stage: string }> } }> {
  const res = await appList(get(`/api/applications${query}`, token));
  const body = (await bodyOf(res)) as { data?: { counts: { total: number; applied: number; screening: number; interviewing: number; offer: number; rejected: number; withdrawn: number }; items: Array<{ id: string; stage: string }> } };
  return { status: res.status, data: body.data! };
}

test('前置：数据库必须可达', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

function get(path: string, token: string | null): Request {
  return new Request(`http://t${path}`, {
    headers: token ? { cookie: `jp_session=${token}` } : {},
  });
}

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `t63_${tag}_${stamp}@example.com`;
  const res = await register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
  const userId = ((await bodyOf(res)) as { data: { user: { id: string } } }).data.user.id;
  createdUserIds.push(userId);
  return { token: extractSessionToken(res)!, userId };
}

type OverviewData = {
  generatedAt: string;
  currentGoal: { id: string; name: string; position: string; location: string | null; employmentType: string; status: string; isCurrent: boolean; jdCount: number } | null;
  goals: { total: number; active: number; hasCurrent: boolean };
  funnel: { total: number; APPLIED: number; SCREENING: number; INTERVIEWING: number; OFFER: number; REJECTED: number; WITHDRAWN: number };
  goalScoped: { applications: number; interviewing: number; offer: number } | null;
  recentApplications: Array<{ id: string; company: string; position: string | null; stage: string; appliedAt: string; updatedAt: string }>;
  activity: { appliedLast7Days: number; appliedLast30Days: number; lastAppliedAt: string | null; staleOver7Days: number };
  interviews: null;
  reminders: Array<{ kind: string; rule: string; applicationId: string; company: string; position: string | null; staleDays: number; message: string }>;
  aiAdvice: null;
};

async function callOverview(token: string, query = ''): Promise<{ status: number; data: OverviewData }> {
  const res = await overview(get(`/api/dashboard/overview${query}`, token));
  const body = (await bodyOf(res)) as { data?: OverviewData };
  return { status: res.status, data: body.data as OverviewData };
}

async function createGoal(userId: string, opts?: { status?: string; isCurrent?: boolean }): Promise<string> {
  const outcome = await repos.careerGoals.create(userId, {
    name: `目标_${stamp}_${Math.random().toString(36).slice(2, 6)}`,
    position: 'AI 应用工程师',
    employmentType: 'FULL_TIME',
    status: opts?.status ?? 'ACTIVE',
  });
  assert.equal(outcome.kind, 'CREATED');
  if (opts?.isCurrent) {
    const set = await repos.careerGoals.setCurrent(userId, outcome.goal.id);
    assert.equal(set.kind === 'SET' || set.kind === 'NOOP', true);
  }
  return outcome.goal.id;
}

async function createApp(
  userId: string,
  opts: { company?: string; appliedAt?: Date; stage?: string; careerGoalId?: string | null } = {},
): Promise<string> {
  const rec = await repos.applications.create({
    userId,
    company: opts.company ?? '云枢智能',
    jdId: null,
    careerGoalId: opts.careerGoalId ?? null,
    resumeVersionId: null,
    position: null,
    appliedAt: opts.appliedAt ?? T0,
    stage: opts.stage ?? 'APPLIED',
    notes: null,
  });
  return rec.id;
}

/** 直写 updatedAt / appliedAt（绕过 @updatedAt），构造 stale / 次级排序数据 */
async function setTimestamps(id: string, appliedAt: Date, updatedAt: Date): Promise<void> {
  await prisma.$executeRaw`UPDATE "JobApplication" SET "appliedAt" = ${appliedAt}, "updatedAt" = ${updatedAt} WHERE "id" = ${id}`;
}

// ─── 基础契约 ─────────────────────────────────────────────────────────

test('[401] 未登录 → 401', async () => {
  const res = await overview(get('/api/dashboard/overview', null));
  assert.equal(res.status, 401);
});

test('[200] 正常用户 → 200；generatedAt 为 ISO；interviews 为真实最小统计；aiAdvice 恒 null', async () => {
  const u = await makeUser('ok');
  const { status, data } = await callOverview(u.token);
  assert.equal(status, 200);
  assert.equal(new Date(data.generatedAt).toISOString(), data.generatedAt);
  assert.equal(data.aiAdvice, null, 'aiAdvice 冻结为 null（零 LLM）');
  assert.equal('userId' in data, false, '不得回显 userId');
  // Interview V2-A（§五）：无面试数据时为零值统计（不再是恒 null）
  assert.deepEqual(data.interviews, { total: 0, active: 0 });
});

test('[interviews] 真实最小统计：total = 全部 session，active = 未结束数（Interview V2-A）', async () => {
  const u = await makeUser('ivstat');
  const s1out = await repos.interviews.createSession({ userId: u.userId, jdId: null, topic: '面试一' });
  if (s1out.kind !== 'CREATED') throw new Error('createSession 应 CREATED');
  await repos.interviews.createSession({ userId: u.userId, jdId: null, topic: '面试二' });
  // 结束其中一个 → active 减一
  const endOut = await repos.interviews.end(s1out.session.id, u.userId, T0);
  assert.equal(endOut.kind, 'ENDED');
  const { data } = await callOverview(u.token);
  assert.deepEqual(data.interviews, { total: 2, active: 1 });
});

test('[currentGoal] 有 current goal → 返回该目标；不得自动选择其他目标', async () => {
  const u = await makeUser('cur');
  await createGoal(u.userId, { status: 'ACTIVE' });
  const currentId = await createGoal(u.userId, { status: 'ACTIVE', isCurrent: true });
  const { data } = await callOverview(u.token);
  assert.notEqual(data.currentGoal, null);
  assert.equal(data.currentGoal!.id, currentId);
  assert.equal(data.currentGoal!.isCurrent, true);
  assert.equal(data.goals.hasCurrent, true);
});

test('[currentGoal] 无 currentGoal → null（即使存在其他 ACTIVE 目标也不自动选择）', async () => {
  const u = await makeUser('nocur');
  await createGoal(u.userId, { status: 'ACTIVE' });
  const { data } = await callOverview(u.token);
  assert.equal(data.currentGoal, null);
  assert.equal(data.goals.hasCurrent, false);
  assert.equal(data.goalScoped, null, '无 currentGoal → goalScoped 为 null');
});

test('[goals] 多 Goal：total / active 计数正确', async () => {
  const u = await makeUser('multi');
  await createGoal(u.userId, { status: 'ACTIVE' });
  await createGoal(u.userId, { status: 'ACTIVE' });
  await createGoal(u.userId, { status: 'PAUSED' });
  const { data } = await callOverview(u.token);
  assert.equal(data.goals.total, 3);
  assert.equal(data.goals.active, 2);
});

test('[goals] 无 Goal → total 0 / active 0 / hasCurrent false；仍 200', async () => {
  const u = await makeUser('nogoal');
  const { status, data } = await callOverview(u.token);
  assert.equal(status, 200);
  assert.deepEqual(data.goals, { total: 0, active: 0, hasCurrent: false });
  assert.equal(data.currentGoal, null);
  assert.equal(data.goalScoped, null);
});

// ─── funnel / 空数据 ──────────────────────────────────────────────────

test('[funnel] 6 个 stage 全部正确计数；语义与 T6-2 counts 一致', async () => {
  const u = await makeUser('funnel');
  const stages = ['APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN'] as const;
  for (const stage of stages) {
    await createApp(u.userId, { stage });
    await createApp(u.userId, { stage, company: '第二家' });
  }
  const { data } = await callOverview(u.token);
  assert.deepEqual(data.funnel, {
    total: 12,
    APPLIED: 2,
    SCREENING: 2,
    INTERVIEWING: 2,
    OFFER: 2,
    REJECTED: 2,
    WITHDRAWN: 2,
  });
});

test('[empty] Application = 0 → 全 0 + [] + lastAppliedAt null；不得 500', async () => {
  const u = await makeUser('zero');
  const { status, data } = await callOverview(u.token);
  assert.equal(status, 200);
  assert.equal(data.funnel.total, 0);
  assert.deepEqual(data.recentApplications, []);
  assert.equal(data.activity.lastAppliedAt, null);
  assert.equal(data.activity.appliedLast7Days, 0);
  assert.equal(data.activity.appliedLast30Days, 0);
  assert.equal(data.activity.staleOver7Days, 0);
  assert.deepEqual(data.reminders, []);
});

// ─── recentApplications ───────────────────────────────────────────────

test('[recent] 最多 5 条；按 appliedAt DESC；不暴露 userId/notes', async () => {
  const u = await makeUser('recent');
  for (let i = 1; i <= 7; i++) {
    await createApp(u.userId, { company: `公司${i}`, appliedAt: new Date(T0.getTime() - i * DAY) });
  }
  const { data } = await callOverview(u.token);
  assert.equal(data.recentApplications.length, 5);
  // 最新的（1 天前）在前
  assert.equal(data.recentApplications[0].company, '公司1');
  assert.equal(data.recentApplications[4].company, '公司5');
  for (const r of data.recentApplications) {
    assert.equal('userId' in r, false);
    assert.equal('notes' in r, false);
    assert.deepEqual(
      Object.keys(r).sort(),
      ['appliedAt', 'company', 'id', 'position', 'stage', 'updatedAt'],
      '最小必要字段：id/company/position/stage/appliedAt/updatedAt',
    );
  }
});

test('[recent] appliedAt 相同时用 updatedAt 作次级稳定排序', async () => {
  const u = await makeUser('sort');
  const same = new Date(T0.getTime() - 2 * DAY);
  const a = await createApp(u.userId, { company: 'A', appliedAt: same });
  const b = await createApp(u.userId, { company: 'B', appliedAt: same });
  await setTimestamps(a, same, new Date(T0.getTime() - 5 * DAY));
  await setTimestamps(b, same, new Date(T0.getTime() - 1 * DAY));
  const { data } = await callOverview(u.token);
  assert.equal(data.recentApplications[0].id, b, 'updatedAt 较新者在前');
  assert.equal(data.recentApplications[1].id, a);
});

// ─── goalScoped ───────────────────────────────────────────────────────

test('[goalScoped] 有 currentGoal → 按 careerGoalId 聚合 applications/interviewing/offer', async () => {
  const u = await makeUser('scoped');
  const goalId = await createGoal(u.userId, { status: 'ACTIVE', isCurrent: true });
  await createApp(u.userId, { stage: 'APPLIED', careerGoalId: goalId });
  await createApp(u.userId, { stage: 'INTERVIEWING', careerGoalId: goalId });
  await createApp(u.userId, { stage: 'INTERVIEWING', careerGoalId: goalId });
  await createApp(u.userId, { stage: 'OFFER', careerGoalId: goalId });
  await createApp(u.userId, { stage: 'OFFER' }); // 不属于该目标
  await createApp(u.userId, { stage: 'OFFER' });
  const { data } = await callOverview(u.token);
  assert.deepEqual(data.goalScoped, { applications: 4, interviewing: 2, offer: 1 });
  assert.equal(data.funnel.total, 6, 'funnel 仍为全量');
});

// ─── activity ─────────────────────────────────────────────────────────

test('[activity] 7 天 / 30 天计数走 appliedAfter（DB 侧过滤）', async () => {
  const u = await makeUser('act');
  await createApp(u.userId, { appliedAt: new Date(T0.getTime() - 3 * DAY) });   // 7d + 30d
  await createApp(u.userId, { appliedAt: new Date(T0.getTime() - 6 * DAY) });   // 7d + 30d
  await createApp(u.userId, { appliedAt: new Date(T0.getTime() - 20 * DAY) });  // 30d only
  await createApp(u.userId, { appliedAt: new Date(T0.getTime() - 45 * DAY) });  // neither
  const { data } = await callOverview(u.token);
  assert.equal(data.activity.appliedLast7Days, 2);
  assert.equal(data.activity.appliedLast30Days, 3);
});

test('[lastAppliedAt] 最近一次投递时间；无申请为 null', async () => {
  const u = await makeUser('lastat');
  await createApp(u.userId, { appliedAt: new Date(T0.getTime() - 9 * DAY) });
  const latest = await createApp(u.userId, { appliedAt: new Date(T0.getTime() - 2 * DAY) });
  const { data } = await callOverview(u.token);
  assert.notEqual(data.activity.lastAppliedAt, null);
  assert.equal(data.recentApplications[0].id, latest);
  const u2 = await makeUser('lastat0');
  const r2 = await callOverview(u2.token);
  assert.equal(r2.data.activity.lastAppliedAt, null);
});

// ─── stale / reminders ────────────────────────────────────────────────

test('[stale] updatedAt 超 7×24h 未更新才计入；REJECTED / WITHDRAWN 排除', async () => {
  const u = await makeUser('stale');
  const staleAt = new Date(T0.getTime() - 9 * DAY);
  const freshAt = new Date(T0.getTime() - 2 * DAY);
  const s1 = await createApp(u.userId, { stage: 'APPLIED' });
  await setTimestamps(s1, staleAt, staleAt);
  const s2 = await createApp(u.userId, { stage: 'SCREENING' });
  await setTimestamps(s2, staleAt, staleAt);
  const rej = await createApp(u.userId, { stage: 'REJECTED' });
  await setTimestamps(rej, staleAt, staleAt);
  const wd = await createApp(u.userId, { stage: 'WITHDRAWN' });
  await setTimestamps(wd, staleAt, staleAt);
  const fresh = await createApp(u.userId, { stage: 'APPLIED' });
  await setTimestamps(fresh, freshAt, freshAt);
  const edge = await createApp(u.userId, { stage: 'APPLIED' }); // 恰好 7×24h（lt 语义，不计入）
  await setTimestamps(edge, new Date(T0.getTime() - 7 * DAY), new Date(T0.getTime() - 7 * DAY));

  const { data } = await callOverview(u.token);
  assert.equal(data.activity.staleOver7Days, 2, '恰 7×24h 边界不计入（updatedAt < cutoff 严格小于）');
});

test('[reminder] FACT_REMINDER 结构：kind/rule 明确；message 客观描述；不评分', async () => {
  const u = await makeUser('rem');
  const staleAt = new Date(T0.getTime() - 9 * DAY);
  const id = await createApp(u.userId, { stage: 'APPLIED', company: '星际物流' });
  await setTimestamps(id, staleAt, staleAt);
  const { data } = await callOverview(u.token);
  assert.equal(data.reminders.length, 1);
  const r = data.reminders[0];
  assert.equal(r.kind, 'FACT_REMINDER');
  assert.equal(r.rule, 'APPLICATION_STALE_7D');
  assert.equal(r.applicationId, id);
  assert.match(r.message, /星际物流/);
  // staleDays 与 message 必须自洽；约 9 天前（raw 绑定存在 ±8h 偏移，断言下界而非精确值）
  assert.match(r.message, new RegExp(`${r.staleDays} 天未更新`));
  assert.ok(Number.isInteger(r.staleDays) && r.staleDays >= 8, `staleDays 应 ≥8，实际 ${r.staleDays}`);
  assert.equal(/希望不大|放弃|效率下降/.test(r.message), false, 'message 不得含主观评判');
});

// ─── G-2：「已投递」累计总数语义 ──────────────────────────────────────

test('[G-2] stage 变更后累计已投递（funnel.total）不变；funnel 各阶段按当前 stage 正确变化', async () => {
  const u = await makeUser('g2');
  const first = await createApp(u.userId, { stage: 'APPLIED' });
  await createApp(u.userId, { stage: 'APPLIED' });

  let { data } = await callOverview(u.token);
  assert.equal(data.funnel.total, 2, '累计已投递 = 全部 Application 总数 2');
  assert.equal(data.funnel.APPLIED, 2, '当前 APPLIED = 2');

  // stage 流转：一条 APPLIED → INTERVIEWING，另一条 APPLIED → REJECTED
  const updated = await repos.applications.update(first, u.userId, { stage: 'INTERVIEWING' });
  assert.notEqual(updated, null);
  await prisma.jobApplication.updateMany({
    where: { userId: u.userId, stage: 'APPLIED' },
    data: { stage: 'REJECTED' },
  });

  ({ data } = await callOverview(u.token));
  assert.equal(data.funnel.total, 2, '累计已投递不随 stage 变化（仍为 2，REJECTED 也计入）');
  assert.equal(data.funnel.APPLIED, 0, '当前 APPLIED 归零（funnel 保持阶段语义）');
  assert.equal(data.funnel.INTERVIEWING, 1);
  assert.equal(data.funnel.REJECTED, 1);
});

// ─── 权限 / 隔离 ──────────────────────────────────────────────────────

test('[P0-1] 投递页 counts.total：1 APPLIED + 1 INTERVIEWING → 累计 2；分别流转后仍为 2', async () => {
  const u = await makeUser('p01');
  const a1 = await createApp(u.userId, { stage: 'APPLIED' });
  const a2 = await createApp(u.userId, { stage: 'INTERVIEWING' });

  let r = await callApplications(u.token);
  assert.equal(r.data.counts.total, 2, '累计投递 = 全部 Application 总数 2');
  assert.equal(r.data.counts.applied, 1, 'APPLIED 当前阶段数 = 1');
  assert.equal(r.data.counts.interviewing, 1, 'INTERVIEWING 当前阶段数 = 1');

  // 两条分别移动到其他阶段
  await repos.applications.update(a1, u.userId, { stage: 'REJECTED' });
  await repos.applications.update(a2, u.userId, { stage: 'OFFER' });

  r = await callApplications(u.token);
  assert.equal(r.data.counts.total, 2, '累计投递仍然 = 2（不随 stage 变化下降）');
  assert.equal(r.data.counts.applied, 0, 'APPLIED 当前阶段数归零');
  assert.equal(r.data.counts.interviewing, 0, 'INTERVIEWING 当前阶段数归零');
  assert.equal(r.data.counts.rejected, 1);
  assert.equal(r.data.counts.offer, 1);
});

// ─── 权限 / 隔离（原区块，上移自 P0-1 测试之前） ──────────────────────

test('[no userId param] ?userId= 参数被忽略：始终返回会话用户自己的数据', async () => {
  const a = await makeUser('own');
  const b = await makeUser('other');
  await createApp(a.userId, { company: '甲公司' });
  await createApp(b.userId, { company: '乙公司' });
  await createApp(b.userId, { company: '乙公司2' });
  const { data } = await callOverview(a.token, `?userId=${b.userId}`);
  assert.equal(data.funnel.total, 1, '传他人 userId 不得改变结果');
  assert.equal(data.recentApplications[0].company, '甲公司');
});

test('[isolation] cross-user：用户 A 的 overview 不含用户 B 的任何数据', async () => {
  const a = await makeUser('isoA');
  const b = await makeUser('isoB');
  const bGoal = await createGoal(b.userId, { status: 'ACTIVE', isCurrent: true });
  await createApp(b.userId, { company: 'B专属公司', careerGoalId: bGoal });
  const { data } = await callOverview(a.token);
  assert.equal(data.funnel.total, 0);
  assert.equal(data.goals.total, 0);
  assert.equal(data.currentGoal, null);
  assert.deepEqual(data.recentApplications, []);
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes(b.userId), false);
  assert.equal(serialized.includes('B专属公司'), false);
});

// ─── Agent 隔离（授权书 §二十） ────────────────────────────────────────

test('[agent isolation] overview 调用零 AgentRun / 零 llmUsage / deps 无 provider', async () => {
  const u = await makeUser('agentfree');
  await createGoal(u.userId, { status: 'ACTIVE', isCurrent: true });
  await createApp(u.userId, { stage: 'APPLIED' });

  const runsBefore = await prisma.agentRun.count({ where: { userId: u.userId } });
  const usageBefore = await prisma.llmUsage.count({ where: { userId: u.userId } });
  const { status, data } = await callOverview(u.token);
  assert.equal(status, 200);

  assert.equal(await prisma.agentRun.count({ where: { userId: u.userId } }), runsBefore, '不得创建 AgentRun');
  assert.equal(await prisma.llmUsage.count({ where: { userId: u.userId } }), usageBefore, '不得消耗任何 LLM quota');
  assert.equal(runsBefore, 0);
  assert.equal(usageBefore, 0);

  assert.equal('provider' in deps, false, 'Dashboard deps 不得含 provider');
  assert.equal('runtime' in deps, false, 'Dashboard deps 不得含 Agent Runtime');
  assert.equal(data.aiAdvice, null);
});

// ─── 清理 ─────────────────────────────────────────────────────────────

after(async () => {
  if (createdUserIds.length === 0) return;
  // Application 无 DB 级联到 CareerGoal 链接表之外的用户资源；按用户删除本测试产物
  await prisma.jobApplication.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.careerGoalJobDescription.deleteMany({ where: { careerGoal: { userId: { in: createdUserIds } } } });
  await prisma.careerGoal.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});
