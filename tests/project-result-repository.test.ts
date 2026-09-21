import test from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { ERROR_CODE, AppError } from '../src/errors.ts';
import { computeContentFingerprint } from '../src/domain/project-result/project-result.ts';

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

async function createUser(tag: string) {
  const user = await prisma.user.create({
    data: { email: `pr_${tag}_${stamp}@example.com`, passwordHash: 'x' },
  });
  return user.id;
}

async function seedPlan(userId: string) {
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
      { order: 1, title: 'step-1-title', desc: 'step-1-desc', targetRequirement: '要求1' },
      { order: 2, title: 'step-2-title', desc: 'step-2-desc', targetRequirement: null },
    ],
  });
  return { plan, resumeId: resume.id, jdId: jd.id, matchRunId: matchRun.id };
}

async function seedDraft(userId: string) {
  const { plan } = await seedPlan(userId);
  const step = plan.steps[0];
  const result = await repos.projectResults.createDraft({
    userId,
    planId: plan.id,
    sourceStepId: step.id,
    sourceStepTitle: step.title,
    sourceStepTargetRequirement: step.targetRequirement,
    title: '成果标题',
    summary: '成果描述',
  });
  return { plan, step, result };
}

test('createDraft / findForUser / listForUser', { skip }, async () => {
  const userId = await createUser('create');
  const { plan, step, result } = await seedDraft(userId);

  const found = await repos.projectResults.findForUser(result.id, userId);
  assert.ok(found);
  assert.equal(found.status, 'DRAFT');
  assert.equal(found.sourceStepId, step.id);
  assert.equal(found.sourceStepTitle, step.title);
  assert.equal(found.artifacts.length, 0);

  const listed = await repos.projectResults.listForUser(userId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, result.id);
  assert.equal(listed[0].artifactCount, 0);

  // 跨用户不可见
  const otherUserId = await createUser('create_other');
  assert.equal(await repos.projectResults.findForUser(result.id, otherUserId), null);

  await prisma.user.delete({ where: { id: userId } });
  await prisma.user.delete({ where: { id: otherUserId } });
});

test('addArtifact 与重复 dedupeKey 返回已存在行', { skip }, async () => {
  const userId = await createUser('artifact');
  const { result } = await seedDraft(userId);

  const a1 = await repos.projectResults.addArtifact(result.id, userId, {
    kind: 'REPO',
    url: 'https://example.com/repo',
    excerpt: 'desc',
  });
  assert.equal(a1.kind, 'REPO');
  assert.equal(a1.url, 'https://example.com/repo');

  const a2 = await repos.projectResults.addArtifact(result.id, userId, {
    kind: 'REPO',
    url: 'https://example.com/repo/',
    excerpt: 'other',
  });
  assert.equal(a2.id, a1.id);

  const found = await repos.projectResults.findForUser(result.id, userId);
  assert.equal(found?.artifacts.length, 1);

  await prisma.user.delete({ where: { id: userId } });
});

test('addArtifact 在非 Draft 状态抛 RESULT_NOT_EDITABLE', { skip }, async () => {
  const userId = await createUser('edit');
  const { result } = await seedDraft(userId);
  await repos.projectResults.addArtifact(result.id, userId, { kind: 'DOC', excerpt: 'e' });
  await repos.projectResults.submit(result.id, userId, new Date());

  await assert.rejects(
    () => repos.projectResults.addArtifact(result.id, userId, { kind: 'DOC', excerpt: 'e2' }),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.RESULT_NOT_EDITABLE,
  );

  await prisma.user.delete({ where: { id: userId } });
});

test('removeDraftArtifact 仅 Draft 可删', { skip }, async () => {
  const userId = await createUser('remove');
  const { result } = await seedDraft(userId);
  const artifact = await repos.projectResults.addArtifact(result.id, userId, { kind: 'DOC', excerpt: 'e' });

  await repos.projectResults.removeDraftArtifact(result.id, userId, artifact.id);
  const afterRemove = await repos.projectResults.findForUser(result.id, userId);
  assert.equal(afterRemove?.artifacts.length, 0);

  await assert.rejects(
    () => repos.projectResults.removeDraftArtifact(result.id, userId, artifact.id),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.NOT_FOUND,
  );

  await prisma.user.delete({ where: { id: userId } });
});

test('submit 计算 fingerprint 并完成转换', { skip }, async () => {
  const userId = await createUser('submit');
  const { result } = await seedDraft(userId);
  await repos.projectResults.addArtifact(result.id, userId, { kind: 'DOC', excerpt: 'e' });

  const now = new Date();
  const submitted = await repos.projectResults.submit(result.id, userId, now);
  assert.equal(submitted.status, 'SUBMITTED');
  assert.ok(submitted.submittedAt);
  assert.equal(
    submitted.contentFingerprint,
    computeContentFingerprint(result.sourceStepId, result.title, result.summary),
  );

  // 重复提交视为不可转换
  await assert.rejects(
    () => repos.projectResults.submit(result.id, userId, now),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.RESULT_NOT_TRANSITIONABLE,
  );

  await prisma.user.delete({ where: { id: userId } });
});

test('submit 无 artifact 抛 RESULT_HAS_NO_ARTIFACT', { skip }, async () => {
  const userId = await createUser('noartifact');
  const { result } = await seedDraft(userId);

  await assert.rejects(
    () => repos.projectResults.submit(result.id, userId, new Date()),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.RESULT_HAS_NO_ARTIFACT,
  );

  await prisma.user.delete({ where: { id: userId } });
});

test('submit 重复 fingerprint 抛 RESULT_DUPLICATE', { skip }, async () => {
  const userId = await createUser('dup');
  const { plan } = await seedPlan(userId);
  const step = plan.steps[0];

  const r1 = await repos.projectResults.createDraft({
    userId,
    planId: plan.id,
    sourceStepId: step.id,
    sourceStepTitle: step.title,
    sourceStepTargetRequirement: step.targetRequirement,
    title: 'T',
    summary: 'S',
  });
  const r2 = await repos.projectResults.createDraft({
    userId,
    planId: plan.id,
    sourceStepId: step.id,
    sourceStepTitle: step.title,
    sourceStepTargetRequirement: step.targetRequirement,
    title: 'T',
    summary: 'S',
  });
  await repos.projectResults.addArtifact(r1.id, userId, { kind: 'DOC', excerpt: 'e' });
  await repos.projectResults.addArtifact(r2.id, userId, { kind: 'DOC', excerpt: 'e' });

  await repos.projectResults.submit(r1.id, userId, new Date());
  await assert.rejects(
    () => repos.projectResults.submit(r2.id, userId, new Date()),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.RESULT_DUPLICATE,
  );

  await prisma.user.delete({ where: { id: userId } });
});

test('revoke 仅 Submitted 可撤销', { skip }, async () => {
  const userId = await createUser('revoke');
  const { result } = await seedDraft(userId);
  await repos.projectResults.addArtifact(result.id, userId, { kind: 'DOC', excerpt: 'e' });

  await assert.rejects(
    () => repos.projectResults.revoke(result.id, userId, new Date()),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.RESULT_NOT_TRANSITIONABLE,
  );

  await repos.projectResults.submit(result.id, userId, new Date());
  const revoked = await repos.projectResults.revoke(result.id, userId, new Date());
  assert.equal(revoked.status, 'REVOKED');

  await assert.rejects(
    () => repos.projectResults.revoke(result.id, userId, new Date()),
    (err: unknown) => err instanceof AppError && err.code === ERROR_CODE.RESULT_NOT_TRANSITIONABLE,
  );

  await prisma.user.delete({ where: { id: userId } });
});

test('findForUser 跨用户 IDOR 返回 null', { skip }, async () => {
  const userId = await createUser('idor');
  const otherUserId = await createUser('idor_other');
  const { result } = await seedDraft(userId);

  assert.equal(await repos.projectResults.findForUser(result.id, otherUserId), null);

  await prisma.user.delete({ where: { id: userId } });
  await prisma.user.delete({ where: { id: otherUserId } });
});
