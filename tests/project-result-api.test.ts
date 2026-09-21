/**
 * T3-A1 ProjectResult / ResultArtifact API 验收
 *
 * 直接调用 handler 函数（与 t2-action-plan-api.test.ts 同一范式），使用真实 Prisma 仓储。
 * 覆盖：创建 Draft / 增删凭据 / 提交 / 撤销 / 列表 / 详情 / 跨用户隔离 / 参数校验 / 重复凭据 200 / 重复提交 409。
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
  createCreateProjectResultHandler,
  createListProjectResultsHandler,
  createGetProjectResultHandler,
  createAddProjectResultArtifactHandler,
  createRemoveProjectResultArtifactHandler,
  createSubmitProjectResultHandler,
  createRevokeProjectResultHandler,
} from '../src/http/handlers/project-results.ts';
import { bodyOf, extractSessionToken, getJson, postJson, deleteJson } from './fakes.ts';

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
    projectResults: repos.projectResults,
    capabilities: repos.capabilities,
    clock: systemClock,
  };
  return {
    register,
    handlers: {
      create: createCreateProjectResultHandler(deps),
      list: createListProjectResultsHandler(deps),
      get: createGetProjectResultHandler(deps),
      addArtifact: createAddProjectResultArtifactHandler(deps),
      removeArtifact: createRemoveProjectResultArtifactHandler(deps),
      submit: createSubmitProjectResultHandler(deps),
      revoke: createRevokeProjectResultHandler(deps),
    },
    async signUp(tag: string) {
      const res = await register(
        postJson('http://t/api/auth/register', { email: `pr_api_${tag}_${stamp}@example.com`, password: 'password-1234' }),
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
          { order: 1, title: 'step-1-title', desc: 'step-1-desc', targetRequirement: '要求1' },
        ],
      });
      return { plan, step: plan.steps[0] };
    },
  };
}

async function createDraft(h: Harness, token: string, planId: string, stepId: string) {
  const res = await h.handlers.create(
    postJson('http://t/api/project-results', { planId, sourceStepId: stepId, title: '成果', summary: '描述' }, token),
  );
  assert.equal(res.status, 201);
  const body = await bodyOf(res);
  return body.data as { id: string; status: string; artifacts: unknown[] };
}

test('完整生命周期：创建 → 加凭据 → 提交 → 撤销', { skip }, async () => {
  const h = makeHarness();
  const { userId, token: userToken } = await h.signUp('lifecycle');
  const { plan: plan2, step: step2 } = await h.seedPlan(userId);

  const draft = await createDraft(h, userToken, plan2.id, step2.id);
  assert.equal(draft.status, 'DRAFT');

  const artifactRes = await h.handlers.addArtifact(
    postJson(`http://t/api/project-results/${draft.id}/artifacts`, { kind: 'REPO', url: 'https://example.com/repo' }, userToken),
    draft.id,
  );
  assert.equal(artifactRes.status, 200);

  // 重复凭据 → 200 返回已存在
  const dupRes = await h.handlers.addArtifact(
    postJson(`http://t/api/project-results/${draft.id}/artifacts`, { kind: 'REPO', url: 'https://example.com/repo/' }, userToken),
    draft.id,
  );
  assert.equal(dupRes.status, 200);
  const dupBody = (await bodyOf(dupRes)) as { data: { id: string } };
  const artBody = (await bodyOf(artifactRes)) as { data: { id: string } };
  assert.equal(dupBody.data.id, artBody.data.id);

  const submitRes = await h.handlers.submit(
    postJson(`http://t/api/project-results/${draft.id}/submit`, {}, userToken),
    draft.id,
  );
  assert.equal(submitRes.status, 200);
  const submitted = (await bodyOf(submitRes)) as { data: { status: string; contentFingerprint: string } };
  assert.equal(submitted.data.status, 'SUBMITTED');
  assert.ok(submitted.data.contentFingerprint);

  const revokeRes = await h.handlers.revoke(
    postJson(`http://t/api/project-results/${draft.id}/revoke`, {}, userToken),
    draft.id,
  );
  assert.equal(revokeRes.status, 200);
  const revoked = (await bodyOf(revokeRes)) as { data: { status: string } };
  assert.equal(revoked.data.status, 'REVOKED');

  // 撤销后不可再加凭据
  const afterRevoke = await h.handlers.addArtifact(
    postJson(`http://t/api/project-results/${draft.id}/artifacts`, { kind: 'DOC', excerpt: 'e' }, userToken),
    draft.id,
  );
  assert.equal(afterRevoke.status, 422);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pr_api_lifecycle` } } });
});

test('列表与详情仅返回本人数据', { skip }, async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('list');
  const { plan, step } = await h.seedPlan(userId);
  const draft = await createDraft(h, token, plan.id, step.id);

  const { token: otherToken } = await h.signUp('list_other');

  const getRes = await h.handlers.get(getJson(`http://t/api/project-results/${draft.id}`, otherToken), draft.id);
  assert.equal(getRes.status, 404);

  const listRes = await h.handlers.list(getJson('http://t/api/project-results', otherToken));
  const listBody = await bodyOf(listRes);
  assert.equal((listBody.data as { items: unknown[] }).items.length, 0);

  const ownListRes = await h.handlers.list(getJson('http://t/api/project-results', token));
  const ownListBody = await bodyOf(ownListRes);
  assert.equal((ownListBody.data as { items: unknown[] }).items.length, 1);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pr_api_list` } } });
});

test('sourceStepId 不在 plan 中 → 400', { skip }, async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('badstep');
  const { plan } = await h.seedPlan(userId);

  const res = await h.handlers.create(
    postJson('http://t/api/project-results', { planId: plan.id, sourceStepId: 'not-in-plan', title: 't', summary: 's' }, token),
  );
  assert.equal(res.status, 400);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pr_api_badstep` } } });
});

test('未登录 → 401', { skip }, async () => {
  const h = makeHarness();
  const res = await h.handlers.create(postJson('http://t/api/project-results', { planId: 'x', sourceStepId: 'y', title: 't', summary: 's' }));
  assert.equal(res.status, 401);
});

test('提交无凭据 → 422 RESULT_HAS_NO_ARTIFACT', { skip }, async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('noartifact');
  const { plan, step } = await h.seedPlan(userId);
  const draft = await createDraft(h, token, plan.id, step.id);

  const res = await h.handlers.submit(
    postJson(`http://t/api/project-results/${draft.id}/submit`, {}, token),
    draft.id,
  );
  assert.equal(res.status, 422);
  const body = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(body.error.code, 'RESULT_HAS_NO_ARTIFACT');

  await prisma.user.deleteMany({ where: { email: { startsWith: `pr_api_noartifact` } } });
});

test('重复提交 → 409 RESULT_DUPLICATE', { skip }, async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('dup');
  const { plan, step } = await h.seedPlan(userId);

  const d1 = await createDraft(h, token, plan.id, step.id);
  const d2 = await createDraft(h, token, plan.id, step.id);

  await h.handlers.addArtifact(
    postJson(`http://t/api/project-results/${d1.id}/artifacts`, { kind: 'DOC', excerpt: 'e' }, token),
    d1.id,
  );
  await h.handlers.addArtifact(
    postJson(`http://t/api/project-results/${d2.id}/artifacts`, { kind: 'DOC', excerpt: 'e' }, token),
    d2.id,
  );

  const s1 = await h.handlers.submit(
    postJson(`http://t/api/project-results/${d1.id}/submit`, {}, token),
    d1.id,
  );
  assert.equal(s1.status, 200);

  const s2 = await h.handlers.submit(
    postJson(`http://t/api/project-results/${d2.id}/submit`, {}, token),
    d2.id,
  );
  assert.equal(s2.status, 409);
  const body = (await bodyOf(s2)) as { error: { code: string } };
  assert.equal(body.error.code, 'RESULT_DUPLICATE');

  await prisma.user.deleteMany({ where: { email: { startsWith: `pr_api_dup` } } });
});

test('删除 Draft 凭据', { skip }, async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('remove');
  const { plan, step } = await h.seedPlan(userId);
  const draft = await createDraft(h, token, plan.id, step.id);

  const addRes = await h.handlers.addArtifact(
    postJson(`http://t/api/project-results/${draft.id}/artifacts`, { kind: 'DOC', excerpt: 'e' }, token),
    draft.id,
  );
  const addBody = await bodyOf(addRes);
  const artifactId = (addBody.data as { id: string }).id;

  const delRes = await h.handlers.removeArtifact(
    deleteJson(`http://t/api/project-results/${draft.id}/artifacts/${artifactId}`, token),
    draft.id,
    artifactId,
  );
  assert.equal(delRes.status, 200);

  await prisma.user.deleteMany({ where: { email: { startsWith: `pr_api_remove` } } });
});
