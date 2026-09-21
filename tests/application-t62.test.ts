/**
 * T6-2 —— Application Tracker API 验收（真实 Prisma + 直接 handler 调用）。
 *
 * 覆盖授权书 §十三：
 *   create / list / detail / PATCH / ownership / cross-user 404 / body userId 拒绝 /
 *   careerGoal & resumeVersion & JD ownership / ResumeVersion-JD mismatch 400 /
 *   CareerGoal-JD 未绑定 400 / 合法绑定成功 / 无 JD 手动记录 / appliedAt 默认与自定义 /
 *   stage 全 6 值 / 非法 stage / PATCH stage / counts / filters / pagination /
 *   DB CHECK / FK RESTRICT / appliedAt 回填语义。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { systemClock } from '../src/ports/index.ts';
import {
  createCreateApplicationHandler,
  createGetApplicationDetailHandler,
  createListApplicationsHandler,
  createUpdateApplicationHandler,
} from '../src/http/handlers/applications.ts';
import { bodyOf, extractSessionToken, getJson, postJson } from './fakes.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createdUserIds: string[] = [];

test('前置：数据库必须可达', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

function makeHandler() {
  const auth = createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
  const register = createRegisterHandler({ auth, secureCookies: false });
  const deps = {
    auth,
    applications: repos.applications,
    jdRepo: repos.jds,
    careerGoals: repos.careerGoals,
    resumeVersions: repos.resumeVersions,
  };
  return {
    register,
    create: createCreateApplicationHandler(deps),
    list: createListApplicationsHandler(deps),
    get: createGetApplicationDetailHandler(deps),
    patch: createUpdateApplicationHandler(deps),
  };
}

const h = makeHandler();

function req(path: string, token: string, init?: { method?: string; body?: unknown }): Request {
  return new Request(`http://t${path}`, {
    method: init?.method ?? 'GET',
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    headers: {
      cookie: `jp_session=${token}`,
      ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
}

async function makeUser(tag: string): Promise<{ token: string; userId: string }> {
  const email = `t62_${tag}_${stamp}@example.com`;
  const res = await h.register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
  const userId = ((await bodyOf(res)) as { data: { user: { id: string } } }).data.user.id;
  createdUserIds.push(userId);
  return { token: extractSessionToken(res)!, userId };
}

async function createGoal(userId: string, jdId?: string): Promise<string> {
  const outcome = await repos.careerGoals.create(userId, {
    name: `目标_${stamp}`,
    position: 'AI 应用工程师',
    employmentType: 'FULL_TIME',
    status: 'ACTIVE',
    ...(jdId ? { jdIds: [jdId] } : {}),
  });
  assert.equal(outcome.kind, 'CREATED');
  return outcome.goal.id;
}

const validBody = { company: '云枢智能' };

test('[create] 无 JD 手动申请 → 201；appliedAt 默认当前时间；stage 默认 APPLIED', async () => {
  const u = await makeUser('create');
  const before = Date.now() - 1000;
  const res = await h.create(postJson('http://t/api/applications', validBody, u.token));
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as { data: { stage: string; appliedAt: string; position: string | null; careerGoalId: string | null; resumeVersionId: string | null } };
  assert.equal(body.data.stage, 'APPLIED');
  assert.equal(body.data.position, null);
  assert.equal(body.data.careerGoalId, null);
  assert.equal(body.data.resumeVersionId, null);
  const at = new Date(body.data.appliedAt).getTime();
  assert.ok(at >= before && at <= Date.now() + 1000, 'appliedAt 缺省 = 当前时间');
  assert.equal('userId' in body.data, false, '不得回显 userId');
});

test('[create] appliedAt 自定义值生效', async () => {
  const u = await makeUser('appliedAt');
  const custom = '2026-09-01T08:00:00.000Z';
  const res = await h.create(postJson('http://t/api/applications', { ...validBody, appliedAt: custom }, u.token));
  const body = (await bodyOf(res)) as { data: { appliedAt: string } };
  assert.equal(body.data.appliedAt, custom);
});

test('[create] 关联 JD → position 从 JD.title 预填', async () => {
  const u = await makeUser('prefill');
  const jd = await prisma.jobDescription.create({
    data: { userId: u.userId, rawText: 'JD'.repeat(30), title: 'AI 应用工程师' },
    select: { id: true, title: true },
  });
  const body = (await bodyOf(
    await h.create(postJson('http://t/api/applications', { company: '云枢智能', jdId: jd.id }, u.token)),
  )) as { data: { position: string | null; jdId: string | null } };
  assert.equal(body.data.jdId, jd.id);
  assert.equal(body.data.position, 'AI 应用工程师');
});

test('[create] body userId → 400；非法 stage → 400', async () => {
  const u = await makeUser('bad');
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { ...validBody, userId: u.userId }, u.token))).status,
    400,
  );
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { ...validBody, stage: 'DRAFT' }, u.token))).status,
    400,
  );
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { ...validBody, stage: 'CLOSED' }, u.token))).status,
    400,
  );
});

test('[stage] 6 种合法值全部可创建', async () => {
  const u = await makeUser('stages');
  for (const stage of ['APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN']) {
    const res = await h.create(postJson('http://t/api/applications', { company: 'X', stage }, u.token));
    assert.equal(res.status, 201, `stage=${stage} 必须合法`);
  }
});

test('[ownership] careerGoal / resumeVersion / JD 跨用户 → 404', async () => {
  const a = await makeUser('own_a');
  const b = await makeUser('own_b');
  const jdB = await prisma.jobDescription.create({
    data: { userId: b.userId, rawText: 'JD'.repeat(30) },
    select: { id: true },
  });
  const goalB = await createGoal(b.userId);
  const resumeB = await prisma.resume.create({ data: { userId: b.userId, rawText: 'R', sourceType: 'TEXT' }, select: { id: true } });
  const rvB = await prisma.resumeVersion.create({
    data: { resumeId: resumeB.id, versionNo: 1, snapshot: {} },
    select: { id: true },
  });

  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdB.id }, a.token))).status,
    404,
  );
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', careerGoalId: goalB }, a.token))).status,
    404,
  );
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', resumeVersionId: rvB.id }, a.token))).status,
    404,
  );
  // PATCH 同样拦截
  const appA = ((await bodyOf(
    await h.create(postJson('http://t/api/applications', validBody, a.token)),
  )) as { data: { id: string } }).data;
  assert.equal(
    (await h.patch(req(`/api/applications/${appA.id}`, b.token, { method: 'PATCH', body: { careerGoalId: goalB } }), appA.id)).status,
    404,
  );
});

test('[consistency] ResumeVersion.jdId 与 Application.jdId 不一致 → 400；RV.jdId 为 null → 允许', async () => {
  const u = await makeUser('cons_rv');
  const jdA = await prisma.jobDescription.create({ data: { userId: u.userId, rawText: 'A'.repeat(30) }, select: { id: true } });
  const jdMismatch = await prisma.jobDescription.create({ data: { userId: u.userId, rawText: 'M'.repeat(30) }, select: { id: true } });
  const resume = await prisma.resume.create({ data: { userId: u.userId, rawText: 'R', sourceType: 'TEXT' }, select: { id: true } });
  const rvWithJd = await prisma.resumeVersion.create({
    data: { resumeId: resume.id, jdId: jdA.id, versionNo: 1, snapshot: {} },
    select: { id: true },
  });
  const rvNoJd = await prisma.resumeVersion.create({
    data: { resumeId: resume.id, jdId: null, versionNo: 2, snapshot: {} },
    select: { id: true },
  });

  // RV.jdId=A + Application.jdId=A → OK
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdA.id, resumeVersionId: rvWithJd.id }, u.token))).status,
    201,
  );
  // RV.jdId=A + Application.jdId=不匹配 → 400
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdMismatch.id, resumeVersionId: rvWithJd.id }, u.token))).status,
    400,
  );
  // RV.jdId=null + jdId 任意 → 允许
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdMismatch.id, resumeVersionId: rvNoJd.id }, u.token))).status,
    201,
  );
  // PATCH 改 jdId 触发重新校验
  const app = ((await bodyOf(
    await h.create(postJson('http://t/api/applications', { company: 'X', resumeVersionId: rvWithJd.id }, u.token)),
  )) as { data: { id: string } }).data;
  assert.equal(
    (await h.patch(req(`/api/applications/${app.id}`, u.token, { method: 'PATCH', body: { jdId: jdMismatch.id } }), app.id)).status,
    400,
  );
});

test('[consistency] CareerGoal 与 JD 未绑定 → 400；已绑定 → 成功', async () => {
  const u = await makeUser('cons_goal');
  const jdA = await prisma.jobDescription.create({ data: { userId: u.userId, rawText: 'A'.repeat(30) }, select: { id: true } });
  const jdOther = await prisma.jobDescription.create({ data: { userId: u.userId, rawText: 'O'.repeat(30) }, select: { id: true } });
  const goalWithA = await createGoal(u.userId, jdA.id);
  const goalBare = await createGoal(u.userId);

  // goal 绑定 jdA + jdA → 成功
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdA.id, careerGoalId: goalWithA }, u.token))).status,
    201,
  );
  // goal 绑定 jdA + jdOther（未绑定）→ 400
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdOther.id, careerGoalId: goalWithA }, u.token))).status,
    400,
  );
  // goal 无绑定 + jdOther → 400（§五.6：必须存在 (goal, jd) 绑定）
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdOther.id, careerGoalId: goalBare }, u.token))).status,
    400,
  );
  // PATCH 触发重新校验
  const app = ((await bodyOf(
    await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdA.id, careerGoalId: goalWithA }, u.token)),
  )) as { data: { id: string } }).data;
  assert.equal(
    (await h.patch(req(`/api/applications/${app.id}`, u.token, { method: 'PATCH', body: { jdId: jdOther.id } }), app.id)).status,
    400,
  );
});

test('[detail] GET /:id 返回关联摘要；跨用户 404', async () => {
  const a = await makeUser('detail_a');
  const b = await makeUser('detail_b');
  const jd = await prisma.jobDescription.create({
    data: { userId: a.userId, rawText: 'JD'.repeat(30), title: 'AI 工程师', company: '云枢智能' },
    select: { id: true },
  });
  const goal = await createGoal(a.userId, jd.id);
  const app = ((await bodyOf(
    await h.create(postJson('http://t/api/applications', { company: '云枢智能', jdId: jd.id, careerGoalId: goal }, a.token)),
  )) as { data: { id: string } }).data;

  const body = (await bodyOf(
    await h.get(req(`/api/applications/${app.id}`, a.token), app.id),
  )) as { data: { application: { jdSummary: { title: string | null } | null; careerGoalSummary: { name: string } | null; resumeVersionSummary: unknown } } };
  assert.equal(body.data.application.jdSummary?.title, 'AI 工程师');
  assert.ok(body.data.application.careerGoalSummary?.name.startsWith('目标_'));

  assert.equal((await h.get(req(`/api/applications/${app.id}`, b.token), app.id)).status, 404);
  assert.equal((await h.get(req('/api/applications/nonexistent', a.token), 'nonexistent')).status, 404);
});

test('[list] counts / filters / pagination', async () => {
  const u = await makeUser('list');
  const jd = await prisma.jobDescription.create({ data: { userId: u.userId, rawText: 'JD'.repeat(30) }, select: { id: true } });
  const goal = await createGoal(u.userId, jd.id); // goal 绑定该 JD，满足 §五.6 一致性
  // 造 6 条：3 APPLIED（2 绑 goal+jd）、1 SCREENING、1 OFFER、1 REJECTED
  for (let i = 0; i < 3; i += 1) {
    await h.create(postJson('http://t/api/applications', { company: '云枢智能', jdId: jd.id, careerGoalId: goal }, u.token));
  }
  await h.create(postJson('http://t/api/applications', { company: '云枢智能', stage: 'SCREENING' }, u.token));
  await h.create(postJson('http://t/api/applications', { company: '其他公司', stage: 'OFFER' }, u.token));
  await h.create(postJson('http://t/api/applications', { company: '其他公司', stage: 'REJECTED' }, u.token));

  const all = (await bodyOf(await h.list(req('/api/applications', u.token)))) as {
    data: { counts: Record<string, number>; items: unknown[]; pagination: { total: number } };
  };
  assert.deepEqual(all.data.counts, {
    total: 6, applied: 3, screening: 1, interviewing: 0, offer: 1, rejected: 1, withdrawn: 0,
  });

  // filter: stage
  const byStage = (await bodyOf(await h.list(req('/api/applications?stage=SCREENING', u.token)))) as {
    data: { counts: Record<string, number>; items: unknown[] };
  };
  assert.equal(byStage.data.counts.total, 1);
  assert.equal(byStage.data.items.length, 1);

  // filter: careerGoalId
  const byGoal = (await bodyOf(await h.list(req(`/api/applications?careerGoalId=${goal}`, u.token)))) as {
    data: { counts: Record<string, number> };
  };
  assert.equal(byGoal.data.counts.total, 3);

  // filter: jdId
  const byJd = (await bodyOf(await h.list(req(`/api/applications?jdId=${jd.id}`, u.token)))) as {
    data: { counts: Record<string, number> };
  };
  assert.equal(byJd.data.counts.total, 3);

  // filter: company keyword（大小写不敏感包含）
  const byCompany = (await bodyOf(await h.list(req('/api/applications?company=云枢', u.token)))) as {
    data: { counts: Record<string, number> };
  };
  assert.equal(byCompany.data.counts.total, 4);

  // pagination：limit=2 offset=1 → 2 条，hasMore=true，counts 仍全量
  const page = (await bodyOf(await h.list(req('/api/applications?limit=2&offset=1', u.token)))) as {
    data: { counts: Record<string, number>; items: unknown[]; pagination: { hasMore: boolean; total: number } };
  };
  assert.equal(page.data.items.length, 2);
  assert.equal(page.data.pagination.hasMore, true);
  assert.equal(page.data.counts.total, 6, 'counts 不受分页影响');

  // 非法 stage 筛选 → 400
  assert.equal((await h.list(req('/api/applications?stage=DRAFT', u.token))).status, 400);
});

test('[patch] stage / position / notes 全链路', async () => {
  const u = await makeUser('patch');
  const app = ((await bodyOf(
    await h.create(postJson('http://t/api/applications', validBody, u.token)),
  )) as { data: { id: string } }).data;
  const patched = ((await bodyOf(
    await h.patch(req(`/api/applications/${app.id}`, u.token, {
      method: 'PATCH',
      body: { stage: 'INTERVIEWING', position: '高级 AI 工程师', notes: '二面约下周' },
    }), app.id),
  )) as { data: { stage: string; position: string | null; notes: string | null } }).data;
  assert.equal(patched.stage, 'INTERVIEWING');
  assert.equal(patched.position, '高级 AI 工程师');
  assert.equal(patched.notes, '二面约下周');
});

test('[db] FK RESTRICT / stage CHECK / appliedAt 回填语义', async () => {
  const u = await makeUser('dbchk');
  const jd = await prisma.jobDescription.create({ data: { userId: u.userId, rawText: 'JD'.repeat(30) }, select: { id: true } });
  const goal = await createGoal(u.userId, jd.id);
  const app = await prisma.jobApplication.create({
    data: { userId: u.userId, company: 'X', jdId: jd.id, careerGoalId: goal, appliedAt: new Date(), stage: 'APPLIED' },
    select: { id: true },
  });

  // RESTRICT：删除被引用的 JD / CareerGoal 必须被 DB 拒绝
  await assert.rejects(() => prisma.jobDescription.delete({ where: { id: jd.id } }));
  await assert.rejects(() => prisma.careerGoal.delete({ where: { id: goal } }));

  // stage CHECK：非法值拒绝
  await assert.rejects(
    () => prisma.$executeRawUnsafe(`UPDATE "JobApplication" SET stage = 'DRAFT' WHERE id = '${app.id}'`),
  );

  // appliedAt 回填语义：直插不写 appliedAt → DB 默认 now()（仅新行；历史行回填已由 #16 完成）
  const direct = await prisma.jobApplication.create({
    data: { userId: u.userId, company: 'Y', appliedAt: new Date() },
    select: { id: true, appliedAt: true, stage: true },
  });
  assert.equal(direct.stage, 'APPLIED', 'DB 默认 stage 必须是 APPLIED（迁移已把 enum 默认改为 text 默认）');
  assert.ok(direct.appliedAt instanceof Date);

  // 重复申请允许（无 unique）
  const dup = await prisma.jobApplication.create({
    data: { userId: u.userId, company: 'X', jdId: jd.id, careerGoalId: goal, appliedAt: new Date(), stage: 'APPLIED' },
    select: { id: true },
  });
  assert.notEqual(dup.id, app.id);
});

after(async () => {
  for (const id of createdUserIds) {
    // 先解除 RESTRICT 引用（application → jd/goal/rv），再删用户
    await prisma.jobApplication.deleteMany({ where: { userId: id } });
    await prisma.user.deleteMany({ where: { id } });
  }
});
