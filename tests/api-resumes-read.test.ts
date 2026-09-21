import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { systemClock } from '../src/ports/index.ts';
import { createListResumesHandler, createGetResumeHandler } from '../src/http/handlers/resume-read.ts';
import { createListJdsHandler } from '../src/http/handlers/jds.ts';
import { bodyOf, getJson } from './fakes.ts';

/**
 * 前端只读接口：GET /api/resumes、GET /api/resumes/:id、GET /api/jds
 * 走真实 Prisma 仓库，验证数据隔离（跨用户 404 / 不可见）与条目 id 往返。
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
const auth = () =>
  createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });

async function signUp(tag: string) {
  const r = await auth().register({ email: `read_${tag}_${stamp}@example.com`, password: 'password-1234' });
  return { token: r.token, userId: r.user.id };
}

const deps = () => ({ auth: auth(), resumes: repos.resumes });
const jdDeps = () => ({ auth: auth(), jdRepo: repos.jds });

test('READ-01 简历列表：本人可见，含四态计数与 itemCount', { skip }, async () => {
  const a = await signUp('a');
  await repos.resumes.createWithItems({
    userId: a.userId,
    rawText: '技能：Python、Docker',
    sourceType: 'TEXT',
    items: [
      { section: 'SKILL', title: 'Python', detail: '熟练', status: 'UNCONFIRMED', source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: 'Python' },
      { section: 'SKILL', title: 'Docker', detail: '熟练', status: 'INFERRED', source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: 'Docker' },
    ],
  });

  const res = await createListResumesHandler(deps())(getJson('http://t/api/resumes', a.token));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { items: Array<{ itemCount: number; statusSummary: { unconfirmed: number; inferred: number } }> } };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].itemCount, 2);
  assert.equal(body.data.items[0].statusSummary.unconfirmed, 1);
  assert.equal(body.data.items[0].statusSummary.inferred, 1);
});

test('READ-02 简历详情：条目带 id 与证据，可据此走确认接口', { skip }, async () => {
  const a = await signUp('b');
  const created = await repos.resumes.createWithItems({
    userId: a.userId,
    rawText: '技能：Python',
    sourceType: 'TEXT',
    items: [{ section: 'SKILL', title: 'Python', detail: '熟练', status: 'UNCONFIRMED', source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: 'Python' }],
  });

  const res = await createGetResumeHandler(deps())(getJson('http://t/api/resumes', a.token), created.id);
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { items: Array<{ id: string; section: string; title: string; status: string; evidence: Array<{ locator: string; excerpt: string }> }> } };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].section, 'SKILL');
  assert.equal(body.data.items[0].title, 'Python');
  assert.equal(body.data.items[0].status, 'UNCONFIRMED');
  assert.ok(body.data.items[0].id.length > 0, '必须返回条目 id');
  assert.equal(body.data.items[0].evidence.length, 1);
  assert.equal(body.data.items[0].evidence[0].excerpt, 'Python');
});

test('READ-03 简历详情跨用户 → 404；列表互相不可见', { skip }, async () => {
  const a = await signUp('c1');
  const b = await signUp('c2');
  const created = await repos.resumes.createWithItems({
    userId: a.userId,
    rawText: '技能：Python',
    sourceType: 'TEXT',
    items: [{ section: 'SKILL', title: 'Python', detail: null, status: 'UNCONFIRMED', source: 'RESUME_TEXT', locator: 'resume:line:1', excerpt: 'Python' }],
  });

  assert.equal((await createGetResumeHandler(deps())(getJson('http://t/api/resumes', b.token), created.id)).status, 404);

  const listB = (await bodyOf(await createListResumesHandler(deps())(getJson('http://t/api/resumes', b.token)))) as { data: { items: unknown[] } };
  assert.equal(listB.data.items.length, 0, 'B 看不到 A 的简历');
});

test('READ-04 JD 列表：本人可见、倒序、含要求数', { skip }, async () => {
  const a = await signUp('d');
  await repos.jds.createWithRequirements({
    userId: a.userId,
    rawText: 'JD 一',
    title: 'AI 工程师',
    company: '云枢智能',
    contentHash: `read_jd1_${stamp}`,
    reqs: { create: [{ text: '精通 Python', category: 'TECH', criticality: 'MUST' }] },
  });

  const res = await createListJdsHandler(jdDeps())(getJson('http://t/api/jds', a.token));
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { items: Array<{ title: string | null; requirementCount: number }> } };
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].title, 'AI 工程师');
  assert.equal(body.data.items[0].requirementCount, 1);
});

test('READ-99 清理', { skip }, async () => {
  const users = await prisma.user.findMany({ where: { email: { contains: `_${stamp}@example.com` } }, select: { id: true } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
  await prisma.jobDescription.deleteMany({ where: { contentHash: { contains: `_${stamp}` } } });
  await prisma.$disconnect();
});
