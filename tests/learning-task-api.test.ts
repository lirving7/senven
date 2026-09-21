/**
 * T3-A2-6 Phase 2 —— LearningTask API 验收
 *
 * 直接调用 handler 函数（与 project-result-api.test.ts 同一范式），使用真实 Prisma 仓储。
 * 覆盖（授权书 Phase 2 测试要求）：
 *   - authenticated / unauthenticated (401)
 *   - user ownership / IDOR（跨用户 404）
 *   - active duplicate（200 existing）
 *   - archived duplicate（409 LEARNING_TASK_ARCHIVED_EXISTS）
 *   - archive
 *   - status 合法性 / 非法状态（422 LEARNING_TASK_NOT_TRANSITIONABLE）
 *   - content nullable
 *   - sourceStepId 必填（400）
 *   - ActionPlan ownership / existence（404）
 *   - 不允许跨用户访问
 *   - 并发创建最终只有一条记录（P2002 reread）
 *   - 错误码与 HTTP status 映射
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { systemClock } from '../src/ports/index.ts';
import {
  createCreateLearningTaskHandler,
  createListLearningTasksHandler,
  createGetLearningTaskHandler,
  createUpdateLearningTaskHandler,
  createArchiveLearningTaskHandler,
} from '../src/http/handlers/learning-tasks.ts';
import { bodyOf, extractSessionToken, getJson, postJson } from './fakes.ts';
// 真实 route wiring：直接 import route.ts 导出的 GET（验证 route 文件正确导出并连接 handler）
import { GET as learningTaskGetRoute } from '../app/api/learning-tasks/[id]/route.ts';

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const repos = createPrismaRepositories(prisma);

// T3-A2-6 Phase 3：fail-fast —— 数据库不可达必须 FAIL，不得静默 skip
test('前置：数据库必须可达（禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

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
    actionPlans: repos.actionPlans,
    learningTasks: repos.learningTasks,
    clock: systemClock,
  };
  return {
    register,
    handlers: {
      create: createCreateLearningTaskHandler(deps),
      list: createListLearningTasksHandler(deps),
      get: createGetLearningTaskHandler(deps),
      update: createUpdateLearningTaskHandler(deps),
      archive: createArchiveLearningTaskHandler(deps),
    },
    async signUp(tag: string) {
      const res = await register(
        postJson('http://t/api/auth/register', { email: `lt_api_${tag}_${stamp}@example.com`, password: 'password-1234' }),
      );
      const token = extractSessionToken(res);
      assert.ok(token, `注册应下发会话 token (${tag})`);
      const body = (await bodyOf(res)) as { data: { user: { id: string } } };
      return { userId: body.data.user.id, token: token as string };
    },
    async seedPlan(userId: string) {
      const resume = await prisma.resume.create({
        data: { userId, rawText: '技能：Python', sourceType: 'TEXT' },
      });
      const jd = await prisma.jobDescription.create({
        data: {
          userId,
          rawText: 'JD',
          title: '岗位',
          reqs: { create: [{ text: '要求1', category: 'TECH', criticality: 'MUST' }] },
        },
      });
      const matchRun = await prisma.matchRun.create({
        data: {
          userId,
          resumeId: resume.id,
          jdId: jd.id,
          matcherVersion: 'v1',
          summary: {},
          items: {
            create: [{
              reqText: '要求1',
              status: 'MISSING',
              category: 'TECH',
              criticality: 'MUST',
              reason: 'r',
              basisType: 'INFERENCE',
              basisDetail: 'd',
            }],
          },
        },
      });
      const plan = await repos.actionPlans.createPlanWithSteps({
        userId,
        matchRunId: matchRun.id,
        jdId: jd.id,
        goal: 'goal',
        have: [],
        gaps: [],
        steps: [
          { order: 1, title: '[学习] Python 基础', desc: 'desc', targetRequirement: '要求1' },
        ],
      });
      return { plan, step: plan.steps[0] };
    },
  };
}

function createBody(planId: string, stepId: string, content: string | null = null) {
  return { actionPlanId: planId, sourceStepId: stepId, content };
}

async function createTask(h: Harness, token: string, planId: string, stepId: string) {
  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', createBody(planId, stepId), token),
  );
  assert.equal(res.status, 201);
  const body = await bodyOf(res);
  return body.data as { id: string; status: string; archivedAt: string | null; content: string | null };
}

test('完整生命周期：创建 → 更新状态 → 归档', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('lifecycle');
  const { plan, step } = await h.seedPlan(userId);

  const task = await createTask(h, token, plan.id, step.id);
  assert.equal(task.status, 'PLANNED');
  assert.equal(task.archivedAt, null);
  assert.equal(task.content, null);

  // 更新状态 → IN_PROGRESS
  const upd = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token),
    task.id,
  );
  assert.equal(upd.status, 200);
  const updated = (await bodyOf(upd)) as { data: { status: string } };
  assert.equal(updated.data.status, 'IN_PROGRESS');

  // 归档
  const arch = await h.handlers.archive(
    postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token),
    task.id,
  );
  assert.equal(arch.status, 200);
  const archived = (await bodyOf(arch)) as { data: { archivedAt: string | null; status: string } };
  assert.ok(archived.data.archivedAt);
  assert.equal(archived.data.status, 'IN_PROGRESS'); // archive 不改 status

  // 归档后默认列表隐藏
  const listRes = await h.handlers.list(getJson('http://t/api/learning-tasks', token));
  const listBody = await bodyOf(listRes);
  assert.equal((listBody.data as { items: unknown[] }).items.length, 0);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_lifecycle` } } });
});

test('未登录 → 401', async () => {
  const h = makeHarness();
  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', { actionPlanId: 'x', sourceStepId: 'y' }),
  );
  assert.equal(res.status, 401);
});

test('active duplicate → 200 返回已有', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('active_dup');
  const { plan, step } = await h.seedPlan(userId);

  const first = await createTask(h, token, plan.id, step.id);
  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', createBody(plan.id, step.id), token),
  );
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { id: string } };
  assert.equal(body.data.id, first.id);

  // 只有一条记录
  const list = await h.handlers.list(getJson('http://t/api/learning-tasks', token));
  const listBody = (await bodyOf(list)) as { data: { items: unknown[] } };
  assert.equal(listBody.data.items.length, 1);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_active_dup` } } });
});

test('archived duplicate → 409 LEARNING_TASK_ARCHIVED_EXISTS', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('arch_dup');
  const { plan, step } = await h.seedPlan(userId);

  const task = await createTask(h, token, plan.id, step.id);
  await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);

  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', createBody(plan.id, step.id), token),
  );
  assert.equal(res.status, 409);
  const body = await bodyOf(res);
  assert.equal((body.error as { code: string }).code, 'LEARNING_TASK_ARCHIVED_EXISTS');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_arch_dup` } } });
});

test('跨用户访问 → 404（IDOR / ownership）', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('owner');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  const { token: otherToken } = await h.signUp('owner_other');

  // 跨用户 PATCH → 404
  const upd = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, otherToken),
    task.id,
  );
  assert.equal(upd.status, 404);

  // 跨用户 archive → 404
  const arch = await h.handlers.archive(
    postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, otherToken),
    task.id,
  );
  assert.equal(arch.status, 404);

  // 跨用户 actionPlan → 创建 404
  const createRes = await h.handlers.create(
    postJson('http://t/api/learning-tasks', createBody(plan.id, step.id), otherToken),
  );
  assert.equal(createRes.status, 404);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_owner` } } });
});

test('非法状态 → 422 LEARNING_TASK_NOT_TRANSITIONABLE', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('badstatus');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 非空但非法的状态值 → 422（走 handler 的 isLearningTaskStatus 检查）
  for (const bad of ['DONE', 'COMPLETED', 'ARCHIVED', 'UNKNOWN'] as const) {
    const res = await h.handlers.update(
      postJson(`http://t/api/learning-tasks/${task.id}`, { status: bad }, token),
      task.id,
    );
    assert.equal(res.status, 422, `状态 ${bad} 应 422`);
    const body = await bodyOf(res);
    assert.equal((body.error as { code: string }).code, 'LEARNING_TASK_NOT_TRANSITIONABLE');
  }

  // 空字符串 → 400（zod min(1) 拦截，属参数校验，非状态语义）
  const emptyRes = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${task.id}`, { status: '' }, token),
    task.id,
  );
  assert.equal(emptyRes.status, 400);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_badstatus` } } });
});

test('归档后不可修改 status / content → 422', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('arch_lock');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);
  await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);

  const upd = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'PAUSED' }, token),
    task.id,
  );
  assert.equal(upd.status, 422);
  const body = await bodyOf(upd);
  assert.equal((body.error as { code: string }).code, 'LEARNING_TASK_NOT_TRANSITIONABLE');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_arch_lock` } } });
});

test('content nullable + 更新 content', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('content');
  const { plan, step } = await h.seedPlan(userId);

  // 显式 content = null → 创建成功，content 为 null
  const task = await createTask(h, token, plan.id, step.id);
  assert.equal(task.content, null);

  // 更新 content
  const upd = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${task.id}`, { content: '学习了 Python 列表推导' }, token),
    task.id,
  );
  assert.equal(upd.status, 200);
  const updated = (await bodyOf(upd)) as { data: { content: string } };
  assert.equal(updated.data.content, '学习了 Python 列表推导');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_content` } } });
});

test('sourceStepId 必填 → 400', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('nostep');
  const { plan } = await h.seedPlan(userId);

  // 缺 sourceStepId
  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', { actionPlanId: plan.id }, token),
  );
  assert.equal(res.status, 400);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_nostep` } } });
});

test('sourceStepId 不属于该 plan → 400', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('badstep');
  const { plan } = await h.seedPlan(userId);

  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', { actionPlanId: plan.id, sourceStepId: 'not-in-plan' }, token),
  );
  assert.equal(res.status, 400);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_badstep` } } });
});

test('ActionPlan 不存在 → 404', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('noplan');

  const res = await h.handlers.create(
    postJson('http://t/api/learning-tasks', { actionPlanId: 'nonexistent-plan', sourceStepId: 's' }, token),
  );
  assert.equal(res.status, 404);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_noplan` } } });
});

test('并发创建同一 (userId, actionPlanId, sourceStepId) → 最终只有一条', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('concurrent');
  const { plan, step } = await h.seedPlan(userId);

  // 同时发两个创建请求（同一三元组）
  const results = await Promise.all([
    h.handlers.create(postJson('http://t/api/learning-tasks', createBody(plan.id, step.id), token)),
    h.handlers.create(postJson('http://t/api/learning-tasks', createBody(plan.id, step.id), token)),
  ]);

  const statuses = results.map((r) => r.status).sort();
  // 一个 201（首次），一个 200（P2002 reread 命中 active duplicate）
  assert.deepEqual(statuses, [200, 201]);

  // DB 最终只有一条记录
  const count = await prisma.learningTask.count({
    where: { userId, actionPlanId: plan.id, sourceStepId: step.id },
  });
  assert.equal(count, 1);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_concurrent` } } });
});

test('错误码与 HTTP status 映射', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('mapping');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 归档重复 → 409 LEARNING_TASK_ARCHIVED_EXISTS
  await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);
  const dup = await h.handlers.create(
    postJson('http://t/api/learning-tasks', createBody(plan.id, step.id), token),
  );
  assert.equal(dup.status, 409);
  assert.equal(((await bodyOf(dup)).error as { code: string }).code, 'LEARNING_TASK_ARCHIVED_EXISTS');

  // 非法状态 → 422 LEARNING_TASK_NOT_TRANSITIONABLE（已在 badstatus 覆盖，此处验证映射一致）
  const another = await h.seedPlan(userId);
  const t2 = await createTask(h, token, another.plan.id, another.step.id);
  const badUpd = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${t2.id}`, { status: 'DONE' }, token),
    t2.id,
  );
  assert.equal(badUpd.status, 422);
  assert.equal(((await bodyOf(badUpd)).error as { code: string }).code, 'LEARNING_TASK_NOT_TRANSITIONABLE');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_mapping` } } });
});

/* ═══════════ Phase 3 新增：GET /:id、状态迁移矩阵、archive strict body、provider 隔离 ═══════════ */

test('GET /:id：own task → 200 且不含 userId', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('get_own');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  const res = await h.handlers.get(getJson(`http://t/api/learning-tasks/${task.id}`, token), task.id);
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: Record<string, unknown> };
  assert.equal(body.data.id, task.id);
  assert.equal(body.data.status, 'PLANNED');
  assert.equal('userId' in body.data, false, '响应不得包含 userId');
  assert.equal(body.data.archivedAt, null);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_get_own` } } });
});

test('GET /:id：archived task → 200 可读', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('get_arch');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);
  await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);

  const res = await h.handlers.get(getJson(`http://t/api/learning-tasks/${task.id}`, token), task.id);
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { archivedAt: string | null } };
  assert.ok(body.data.archivedAt, '归档任务应可读且 archivedAt 非空');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_get_arch` } } });
});

test('GET /:id：未登录 → 401', async () => {
  const h = makeHarness();
  const res = await h.handlers.get(getJson('http://t/api/learning-tasks/any-id'), 'any-id');
  assert.equal(res.status, 401);
});

test('GET /:id：missing → 404 且无 existence oracle', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('get_missing');
  const res = await h.handlers.get(getJson('http://t/api/learning-tasks/nonexistent', token), 'nonexistent');
  assert.equal(res.status, 404);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'NOT_FOUND');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_get_missing` } } });
});

test('GET /:id：cross-user → 404（不泄露存在性）', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('get_owner');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  const { token: otherToken } = await h.signUp('get_other');
  const res = await h.handlers.get(getJson(`http://t/api/learning-tasks/${task.id}`, otherToken), task.id);
  assert.equal(res.status, 404);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_get_owner` } } });
});

test('状态迁移矩阵：正向迁移 200', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('migrate_forward');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // PLANNED → IN_PROGRESS
  const r1 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token), task.id);
  assert.equal(r1.status, 200);
  assert.equal(((await bodyOf(r1)).data as { status: string }).status, 'IN_PROGRESS');

  // IN_PROGRESS → PAUSED
  const r2 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'PAUSED' }, token), task.id);
  assert.equal(r2.status, 200);
  assert.equal(((await bodyOf(r2)).data as { status: string }).status, 'PAUSED');

  // PAUSED → IN_PROGRESS
  const r3 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token), task.id);
  assert.equal(r3.status, 200);
  assert.equal(((await bodyOf(r3)).data as { status: string }).status, 'IN_PROGRESS');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_migrate_forward` } } });
});

test('状态迁移矩阵：禁止回退到 PLANNED → 422', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('migrate_back');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 先到 IN_PROGRESS
  await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token), task.id);

  // IN_PROGRESS → PLANNED = 422
  const r1 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'PLANNED' }, token), task.id);
  assert.equal(r1.status, 422);
  assert.equal(((await bodyOf(r1)).error as { code: string }).code, 'LEARNING_TASK_NOT_TRANSITIONABLE');

  // 到 PAUSED，PAUSED → PLANNED = 422
  await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'PAUSED' }, token), task.id);
  const r2 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'PLANNED' }, token), task.id);
  assert.equal(r2.status, 422);
  assert.equal(((await bodyOf(r2)).error as { code: string }).code, 'LEARNING_TASK_NOT_TRANSITIONABLE');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_migrate_back` } } });
});

test('状态迁移矩阵：同值 → 200 no-op', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('migrate_noop');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // PLANNED → PLANNED = 200 no-op
  const r1 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'PLANNED' }, token), task.id);
  assert.equal(r1.status, 200);
  assert.equal(((await bodyOf(r1)).data as { status: string }).status, 'PLANNED');

  // 到 IN_PROGRESS 后，IN_PROGRESS → IN_PROGRESS = 200 no-op
  await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token), task.id);
  const r2 = await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token), task.id);
  assert.equal(r2.status, 200);
  assert.equal(((await bodyOf(r2)).data as { status: string }).status, 'IN_PROGRESS');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_migrate_noop` } } });
});

test('archive strict body：非空 body → 400', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('arch_strict');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 未知字段 → 400
  const r1 = await h.handlers.archive(
    postJson(`http://t/api/learning-tasks/${task.id}/archive`, { restore: true }, token),
    task.id,
  );
  assert.equal(r1.status, 400);

  // 非对象字段 → 400
  const r2 = await h.handlers.archive(
    postJson(`http://t/api/learning-tasks/${task.id}/archive`, { status: 'ARCHIVED' }, token),
    task.id,
  );
  assert.equal(r2.status, 400);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_arch_strict` } } });
});

test('archive：正常 + 重复幂等 + 不改变 status', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('arch_idem');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 先到 IN_PROGRESS
  await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { status: 'IN_PROGRESS' }, token), task.id);

  // 正常 archive
  const r1 = await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);
  assert.equal(r1.status, 200);
  const b1 = (await bodyOf(r1)).data as { status: string; archivedAt: string | null };
  assert.equal(b1.status, 'IN_PROGRESS'); // archive 不改 status
  assert.ok(b1.archivedAt);

  // 重复 archive 幂等 → 200，archivedAt 不变
  const r2 = await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);
  assert.equal(r2.status, 200);
  const b2 = (await bodyOf(r2)).data as { archivedAt: string | null };
  assert.equal(b2.archivedAt, b1.archivedAt); // 幂等：不重复改时间戳

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_arch_idem` } } });
});

test('provider 隔离：handler/deps 不含 provider/LLM/quota/Capability/Skill/ProjectResult repository', () => {
  const handler = readFileSync('src/http/handlers/learning-tasks.ts', 'utf8');
  const deps = readFileSync('src/http/deps.ts', 'utf8');

  // 只校验 handler 文件本体（不含注释）—— 不引用 provider / LLM / quota / Capability / Skill / ProjectResult
  const handlerCode = handler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of ['provider', 'LLM', 'quota', 'Capability', 'Skill', 'ProjectResult']) {
    assert.equal(handlerCode.includes(forbidden), false, `handler 不得引用 ${forbidden}`);
  }

  // deps 中 buildLearningTasksHandlerDeps 不含 provider / capabilities / skills / projectResults
  const depsCode = deps.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const buildFn = depsCode.slice(depsCode.indexOf('buildLearningTasksHandlerDeps'));
  for (const forbidden of ['provider', 'capabilities', 'skills', 'projectResults', 'llmUsage']) {
    assert.equal(buildFn.includes(forbidden), false, `buildLearningTasksHandlerDeps 不得包含 ${forbidden}`);
  }
});

test('A：归档后修改 content → 422 且数据库 content 不改变', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('arch_content');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 先写入 content
  await h.handlers.update(postJson(`http://t/api/learning-tasks/${task.id}`, { content: '原始内容' }, token), task.id);

  // 归档
  await h.handlers.archive(postJson(`http://t/api/learning-tasks/${task.id}/archive`, {}, token), task.id);

  // 归档后改 content → 422
  const res = await h.handlers.update(
    postJson(`http://t/api/learning-tasks/${task.id}`, { content: '篡改内容' }, token),
    task.id,
  );
  assert.equal(res.status, 422);
  assert.equal(((await bodyOf(res)).error as { code: string }).code, 'LEARNING_TASK_NOT_TRANSITIONABLE');

  // 数据库 content 未改变
  const row = await prisma.learningTask.findUnique({ where: { id: task.id } });
  assert.equal(row?.content, '原始内容', '归档后 content 不得改变');

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_arch_content` } } });
});

test('C：真实 route wiring —— GET /api/learning-tasks/:id 经 route 导出函数', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('route_get');
  const { plan, step } = await h.seedPlan(userId);
  const task = await createTask(h, token, plan.id, step.id);

  // 经 route.ts 导出的 GET（而非直接调 handler），验证真实 route wiring
  const ctx = { params: Promise.resolve({ id: task.id }) };
  const res = await learningTaskGetRoute(getJson(`http://t/api/learning-tasks/${task.id}`, token), ctx);
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { id: string; status: string } };
  assert.equal(body.data.id, task.id);
  assert.equal(body.data.status, 'PLANNED');

  // 跨用户经 route → 404
  const { token: otherToken } = await h.signUp('route_get_other');
  const res2 = await learningTaskGetRoute(getJson(`http://t/api/learning-tasks/${task.id}`, otherToken), ctx);
  assert.equal(res2.status, 404);

  await prisma.user.deleteMany({ where: { email: { startsWith: `lt_api_route_get` } } });
});
