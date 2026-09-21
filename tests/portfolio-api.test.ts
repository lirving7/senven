/**
 * T4-2 Portfolio API 验收。
 *
 * 直接调用 handler 函数（与 project-result-api.test.ts 同一范式），使用真实 Prisma 仓储。
 * 覆盖：认证 / 归属（跨用户 404）/ 创建边界 / PATCH 白名单 / archive 语义 /
 * membership eligibility（DRAFT/REVOKED 422）/ duplicate add 200 / 排序 / 并发。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { systemClock } from '../src/ports/index.ts';
import {
  createCreatePortfolioProjectHandler,
  createListPortfolioProjectsHandler,
  createGetPortfolioProjectHandler,
  createUpdatePortfolioProjectHandler,
  createArchivePortfolioProjectHandler,
  createAddPortfolioProjectResultHandler,
  createRemovePortfolioProjectResultHandler,
} from '../src/http/handlers/portfolio-projects.ts';
import { bodyOf, deleteJson, extractSessionToken, getJson, postJson } from './fakes.ts';

const dbUp = await (async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
})();

test('前置：数据库必须可达（fail-fast，禁止静默 skip）', () => {
  assert.equal(dbUp, true, 'PostgreSQL 不可达，Portfolio 核心测试不得静默跳过');
});

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

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  const auth = authSvc();
  const register = createRegisterHandler({ auth, secureCookies: false });
  const deps = {
    auth,
    portfolioProjects: repos.portfolioProjects,
    clock: systemClock,
  };
  return {
    handlers: {
      create: createCreatePortfolioProjectHandler(deps),
      list: createListPortfolioProjectsHandler(deps),
      get: createGetPortfolioProjectHandler(deps),
      update: createUpdatePortfolioProjectHandler(deps),
      archive: createArchivePortfolioProjectHandler(deps),
      addResult: createAddPortfolioProjectResultHandler(deps),
      removeResult: createRemovePortfolioProjectResultHandler(deps),
    },
    async signUp(tag: string) {
      const res = await register(
        postJson('http://t/api/auth/register', { email: `pf_api_${tag}_${stamp}@example.com`, password: 'password-1234' }),
      );
      const token = extractSessionToken(res);
      assert.ok(token, `注册应下发会话 token (${tag})`);
      const body = (await bodyOf(res)) as { data: { user: { id: string } } };
      return { userId: body.data.user.id, token: token as string };
    },
    async createProject(token: string, title = '作品集', description: string | null = null) {
      const res = await this.handlers.create(postJson('http://t/api/portfolio-projects', { title, description }, token));
      assert.equal(res.status, 201);
      return ((await bodyOf(res)) as { data: { id: string } }).data.id;
    },
    /** 直接造一个 ProjectResult（含状态），返回 id */
    async seedResult(userId: string, opts: { submittedAt?: Date | null; revokedAt?: Date | null } = {}) {
      const resume = await prisma.resume.create({ data: { userId, rawText: '技能：Python', sourceType: 'TEXT' } });
      const jd = await prisma.jobDescription.create({
        data: { userId, rawText: 'JD', title: '岗位', reqs: { create: [{ text: '要求1', category: 'TECH', criticality: 'MUST' }] } },
      });
      const matchRun = await prisma.matchRun.create({
        data: {
          userId,
          resumeId: resume.id,
          jdId: jd.id,
          matcherVersion: 'v1',
          summary: {},
          items: { create: [{ reqText: '要求1', status: 'MISSING', category: 'TECH', criticality: 'MUST', reason: 'r', basisType: 'INFERENCE', basisDetail: 'd' }] },
        },
      });
      const plan = await repos.actionPlans.createPlanWithSteps({
        userId,
        matchRunId: matchRun.id,
        jdId: jd.id,
        goal: 'goal',
        have: [],
        gaps: [],
        steps: [{ order: 1, title: 'step', desc: 'd', targetRequirement: '要求1' }],
      });
      const submittedAt = opts.submittedAt !== undefined ? opts.submittedAt : new Date('2026-09-16T00:00:00.000Z');
      const revokedAt = opts.revokedAt !== undefined ? opts.revokedAt : null;
      const result = await prisma.projectResult.create({
        data: {
          userId,
          planId: plan.id,
          sourceStepId: plan.steps[0].id,
          sourceStepTitle: 'step',
          title: '成果',
          summary: '描述',
          submittedAt,
          revokedAt,
          contentFingerprint: submittedAt ? 'fp' : null,
        },
      });
      return result.id;
    },
  };
}

test('认证：7 个端点未登录一律 401', async () => {
  const h = makeHarness();
  const noToken = null;
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: 't' }, noToken))).status, 401);
  assert.equal((await h.handlers.list(getJson('http://t/api/portfolio-projects', noToken))).status, 401);
  assert.equal((await h.handlers.get(getJson('http://t/api/portfolio-projects/any', noToken), 'any')).status, 401);
  assert.equal((await h.handlers.update(postJson('http://t/api/portfolio-projects/any', { title: 't' }, noToken), 'any')).status, 401);
  assert.equal((await h.handlers.archive(postJson('http://t/api/portfolio-projects/any/archive', {}, noToken), 'any')).status, 401);
  assert.equal((await h.handlers.addResult(postJson('http://t/api/portfolio-projects/any/results', { projectResultId: 'x' }, noToken), 'any')).status, 401);
  assert.equal((await h.handlers.removeResult(deleteJson('http://t/api/portfolio-projects/any/results/x', noToken), 'any', 'x')).status, 401);
});

test('创建：合法 / title 边界 / description 边界 / 未知字段 / 空 body', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('create');

  // 合法
  const ok = await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: '我的作品', description: 'desc' }, token));
  assert.equal(ok.status, 201);
  const okBody = (await bodyOf(ok)) as { data: { id: string; displayOrder: number; featured: boolean; description: string | null } };
  assert.equal(okBody.data.displayOrder, 0);
  assert.equal(okBody.data.featured, false);

  // title 空 → 400
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: '  ' }, token))).status, 400);
  // title 超 120 → 400
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: 'x'.repeat(121) }, token))).status, 400);
  // description 超 2000 → 400
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: 't', description: 'x'.repeat(2001) }, token))).status, 400);
  // 未知字段 → 400
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: 't', displayOrder: 5 }, token))).status, 400);
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: 't', userId: 'hack' }, token))).status, 400);
  // 空 body → 400
  assert.equal((await h.handlers.create(postJson('http://t/api/portfolio-projects', {}, token))).status, 400);

  // description 清空归一化为 null（NOTE-2）
  const nullDesc = await h.handlers.create(postJson('http://t/api/portfolio-projects', { title: 't2', description: '' }, token));
  assert.equal(nullDesc.status, 201);
  assert.equal(((await bodyOf(nullDesc)) as { data: { description: string | null } }).data.description, null);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_create` } } });
});

test('归属：跨用户 / 不存在 → 404（无 existence oracle）', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('owner');
  const { token: otherToken } = await h.signUp('other');
  const id = await h.createProject(token);

  // 跨用户 get/patch/archive/add/remove → 404
  assert.equal((await h.handlers.get(getJson(`http://t/api/portfolio-projects/${id}`, otherToken), id)).status, 404);
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { title: 'x' }, otherToken), id)).status, 404);
  assert.equal((await h.handlers.archive(postJson(`http://t/api/portfolio-projects/${id}/archive`, {}, otherToken), id)).status, 404);
  assert.equal((await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: 'x' }, otherToken), id)).status, 404);
  assert.equal((await h.handlers.removeResult(deleteJson(`http://t/api/portfolio-projects/${id}/results/x`, otherToken), id, 'x')).status, 404);

  // 不存在 id → 404（同状态码，不泄露）
  assert.equal((await h.handlers.get(getJson('http://t/api/portfolio-projects/nonexistent', token), 'nonexistent')).status, 404);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_owner` } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_other` } } });
});

test('PATCH：白名单 / 空对象 / 禁止字段 / 归档后 409', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('patch');
  const id = await h.createProject(token);

  // 每个白名单字段
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { title: '新标题' }, token), id)).status, 200);
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { description: 'd' }, token), id)).status, 200);
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { displayOrder: 3 }, token), id)).status, 200);
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { featured: true }, token), id)).status, 200);

  // 空对象 → 400
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, {}, token), id)).status, 400);
  // 禁止字段 → 400
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { archivedAt: '2026-01-01' }, token), id)).status, 400);
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { userId: 'hack' }, token), id)).status, 400);
  assert.equal((await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { createdAt: '2026-01-01' }, token), id)).status, 400);

  // 归档后 PATCH → 409
  await h.handlers.archive(postJson(`http://t/api/portfolio-projects/${id}/archive`, {}, token), id);
  const archivedPatch = await h.handlers.update(postJson(`http://t/api/portfolio-projects/${id}`, { title: 'x' }, token), id);
  assert.equal(archivedPatch.status, 409);
  assert.equal(((await bodyOf(archivedPatch)) as { error: { code: string } }).error.code, 'PORTFOLIO_ARCHIVED');

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_patch` } } });
});

test('archive：首次 200 / 重复 200 不改变 archivedAt / GET 仍 200 / 无 restore', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('archive');
  const id = await h.createProject(token);

  const first = await h.handlers.archive(postJson(`http://t/api/portfolio-projects/${id}/archive`, {}, token), id);
  assert.equal(first.status, 200);
  const firstAt = ((await bodyOf(first)) as { data: { archivedAt: string } }).data.archivedAt;
  assert.ok(firstAt);

  // 重复 archive → 200 且 archivedAt 不变
  const second = await h.handlers.archive(postJson(`http://t/api/portfolio-projects/${id}/archive`, {}, token), id);
  assert.equal(second.status, 200);
  const secondAt = ((await bodyOf(second)) as { data: { archivedAt: string } }).data.archivedAt;
  assert.equal(secondAt, firstAt);

  // 归档后 GET detail 仍 200
  assert.equal((await h.handlers.get(getJson(`http://t/api/portfolio-projects/${id}`, token), id)).status, 200);

  // 归档后列表隐藏
  const list = await h.handlers.list(getJson('http://t/api/portfolio-projects', token));
  const items = ((await bodyOf(list)) as { data: { items: unknown[] } }).data.items;
  assert.equal(items.length, 0);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_archive` } } });
});

test('membership：submitted 201 / DRAFT 422 / REVOKED 422 / 重复 200 不改 displayOrder / 跨用户 ProjectResult 404', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('member');
  const { userId: otherUserId, token: otherToken } = await h.signUp('member_other');
  const id = await h.createProject(token);

  // submitted → 201
  const submitted = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });
  const add1 = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: submitted, displayOrder: 7 }, token), id);
  assert.equal(add1.status, 201);

  // DRAFT → 422
  const draft = await h.seedResult(userId, { submittedAt: null, revokedAt: null });
  const addDraft = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: draft }, token), id);
  assert.equal(addDraft.status, 422);
  assert.equal(((await bodyOf(addDraft)) as { error: { code: string } }).error.code, 'PORTFOLIO_RESULT_NOT_ELIGIBLE');

  // REVOKED → 422
  const revoked = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: new Date('2026-09-17T00:00:00.000Z') });
  const addRevoked = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: revoked }, token), id);
  assert.equal(addRevoked.status, 422);

  // 重复加入（不同 displayOrder）→ 200 且不改原 displayOrder
  const dup = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: submitted, displayOrder: 999 }, token), id);
  assert.equal(dup.status, 200);
  assert.equal(((await bodyOf(dup)) as { data: { displayOrder: number } }).data.displayOrder, 7);

  // 跨用户 ProjectResult → 404
  const otherResult = await h.seedResult(otherUserId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });
  const cross = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: otherResult }, token), id);
  assert.equal(cross.status, 404);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_member` } } });
});

test('detail 二分：results / revokedResults / activeResultCount 穷尽', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('detail');
  const id = await h.createProject(token);

  const active = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });
  const toRevoke = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });
  await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: active }, token), id);
  await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: toRevoke }, token), id);

  // 成员加入后，其关联 ProjectResult 被撤销 → 该成员应被归类到 revokedResults（G-2 穷尽性）
  await prisma.projectResult.update({ where: { id: toRevoke }, data: { revokedAt: new Date('2026-09-17T00:00:00.000Z') } });

  const detail = await h.handlers.get(getJson(`http://t/api/portfolio-projects/${id}`, token), id);
  const body = ((await bodyOf(detail)) as { data: { results: unknown[]; revokedResults: unknown[]; activeResultCount: number } }).data;
  assert.equal(body.results.length, 1);
  assert.equal(body.revokedResults.length, 1);
  assert.equal(body.activeResultCount, 1);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_detail` } } });
});

test('REMOVE：正常移除 / 归档后 409 / 不存在 404', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('remove');
  const id = await h.createProject(token);
  const result = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });
  await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: result }, token), id);

  // 移除 → 200
  assert.equal((await h.handlers.removeResult(deleteJson(`http://t/api/portfolio-projects/${id}/results/${result}`, token), id, result)).status, 200);
  // 再移除（不存在）→ 404
  assert.equal((await h.handlers.removeResult(deleteJson(`http://t/api/portfolio-projects/${id}/results/${result}`, token), id, result)).status, 404);

  // 重新加入 + 归档 + 移除 → 409
  await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: result }, token), id);
  await h.handlers.archive(postJson(`http://t/api/portfolio-projects/${id}/archive`, {}, token), id);
  assert.equal((await h.handlers.removeResult(deleteJson(`http://t/api/portfolio-projects/${id}/results/${result}`, token), id, result)).status, 409);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_remove` } } });
});

test('并发：重复 ADD 最终只有一条关系', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('concurrent');
  const id = await h.createProject(token);
  const result = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });

  const [r1, r2] = await Promise.all([
    h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: result }, token), id),
    h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: result }, token), id),
  ]);
  const statuses = [r1.status, r2.status].sort();
  // 一个 201（首次）+ 一个 200（重复），不得 500
  assert.ok(statuses.includes(201) && statuses.includes(200), `期望 [200,201]，实际 ${statuses}`);

  // 最终 DB 只有一条关系
  const count = await prisma.portfolioProjectResult.count({ where: { portfolioProjectId: id, projectResultId: result } });
  assert.equal(count, 1);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_concurrent` } } });
});

test('ISSUE-1：active 加入 → revoke → 再 ADD 同 ProjectResult → 200 existing，member 仍 1，displayOrder 不变', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('revoke_readd');
  const id = await h.createProject(token);
  const result = await h.seedResult(userId, { submittedAt: new Date('2026-09-16T00:00:00.000Z'), revokedAt: null });

  // 首次加入 active → 201，displayOrder=5
  const first = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: result, displayOrder: 5 }, token), id);
  assert.equal(first.status, 201);

  // 直接 revoke ProjectResult
  await prisma.projectResult.update({ where: { id: result }, data: { revokedAt: new Date('2026-09-17T00:00:00.000Z') } });

  // 再次 ADD 同一 ProjectResult → 200 existing（即使已 revoked）
  const again = await h.handlers.addResult(postJson(`http://t/api/portfolio-projects/${id}/results`, { projectResultId: result, displayOrder: 999 }, token), id);
  assert.equal(again.status, 200);
  assert.equal(((await bodyOf(again)) as { data: { displayOrder: number } }).data.displayOrder, 5, 'displayOrder 不改变');

  // member 数量仍为 1
  const count = await prisma.portfolioProjectResult.count({ where: { portfolioProjectId: id, projectResultId: result } });
  assert.equal(count, 1);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pf_api_revoke_readd` } } });
});
