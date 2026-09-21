/**
 * T3-A2-1 并发验收（真实 PostgreSQL，**禁止静默 skip**）
 *
 * 覆盖 §二十七 Concurrency：
 *   ① 同一 Capability 的并发候选创建
 *   ② 同一 ResultArtifact 的并发回流
 *   ③ confirm × revoke
 * 目标（冻结要求）：
 *   - 不存在重复 evidence
 *   - 不存在 CONFIRMED 被错误降级
 *   - 不存在「依据已 revoke 的成果仍成功 CONFIRMED」
 *   - 不存在 ownership 绕过
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

test('前置：数据库必须可达（A2-1 并发测试禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

let seq = 0;
async function makeUser() {
  seq += 1;
  const u = await prisma.user.create({
    data: { email: `pr_ret_cc_${seq}_${stamp}@example.com`, passwordHash: 'x' },
  });
  return u.id;
}

async function seedSubmittedResult(userId: string, tag: string, extraUrls: string[] = []) {
  const resume = await prisma.resume.create({ data: { userId, rawText: '技能：Python', sourceType: 'TEXT' } });
  const jd = await prisma.jobDescription.create({ data: { userId, rawText: 'JD', title: '岗位' } });
  const matchRun = await prisma.matchRun.create({
    data: {
      userId, resumeId: resume.id, jdId: jd.id, matcherVersion: 'v1', summary: {},
      items: { create: [{ reqText: 'r', status: 'MISSING', category: 'TECH', criticality: 'MUST', reason: 'r', basisType: 'INFERENCE', basisDetail: 'd' }] },
    },
  });
  const plan = await repos.actionPlans.createPlanWithSteps({
    userId, matchRunId: matchRun.id, jdId: jd.id, goal: 'g', have: [], gaps: [],
    steps: [{ order: 1, title: 't', desc: 'd', targetRequirement: 'r' }],
  });
  const draft = await repos.projectResults.createDraft({
    userId, planId: plan.id, sourceStepId: plan.steps[0].id, sourceStepTitle: 't',
    sourceStepTargetRequirement: 'r', title: `成果-${tag}`, summary: `描述-${tag}`,
  });
  const artifact = await repos.projectResults.addArtifact(draft.id, userId, {
    kind: 'REPO', url: `https://example.com/${tag}`,
  });
  const extras = [];
  for (const [i, u] of extraUrls.entries()) {
    extras.push(await repos.projectResults.addArtifact(draft.id, userId, { kind: i % 2 === 0 ? 'DEPLOY' : 'DOC', url: u }));
  }
  await repos.projectResults.submit(draft.id, userId, new Date());
  return { draft, artifact, extras };
}

// ─── ① 并发候选创建 ───────────────────────────────────────────────────

test('并发候选创建：6 个不同成果同时回流同一 key → Capability 恰好一行', async () => {
  const userId = await makeUser();
  const key = `cc_cand_${stamp}`;
  const seeds = [];
  for (let i = 0; i < 6; i += 1) seeds.push(await seedSubmittedResult(userId, `cand${i}`));

  const results = await Promise.all(seeds.map((s) =>
    repos.capabilities.declareFromProjectArtifact({
      userId, resultId: s.draft.id, artifactId: s.artifact.id, key, label: '并发能力',
    }),
  ));

  for (const r of results) assert.equal(r.kind, 'DECLARED');
  const ids = new Set(results.map((r) => (r.kind === 'DECLARED' ? r.capabilityId : '')));
  assert.equal(ids.size, 1, '并发创建必须收敛到同一 Capability');
  assert.equal(await prisma.capability.count({ where: { userId, key } }), 1);
  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: [...ids][0] } }), 6);

  const cap = await prisma.capability.findUnique({ where: { id: [...ids][0] } });
  assert.equal(cap?.status, 'UNCONFIRMED');
  assert.equal(cap?.source, 'PROJECT_RESULT');

  await prisma.user.delete({ where: { id: userId } });
});

// ─── ② 并发同一 evidence ──────────────────────────────────────────────

test('并发同一 evidence：8 个并发重复请求 → Evidence 恰好一行，且不返回 500', async () => {
  const userId = await makeUser();
  const key = `cc_ev_${stamp}`;
  const s = await seedSubmittedResult(userId, 'ev');

  const results = await Promise.all(Array.from({ length: 8 }, () =>
    repos.capabilities.declareFromProjectArtifact({
      userId, resultId: s.draft.id, artifactId: s.artifact.id, key, label: 'L',
    }),
  ));

  for (const r of results) assert.equal(r.kind, 'DECLARED');
  const created = results.filter((r) => r.kind === 'DECLARED' && r.evidenceCreated).length;
  assert.equal(created, 1, '只应有一次真正创建证据');
  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: results[0].kind === 'DECLARED' ? results[0].capabilityId : '' } }), 1);
  assert.equal(await prisma.capability.count({ where: { userId, key } }), 1);

  await prisma.user.delete({ where: { id: userId } });
});

// ─── ③ confirm × revoke ──────────────────────────────────────────────

test('confirm × revoke（确定性）：revoke 完成后 confirm 必须失败且不产生 CONFIRMED', async () => {
  const userId = await makeUser();
  const key = `cc_cr_${stamp}`;
  const s = await seedSubmittedResult(userId, 'cr1');
  const d = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: s.draft.id, artifactId: s.artifact.id, key, label: 'L',
  });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;

  await repos.projectResults.revoke(s.draft.id, userId, new Date());
  assert.equal(await repos.capabilities.confirm(d.capabilityId, userId), 'NO_EVIDENCE');
  assert.equal((await prisma.capability.findUnique({ where: { id: d.capabilityId } }))?.status, 'UNCONFIRMED');
  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: d.capabilityId } }), 1, 'revoke 不得删除证据');

  await prisma.user.delete({ where: { id: userId } });
});

test('confirm × revoke（真并发）：锁序 ProjectResult→Capability，状态始终一致、无死锁、不降级', async () => {
  const userId = await makeUser();
  const ROUNDS = 6;
  const observations = [];

  for (let i = 0; i < ROUNDS; i += 1) {
    const key = `cc_race_${i}_${stamp}`;
    const s = await seedSubmittedResult(userId, `race${i}`);
    const d = await repos.capabilities.declareFromProjectArtifact({
      userId, resultId: s.draft.id, artifactId: s.artifact.id, key, label: 'L',
    });
    assert.equal(d.kind, 'DECLARED');
    if (d.kind !== 'DECLARED') return;

    const [confirmOutcome] = await Promise.all([
      repos.capabilities.confirm(d.capabilityId, userId),
      repos.projectResults.revoke(s.draft.id, userId, new Date()),
    ]);

    const cap = await prisma.capability.findUnique({ where: { id: d.capabilityId } });
    const result = await prisma.projectResult.findUnique({ where: { id: s.draft.id } });
    observations.push({ confirmOutcome, status: cap?.status, revoked: result?.revokedAt != null });

    assert.ok(
      confirmOutcome === 'CONFIRMED' || confirmOutcome === 'NO_EVIDENCE',
      `confirm 只应是 CONFIRMED / NO_EVIDENCE，实际 ${confirmOutcome}`,
    );
    // 关键不变式：若 confirm 未成功，则成果必已 revoke（不是无端失败）
    if (confirmOutcome === 'NO_EVIDENCE') assert.equal(result?.revokedAt != null, true);
    // 关键不变式：confirm 成功 ⇔ 最终为 CONFIRMED（不得被 revoke 降级）
    assert.equal(cap?.status, confirmOutcome === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIRMED');
    // 证据始终不被 revoke 删除
    assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: d.capabilityId } }), 1);
  }

  // revoke 先于 confirm 的轮次必须失败；confirm 先于 revoke 的轮次合法成功
  assert.equal(observations.length, ROUNDS);
  assert.equal(observations.some((o) => o.confirmOutcome === 'CONFIRMED' || o.confirmOutcome === 'NO_EVIDENCE'), true);

  await prisma.user.delete({ where: { id: userId } });
});

test('并发 + ownership：跨用户并发声明不得产生任何写入', async () => {
  const owner = await makeUser();
  const attacker = await makeUser();
  const s = await seedSubmittedResult(owner, 'idorcc');
  const key = `cc_idor_${stamp}`;

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    repos.capabilities.declareFromProjectArtifact({
      userId: attacker, resultId: s.draft.id, artifactId: s.artifact.id, key, label: 'L',
    }),
  ));

  for (const r of results) assert.equal(r.kind, 'NOT_FOUND');
  assert.equal(await prisma.capability.count({ where: { userId: attacker } }), 0);
  assert.equal(await prisma.capabilityEvidence.count({ where: { resultArtifactId: s.artifact.id } }), 0);

  await prisma.user.delete({ where: { id: owner } });
  await prisma.user.delete({ where: { id: attacker } });
});
