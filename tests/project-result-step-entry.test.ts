/**
 * T3-A2-4 · Phase 0 —— ActionStep → ProjectResult UI 闭环（真实 PostgreSQL，**禁止静默 skip**）
 *
 * 覆盖授权书 §六 的 10 项：
 *   1 从 ActionPlan Step 打开提交成果入口（源码守卫）
 *   2 sourceStepId 正确传递
 *   3 ProjectResult 创建成功
 *   4 Artifact 添加成功
 *   5 Submit 成功
 *   6 ownership 不能绕过
 *   7 不允许 DONE 自动生成 ProjectResult
 *   8 既有 ProjectResult API 行为保持
 *   9 既有 Capability 回流链路保持
 *   10 既有 Confirm 唯一路径保持
 *
 * 另含 §四/§五 的授权边界守卫（准入类型、零新增 API、零 useEffect、空态文案一致性）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { createUpdateActionStepHandler } from '../src/http/handlers/action-plans.ts';
import { systemClock } from '../src/ports/index.ts';
import { FakeValidProvider } from '../src/llm/fake-providers.ts';
import {
  createCreateProjectResultHandler,
  createAddProjectResultArtifactHandler,
  createSubmitProjectResultHandler,
  createGetProjectResultHandler,
  createDeclareProjectEvidenceHandler,
} from '../src/http/handlers/project-results.ts';
import { createConfirmCapabilityHandler } from '../src/http/handlers/capabilities.ts';
import {
  ARTIFACT_KINDS,
  RESULT_ENTRY_KINDS,
  buildArtifactBody,
  buildCreateResultBody,
  buildResultTitlePrefill,
  canSubmitResultForKind,
  canSubmitResultForTitle,
  validateResultDraftInput,
} from '../app/_lib/step-result-entry.ts';
import { bodyOf, extractSessionToken, getJson, postJson } from './fakes.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
/**
 * 源码守卫必须剔除注释：禁止项/说明性词汇常写在注释里，
 * 裸正则命中注释会造成假失败（本项目已多次踩到）。
 */
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** §十一：关键 DB 测试禁止 skip —— DB 不可达时本文件必须失败 */
test('前置：数据库必须可达（A2-4 Phase 0 禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

const auth = createAuthService({
  users: repos.users, sessions: repos.sessions,
  failures: createInMemoryFailureLimiter(systemClock), clock: systemClock,
});

const deps = {
  auth,
  actionPlans: repos.actionPlans,
  projectResults: repos.projectResults,
  capabilities: repos.capabilities,
  clock: systemClock,
};
const capDeps = { auth, capabilities: repos.capabilities };
const planDeps = {
  auth,
  provider: new FakeValidProvider({}),
  matchRepo: repos.matches,
  capabilities: repos.capabilities,
  jdRepo: repos.jds,
  actionPlans: repos.actionPlans,
  usage: repos.llmUsage,
  clock: systemClock,
};

const register = createRegisterHandler({ auth, secureCookies: false });
const handlers = {
  create: createCreateProjectResultHandler(deps),
  addArtifact: createAddProjectResultArtifactHandler(deps),
  submit: createSubmitProjectResultHandler(deps),
  get: createGetProjectResultHandler(deps),
  declare: createDeclareProjectEvidenceHandler(deps),
  confirm: createConfirmCapabilityHandler(capDeps),
  updateStep: createUpdateActionStepHandler(planDeps),
};

let seq = 0;
async function signUp(tag: string) {
  seq += 1;
  const res = await register(postJson('http://t/api/auth/register', {
    email: `a24p0_${tag}_${seq}_${stamp}@example.com`, password: 'password-1234',
  }));
  const token = extractSessionToken(res);
  assert.ok(token, '注册应下发会话 token');
  const body = (await bodyOf(res)) as { data: { user: { id: string } } };
  return { userId: body.data.user.id, token: token as string };
}

/** 造一个带指定步骤标题的 ActionPlan（标题含类型前缀，与 3A 的服务端折叠规则一致） */
async function seedPlan(userId: string, stepTitles: string[]) {
  const resume = await prisma.resume.create({ data: { userId, rawText: '技能：Python', sourceType: 'TEXT' } });
  const jd = await prisma.jobDescription.create({ data: { userId, rawText: 'JD', title: '岗位' } });
  const matchRun = await prisma.matchRun.create({
    data: {
      userId, resumeId: resume.id, jdId: jd.id, matcherVersion: 'v1', summary: {},
      items: { create: [{ reqText: 'r', status: 'MISSING', category: 'TECH', criticality: 'MUST', reason: 'r', basisType: 'INFERENCE', basisDetail: 'd' }] },
    },
  });
  const plan = await repos.actionPlans.createPlanWithSteps({
    userId, matchRunId: matchRun.id, jdId: jd.id, goal: 'AI 应用工程师', have: [], gaps: [],
    steps: stepTitles.map((t, i) => ({ order: i + 1, title: t, desc: 'd', targetRequirement: '熟悉 Kubernetes' })),
  });
  return plan;
}

const createUrl = 'http://t/api/project-results';
const patchStep = (planId: string, stepId: string, body: unknown, token: string) =>
  new Request(`http://t/api/action-plans/${planId}/steps/${stepId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: `jp_session=${token}` },
    body: JSON.stringify(body),
  });
const cleanup = (userId: string) => prisma.user.delete({ where: { id: userId } });
const resultCount = (userId: string) => prisma.projectResult.count({ where: { userId } });

/* ═══════════ 纯逻辑：准入 / 预填 / body 构造 ═══════════ */

test('[A2-4 §四] 准入范围恰为 [学习] / [项目]，不含 [实践] / 无前缀 / 未知前缀', () => {
  assert.deepEqual([...RESULT_ENTRY_KINDS], ['LEARN', 'PROJECT']);

  assert.equal(canSubmitResultForKind('LEARN'), true);
  assert.equal(canSubmitResultForKind('PROJECT'), true);
  assert.equal(canSubmitResultForKind('PRACTICE'), false, 'Phase 0 授权仅 [学习]/[项目]');
  assert.equal(canSubmitResultForKind('GENERIC'), false);

  assert.equal(canSubmitResultForTitle('[学习] 完成 K8s 课程'), true);
  assert.equal(canSubmitResultForTitle('[项目] 做一个 demo'), true);
  assert.equal(canSubmitResultForTitle('[实践] 部署一个 demo'), false);
  assert.equal(canSubmitResultForTitle('补 Kubernetes'), false);
  assert.equal(canSubmitResultForTitle('[未知] 某动作'), false);
  assert.equal(canSubmitResultForTitle(''), false);
});

test('[A2-4 §四] 成果标题预填：去类型前缀，仅前缀时退回原文', () => {
  assert.equal(buildResultTitlePrefill('[项目] 做一个 RAG 应用'), '做一个 RAG 应用');
  assert.equal(buildResultTitlePrefill('[学习]   完成 K8s 课程  '), '完成 K8s 课程');
  assert.equal(buildResultTitlePrefill('[项目]'), '[项目]', '仅前缀不得预填为空串');
  assert.equal(buildResultTitlePrefill('[实践] 部署 demo'), '部署 demo');
  assert.equal(buildResultTitlePrefill('  无前缀标题  '), '无前缀标题');
});

test('[A2-4 §四] create body 恰为 4 个键，不夹带 userId', () => {
  const body = buildCreateResultBody({ planId: ' p1 ', sourceStepId: ' s1 ', title: ' T ', summary: ' S ' });
  assert.deepEqual(Object.keys(body).sort(), ['planId', 'sourceStepId', 'summary', 'title']);
  assert.deepEqual(body, { planId: 'p1', sourceStepId: 's1', title: 'T', summary: 'S' });
  assert.equal('userId' in body, false);
});

test('[A2-4 §四] artifact body：两者皆空 → null；只带非空字段；非法 kind 降级 OTHER', () => {
  assert.equal(buildArtifactBody({ kind: 'REPO', url: '', excerpt: '   ' }), null);
  assert.equal(buildArtifactBody({ kind: 'REPO', url: null, excerpt: null }), null);

  assert.deepEqual(buildArtifactBody({ kind: 'REPO', url: ' https://x/y ', excerpt: '' }), {
    kind: 'REPO', url: 'https://x/y',
  });
  assert.deepEqual(buildArtifactBody({ kind: 'DOC', url: '', excerpt: ' 记录了步骤 ' }), {
    kind: 'DOC', excerpt: '记录了步骤',
  });
  assert.deepEqual(buildArtifactBody({ kind: '不存在的类型', url: 'https://x', excerpt: '' }), {
    kind: 'OTHER', url: 'https://x',
  });
  // kind 白名单与服务端 ArtifactBodySchema 的 enum 完全一致
  assert.deepEqual([...ARTIFACT_KINDS], ['REPO', 'DEPLOY', 'DOC', 'SCREENSHOT', 'OTHER']);
});

test('[A2-4 §四] 草稿前置校验：标题与说明必填', () => {
  assert.equal(validateResultDraftInput('', 'x').ok, false);
  assert.equal(validateResultDraftInput('   ', 'x').ok, false);
  assert.equal(validateResultDraftInput('t', '').ok, false);
  assert.equal(validateResultDraftInput('t', 's').ok, true);
});

/* ═══════════ 源码守卫：接线 / 零自动触发 / 零新增 API ═══════════ */

test('[§六.1] 从 ActionPlan Step 打开提交成果入口：页面确实渲染并传入 planId / sourceStepId / stepTitle', () => {
  const page = read('app/action-plans/[id]/page.tsx');
  assert.ok(page.includes("from '../../_components/StepResultEntry'"), '页面应导入 StepResultEntry');
  assert.ok(page.includes('<StepResultEntry'), '页面应渲染 StepResultEntry');
  assert.ok(page.includes('planId={planId}'), '应传当前 ActionPlan 的 planId');
  assert.ok(page.includes('sourceStepId={s.id}'), '应传当前 ActionStep.id');
  assert.ok(page.includes('stepTitle={s.title}'), '应传步骤标题（供准入判断与预填）');
});

test('[§六.7] StepResultEntry 内**没有 useEffect** ⇒ 加载 / DONE 均不可能自动创建成果', () => {
  const src = code('app/_components/StepResultEntry.tsx');
  assert.equal(/useEffect/.test(src), false, '提交入口不得包含任何副作用 effect');
  assert.match(src, /onClick=\{\(\) => void run\(/, '写操作必须绑定在显式点击上');
  assert.equal(/status\s*===\s*'DONE'/.test(src), false, '入口不得以步骤状态作为触发条件');
});

test('[§四/§五] 提交入口只调用 3 个既有端点；不触碰能力/证据/确认链路', () => {
  const src = code('app/_components/StepResultEntry.tsx');
  assert.ok(src.includes("'/api/project-results'"), '应调用既有 create');
  assert.ok(src.includes('/api/project-results/${resultId}/artifacts'), '应调用既有 artifacts');
  assert.ok(src.includes('/api/project-results/${resultId}/submit'), '应调用既有 submit');

  for (const forbidden of ['/api/capabilities', '/evidence', '/confirm', '/analyze', 'CONFIRMED', 'Capability']) {
    assert.equal(src.includes(forbidden), false, `提交入口不得引用 ${forbidden}`);
  }
});

test('[§五] /projects 补齐「创建 → 凭据 → 提交」入口，且空态文案与实际行为一致', () => {
  const page = read('app/projects/page.tsx');

  // 复用既有读接口取步骤（不新增 API）
  assert.ok(page.includes("'/api/action-plans'"), '应复用既有 action-plans 列表接口');
  assert.ok(page.includes('<h2>新建成果</h2>'), '应有新建成果入口');
  assert.ok(page.includes('<StepResultEntry'), '应复用同一提交组件');
  assert.ok(page.includes('async function addArtifact()'), '应能在成果详情添加凭据');
  assert.ok(page.includes('async function submitResult()'), '应能提交成果');
  assert.ok(page.includes('/api/project-results/${detail.id}/artifacts'), '添加凭据复用既有端点');
  assert.ok(page.includes('/api/project-results/${detail.id}/submit'), '提交复用既有端点');

  // 空态文案必须与实际 UI 一致：旧文案指引用户去步骤页，但当时步骤页并无入口
  assert.equal(
    page.includes('先在行动计划的步骤里提交一个成果'),
    false,
    '旧空态文案必须修正',
  );
  assert.ok(page.includes('新建成果'), '空态文案应指向真实存在的入口');
  assert.ok(page.includes('提交成果'), '空态文案应指向步骤页真实入口');
});

test('[§九] 零新增 API：project-results / action-plans 路由清单与授权前完全一致', () => {
  const list = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (cur: string) => {
      for (const e of readdirSync(path.join(process.cwd(), cur), { withFileTypes: true })) {
        const rel = `${cur}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (e.name === 'route.ts') out.push(rel);
      }
    };
    walk(dir);
    return out.sort();
  };

  assert.deepEqual(list('app/api/project-results'), [
    'app/api/project-results/[id]/analyze/route.ts',
    'app/api/project-results/[id]/artifacts/[artifactId]/route.ts',
    'app/api/project-results/[id]/artifacts/route.ts',
    'app/api/project-results/[id]/evidence/route.ts',
    'app/api/project-results/[id]/revoke/route.ts',
    'app/api/project-results/[id]/route.ts',
    'app/api/project-results/[id]/submit/route.ts',
    'app/api/project-results/route.ts',
  ].sort());

  assert.deepEqual(list('app/api/action-plans'), [
    'app/api/action-plans/[id]/regenerate/route.ts',
    'app/api/action-plans/[id]/route.ts',
    'app/api/action-plans/[id]/steps/[stepId]/guide/route.ts', // Project V2 Phase 0 授权新增：AI 执行指导（零写入建议层）
    'app/api/action-plans/[id]/steps/[stepId]/route.ts',
    'app/api/action-plans/route.ts',
  ].sort());

  // 不得出现学习实体相关路由（T3-A2-6 已授权 learning-tasks 5 个端点；T4-2 已授权 portfolio-projects 除外）
  const apiRoot = readdirSync(path.join(process.cwd(), 'app/api'));
  for (const name of apiRoot) {
    // T5-A 已授权 `rag`（**恰好 2 个只读 endpoint**，见下方 method+path 白名单校验）
    if (name === 'learning-tasks' || name === 'portfolio-projects' || name === 'rag') continue;
    assert.equal(/learning/i.test(name), false, `不得新增学习相关路由：${name}`);
  }

  // learning-tasks 仅允许已授权的 5 个 endpoint（HTTP method + route path 白名单）。
  const routeMethods = (rel: string): string[] => {
    const code = read(rel);
    const methods: string[] = [];
    const re = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) methods.push(m[1]);
    return methods.sort();
  };
  const learningTaskEndpoints: Record<string, string[]> = {
    'app/api/learning-tasks/route.ts': ['GET', 'POST'],
    'app/api/learning-tasks/[id]/route.ts': ['GET', 'PATCH'],
    'app/api/learning-tasks/[id]/archive/route.ts': ['POST'],
  };
  assert.deepEqual(
    list('app/api/learning-tasks'),
    Object.keys(learningTaskEndpoints).sort(),
    'learning-tasks 路由文件集合必须与白名单一致（不得新增/删除 route 文件）',
  );
  for (const [rel, expectedMethods] of Object.entries(learningTaskEndpoints)) {
    assert.deepEqual(
      routeMethods(rel),
      [...expectedMethods].sort(),
      `${rel} 导出的 HTTP method 必须与白名单一致（不得新增未授权 method）`,
    );
  }

  // T4-2 已授权 portfolio-projects 5 个 route 文件 / 7 methods（method+path 白名单）。
  const portfolioEndpoints: Record<string, string[]> = {
    'app/api/portfolio-projects/route.ts': ['GET', 'POST'],
    'app/api/portfolio-projects/[id]/route.ts': ['GET', 'PATCH'],
    'app/api/portfolio-projects/[id]/archive/route.ts': ['POST'],
    'app/api/portfolio-projects/[id]/results/route.ts': ['POST'],
    'app/api/portfolio-projects/[id]/results/[resultId]/route.ts': ['DELETE'],
  };
  assert.deepEqual(
    list('app/api/portfolio-projects'),
    Object.keys(portfolioEndpoints).sort(),
    'portfolio-projects 路由文件集合必须与白名单一致（不得新增/删除 route 文件）',
  );
  for (const [rel, expectedMethods] of Object.entries(portfolioEndpoints)) {
    assert.deepEqual(
      routeMethods(rel),
      [...expectedMethods].sort(),
      `${rel} 导出的 HTTP method 必须与白名单一致（不得新增未授权 method）`,
    );
  }

  // T5-A 已授权 rag **恰好 2 个** endpoint（method+path 白名单，ADR-016 §9 T5A-F-56）。
  // 禁止第 3 个 RAG endpoint：HTTP ingest / admin / delete / update / query history / debug / agent。
  const ragEndpoints: Record<string, string[]> = {
    'app/api/rag/retrieve/route.ts': ['POST'],
    'app/api/rag/sources/route.ts': ['GET'],
  };
  assert.deepEqual(
    list('app/api/rag'),
    Object.keys(ragEndpoints).sort(),
    'rag 路由文件集合必须与白名单一致（**恰好 2 个**，不得新增/删除 route 文件）',
  );
  for (const [rel, expectedMethods] of Object.entries(ragEndpoints)) {
    assert.deepEqual(
      routeMethods(rel),
      [...expectedMethods].sort(),
      `${rel} 导出的 HTTP method 必须与白名单一致（不得新增未授权 method）`,
    );
  }
});

/* ═══════════ 真实产品闭环：Step → Draft → Artifact → Submitted ═══════════ */

test('[§六.2/3] 从步骤创建成果：sourceStepId 正确传递 + 快照完整 + 201 DRAFT', async () => {
  const u = await signUp('create');
  const plan = await seedPlan(u.userId, ['[项目] 做一个 RAG 应用']);
  const step = plan.steps[0];

  const body = buildCreateResultBody({
    planId: plan.id, sourceStepId: step.id, title: 'RAG 应用', summary: '做了检索增强问答的最小实现',
  });
  const res = await handlers.create(postJson(createUrl, body, u.token));
  assert.equal(res.status, 201);
  const created = (await bodyOf(res)) as { data: { id: string; status: string; sourceStepId: string; sourceStepTitle: string; sourceStepTargetRequirement: string | null; contentFingerprint: string | null } };

  assert.equal(created.data.status, 'DRAFT');
  assert.equal(created.data.sourceStepId, step.id, 'sourceStepId 必须逐字传递');
  assert.equal(created.data.sourceStepTitle, '[项目] 做一个 RAG 应用', '服务端快照保留原文（含前缀）');
  assert.equal(created.data.sourceStepTargetRequirement, '熟悉 Kubernetes');
  assert.equal(created.data.contentFingerprint, null, 'Draft 的 contentFingerprint 必须为 NULL（Q8）');

  // 只读接口（前端通过它进入成果详情）
  const got = await handlers.get(getJson(`http://t/api/project-results/${created.data.id}`, u.token), created.data.id);
  assert.equal(got.status, 200);
  assert.equal(((await bodyOf(got)) as { data: { id: string } }).data.id, created.data.id);

  await cleanup(u.userId);
});

test('[§六.4/5] Artifact 添加成功 → Submit 成功（DRAFT → SUBMITTED）', async () => {
  const u = await signUp('flow');
  const plan = await seedPlan(u.userId, ['[学习] 完成 K8s 课程']);
  const step = plan.steps[0];

  const created = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: plan.id, sourceStepId: step.id, title: 'K8s 学习产出', summary: '完成了课程并做了实验',
  }), u.token));
  const resultId = ((await bodyOf(created)) as { data: { id: string } }).data.id;

  const artifactBody = buildArtifactBody({ kind: 'REPO', url: 'https://example.com/a24-repo', excerpt: '' });
  assert.ok(artifactBody);
  const art = await handlers.addArtifact(postJson(`http://t/api/project-results/${resultId}/artifacts`, artifactBody, u.token), resultId);
  assert.equal(art.status, 200);
  assert.equal(((await bodyOf(art)) as { data: { url: string } }).data.url, 'https://example.com/a24-repo');

  const sub = await handlers.submit(postJson(`http://t/api/project-results/${resultId}/submit`, {}, u.token), resultId);
  assert.equal(sub.status, 200);
  assert.equal(((await bodyOf(sub)) as { data: { status: string } }).data.status, 'SUBMITTED');

  // 提交后不可再增删凭据（既有闸门保持）
  const after = await handlers.addArtifact(postJson(`http://t/api/project-results/${resultId}/artifacts`, artifactBody, u.token), resultId);
  assert.equal(after.status, 422);
  assert.equal(((await bodyOf(after)) as { error: { code: string } }).error.code, 'RESULT_NOT_EDITABLE');

  await cleanup(u.userId);
});

test('[§六.6] ownership 不能绕过：跨用户 planId / artifact / submit 一律 404，步骤不属于该计划 → 400', async () => {
  const alice = await signUp('alice');
  const bob = await signUp('bob');
  const alicePlan = await seedPlan(alice.userId, ['[项目] Alice 的项目']);
  const bobPlan = await seedPlan(bob.userId, ['[项目] Bob 的项目']);

  // 用别人的 planId 创建 → 404（且响应与「不存在计划」一致）
  const cross = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: alicePlan.id, sourceStepId: alicePlan.steps[0].id, title: 't', summary: 's',
  }), bob.token));
  assert.equal(cross.status, 404, '跨用户 planId 必须 404');

  const missing = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: 'nope_plan', sourceStepId: 'nope_step', title: 't', summary: 's',
  }), bob.token));
  assert.equal(missing.status, 404);
  assert.equal(
    JSON.stringify((await bodyOf(cross)) as object).replace(/"requestId":"[^"]*"/g, ''),
    JSON.stringify((await bodyOf(missing)) as object).replace(/"requestId":"[^"]*"/g, ''),
    '跨用户与不存在计划的 404 语义必须一致（无 existence oracle）',
  );

  // 步骤不属于该计划 → 400 VALIDATION_FAILED（服务端归属校验）
  const foreignStep = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: alicePlan.id, sourceStepId: bobPlan.steps[0].id, title: 't', summary: 's',
  }), alice.token));
  assert.equal(foreignStep.status, 400);
  assert.equal(((await bodyOf(foreignStep)) as { error: { code: string } }).error.code, 'VALIDATION_FAILED');

  // 跨用户 result：加凭据 / 提交 / 读取 一律 404
  const aliceResult = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: alicePlan.id, sourceStepId: alicePlan.steps[0].id, title: 't', summary: 's',
  }), alice.token));
  const rid = ((await bodyOf(aliceResult)) as { data: { id: string } }).data.id;

  const bobArt = await handlers.addArtifact(postJson(`http://t/api/project-results/${rid}/artifacts`, { kind: 'REPO', url: 'https://example.com/x' }, bob.token), rid);
  assert.equal(bobArt.status, 404);
  const bobSub = await handlers.submit(postJson(`http://t/api/project-results/${rid}/submit`, {}, bob.token), rid);
  assert.equal(bobSub.status, 404);
  const bobGet = await handlers.get(getJson(`http://t/api/project-results/${rid}`, bob.token), rid);
  assert.equal(bobGet.status, 404);

  assert.equal(await prisma.resultArtifact.count({ where: { resultId: rid } }), 0, '跨用户不得产生任何凭据');

  await cleanup(alice.userId);
  await cleanup(bob.userId);
});

test('[§六.7] ActionStep 置为 DONE **不会**自动创建 ProjectResult', async () => {
  const u = await signUp('done');
  const plan = await seedPlan(u.userId, ['[项目] 待完成的项目']);
  const step = plan.steps[0];

  const before = await resultCount(u.userId);
  assert.equal(before, 0);

  const patched = await handlers.updateStep(patchStep(plan.id, step.id, { status: 'DONE' }, u.token), plan.id, step.id);
  assert.equal(patched.status, 200, 'PATCH 步骤应成功');
  assert.equal(((await bodyOf(patched)) as { data: { status: string } }).data.status, 'DONE', '步骤状态确实已变为 DONE');

  assert.equal(await resultCount(u.userId), 0, 'DONE 不得自动生成任何 ProjectResult');

  // 只有用户显式创建才会产生成果
  const created = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: plan.id, sourceStepId: step.id, title: 't', summary: 's',
  }), u.token));
  assert.equal(created.status, 201);
  assert.equal(await resultCount(u.userId), 1);

  await cleanup(u.userId);
});

/* ═══════════ 既有行为保持 ═══════════ */

test('[§六.8] 既有 ProjectResult API 行为保持（strict body / 凭据闸门 / 提交闸门 / 幂等）', async () => {
  const u = await signUp('legacy');
  const plan = await seedPlan(u.userId, ['[项目] 兼容性检查']);
  const step = plan.steps[0];
  const base = { planId: plan.id, sourceStepId: step.id, title: 't', summary: 's' };

  // body 含 userId → 400（strict schema）
  const withUserId = await handlers.create(postJson(createUrl, { ...base, userId: u.userId }, u.token));
  assert.equal(withUserId.status, 400);

  // 未登录 → 401
  const anon = await handlers.create(postJson(createUrl, base, null));
  assert.equal(anon.status, 401);

  // 缺少 summary → 400
  const noSummary = await handlers.create(postJson(createUrl, { planId: plan.id, sourceStepId: step.id, title: 't' }, u.token));
  assert.equal(noSummary.status, 400);

  const created = await handlers.create(postJson(createUrl, base, u.token));
  const rid = ((await bodyOf(created)) as { data: { id: string } }).data.id;

  // 凭据既无 url 又无 excerpt → 400
  const emptyArt = await handlers.addArtifact(postJson(`http://t/api/project-results/${rid}/artifacts`, { kind: 'REPO' }, u.token), rid);
  assert.equal(emptyArt.status, 400);

  // 无凭据提交 → 422 RESULT_HAS_NO_ARTIFACT
  const earlySubmit = await handlers.submit(postJson(`http://t/api/project-results/${rid}/submit`, {}, u.token), rid);
  assert.equal(earlySubmit.status, 422);
  assert.equal(((await bodyOf(earlySubmit)) as { error: { code: string } }).error.code, 'RESULT_HAS_NO_ARTIFACT');

  // 重复凭据（同 dedupeKey）→ 200 幂等，不新增行
  const artBody = { kind: 'REPO', url: 'https://example.com/same-repo' };
  const a1 = await handlers.addArtifact(postJson(`http://t/api/project-results/${rid}/artifacts`, artBody, u.token), rid);
  const a2 = await handlers.addArtifact(postJson(`http://t/api/project-results/${rid}/artifacts`, artBody, u.token), rid);
  assert.equal(a1.status, 200);
  assert.equal(a2.status, 200);
  assert.equal(await prisma.resultArtifact.count({ where: { resultId: rid } }), 1, '重复凭据必须幂等');

  await cleanup(u.userId);
});

test('[§六.9/10] 既有回流链路与唯一确认入口保持：declare → UNCONFIRMED → confirm → CONFIRMED', async () => {
  const u = await signUp('loop');
  const plan = await seedPlan(u.userId, ['[项目] 回流链路检查']);
  const step = plan.steps[0];

  const created = await handlers.create(postJson(createUrl, buildCreateResultBody({
    planId: plan.id, sourceStepId: step.id, title: '回流成果', summary: '有可核验凭据',
  }), u.token));
  const rid = ((await bodyOf(created)) as { data: { id: string } }).data.id;
  const art = await handlers.addArtifact(postJson(`http://t/api/project-results/${rid}/artifacts`, { kind: 'REPO', url: 'https://example.com/loop-repo' }, u.token), rid);
  const aid = ((await bodyOf(art)) as { data: { id: string } }).data.id;
  await handlers.submit(postJson(`http://t/api/project-results/${rid}/submit`, {}, u.token), rid);

  const decl = await handlers.declare(postJson(`http://t/api/project-results/${rid}/evidence`, { artifactId: aid, key: 'Docker', label: 'Docker 容器化' }, u.token), rid);
  assert.equal(decl.status, 201);
  const declBody = (await bodyOf(decl)) as { data: { capability: { id: string; status: string; source: string } } };
  assert.equal(declBody.data.capability.status, 'UNCONFIRMED');
  assert.equal(declBody.data.capability.source, 'PROJECT_RESULT');

  // A2-3 的 key 契约仍然生效（大写归一为 canonical）
  const cap = await prisma.capability.findUniqueOrThrow({ where: { id: declBody.data.capability.id } });
  assert.equal(cap.key, 'docker');

  const conf = await handlers.confirm(postJson('http://t/api/capabilities', { confirmed: true }, u.token), cap.id);
  assert.equal(conf.status, 200);
  assert.equal((await prisma.capability.findUniqueOrThrow({ where: { id: cap.id } })).status, 'CONFIRMED');

  await cleanup(u.userId);
});

test('[§六.10] 源码守卫：CONFIRMED 写入点仍唯一且在 confirm 内（A2-4 未新增第二条确认路径）', () => {
  const src = readFileSync(path.join(process.cwd(), 'src/db/repositories.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const writes = [...src.matchAll(/capability\.update(?:Many)?\(\{[\s\S]{0,240}?status: 'CONFIRMED'/g)];
  assert.equal(writes.length, 1, `CONFIRMED 写入点必须唯一，实际 ${writes.length}`);

  // 前端页面同样不得直接写 CONFIRMED
  for (const rel of ['app/projects/page.tsx', 'app/action-plans/[id]/page.tsx', 'app/_components/StepResultEntry.tsx']) {
    const page = read(rel);
    assert.equal(/status:\s*'CONFIRMED'/.test(page), false, `${rel} 不得直接写 CONFIRMED`);
    assert.equal(/\/api\/capabilities\/[^`'"]*\/confirm/.test(page) && rel !== 'app/projects/page.tsx', false, `${rel} 不得新增 confirm 调用`);
  }
});
