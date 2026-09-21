/**
 * T6-4-A/B —— Act 状态机 + Act Tool Contract 测试。
 *
 * 授权依据：T6-4-A/B 授权书 §十一（14 项）。
 * 方式：真实 Prisma DB + 既有 handler 直调（与 dashboard-t63 同风格）；零 LLM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import type { Clock } from '../src/ports/index.ts';
import { createConfirmActHandler, createExecuteActHandler, createGetActActionHandler } from '../src/http/handlers/agent-actions.ts';
import { postJson, bodyOf, extractSessionToken } from './fakes.ts';

const prisma = new PrismaClient();
const repos = createPrismaRepositories(prisma);
const T0 = new Date('2026-09-20T02:00:00.000Z');
const clock: Clock = { now: () => T0 };
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createdUserIds: string[] = [];

const auth = createAuthService({
  users: repos.users,
  sessions: repos.sessions,
  failures: createInMemoryFailureLimiter(clock),
  clock,
});
const register = createRegisterHandler({ auth, secureCookies: false });

const actDeps = {
  auth,
  runs: repos.agentRuns,
  agentActions: repos.agentActions,
  careerGoals: repos.careerGoals,
  applications: repos.applications,
  learningTasks: repos.learningTasks,
  jds: repos.jds,
  resumeVersions: repos.resumeVersions,
  actionPlans: repos.actionPlans,
};
const confirm = createConfirmActHandler(actDeps);
const execute = createExecuteActHandler(actDeps);
const getAction = createGetActActionHandler(actDeps);

type AnyBody = { data: any };

function req(method: string, path: string, token: string | null, body?: unknown): Request {
  return new Request(`http://t${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { cookie: `jp_session=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `act_${tag}_${stamp}@example.com`;
  const res = await register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
  const userId = ((await bodyOf(res)) as AnyBody).data.user.id;
  createdUserIds.push(userId);
  return { token: extractSessionToken(res)!, userId };
}

/** 直接经 repository 建 run + proposal（Plan/Propose 属 T5-B 已验收能力，此处为 Act 前置） */
async function makeProposal(userId: string): Promise<string> {
  const run = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: {},
  });
  const outcome = await repos.agentRuns.createProposal(userId, {
    runId: run.id,
    kind: 'PLAN',
    revision: 1,
    payload: { steps: [] },
    basedOnRefs: [],
  });
  assert.equal(outcome.kind, 'CREATED');
  return outcome.proposal.id;
}

async function makeProposalWithRun(userId: string): Promise<{ proposalId: string; runId: string }> {
  const run = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: {},
  });
  const outcome = await repos.agentRuns.createProposal(userId, {
    runId: run.id, kind: 'PLAN', revision: 1, payload: { steps: [] }, basedOnRefs: [],
  });
  assert.equal(outcome.kind, 'CREATED');
  return { proposalId: outcome.proposal.id, runId: run.id };
}

test('前置：数据库必须可达', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

test('[§十一.1] PROPOSED → CONFIRMED：Confirm 创建 CONFIRMED Action', async () => {
  const u = await makeUser('c1');
  const proposalId = await makeProposal(u.userId);
  const res = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'create_career_goal',
    input: { name: `Act目标_${stamp}`, position: 'AI 视频制作实习生', employmentType: 'INTERNSHIP' },
    runId: null,
  }), proposalId);
  const body = (await bodyOf(res)) as AnyBody;
  assert.equal(res.status, 201);
  assert.equal(body.data.status, 'CONFIRMED', 'Confirm 直接产生 CONFIRMED（授权即状态转移）');
  assert.equal(body.data.toolName, 'create_career_goal');
});

test('[§十一.5] 未 Confirm 不得 Execute：PROPOSED 状态 Action 被拒绝', async () => {
  const u = await makeUser('c5');
  const action = await repos.agentActions.create({
    userId: u.userId, runId: null, proposalId: null,
    toolName: 'create_career_goal',
    payload: { name: `X_${stamp}`, position: 'p', employmentType: 'INTERNSHIP' },
    status: 'PROPOSED',
    idempotencyKey: `k5_${stamp}`,
  });
  const res = await execute(req('POST', `/api/agent/actions/${action.id}/execute`, u.token, {}), action.id);
  assert.equal(res.status, 400, 'PROPOSED 不得直接 EXECUTING');
});

test('[§十一.2/3] CONFIRMED → EXECUTING → SUCCEEDED：create_career_goal 全链（零 LLM）', async () => {
  const u = await makeUser('c23');
  const proposalId = await makeProposal(u.userId);
  const cres = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'create_career_goal',
    input: { name: `Act全链_${stamp}`, position: 'AI 应用工程师', employmentType: 'FULL_TIME' },
    runId: null,
  }), proposalId);
  const actionId = ((await bodyOf(cres)) as AnyBody).data.id as string;
  const eres = await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId);
  const body = (await bodyOf(eres)) as AnyBody;
  assert.equal(eres.status, 200);
  assert.equal(body.data.status, 'SUCCEEDED');
  assert.equal(body.data.result.kind, 'CREATED');
  // 既有业务写入口落库（不是第二套写入）
  const goals = await repos.careerGoals.listForUser(u.userId);
  assert.equal(goals.filter((g) => g.name === `Act全链_${stamp}`).length, 1);
});

test('[§十一.4] PROPOSED → CANCELLED：CANCELLED 不得再 Execute', async () => {
  const u = await makeUser('c4');
  const action = await repos.agentActions.create({
    userId: u.userId, runId: null, proposalId: null,
    toolName: 'create_career_goal',
    payload: { name: `C_${stamp}`, position: 'p', employmentType: 'INTERNSHIP' },
    status: 'PROPOSED',
    idempotencyKey: `k4_${stamp}`,
  });
  const cancelled = await repos.agentActions.updateStatus(action.id, u.userId, { status: 'CANCELLED' });
  assert.equal(cancelled?.status, 'CANCELLED');
  const res = await execute(req('POST', `/api/agent/actions/${action.id}/execute`, u.token, {}), action.id);
  assert.equal(res.status, 400, 'CANCELLED 不得执行');
});

test('[§十一.5b] EXECUTING → FAILED：业务校验失败落 errorCode（不自动 retry）', async () => {
  const u = await makeUser('c5b');
  const proposalId = await makeProposal(u.userId);
  // jdIds 含不存在的 JD → 既有 CareerGoal 写入口 JD_NOT_FOUND → FAILED
  const cres = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'create_career_goal',
    input: { name: `Fail_${stamp}`, position: 'p', employmentType: 'INTERNSHIP', jdIds: ['nonexistent_jd'] },
    runId: null,
  }), proposalId);
  const actionId = ((await bodyOf(cres)) as AnyBody).data.id as string;
  const eres = await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId);
  assert.equal(eres.status, 400, '业务校验失败 → 既有错误映射（VALIDATION_FAILED=400）');
  const get = await getAction(req('GET', `/api/agent/actions/${actionId}`, u.token), actionId);
  const gb = (await bodyOf(get)) as AnyBody;
  assert.equal(gb.data.status, 'FAILED');
  assert.match(String(gb.data.errorCode), /VALIDATION|JD/, 'errorCode 落库');
});

test('[§十一.7] SUCCEEDED 不得重复 Execute：复用结果不重复创建', async () => {
  const u = await makeUser('c7');
  const proposalId = await makeProposal(u.userId);
  const cres = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'create_career_goal',
    input: { name: `Dup_${stamp}`, position: 'p', employmentType: 'INTERNSHIP' },
    runId: null,
  }), proposalId);
  const actionId = (await bodyOf(cres) as unknown as AnyBody).data.id;
  const e1 = (await bodyOf(await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId))) as AnyBody;
  assert.equal(e1.data.status, 'SUCCEEDED');
  const e2 = (await bodyOf(await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId))) as AnyBody;
  assert.equal(e2.data.status, 'SUCCEEDED', '重复 execute 返回成功');
  const goals = await repos.careerGoals.listForUser(u.userId);
  assert.equal(goals.filter((g) => g.name === `Dup_${stamp}`).length, 1, '不重复创建事实');
});

test('[§十一.8] 重复 Confirm 不得重复创建事实（proposal 幂等）', async () => {
  const u = await makeUser('c8');
  const proposalId = await makeProposal(u.userId);
  const input = { toolName: 'create_career_goal', input: { name: `RC_${stamp}`, position: 'p', employmentType: 'INTERNSHIP' }, runId: null };
  const r1 = (await bodyOf(await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, input), proposalId))) as AnyBody;
  const r2 = (await bodyOf(await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, input), proposalId))) as AnyBody;
  assert.equal(r1.data.id, r2.data.id, '重复 Confirm 返回同一 Action');
  await execute(req('POST', `/api/agent/actions/${r1.data.id}/execute`, u.token, {}), r1.data.id);
  await execute(req('POST', `/api/agent/actions/${r1.data.id}/execute`, u.token, {}), r1.data.id);
  const goals = await repos.careerGoals.listForUser(u.userId);
  assert.equal(goals.filter((g) => g.name === `RC_${stamp}`).length, 1);
});

test('[§十一.9] 同 payload 重复 Confirm（不同 proposal）幂等：不重复创建事实', async () => {
  const u = await makeUser('c9');
  const p1 = await makeProposal(u.userId);
  const p2 = await makeProposal(u.userId);
  const input = { toolName: 'create_career_goal', input: { name: `IK_${stamp}`, position: 'p', employmentType: 'INTERNSHIP' }, runId: null };
  const a1 = (await bodyOf(await confirm(req('POST', `/api/agent/proposals/${p1}/confirm`, u.token, input), p1))) as AnyBody;
  const a2 = (await bodyOf(await confirm(req('POST', `/api/agent/proposals/${p2}/confirm`, u.token, input), p2))) as AnyBody;
  assert.equal(a1.data.id, a2.data.id, '同 idempotencyKey 复用既有 Action');
  await execute(req('POST', `/api/agent/actions/${a1.data.id}/execute`, u.token, {}), a1.data.id);
  const goals = await repos.careerGoals.listForUser(u.userId);
  assert.equal(goals.filter((g) => g.name === `IK_${stamp}`).length, 1);
});

test('[§十一.10] update_application_stage：合法 stage 流转（既有写入口）', async () => {
  const u = await makeUser('c10');
  const app = await repos.applications.create({
    userId: u.userId, company: `StageCo_${stamp}`, jdId: null, careerGoalId: null,
    resumeVersionId: null, position: null, appliedAt: T0, stage: 'APPLIED', notes: null,
  });
  const proposalId = await makeProposal(u.userId);
  const cres = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'update_application_stage',
    input: { applicationId: app.id, stage: 'INTERVIEWING' },
    runId: null,
  }), proposalId);
  const actionId = (await bodyOf(cres) as unknown as AnyBody).data.id;
  const eres = (await bodyOf(await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId))) as AnyBody;
  assert.equal(eres.data.status, 'SUCCEEDED');
  assert.equal(eres.data.result.stage, 'INTERVIEWING');
  const cur = await prisma.jobApplication.findFirst({ where: { id: app.id } });
  assert.equal(cur?.stage, 'INTERVIEWING');
});

test('[§十一.11] 跨用户：B 不得 Confirm/Execute/GET A 的资源（404 无 oracle）', async () => {
  const a = await makeUser('xa');
  const b = await makeUser('xb');
  const proposalId = await makeProposal(a.userId);
  const cA = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, a.token, {
    toolName: 'create_career_goal',
    input: { name: `Iso_${stamp}`, position: 'p', employmentType: 'INTERNSHIP' },
    runId: null,
  }), proposalId);
  const actionId = (await bodyOf(cA) as unknown as AnyBody).data.id;
  const byB = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, b.token, {
    toolName: 'create_career_goal', input: { name: 'x', position: 'x', employmentType: 'INTERNSHIP' }, runId: null,
  }), proposalId);
  assert.equal(byB.status, 404, 'B confirm A 的 proposal → 404');
  const exB = await execute(req('POST', `/api/agent/actions/${actionId}/execute`, b.token, {}), actionId);
  assert.equal(exB.status, 404, 'B execute A 的 action → 404');
  const gB = await getAction(req('GET', `/api/agent/actions/${actionId}`, b.token), actionId);
  assert.equal(gB.status, 404, 'B GET A 的 action → 404');
});

test('[§十一.12] 未登录：401', async () => {
  const anonC = await confirm(req('POST', '/api/agent/proposals/p_x/confirm', null, {
    toolName: 'create_career_goal', input: { name: 'x', position: 'x', employmentType: 'INTERNSHIP' }, runId: null,
  }), 'p_x');
  const anonE = await execute(req('POST', '/api/agent/actions/a_x/execute', null, {}), 'a_x');
  const anonG = await getAction(req('GET', '/api/agent/actions/a_x', null), 'a_x');
  assert.equal(anonC.status, 401);
  assert.equal(anonE.status, 401);
  assert.equal(anonG.status, 401);
});

test('[§十一.13] 白名单之外的工具：Confirm 一律 400', async () => {
  const u = await makeUser('c13');
  const proposalId = await makeProposal(u.userId);
  const res = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'delete_everything', input: {}, runId: null,
  }), proposalId);
  assert.equal(res.status, 400, '未知工具硬拒绝（无兜底）');
});

test('[§十一.14] Agent 不得绕过业务写入规则：goal-jd 未绑定时 create_application 被拒', async () => {
  const u = await makeUser('c14');
  const goal = await repos.careerGoals.create(u.userId, {
    name: `NoBind_${stamp}`, position: 'p', employmentType: 'INTERNSHIP', status: 'ACTIVE',
  });
  const jd = await jds_create(u.userId);
  assert.ok(goal.kind === 'CREATED');
  const proposalId = await makeProposal(u.userId);
  const cres = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'create_application',
    input: { company: `Bind_${stamp}`, position: 'p', jdId: jd, careerGoalId: goal.goal.id },
    runId: null,
  }), proposalId);
  const actionId = (await bodyOf(cres) as unknown as AnyBody).data.id;
  const eres = await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId);
  assert.equal(eres.status, 400, 'goal-jd 未绑定 → 一致性校验拒绝（与 HTTP 同规则）');
  const appCount = await prisma.jobApplication.count({ where: { userId: u.userId } });
  assert.equal(appCount, 0, '未产生 Application（无绕过）');
});

test('[§十一.补充] create_learning_task：REUSED_EXISTING 幂等 + confirm/execute 全链', async () => {
  const u = await makeUser('clt');
  // 造 plan：直接 repository（actionPlans.create 的调用签名按既有测试）
  const goal = await repos.careerGoals.create(u.userId, {
    name: `LT_${stamp}`, position: 'p', employmentType: 'INTERNSHIP', status: 'ACTIVE',
  });
  assert.ok(goal.kind === 'CREATED');
  // 用最小 plan（走既有 create 入口：projectResults/actionPlans 均可；此处走 learningTasks 前置的 actionPlans.create——若无则经 HTTP 难度大，改用直接 create）
  const jd = await repos.jds.createWithRequirements({
    userId: u.userId, rawText: '要求：剪辑', title: `JDLT_${stamp}`, company: null, contentHash: `jdlt_${stamp}`,
    reqs: { create: [{ text: '剪辑', category: 'TECH', criticality: 'MUST' }] } },
  ) as { id: string };
  const resume = await repos.resumes.createWithItems({
    userId: u.userId, rawText: '技能：剪辑', sourceType: 'TEXT',
    items: [{ section: 'SKILL', title: '剪辑', detail: null, status: 'UNCONFIRMED', source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: '技能：剪辑' }],
  } as never) as { id: string };
  const matchRun = await repos.matches.createRunWithItems({
    userId: u.userId, resumeId: resume.id, jdId: jd.id, matcherVersion: 'v1', summary: {
      total: 0, have: 0, enhance: 0, missing: 0, mustTotal: 0, mustHave: 0, needsUserConfirmation: 0, ambiguous: 0,
    }, items: { create: [] },
  } as never) as { id: string };
  const plan = await repos.actionPlans.createPlanWithSteps({
    userId: u.userId,
    matchRunId: matchRun.id,
    jdId: null,
    goal: `LT 计划_${stamp}`,
    have: [],
    gaps: [],
    steps: [{ order: 1, title: `[学习] 学剪辑`, desc: 'd', targetRequirement: null }],
  });
  const planId = plan.id;
  const stepId = plan.steps[0].id;
  const proposalId = await makeProposal(u.userId);
  const cres = await confirm(req('POST', `/api/agent/proposals/${proposalId}/confirm`, u.token, {
    toolName: 'create_learning_task',
    input: { actionPlanId: planId, sourceStepId: stepId },
    runId: null,
  }), proposalId);
  const actionId = (await bodyOf(cres) as unknown as AnyBody).data.id;
  const e1 = (await bodyOf(await execute(req('POST', `/api/agent/actions/${actionId}/execute`, u.token, {}), actionId))) as AnyBody;
  assert.equal(e1.data.status, 'SUCCEEDED');
  assert.equal(e1.data.result.kind, 'CREATED');
  // 幂等：同 payload 再次 confirm（新 proposal）+ execute → REUSED_EXISTING（业务层不重复创建）
  const p2 = await makeProposal(u.userId);
  const c2 = (await bodyOf(await confirm(req('POST', `/api/agent/proposals/${p2}/confirm`, u.token, {
    toolName: 'create_learning_task', input: { actionPlanId: planId, sourceStepId: stepId }, runId: null,
  }), p2))) as AnyBody;
  const e2 = (await bodyOf(await execute(req('POST', `/api/agent/actions/${c2.data.id}/execute`, u.token, {}), c2.data.id))) as AnyBody;
  assert.equal(e2.data.status, 'SUCCEEDED');
  assert.equal(e2.data.result.id, e1.data.result.id, '幂等复用：返回同一任务的既有结果（§四）');
  const lt = await repos.learningTasks.listForUser(u.userId);
  assert.equal(lt.filter((t) => t.actionPlanId === planId).length, 1, '不重复创建学习任务');
});

async function jds_create(userId: string): Promise<string> {
  const created = await repos.jds.createWithRequirements({
    userId,
    rawText: '要求：TypeScript',
    title: `JD_${stamp}`,
    company: 'probe',
    contentHash: `hash_${stamp}`,
    reqs: { create: [{ text: 'TypeScript', category: 'TECH', criticality: 'MUST' }] },
  } as never);
  return created.id;
}

test.after(async () => {
  // 清理：Act 数据 + 测试用户（业务事实随用户级联）
  await prisma.agentAction.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.agentProposal.deleteMany({ where: { run: { userId: { in: createdUserIds } } } });
  await prisma.agentRun.deleteMany({ where: { userId: { in: createdUserIds } } });
  for (const id of createdUserIds) {
    await prisma.user.deleteMany({ where: { id } });
  }
  await prisma.$disconnect();
});
