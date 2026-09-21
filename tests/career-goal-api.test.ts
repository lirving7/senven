/**
 * T6-1 —— CareerGoal API 验收（真实 Prisma + 直接 handler 调用，与 agent-api 同范式）。
 *
 * 覆盖授权书 §十六：
 *   create / list / detail / patch / current switch（幂等）/ cross-user 404 /
 *   body userId rejection / invalid employmentType / invalid status /
 *   invalid JD ownership / jdIds replace-set / PATCH isCurrent rejection /
 *   并发 current 切换（同一 user 恰一个 isCurrent=true）/ DB CHECK / partial unique index。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { systemClock } from '../src/ports/index.ts';
import {
  createCreateCareerGoalHandler,
  createGetCareerGoalHandler,
  createListCareerGoalsHandler,
  createPatchCareerGoalHandler,
  createSetCurrentCareerGoalHandler,
} from '../src/http/handlers/career-goals.ts';
import { bodyOf, extractSessionToken, postJson } from './fakes.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createdUserIds: string[] = [];

test('前置：数据库必须可达（禁止静默 skip）', async () => {
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
  const create = createCreateCareerGoalHandler({ auth, careerGoals: repos.careerGoals });
  const list = createListCareerGoalsHandler({ auth, careerGoals: repos.careerGoals });
  const get = createGetCareerGoalHandler({ auth, careerGoals: repos.careerGoals });
  const patch = createPatchCareerGoalHandler({ auth, careerGoals: repos.careerGoals });
  const setCurrent = createSetCurrentCareerGoalHandler({ auth, careerGoals: repos.careerGoals });
  return { register, create, list, get, patch, setCurrent };
}

const h = makeHandler();

/** 带 cookie 的 GET/PATCH/POST-current 请求构造（与生产同源 fetch 语义一致） */
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
  const email = `cg_${tag}_${stamp}@example.com`;
  const res = await h.register(postJson('http://t/api/auth/register', { email, password: 'password-1234' }));
  const userId = ((await bodyOf(res)) as { data: { user: { id: string } } }).data.user.id;
  createdUserIds.push(userId);
  return { token: extractSessionToken(res)!, userId };
}

const validBody = { name: '2026 秋招 AI 方向', position: 'AI 应用工程师', employmentType: 'FULL_TIME' };

test('[create] 合法创建 → 201 + 冻结字段；缺省 status=ACTIVE、isCurrent=false', async () => {
  const u = await makeUser('create');
  const res = await h.create(postJson('http://t/api/career-goals', validBody, u.token));
  assert.equal(res.status, 201);
  const goal = ((await bodyOf(res)) as { data: { goal: Record<string, unknown> } }).data.goal;
  assert.equal(goal.name, '2026 秋招 AI 方向');
  assert.equal(goal.status, 'ACTIVE');
  assert.equal(goal.isCurrent, false);
  assert.deepEqual(goal.jdIds, []);
  // 不得回显 userId（§十四）
  assert.equal('userId' in goal, false);
});

test('[create] body 携带 userId → 400（strict schema，§十）', async () => {
  const u = await makeUser('inject');
  const res = await h.create(postJson('http://t/api/career-goals', { ...validBody, userId: u.userId }, u.token));
  assert.equal(res.status, 400);
});

test('[create] 非法 employmentType / status → 400', async () => {
  const u = await makeUser('badenum');
  const r1 = await h.create(postJson('http://t/api/career-goals', { ...validBody, employmentType: 'REMOTE' }, u.token));
  assert.equal(r1.status, 400);
  const r2 = await h.create(postJson('http://t/api/career-goals', { ...validBody, status: 'CONFIRMED' }, u.token));
  assert.equal(r2.status, 400);
});

test('[auth] 5 个 endpoint 未认证一律 401', async () => {
  assert.equal((await h.create(postJson('http://t/api/career-goals', validBody))).status, 401);
  assert.equal((await h.list(new Request('http://t/api/career-goals'))).status, 401);
  assert.equal((await h.get(new Request('http://t/api/career-goals/x'), 'x')).status, 401);
  assert.equal((await h.patch(new Request('http://t/api/career-goals/x', { method: 'PATCH' }), 'x')).status, 401);
  assert.equal((await h.setCurrent(new Request('http://t/api/career-goals/x/current', { method: 'POST' }), 'x')).status, 401);
});

test('[list] ?status= / ?current=true 过滤正确', async () => {
  const u = await makeUser('list');
  await h.create(postJson('http://t/api/career-goals', validBody, u.token));
  await h.create(
    postJson('http://t/api/career-goals', { ...validBody, name: '第二个目标', status: 'PAUSED' }, u.token),
  );
  const all = (await bodyOf(await h.list(req('/api/career-goals', u.token)))) as { data: { items: unknown[] } };
  assert.equal(all.data.items.length, 2);
  const paused = (await bodyOf(await h.list(req('/api/career-goals?status=PAUSED', u.token)))) as {
    data: { items: Array<{ status: string }> };
  };
  assert.equal(paused.data.items.length, 1);
  assert.equal(paused.data.items[0]!.status, 'PAUSED');
  const current = (await bodyOf(await h.list(req('/api/career-goals?current=true', u.token)))) as {
    data: { items: unknown[] };
  };
  assert.equal(current.data.items.length, 0);
  const badStatus = await h.list(req('/api/career-goals?status=WHATEVER', u.token));
  assert.equal(badStatus.status, 400);
});

test('[current] 切换 / 幂等 / 唯一性 / 非 ACTIVE 拒绝（§五/§六）', async () => {
  const u = await makeUser('current');
  const g1 = ((await bodyOf(await h.create(postJson('http://t/api/career-goals', validBody, u.token)))) as {
    data: { goal: { id: string } };
  }).data.goal;
  const g2 = ((await bodyOf(
    await h.create(postJson('http://t/api/career-goals', { ...validBody, name: '目标二' }, u.token)),
  )) as { data: { goal: { id: string } } }).data.goal;

  // 设 g1 为当前
  const r1 = (await bodyOf(await h.setCurrent(req(`/api/career-goals/${g1.id}/current`, u.token, { method: 'POST' }), g1.id))) as {
    data: { goal: { id: string; isCurrent: boolean } };
  };
  assert.equal(r1.data.goal.isCurrent, true);

  // 切换到 g2：g1 自动失去 current（单事务）
  const r2 = (await bodyOf(await h.setCurrent(req(`/api/career-goals/${g2.id}/current`, u.token, { method: 'POST' }), g2.id))) as {
    data: { goal: { id: string; isCurrent: boolean } };
  };
  assert.equal(r2.data.goal.isCurrent, true);
  const g1After = ((await bodyOf(await h.get(req(`/api/career-goals/${g1.id}`, u.token), g1.id))) as {
    data: { goal: { isCurrent: boolean } };
  }).data.goal;
  assert.equal(g1After.isCurrent, false);

  // 幂等：重复设 g2 → 200，仍恰一个 current
  const r3 = (await bodyOf(await h.setCurrent(req(`/api/career-goals/${g2.id}/current`, u.token, { method: 'POST' }), g2.id))) as {
    data: { goal: { isCurrent: boolean } };
  };
  assert.equal(r3.data.goal.isCurrent, true);
  const cnt = await prisma.careerGoal.count({ where: { userId: u.userId, isCurrent: true } });
  assert.equal(cnt, 1, '同一 user 恰一个 isCurrent=true');

  // ACTIVE→PAUSED 自动清除 isCurrent（§十一）；再设当前 → 409
  await h.patch(req(`/api/career-goals/${g2.id}`, u.token, { method: 'PATCH', body: { status: 'PAUSED' } }), g2.id);
  const paused = ((await bodyOf(await h.get(req(`/api/career-goals/${g2.id}`, u.token), g2.id))) as {
    data: { goal: { status: string; isCurrent: boolean } };
  }).data.goal;
  assert.equal(paused.status, 'PAUSED');
  assert.equal(paused.isCurrent, false, 'ACTIVE→PAUSED 必须自动清除 isCurrent（§十一）');
  const conflict = await h.setCurrent(req(`/api/career-goals/${g2.id}/current`, u.token, { method: 'POST' }), g2.id);
  assert.equal(conflict.status, 409);
});

test('[ownership] 跨用户 detail / patch / current 一律 404（无 oracle）', async () => {
  const a = await makeUser('own_a');
  const b = await makeUser('own_b');
  const g = ((await bodyOf(await h.create(postJson('http://t/api/career-goals', validBody, a.token)))) as {
    data: { goal: { id: string } };
  }).data.goal;
  assert.equal((await h.get(req(`/api/career-goals/${g.id}`, b.token), g.id)).status, 404);
  assert.equal(
    (await h.patch(req(`/api/career-goals/${g.id}`, b.token, { method: 'PATCH', body: { name: '劫持' } }), g.id)).status,
    404,
  );
  assert.equal(
    (await h.setCurrent(req(`/api/career-goals/${g.id}/current`, b.token, { method: 'POST' }), g.id)).status,
    404,
  );
  const list = (await bodyOf(await h.list(req('/api/career-goals', b.token)))) as { data: { items: unknown[] } };
  assert.equal(list.data.items.length, 0);
});

test('[patch] replace-set jdIds + 逐项 ownership 校验 + PATCH isCurrent 拒绝', async () => {
  const u = await makeUser('patch');
  const jdA = await prisma.jobDescription.create({
    data: { userId: u.userId, rawText: 'JD-A'.repeat(20) },
    select: { id: true },
  });
  const jdB = await prisma.jobDescription.create({
    data: { userId: u.userId, rawText: 'JD-B'.repeat(20) },
    select: { id: true },
  });
  const stranger = await makeUser('jd_owner');
  const jdX = await prisma.jobDescription.create({
    data: { userId: stranger.userId, rawText: 'JD-X'.repeat(20) },
    select: { id: true },
  });

  const g = ((await bodyOf(
    await h.create(postJson('http://t/api/career-goals', { ...validBody, jdIds: [jdA.id] }, u.token)),
  )) as { data: { goal: { id: string; jdIds: string[] } } }).data.goal;
  assert.deepEqual(g.jdIds, [jdA.id]);

  // replace-set：[A] → [A,B] → [B]（整体替换语义）
  const expanded = ((await bodyOf(
    await h.patch(req(`/api/career-goals/${g.id}`, u.token, { method: 'PATCH', body: { jdIds: [jdA.id, jdB.id] } }), g.id),
  )) as { data: { goal: { jdIds: string[] } } }).data.goal;
  assert.equal(expanded.jdIds.length, 2);
  const shrunk = ((await bodyOf(
    await h.patch(req(`/api/career-goals/${g.id}`, u.token, { method: 'PATCH', body: { jdIds: [jdB.id] } }), g.id),
  )) as { data: { goal: { jdIds: string[] } } }).data.goal;
  assert.deepEqual(shrunk.jdIds, [jdB.id], 'replace-set 语义：旧集合被整体替换');

  // 他人 JD / 不存在 → 422，不透露哪个
  assert.equal(
    (await h.patch(req(`/api/career-goals/${g.id}`, u.token, { method: 'PATCH', body: { jdIds: [jdX.id] } }), g.id)).status,
    422,
  );
  assert.equal(
    (await h.patch(req(`/api/career-goals/${g.id}`, u.token, { method: 'PATCH', body: { jdIds: ['nonexistent_jd'] } }), g.id)).status,
    422,
  );
  // 创建路径同样拦截
  assert.equal(
    (await h.create(postJson('http://t/api/career-goals', { ...validBody, jdIds: [jdX.id] }, u.token))).status,
    422,
  );

  // PATCH isCurrent → 400（strict schema；isCurrent 只能经 /current 切换）
  assert.equal(
    (await h.patch(req(`/api/career-goals/${g.id}`, u.token, { method: 'PATCH', body: { isCurrent: true } }), g.id)).status,
    400,
  );
});

test('[concurrency] 同一 user 并发切换 → 恰一个 isCurrent=true（部分唯一索引兜底）', async () => {
  const u = await makeUser('conc');
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const g = ((await bodyOf(
      await h.create(postJson('http://t/api/career-goals', { ...validBody, name: `并发目标${i}` }, u.token)),
    )) as { data: { goal: { id: string } } }).data.goal;
    ids.push(g.id);
  }
  const results = await Promise.all(
    ids.map((id) => h.setCurrent(req(`/api/career-goals/${id}/current`, u.token, { method: 'POST' }), id)),
  );
  const statuses = results.map((r) => r.status);
  const successCount = statuses.filter((s) => s === 200).length;
  const conflictCount = statuses.filter((s) => s === 409).length;
  assert.equal(successCount + conflictCount, 3, '不得出现 500');
  const cnt = await prisma.careerGoal.count({ where: { userId: u.userId, isCurrent: true } });
  assert.equal(cnt, 1, '并发切换后同一 user 恰一个 isCurrent=true');
});

test('[db] CHECK / partial unique index 机械核验（§十六）', async () => {
  await assert.rejects(
    () => prisma.$executeRawUnsafe(`INSERT INTO "CareerGoal" ("id","userId","name","position","employmentType","status","isCurrent","updatedAt") VALUES ('cg_check1', (SELECT id FROM "User" LIMIT 1), 'n','p','FULL_TIME','CONFIRMED',false,now())`),
  );
  await assert.rejects(
    () => prisma.$executeRawUnsafe(`INSERT INTO "CareerGoal" ("id","userId","name","position","employmentType","status","isCurrent","updatedAt") VALUES ('cg_check2', (SELECT id FROM "User" LIMIT 1), 'n','p','REMOTE','ACTIVE',false,now())`),
  );
  await assert.rejects(
    () => prisma.$executeRawUnsafe(`INSERT INTO "CareerGoal" ("id","userId","name","position","employmentType","status","isCurrent","updatedAt") VALUES ('cg_check3', (SELECT id FROM "User" LIMIT 1), 'n','p','FULL_TIME','PAUSED',true,now())`),
  );
  const uid = (await prisma.user.findFirst({ select: { id: true } }))!.id;
  await prisma.$executeRawUnsafe(`INSERT INTO "CareerGoal" ("id","userId","name","position","employmentType","status","isCurrent","updatedAt") VALUES ('cg_pu1', '${uid}', 'n','p','FULL_TIME','ACTIVE',true,now())`);
  await assert.rejects(
    () => prisma.$executeRawUnsafe(`INSERT INTO "CareerGoal" ("id","userId","name","position","employmentType","status","isCurrent","updatedAt") VALUES ('cg_pu2', '${uid}', 'n','p','FULL_TIME','ACTIVE',true,now())`),
  );
  await prisma.careerGoal.deleteMany({ where: { id: 'cg_pu1' } });
});

test('[routing] app/api/career-goals 恰 3 个 route 文件，method 白名单一致', () => {
  const root = path.join(process.cwd(), 'app/api/career-goals');
  assert.equal(existsSync(root), true);
  const routes: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else routes.push(abs.split('app')[1]!.replace(/\\/g, '/'));
    }
  })(root);
  assert.deepEqual(routes.sort(), [
    '/api/career-goals/[id]/current/route.ts',
    '/api/career-goals/[id]/route.ts',
    '/api/career-goals/route.ts',
  ]);
  const methodsOf = (rel: string) =>
    [...readFileSync(path.join(process.cwd(), `app${rel}`), 'utf8').matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!).sort();
  assert.deepEqual(methodsOf('/api/career-goals/route.ts'), ['GET', 'POST']);
  assert.deepEqual(methodsOf('/api/career-goals/[id]/route.ts'), ['GET', 'PATCH']);
  assert.deepEqual(methodsOf('/api/career-goals/[id]/current/route.ts'), ['POST']);
  for (const banned of ['execute', 'confirm', 'current-bulk']) {
    assert.equal(existsSync(path.join(root, banned)), false);
  }
});

after(async () => {
  // 清理本文件创建的全部用户（级联清除 goals / links / jds / sessions）
  for (const id of createdUserIds) {
    await prisma.user.deleteMany({ where: { id } });
  }
});
