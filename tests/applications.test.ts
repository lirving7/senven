import test from 'node:test';
import assert from 'node:assert/strict';

import {
  APPLICATION_STAGE,
  APPLICATION_STAGE_LABEL,
  countByStage,
  DEFAULT_STAGE,
  toView,
} from '../src/domain/application/types.ts';
import type { ApplicationRecord } from '../src/domain/application/types.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import {
  createCreateApplicationHandler,
  createListApplicationsHandler,
  createUpdateApplicationHandler,
  DEFAULT_PAGE_SIZE,
} from '../src/http/handlers/applications.ts';
import {
  FixedClock,
  InMemoryApplicationRepository,
  InMemoryJdRepository,
  InMemorySessionRepository,
  InMemoryUserRepository,
  bodyOf,
  extractSessionToken,
  postJson,
  getJson,
} from './fakes.ts';

function record(over: Partial<ApplicationRecord> = {}): ApplicationRecord {
  const t = new Date('2026-09-16T00:00:00.000Z');
  return {
    id: 'app_1',
    company: '云枢智能',
    jdId: null,
    careerGoalId: null,
    resumeVersionId: null,
    position: null,
    appliedAt: t,
    stage: APPLICATION_STAGE.APPLIED,
    notes: null,
    createdAt: t,
    updatedAt: t,
    ...over,
  };
}

/* ------------------------------ Domain ------------------------------ */

test('T8-01 默认状态是 APPLIED（已投递）；DRAFT/CLOSED 已从词表删除', () => {
  assert.equal(DEFAULT_STAGE, 'APPLIED');
  assert.equal(APPLICATION_STAGE_LABEL.APPLIED, '已投递');
  assert.equal('DRAFT' in APPLICATION_STAGE_LABEL, false, 'T6-2 不暴露 DRAFT');
  assert.equal('CLOSED' in APPLICATION_STAGE_LABEL, false, 'T6-2 不暴露 CLOSED');
});

test('T8-02 计数按状态汇总，含 total 与四种状态', () => {
  const counts = countByStage([
    record({ id: 'a', stage: APPLICATION_STAGE.APPLIED }),
    record({ id: 'b', stage: APPLICATION_STAGE.INTERVIEWING }),
    record({ id: 'c', stage: APPLICATION_STAGE.OFFER }),
    record({ id: 'd', stage: APPLICATION_STAGE.SCREENING }),
    record({ id: 'e', stage: APPLICATION_STAGE.REJECTED }),
    record({ id: 'f', stage: APPLICATION_STAGE.WITHDRAWN }),
  ]);
  assert.deepEqual(counts, {
    total: 6, applied: 1, screening: 1, interviewing: 1, offer: 1, rejected: 1, withdrawn: 1,
  });
});

test('T8-03 计数在空集合下返回全 0，而不是缺字段', () => {
  assert.deepEqual(countByStage([]), { total: 0, applied: 0, screening: 0, interviewing: 0, offer: 0, rejected: 0, withdrawn: 0 });
});

test('T8-04 输出带中文状态标签与 ISO 时间', () => {
  const view = toView(record({ stage: APPLICATION_STAGE.OFFER }));
  assert.equal(view.stageLabel, 'Offer');
  assert.equal(view.createdAt, '2026-09-16T00:00:00.000Z');
  assert.equal('userId' in view, false, '输出不得包含 userId');
});

/* ------------------------------ API ------------------------------ */

function harness() {
  const clock = new FixedClock();
  const users = new InMemoryUserRepository();
  const sessions = new InMemorySessionRepository();
  const failures = createInMemoryFailureLimiter(clock, 5, 15 * 60 * 1000);
  const auth = createAuthService({ users, sessions, failures, clock });
  const register = createRegisterHandler({ auth, secureCookies: false });

  const applications = new InMemoryApplicationRepository(clock);
  const jdRepo = new InMemoryJdRepository();
  // T6-2：本文件不触达 CareerGoal / ResumeVersion —— 提供空行为桩（findForUser 恒 null）
  const careerGoals = {
    findForUser: async () => null,
    hasJobDescriptionLink: async () => false,
  } as unknown as import('../src/ports/index.ts').CareerGoalRepository;
  const resumeVersions = {
    findForUser: async () => null,
  } as unknown as import('../src/ports/index.ts').ResumeVersionRepository;
  const deps = { auth, applications, jdRepo, careerGoals, resumeVersions };

  return {
    users,
    applications,
    jdRepo,
    clock,
    list: createListApplicationsHandler(deps),
    create: createCreateApplicationHandler(deps),
    update: createUpdateApplicationHandler(deps),
    async signUp(email: string): Promise<{ token: string; userId: string }> {
      const res = await register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
      const token = extractSessionToken(res);
      return { token: token as string, userId: users.rows[users.rows.length - 1].id };
    },
  };
}

test('T8-05 未登录 → 401（列表与创建都是）', async () => {
  const h = harness();
  assert.equal((await h.list(getJson('http://t/api/applications'))).status, 401);
  assert.equal((await h.create(postJson('http://t/api/applications', { company: 'X' }))).status, 401);
  assert.equal(h.applications.rows.length, 0);
});

test('T8-06 创建成功 → 201，状态默认 APPLIED', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const res = await h.create(postJson('http://t/api/applications', { company: '云枢智能' }, a.token));
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as { data: { id: string; stage: string; stageLabel: string; jdId: string | null } };
  assert.equal(body.data.stage, 'APPLIED');
  assert.equal(body.data.stageLabel, '已投递');
  assert.equal(body.data.jdId, null);
  assert.equal(h.applications.rows.length, 1);
});

test('T8-07 可以不关联 JD，也可以关联已有 JD', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const jd = await h.jdRepo.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: 'h1',
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });

  const withJd = await h.create(postJson('http://t/api/applications', { company: '云枢智能', jdId: jd.id }, a.token));
  assert.equal(withJd.status, 201);
  const body = (await bodyOf(withJd)) as { data: { jdId: string } };
  assert.equal(body.data.jdId, jd.id);
});

test('T8-08 关联他人的 JD → 404', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const jdOfA = await h.jdRepo.createWithRequirements({
    userId: a.userId,
    rawText: 'JD',
    title: 'T',
    company: 'C',
    contentHash: 'h2',
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });

  const res = await h.create(postJson('http://t/api/applications', { company: 'X', jdId: jdOfA.id }, b.token));
  assert.equal(res.status, 404);
});

test('T8-09 请求体带 userId → 400', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const res = await h.create(postJson('http://t/api/applications', { company: 'X', userId: a.userId }, a.token));
  assert.equal(res.status, 400);
  assert.equal(h.applications.rows.length, 0);
});

test('T8-10 公司名为空 / 非法状态 → 400', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  assert.equal((await h.create(postJson('http://t/api/applications', { company: '   ' }, a.token))).status, 400);
  assert.equal(
    (await h.create(postJson('http://t/api/applications', { company: 'X', stage: 'DRAFT' }, a.token))).status,
    400,
    'DRAFT 不在 V1 允许的写入状态内',
  );
});

test('T8-11 列表返回计数与条目；空数据时计数为 0 而不是缺字段', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');

  const empty = await h.list(getJson('http://t/api/applications', a.token));
  assert.equal(empty.status, 200);
  const emptyBody = (await bodyOf(empty)) as { data: { counts: Record<string, number>; items: unknown[] } };
  assert.deepEqual(emptyBody.data.counts, { total: 0, applied: 0, screening: 0, interviewing: 0, offer: 0, rejected: 0, withdrawn: 0 });
  assert.equal(emptyBody.data.items.length, 0);

  await h.create(postJson('http://t/api/applications', { company: '云枢智能' }, a.token));
  const filled = await h.list(getJson('http://t/api/applications', a.token));
  const filledBody = (await bodyOf(filled)) as { data: { counts: { total: number; applied: number } } };
  assert.equal(filledBody.data.counts.total, 1);
  assert.equal(filledBody.data.counts.applied, 1);
});

test('T8-12 状态流转：投递中 → 面试中 → Offer', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const created = await h.create(postJson('http://t/api/applications', { company: '云枢智能' }, a.token));
  const id = ((await bodyOf(created)) as { data: { id: string } }).data.id;

  const interviewing = await h.update(postJson(`http://t/api/applications/${id}`, { stage: 'INTERVIEWING' }, a.token), id);
  assert.equal(interviewing.status, 200);
  assert.equal(((await bodyOf(interviewing)) as { data: { stageLabel: string } }).data.stageLabel, '面试中');

  const offer = await h.update(postJson(`http://t/api/applications/${id}`, { stage: 'OFFER' }, a.token), id);
  assert.equal(((await bodyOf(offer)) as { data: { stageLabel: string } }).data.stageLabel, 'Offer');
});

test('T8-13 PATCH 空 body → 400', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const created = await h.create(postJson('http://t/api/applications', { company: 'X' }, a.token));
  const id = ((await bodyOf(created)) as { data: { id: string } }).data.id;
  assert.equal((await h.update(postJson(`http://t/api/applications/${id}`, {}, a.token), id)).status, 400);
});

test('T8-14 PATCH 跨用户 / 不存在的记录 → 404', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  const created = await h.create(postJson('http://t/api/applications', { company: 'X' }, a.token));
  const id = ((await bodyOf(created)) as { data: { id: string } }).data.id;

  assert.equal((await h.update(postJson(`http://t/api/applications/${id}`, { stage: 'OFFER' }, b.token), id)).status, 404);
  assert.equal((await h.update(postJson('http://t/api/applications/nope', { stage: 'OFFER' }, a.token), 'nope')).status, 404);
});

test('T8-15 更新会刷新 updatedAt，且列表按 updatedAt 倒序', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const first = await h.create(postJson('http://t/api/applications', { company: '公司一' }, a.token));
  const firstId = ((await bodyOf(first)) as { data: { id: string } }).data.id;

  h.clock.advanceMs(60_000);
  await h.create(postJson('http://t/api/applications', { company: '公司二' }, a.token));

  h.clock.advanceMs(60_000);
  const updated = await h.update(postJson(`http://t/api/applications/${firstId}`, { stage: 'INTERVIEWING' }, a.token), firstId);
  const updatedBody = (await bodyOf(updated)) as { data: { updatedAt: string; createdAt: string } };
  assert.notEqual(updatedBody.data.updatedAt, updatedBody.data.createdAt, 'updatedAt 必须被刷新');

  const list = await h.list(getJson('http://t/api/applications', a.token));
  const items = ((await bodyOf(list)) as { data: { items: Array<{ company: string }> } }).data.items;
  assert.equal(items[0].company, '公司一', '最近更新的排在最前');
});

test('T8-16 用户隔离：A 看不到 B 的记录', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const b = await h.signUp('b@example.com');
  await h.create(postJson('http://t/api/applications', { company: 'A 的公司' }, a.token));
  await h.create(postJson('http://t/api/applications', { company: 'B 的公司' }, b.token));

  const listA = await h.list(getJson('http://t/api/applications', a.token));
  const itemsA = ((await bodyOf(listA)) as { data: { items: Array<{ company: string }> } }).data.items;
  assert.equal(itemsA.length, 1);
  assert.equal(itemsA[0].company, 'A 的公司');
});

test('T8-17 可以清空备注（notes: null）', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  const created = await h.create(postJson('http://t/api/applications', { company: 'X', notes: '初面已过' }, a.token));
  const id = ((await bodyOf(created)) as { data: { id: string } }).data.id;

  const cleared = await h.update(postJson(`http://t/api/applications/${id}`, { notes: null }, a.token), id);
  assert.equal(((await bodyOf(cleared)) as { data: { notes: string | null } }).data.notes, null);
});

/* -------------------- BUG-002 分页 / BUG-003 遗留状态 -------------------- */

async function seedApplications(h: ReturnType<typeof harness>, userId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await h.applications.create({
      userId,
      company: `公司${i}`,
      jdId: null,
      careerGoalId: null,
      resumeVersionId: null,
      position: null,
      appliedAt: new Date(),
      stage: APPLICATION_STAGE.APPLIED,
      notes: null,
    });
  }
}

type ListBody = {
  data: {
    counts: { total: number; applied: number; screening: number; interviewing: number; offer: number; rejected: number; withdrawn: number };
    items: unknown[];
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
  };
};

test('T8-18【T6-2】DRAFT 已从词表删除：遗留值兜底为「未知状态」，不回显原文', () => {
  const view = toView(record({ stage: 'DRAFT' }));
  assert.equal(view.stageLabel, '未知状态');
  assert.equal('DRAFT' in APPLICATION_STAGE_LABEL, false, 'T6-2 状态词表不得含 DRAFT');
  assert.equal('CLOSED' in APPLICATION_STAGE_LABEL, false, 'T6-2 状态词表不得含 CLOSED');
});

test('T8-19【BUG-003】未知状态兜底为占位文案，不透出内部取值', () => {
  assert.equal(toView(record({ stage: 'SOMETHING_ELSE' })).stageLabel, '未知状态');
});

test('T8-20【BUG-002】达到阈值时只返回首页，counts 仍反映全量', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  await seedApplications(h, a.userId, 60);

  const res = await h.list(getJson('http://t/api/applications', a.token));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as ListBody;

  assert.equal(body.data.items.length, DEFAULT_PAGE_SIZE, '响应体不再随数据量无界增长');
  assert.equal(body.data.pagination.total, 60);
  assert.equal(body.data.pagination.hasMore, true);
  // 核心不变量：看板计数不得随页码漂移
  assert.equal(body.data.counts.total, 60, 'counts 必须是全量，不是当前页条数');
  assert.equal(body.data.counts.applied, 60);
});

test('T8-21【BUG-002】limit / offset 生效，第二页取剩余项且无下一页', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  await seedApplications(h, a.userId, 60);

  const page2 = (await bodyOf(
    await h.list(getJson('http://t/api/applications?limit=20&offset=50', a.token)),
  )) as ListBody;
  assert.equal(page2.data.items.length, 10);
  assert.equal(page2.data.pagination.offset, 50);
  assert.equal(page2.data.pagination.hasMore, false);
  assert.equal(page2.data.counts.total, 60, '翻页后计数仍必须是全量');

  const capped = (await bodyOf(await h.list(getJson('http://t/api/applications?limit=10', a.token)))) as ListBody;
  assert.equal(capped.data.items.length, 10);
  assert.equal(capped.data.pagination.limit, 10);
});

test('T8-22【BUG-002】非法分页参数 → 400，不静默回落默认值', async () => {
  const h = harness();
  const a = await h.signUp('a@example.com');
  await seedApplications(h, a.userId, 3);

  for (const q of ['limit=0', 'limit=-1', 'limit=abc', 'limit=101', 'offset=-1', 'offset=abc']) {
    const res = await h.list(getJson(`http://t/api/applications?${q}`, a.token));
    assert.equal(res.status, 400, `非法参数 ${q} 必须拒绝`);
  }

  // 空值与合法边界仍可用
  assert.equal((await h.list(getJson('http://t/api/applications?limit=&offset=', a.token))).status, 200);
  assert.equal((await h.list(getJson('http://t/api/applications?limit=100&offset=0', a.token))).status, 200);
});
