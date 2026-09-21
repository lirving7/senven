/**
 * T3-A2-1 Repository 层验收（真实 PostgreSQL，**禁止静默 skip**）
 *
 * 覆盖 §二十七 Repository / DB invariant / Provider：
 *   - 新 Capability → UNCONFIRMED + source=PROJECT_RESULT
 *   - 已存在 Capability → status / level / source **均不变**（M6：根本不 UPDATE）
 *   - Evidence 幂等（唯一身份 capabilityId + resultArtifactId）
 *   - Resume Evidence 不被误删（source isolation）
 *   - Draft / Revoked declare → NOT_SUBMITTED；Submitted → 成功
 *   - ownership / artifact 不属于该成果 → NOT_FOUND
 *   - url-less artifact → ARTIFACT_URL_REQUIRED
 *   - confirm 闸门：revoke 后不得 CONFIRMED；Resume 语义保持不变
 *   - DB invariant：两条既有 CHECK 继续有效；Skill 不变量；partial unique index 生效
 *   - Provider：provider calls = 0
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import {
  PROJECT_RESULT_EVIDENCE_TYPE,
  PROJECT_RESULT_SOURCE,
} from '../src/domain/capability/project.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * §二十八：A2-1 新增 DB 测试**禁止** `{ skip: ... }`。
 * 数据库不可达时，本文件必须**失败**而不是被跳过——故此处显式断言可达性。
 */
test('前置：数据库必须可达（A2-1 关键 DB 测试禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

// ─── 夹具 ─────────────────────────────────────────────────────────────

let userSeq = 0;
async function makeUser() {
  userSeq += 1;
  const email = `pr_ret_repo_${userSeq}_${stamp}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: 'x' } });
  return user.id;
}

/** 造一个 ProjectResult（含带 URL 的 artifact），可指定提交/撤销状态 */
async function seedResult(
  userId: string,
  opts?: { state?: 'DRAFT' | 'SUBMITTED' | 'REVOKED'; url?: string | null; extraUrls?: string[] },
) {
  const state = opts?.state ?? 'SUBMITTED';
  const url = opts?.url === undefined ? 'https://example.com/Repo' : opts.url;

  const resume = await prisma.resume.create({ data: { userId, rawText: '技能：Python', sourceType: 'TEXT' } });
  const jd = await prisma.jobDescription.create({ data: { userId, rawText: 'JD', title: '岗位' } });
  const matchRun = await prisma.matchRun.create({
    data: {
      userId, resumeId: resume.id, jdId: jd.id, matcherVersion: 'v1', summary: {},
      items: {
        create: [{
          reqText: '要求1', status: 'MISSING', category: 'TECH', criticality: 'MUST',
          reason: 'r', basisType: 'INFERENCE', basisDetail: 'd',
        }],
      },
    },
  });
  const plan = await repos.actionPlans.createPlanWithSteps({
    userId, matchRunId: matchRun.id, jdId: jd.id, goal: 'goal', have: [], gaps: [],
    steps: [{ order: 1, title: 't1', desc: 'd1', targetRequirement: '要求1' }],
  });
  const draft = await repos.projectResults.createDraft({
    userId, planId: plan.id, sourceStepId: plan.steps[0].id,
    sourceStepTitle: 't1', sourceStepTargetRequirement: '要求1',
    title: '成果', summary: '描述',
  });
  const artifact = await repos.projectResults.addArtifact(draft.id, userId, {
    kind: 'REPO',
    ...(url === null ? { excerpt: '仅文字描述' } : { url }),
  });
  // 追加凭据必须在提交之前（Submitted 后 RESULT_NOT_EDITABLE）
  const extras = [];
  for (const [i, u] of (opts?.extraUrls ?? []).entries()) {
    extras.push(await repos.projectResults.addArtifact(draft.id, userId, { kind: i === 0 ? 'DEPLOY' : 'DOC', url: u }));
  }
  if (state === 'SUBMITTED' || state === 'REVOKED') await repos.projectResults.submit(draft.id, userId, new Date());
  if (state === 'REVOKED') await repos.projectResults.revoke(draft.id, userId, new Date());
  return { plan, draft, artifact, extras };
}

async function evidenceOf(capabilityId: string) {
  return prisma.capabilityEvidence.findMany({
    where: { capabilityId },
    select: { id: true, type: true, source: true, url: true, excerpt: true, resumeEvidenceId: true, resultArtifactId: true },
    orderBy: { createdAt: 'asc' },
  });
}
async function cleanup(userId: string) {
  await prisma.user.delete({ where: { id: userId } });
}

// ─── 回流：新建 ───────────────────────────────────────────────────────

test('declare：新建 Capability 为 UNCONFIRMED + source=PROJECT_RESULT', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `ret_new_${stamp}`;

  const out = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: '示例能力',
  });

  assert.equal(out.kind, 'DECLARED');
  if (out.kind !== 'DECLARED') return;
  assert.equal(out.capabilityStatus, 'UNCONFIRMED');
  assert.equal(out.capabilitySource, PROJECT_RESULT_SOURCE);
  assert.equal(out.evidenceCreated, true);

  const cap = await prisma.capability.findUnique({ where: { id: out.capabilityId } });
  assert.equal(cap?.status, 'UNCONFIRMED');
  assert.equal(cap?.source, 'PROJECT_RESULT');
  assert.equal(cap?.level, null);

  const ev = await evidenceOf(out.capabilityId);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, PROJECT_RESULT_EVIDENCE_TYPE);
  assert.equal(ev[0].resultArtifactId, artifact.id);
  assert.equal(ev[0].resumeEvidenceId, null);
  assert.equal(ev[0].url, 'https://example.com/Repo');

  await cleanup(userId);
});

test('declare：证据幂等 —— 重复声明不产生第二条证据，返回同一条 id', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `ret_idem_${stamp}`;

  const first = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L',
  });
  const second = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L',
  });

  assert.equal(first.kind, 'DECLARED');
  assert.equal(second.kind, 'DECLARED');
  if (first.kind !== 'DECLARED' || second.kind !== 'DECLARED') return;
  assert.equal(first.evidenceCreated, true);
  assert.equal(second.evidenceCreated, false);
  assert.equal(first.evidenceId, second.evidenceId);

  const ev = await evidenceOf(first.capabilityId);
  assert.equal(ev.length, 1);

  await cleanup(userId);
});

test('declare：同一成果的多个 artifact → 同一 Capability，证据各一条', async () => {
  const userId = await makeUser();
  const { draft, artifact, extras } = await seedResult(userId, { extraUrls: ['https://example.com/DeployA#one'] });
  const a2 = extras[0];
  const key = `ret_multi_${stamp}`;

  const r1 = await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L' });
  const r2 = await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: a2.id, key, label: 'L' });

  assert.equal(r1.kind, 'DECLARED');
  assert.equal(r2.kind, 'DECLARED');
  if (r1.kind !== 'DECLARED' || r2.kind !== 'DECLARED') return;
  assert.equal(r1.capabilityId, r2.capabilityId);
  assert.equal((await evidenceOf(r1.capabilityId)).length, 2);
  assert.equal(await prisma.capability.count({ where: { userId, key } }), 1);

  await cleanup(userId);
});

// ─── M6：已存在 Capability 只读 ────────────────────────────────────────

test('M6：已存在 CONFIRMED 能力不得被降级，level / source 不得被覆盖', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `ret_m6_${stamp}`;

  const resume = await prisma.resume.create({ data: { userId, rawText: 'x', sourceType: 'TEXT' } });
  const skill = await prisma.skill.create({
    data: { resumeId: resume.id, key, label: '既有能力', level: 'ADVANCED', status: 'CONFIRMED' },
  });
  const ev = await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'loc', excerpt: '既有证据', skillId: skill.id },
  });
  const cap = await prisma.capability.create({
    data: {
      userId, key, label: '既有能力', level: 'ADVANCED', status: 'CONFIRMED', source: 'RESUME_PROJECTION',
      evidence: { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: '既有证据', resumeEvidenceId: ev.id }] },
    },
  });

  const before = await prisma.capability.findUnique({ where: { id: cap.id } });

  const out = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: '改名企图',
  });
  assert.equal(out.kind, 'DECLARED');
  if (out.kind !== 'DECLARED') return;
  assert.equal(out.capabilityId, cap.id);
  assert.equal(out.capabilityStatus, 'CONFIRMED');
  assert.equal(out.capabilitySource, 'RESUME_PROJECTION');

  const after = await prisma.capability.findUnique({ where: { id: cap.id } });
  assert.equal(after?.status, before?.status);
  assert.equal(after?.level, before?.level);
  assert.equal(after?.source, before?.source);
  assert.equal(after?.label, before?.label);
  assert.equal(after?.status, 'CONFIRMED');
  assert.equal(after?.level, 'ADVANCED');
  assert.equal(after?.source, 'RESUME_PROJECTION');

  // 证据：Resume 证据未被误删，且新增了项目证据
  const all = await evidenceOf(cap.id);
  assert.equal(all.filter((e) => e.type === 'RESUME_EVIDENCE').length, 1);
  assert.equal(all.filter((e) => e.type === PROJECT_RESULT_EVIDENCE_TYPE).length, 1);
  assert.equal(all.find((e) => e.type === 'RESUME_EVIDENCE')?.resumeEvidenceId, ev.id);

  await cleanup(userId);
});

test('来源隔离：declare 只新增 PROJECT_RESULT_EVIDENCE，绝不动 Resume Evidence', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `ret_iso_${stamp}`;

  const resume = await prisma.resume.create({ data: { userId, rawText: 'x', sourceType: 'TEXT' } });
  const skill = await prisma.skill.create({ data: { resumeId: resume.id, key, label: 'L', status: 'CONFIRMED' } });
  const ev = await prisma.evidence.create({
    data: { source: 'RESUME_TEXT', locator: 'loc', excerpt: 'e1', skillId: skill.id },
  });
  const cap = await prisma.capability.create({
    data: {
      userId, key, label: 'L', status: 'UNCONFIRMED', source: 'RESUME_PROJECTION',
      evidence: { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: 'e1', resumeEvidenceId: ev.id }] },
    },
  });
  const resumeEvBefore = await prisma.capabilityEvidence.count({ where: { capabilityId: cap.id, type: 'RESUME_EVIDENCE' } });

  await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L' });

  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: cap.id, type: 'RESUME_EVIDENCE' } }), resumeEvBefore);
  const all = await evidenceOf(cap.id);
  assert.equal(all.length, 2);
  assert.equal(all.filter((e) => e.type === 'RESUME_EVIDENCE').length, 1);

  await cleanup(userId);
});

// ─── 状态限制 / 归属 ───────────────────────────────────────────────────

test('declare：DRAFT 成果 → NOT_SUBMITTED', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId, { state: 'DRAFT' });
  const out = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key: `ret_draft_${stamp}`, label: 'L',
  });
  assert.equal(out.kind, 'NOT_SUBMITTED');
  await cleanup(userId);
});

test('declare：REVOKED 成果 → NOT_SUBMITTED', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId, { state: 'REVOKED' });
  const out = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key: `ret_revoked_${stamp}`, label: 'L',
  });
  assert.equal(out.kind, 'NOT_SUBMITTED');
  await cleanup(userId);
});

test('declare：url-less（仅 excerpt）凭据 → ARTIFACT_URL_REQUIRED', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId, { url: null });
  assert.equal(artifact.url, null);
  const out = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key: `ret_nourl_${stamp}`, label: 'L',
  });
  assert.equal(out.kind, 'ARTIFACT_URL_REQUIRED');
  assert.equal(await prisma.capabilityEvidence.count({ where: { resultArtifactId: artifact.id } }), 0);
  await cleanup(userId);
});

test('declare：跨用户 result → NOT_FOUND', async () => {
  const owner = await makeUser();
  const attacker = await makeUser();
  const { draft, artifact } = await seedResult(owner);
  const out = await repos.capabilities.declareFromProjectArtifact({
    userId: attacker, resultId: draft.id, artifactId: artifact.id, key: `ret_idor_${stamp}`, label: 'L',
  });
  assert.equal(out.kind, 'NOT_FOUND');
  assert.equal(await prisma.capability.count({ where: { userId: attacker } }), 0);
  await cleanup(owner);
  await cleanup(attacker);
});

test('declare：artifact 不属于该 result → NOT_FOUND', async () => {
  const userId = await makeUser();
  const a = await seedResult(userId);
  const b = await seedResult(userId);
  const out = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: a.draft.id, artifactId: b.artifact.id, key: `ret_mismatch_${stamp}`, label: 'L',
  });
  assert.equal(out.kind, 'NOT_FOUND');
  await cleanup(userId);
});

test('declare：不存在的 result / artifact → NOT_FOUND', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const r1 = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: 'nope_result', artifactId: artifact.id, key: `ret_nf1_${stamp}`, label: 'L',
  });
  const r2 = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: 'nope_artifact', key: `ret_nf2_${stamp}`, label: 'L',
  });
  assert.equal(r1.kind, 'NOT_FOUND');
  assert.equal(r2.kind, 'NOT_FOUND');
  await cleanup(userId);
});

// ─── Confirmation Gate ────────────────────────────────────────────────

test('confirm：项目证据（URL 有效、未 revoke）→ CONFIRMED', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `ret_conf_${stamp}`;
  const d = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L',
  });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;

  assert.equal(await repos.capabilities.confirm(d.capabilityId, userId), 'CONFIRMED');
  assert.equal((await prisma.capability.findUnique({ where: { id: d.capabilityId } }))?.status, 'CONFIRMED');
  await cleanup(userId);
});

test('confirm × revoke：成果被 revoke 后不得再 CONFIRMED（且不得降级已有状态）', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `ret_confrev_${stamp}`;
  const d = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L',
  });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;
  assert.equal((await prisma.capability.findUnique({ where: { id: d.capabilityId } }))?.status, 'UNCONFIRMED');

  await repos.projectResults.revoke(draft.id, userId, new Date());

  assert.equal(await repos.capabilities.confirm(d.capabilityId, userId), 'NO_EVIDENCE');
  assert.equal((await prisma.capability.findUnique({ where: { id: d.capabilityId } }))?.status, 'UNCONFIRMED');

  // 已 CONFIRMED 的能力再 confirm 时若来源已 revoke → 返回 NO_EVIDENCE，但**不得被降级**
  await prisma.capability.update({ where: { id: d.capabilityId }, data: { status: 'CONFIRMED' } });
  assert.equal(await repos.capabilities.confirm(d.capabilityId, userId), 'NO_EVIDENCE');
  assert.equal((await prisma.capability.findUnique({ where: { id: d.capabilityId } }))?.status, 'CONFIRMED');

  await cleanup(userId);
});

test('confirm：既有 Resume 语义保持不变（url ∥ excerpt）', async () => {
  const userId = await makeUser();
  const resume = await prisma.resume.create({ data: { userId, rawText: 'x', sourceType: 'TEXT' } });
  const skill = await prisma.skill.create({ data: { resumeId: resume.id, key: `k_${stamp}`, label: 'L', status: 'CONFIRMED' } });

  // excerpt-only → 可确认（沿用旧语义）
  const evA = await prisma.evidence.create({ data: { source: 'RESUME_TEXT', locator: 'l', excerpt: 'e', skillId: skill.id } });
  const capA = await prisma.capability.create({
    data: {
      userId, key: `resumeA_${stamp}`, label: 'L', status: 'UNCONFIRMED', source: 'RESUME_PROJECTION',
      evidence: { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: 'e', resumeEvidenceId: evA.id }] },
    },
  });
  assert.equal(await repos.capabilities.confirm(capA.id, userId), 'CONFIRMED');

  // 无 url 且无 excerpt → 不可确认
  const evB = await prisma.evidence.create({ data: { source: 'RESUME_TEXT', locator: 'l', excerpt: null, skillId: skill.id } });
  const capB = await prisma.capability.create({
    data: {
      userId, key: `resumeB_${stamp}`, label: 'L', status: 'UNCONFIRMED', source: 'RESUME_PROJECTION',
      evidence: { create: [{ type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: null, resumeEvidenceId: evB.id }] },
    },
  });
  assert.equal(await repos.capabilities.confirm(capB.id, userId), 'NO_EVIDENCE');

  // 跨用户 → NOT_FOUND
  const other = await makeUser();
  assert.equal(await repos.capabilities.confirm(capA.id, other), 'NOT_FOUND');

  await cleanup(other);
  await cleanup(userId);
});

// ─── DB invariant ─────────────────────────────────────────────────────

test('DB invariant：两条既有 CHECK 继续生效', async () => {
  const userId = await makeUser();
  const cap = await prisma.capability.create({
    data: { userId, key: `chk_${stamp}`, label: 'L', status: 'UNCONFIRMED', source: 'PROJECT_RESULT' },
  });
  const { artifact } = await seedResult(userId);

  // ① XOR 违规：两个指针都为空
  await assert.rejects(
    () => prisma.$executeRaw`
      INSERT INTO "CapabilityEvidence" (id, "capabilityId", type, source, url, excerpt, "createdAt")
      VALUES (${`x1_${stamp}`}, ${cap.id}, 'RESUME_EVIDENCE', 'RESUME_TEXT', NULL, NULL, NOW())`,
  );
  // ② XOR 违规：两个指针都非空
  const resume = await prisma.resume.create({ data: { userId, rawText: 'x', sourceType: 'TEXT' } });
  const ev = await prisma.evidence.create({ data: { source: 'RESUME_TEXT', locator: 'l', excerpt: 'e', skillId: (await prisma.skill.create({ data: { resumeId: resume.id, key: `sk_${stamp}`, label: 'L' } })).id } });
  await assert.rejects(
    () => prisma.$executeRaw`
      INSERT INTO "CapabilityEvidence" (id, "capabilityId", type, source, url, excerpt, "resumeEvidenceId", "resultArtifactId", "createdAt")
      VALUES (${`x2_${stamp}`}, ${cap.id}, 'RESUME_EVIDENCE', 'RESUME_TEXT', NULL, 'e', ${ev.id}, ${artifact.id}, NOW())`,
  );
  // ③ type ↔ pointer 不一致
  await assert.rejects(
    () => prisma.$executeRaw`
      INSERT INTO "CapabilityEvidence" (id, "capabilityId", type, source, url, excerpt, "resultArtifactId", "createdAt")
      VALUES (${`x3_${stamp}`}, ${cap.id}, 'RESUME_EVIDENCE', 'RESUME_TEXT', 'https://x/a', NULL, ${artifact.id}, NOW())`,
  );
  await assert.rejects(
    () => prisma.$executeRaw`
      INSERT INTO "CapabilityEvidence" (id, "capabilityId", type, source, url, excerpt, "createdAt")
      VALUES (${`x4_${stamp}`}, ${cap.id}, 'PROJECT_RESULT_EVIDENCE', 'PROJECT_RESULT', NULL, NULL, NOW())`,
  );

  await cleanup(userId);
});

test('DB invariant：partial unique index 阻止重复 (capabilityId, resultArtifactId)', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `uniq_${stamp}`;
  const d = await repos.capabilities.declareFromProjectArtifact({
    userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L',
  });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;

  await assert.rejects(
    () => prisma.$executeRaw`
      INSERT INTO "CapabilityEvidence" (id, "capabilityId", type, source, url, excerpt, "resultArtifactId", "createdAt")
      VALUES (${`dup_${stamp}`}, ${d.capabilityId}, 'PROJECT_RESULT_EVIDENCE', 'PROJECT_RESULT', 'https://x/a', NULL, ${artifact.id}, NOW())`,
  );
  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: d.capabilityId, resultArtifactId: artifact.id } }), 1);

  await cleanup(userId);
});

test('DB invariant：Capability 不降级 —— 回流后状态单调不回退', async () => {
  const userId = await makeUser();
  const { draft, artifact, extras } = await seedResult(userId, { extraUrls: ['https://example.com/doc#v1'] });
  const key = `mono_${stamp}`;
  const d = await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L' });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;
  assert.equal(await repos.capabilities.confirm(d.capabilityId, userId), 'CONFIRMED');

  const again = await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: extras[0].id, key, label: 'L' });
  assert.equal(again.kind, 'DECLARED');
  if (again.kind !== 'DECLARED') return;
  assert.equal(again.capabilityStatus, 'CONFIRMED');
  assert.equal((await prisma.capability.findUnique({ where: { id: d.capabilityId } }))?.status, 'CONFIRMED');

  await cleanup(userId);
});

test('Skill 不变量：declare 与 confirm 全程不写 Skill', async () => {
  const userId = await makeUser();
  const resume = await prisma.resume.create({ data: { userId, rawText: 'x', sourceType: 'TEXT' } });
  const key = `skillinv_${stamp}`;
  const skill = await prisma.skill.create({
    data: { resumeId: resume.id, key, label: 'L', level: 'BEGINNER', status: 'UNCONFIRMED' },
  });
  const { draft, artifact } = await seedResult(userId);

  // 快照必须**限定到本用例的用户**（测试文件并行执行，全库快照会被其他用例污染）
  const skillSnapshot = () => prisma.skill.findMany({
    where: { resume: { userId } },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { id: 'asc' },
  });

  const before = await skillSnapshot();

  const d = await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L' });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;
  assert.equal(await repos.capabilities.confirm(d.capabilityId, userId), 'CONFIRMED');

  assert.deepEqual(await skillSnapshot(), before);
  assert.equal((await prisma.skill.findUnique({ where: { id: skill.id } }))?.status, 'UNCONFIRMED');
  assert.equal((await prisma.skill.findUnique({ where: { id: skill.id } }))?.level, 'BEGINNER');

  await cleanup(userId);
});

// ─── Provider：零 LLM ─────────────────────────────────────────────────

test('Provider：declare + confirm 全程 provider calls = 0', async () => {
  const userId = await makeUser();
  const { draft, artifact } = await seedResult(userId);
  const key = `zerollm_${stamp}`;

  const before = await prisma.llmUsage.count({ where: { userId } });
  const d = await repos.capabilities.declareFromProjectArtifact({ userId, resultId: draft.id, artifactId: artifact.id, key, label: 'L' });
  assert.equal(d.kind, 'DECLARED');
  if (d.kind !== 'DECLARED') return;
  await repos.capabilities.confirm(d.capabilityId, userId);

  assert.equal(await prisma.llmUsage.count({ where: { userId } }), before);
  // 依赖边界：CapabilityRepository 不含任何 provider 端口
  assert.equal(typeof (repos.capabilities as unknown as Record<string, unknown>).provider, 'undefined');
  assert.deepEqual(
    Object.keys(repos.capabilities).sort(),
    ['confirm', 'declareFromProjectArtifact', 'findForUser', 'listForUser', 'projectConfirmedSkills'],
  );

  await cleanup(userId);
});
