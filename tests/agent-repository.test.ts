/**
 * T5-B-1 —— Agent 持久化 / 隔离 / 并发 / DB 约束测试（真实 PostgreSQL）
 *
 * 覆盖授权书 §十六：Isolation（跨用户不可读）、Concurrency（唯一约束 + P2002 reread + 条件更新）、
 * Schema（FK CASCADE / unique revision / CHECK 值 / nullable）。
 *
 * 前置：数据库可达（fail-fast，禁止静默 skip）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createdEmails: string[] = [];

async function makeUser(tag: string): Promise<string> {
  const email = `qa_agent_${tag}_${stamp}@example.com`;
  createdEmails.push(email);
  const u = await prisma.user.create({ data: { email, passwordHash: 'x' } });
  return u.id;
}

function runInput(userId: string, extra: Record<string, unknown> = {}) {
  return {
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: { providerCalls: 0 },
    ...extra,
  };
}

after(async () => {
  // 删除测试用户 → CASCADE 删除 AgentRun → AgentProposal
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.$disconnect();
});

test('前置：数据库必须可达（禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

// ─── createRun / 读取 ────────────────────────────────────────────────────

test('[run] createRun 写入字段正确：status 默认 CREATED、nullable 为空、endedAt = null', async () => {
  const userId = await makeUser('run');
  const run = await repos.agentRuns.createRun(runInput(userId));

  assert.equal(run.userId, userId);
  assert.equal(run.goalKind, 'CAREER_ASSISTANCE');
  assert.equal(run.status, 'CREATED');
  assert.equal(run.modelVersion, null);
  assert.equal(run.providerRequestId, null);
  assert.equal(run.errorCode, null);
  assert.equal(run.endedAt, null);
  assert.equal(run.promptTemplateVersion, 'agent-plan/v1');
  assert.deepEqual(run.semanticVersions, {});
  assert.deepEqual(run.quotaUsage, { providerCalls: 0 });
  assert.ok(run.createdAt instanceof Date);
  assert.ok(run.updatedAt instanceof Date);
});

test('[run] findRunForUser 跨用户 → null（不泄露存在性）', async () => {
  const a = await makeUser('a');
  const b = await makeUser('b');
  const run = await repos.agentRuns.createRun(runInput(a));

  assert.ok(await repos.agentRuns.findRunForUser(run.id, a));
  assert.equal(await repos.agentRuns.findRunForUser(run.id, b), null);
});

test('[run] listRunsForUser 仅返回本人且确定性排序', async () => {
  const a = await makeUser('list-a');
  const b = await makeUser('list-b');
  const r1 = await repos.agentRuns.createRun(runInput(a));
  const r2 = await repos.agentRuns.createRun(runInput(a));
  await repos.agentRuns.createRun(runInput(b));

  const list = await repos.agentRuns.listRunsForUser(a);
  assert.equal(list.length, 2);
  assert.ok(list.every((r) => r.userId === a));
  assert.deepEqual(new Set(list.map((r) => r.id)), new Set([r1.id, r2.id]));
  // createdAt DESC → id DESC：同毫秒时按 id 降序，断言稳定可复现
  const again = await repos.agentRuns.listRunsForUser(a);
  assert.deepEqual(again.map((r) => r.id), list.map((r) => r.id));
});

// ─── 状态转移 ────────────────────────────────────────────────────────────

test('[transition] CREATED → PLANNING 允许；同值 NOOP 可接受', async () => {
  const userId = await makeUser('tr1');
  const run = await repos.agentRuns.createRun(runInput(userId));

  const moved = await repos.agentRuns.transitionRun(run.id, userId, 'PLANNING', new Date());
  assert.equal(moved.kind, 'UPDATED');
  if (moved.kind === 'UPDATED') {
    assert.equal(moved.run.status, 'PLANNING');
    assert.equal(moved.run.endedAt, null, '非终态不得写 endedAt');
  }

  const noop = await repos.agentRuns.transitionRun(run.id, userId, 'PLANNING', new Date());
  assert.equal(noop.kind, 'UPDATED');
});

test('[transition] PLANNING → PROPOSED 允许并写 endedAt（条件更新）', async () => {
  const userId = await makeUser('tr2');
  const run = await repos.agentRuns.createRun(runInput(userId));
  await repos.agentRuns.transitionRun(run.id, userId, 'PLANNING', new Date());

  const now = new Date();
  const out = await repos.agentRuns.transitionRun(run.id, userId, 'PROPOSED', now);
  assert.equal(out.kind, 'UPDATED');
  if (out.kind === 'UPDATED') {
    assert.equal(out.run.status, 'PROPOSED');
    assert.ok(out.run.endedAt instanceof Date, '进入终态必须写 endedAt');
    assert.equal(out.run.endedAt.getTime(), now.getTime());
  }
});

test('[transition] 非法转移被拒：(CREATED→PROPOSED) 与 (PROPOSED→CANCELLED)', async () => {
  const userId = await makeUser('tr3');
  const run = await repos.agentRuns.createRun(runInput(userId));

  const skip = await repos.agentRuns.transitionRun(run.id, userId, 'PROPOSED', new Date());
  assert.equal(skip.kind, 'FORBIDDEN_TRANSITION');

  await repos.agentRuns.transitionRun(run.id, userId, 'PLANNING', new Date());
  await repos.agentRuns.transitionRun(run.id, userId, 'PROPOSED', new Date());
  const cancelAfterPropose = await repos.agentRuns.transitionRun(run.id, userId, 'CANCELLED', new Date());
  assert.equal(cancelAfterPropose.kind, 'FORBIDDEN_TRANSITION');
});

test('[transition] 终态不可再转移（PROPOSED→PLANNING / CANCELLED→PLANNING）', async () => {
  const userId = await makeUser('tr4');
  const run = await repos.agentRuns.createRun(runInput(userId));
  await repos.agentRuns.transitionRun(run.id, userId, 'CANCELLED', new Date());
  const back = await repos.agentRuns.transitionRun(run.id, userId, 'PLANNING', new Date());
  assert.equal(back.kind, 'FORBIDDEN_TRANSITION');
});

test('[transition] 目标状态非法（CONFIRMED）→ INVALID_STATUS', async () => {
  const userId = await makeUser('tr5');
  const run = await repos.agentRuns.createRun(runInput(userId));
  const out = await repos.agentRuns.transitionRun(run.id, userId, 'CONFIRMED', new Date());
  assert.equal(out.kind, 'INVALID_STATUS');
});

test('[transition] 跨用户 → NOT_FOUND（不泄露存在性）', async () => {
  const a = await makeUser('tr6a');
  const b = await makeUser('tr6b');
  const run = await repos.agentRuns.createRun(runInput(a));
  const out = await repos.agentRuns.transitionRun(run.id, b, 'PLANNING', new Date());
  assert.equal(out.kind, 'NOT_FOUND');
});

// ─── Proposal：唯一 / 并发 / 归属 ────────────────────────────────────────

test('[proposal] createProposal 成功后（runId, revision=1）唯一；重复 → DUPLICATE 且同一 id', async () => {
  const userId = await makeUser('p1');
  const run = await repos.agentRuns.createRun(runInput(userId));
  const input = {
    runId: run.id,
    kind: 'PLAN',
    revision: 1,
    payload: { steps: ['a'] },
    basedOnRefs: [{ entityType: 'RESUME', entityId: 'r1' }],
  };

  const first = await repos.agentRuns.createProposal(userId, input);
  assert.equal(first.kind, 'CREATED');
  assert.equal(first.kind === 'CREATED' && first.proposal.status, 'ACTIVE');
  assert.equal(first.kind === 'CREATED' && first.proposal.revision, 1);

  const second = await repos.agentRuns.createProposal(userId, input);
  assert.equal(second.kind, 'DUPLICATE');
  if (first.kind === 'CREATED' && second.kind === 'DUPLICATE') {
    assert.equal(second.proposal.id, first.proposal.id, 'DUPLICATE 必须返回既有记录');
  }
});

test('[proposal] 并发 createProposal(revision=1)：恰好一个 CREATED、其余 DUPLICATE（P2002 → reread）', async () => {
  const userId = await makeUser('p2');
  const run = await repos.agentRuns.createRun(runInput(userId));
  const input = {
    runId: run.id,
    kind: 'PLAN',
    revision: 1,
    payload: { steps: ['a'] },
    basedOnRefs: [],
  };

  const results = await Promise.all([
    repos.agentRuns.createProposal(userId, input),
    repos.agentRuns.createProposal(userId, input),
    repos.agentRuns.createProposal(userId, input),
  ]);

  const created = results.filter((r) => r.kind === 'CREATED');
  const dup = results.filter((r) => r.kind === 'DUPLICATE');
  assert.equal(created.length, 1, '并发下必须恰好一条成功');
  assert.equal(dup.length, 2);

  const ids = new Set(results.map((r) => ('proposal' in r ? r.proposal.id : 'none')));
  assert.equal(ids.size, 1, '所有结果必须指向同一 proposal');

  const count = await prisma.agentProposal.count({ where: { runId: run.id } });
  assert.equal(count, 1, 'DB 中不得出现重复 revision');
});

test('[proposal] createProposal 跨用户 run → RUN_NOT_FOUND', async () => {
  const a = await makeUser('p3a');
  const b = await makeUser('p3b');
  const run = await repos.agentRuns.createRun(runInput(a));
  const out = await repos.agentRuns.createProposal(b, {
    runId: run.id,
    kind: 'PLAN',
    revision: 1,
    payload: {},
    basedOnRefs: [],
  });
  assert.equal(out.kind, 'RUN_NOT_FOUND');
});

test('[proposal] 归属经 AgentRun：findProposalForUser / listProposalsForRun 跨用户 → null', async () => {
  const a = await makeUser('p4a');
  const b = await makeUser('p4b');
  const run = await repos.agentRuns.createRun(runInput(a));
  const created = await repos.agentRuns.createProposal(a, {
    runId: run.id,
    kind: 'PLAN',
    revision: 1,
    payload: {},
    basedOnRefs: [],
  });
  assert.equal(created.kind, 'CREATED');
  if (created.kind !== 'CREATED') return;

  assert.ok(await repos.agentRuns.findProposalForUser(created.proposal.id, a));
  assert.equal(await repos.agentRuns.findProposalForUser(created.proposal.id, b), null);

  assert.equal((await repos.agentRuns.listProposalsForRun(run.id, a))?.length, 1);
  assert.equal(await repos.agentRuns.listProposalsForRun(run.id, b), null);
});

test('[proposal] AgentProposal 无 userId 列（归属只经 AgentRun）', async () => {
  const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'AgentProposal'
  `;
  const cols = rows.map((r) => r.column_name);
  assert.equal(cols.includes('userId'), false, 'AgentProposal 不得有 userId');
  assert.ok(cols.includes('runId'));
});

// ─── DB CHECK / FK CASCADE ───────────────────────────────────────────────

test('[schema] DB CHECK 拒绝越界 allowlist（status / goalKind / kind / status）', async () => {
  const userId = await makeUser('chk');

  await assert.rejects(
    prisma.agentRun.create({
      data: {
        userId,
        goalKind: 'CAREER_ASSISTANCE',
        status: 'CONFIRMED',
        promptTemplateVersion: 'v1',
      },
    }),
    'AgentRun.status CHECK 必须拒绝 CONFIRMED',
  );

  await assert.rejects(
    prisma.agentRun.create({
      data: { userId, goalKind: 'OTHER', promptTemplateVersion: 'v1' },
    }),
    'AgentRun.goalKind CHECK 必须拒绝非 allowlist',
  );

  const run = await repos.agentRuns.createRun(runInput(userId));

  await assert.rejects(
    prisma.agentProposal.create({
      data: { runId: run.id, revision: 1, kind: 'OTHER', payload: {}, basedOnRefs: [] },
    }),
    'AgentProposal.kind CHECK 必须拒绝非 PLAN',
  );

  await assert.rejects(
    prisma.agentProposal.create({
      data: { runId: run.id, revision: 1, kind: 'PLAN', status: 'CONFIRMED', payload: {}, basedOnRefs: [] },
    }),
    'AgentProposal.status CHECK 必须拒绝 CONFIRMED',
  );
});

test('[schema] @unique(runId, revision) 在 DB 层拒绝重复 revision', async () => {
  const userId = await makeUser('uniq');
  const run = await repos.agentRuns.createRun(runInput(userId));
  await prisma.agentProposal.create({
    data: { runId: run.id, revision: 1, kind: 'PLAN', payload: {}, basedOnRefs: [] },
  });
  await assert.rejects(
    prisma.agentProposal.create({
      data: { runId: run.id, revision: 1, kind: 'PLAN', payload: {}, basedOnRefs: [] },
    }),
    '同 (runId, revision) 必须被唯一约束拒绝',
  );
});

test('[schema] FK CASCADE：删除 AgentRun 级联删除 AgentProposal', async () => {
  const userId = await makeUser('cascade');
  const run = await repos.agentRuns.createRun(runInput(userId));
  await repos.agentRuns.createProposal(userId, {
    runId: run.id,
    kind: 'PLAN',
    revision: 1,
    payload: {},
    basedOnRefs: [],
  });
  assert.equal(await prisma.agentProposal.count({ where: { runId: run.id } }), 1);

  await prisma.agentRun.delete({ where: { id: run.id } });
  assert.equal(await prisma.agentProposal.count({ where: { runId: run.id } }), 0, 'proposal 必须随 run 级联删除');
});

test('[schema] User → AgentRun 为 CASCADE 外键', async () => {
  const rows = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
    SELECT c.confdeltype::text AS confdeltype
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE c.contype = 'f' AND t.relname = 'AgentRun' AND c.conname = 'AgentRun_userId_fkey'
  `;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confdeltype, 'c');
});
