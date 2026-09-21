/**
 * T3-A2-4 Phase 2 —— regenerate 后 `sourceStepId` 悬空回归
 *
 * **本 Phase 是验证型 Phase：零生产代码改动。** 目标不是「修复悬空 sourceStepId」，
 * 而是证明当前架构**允许** ProjectResult 继续保存旧 Step 的 value snapshot，
 * 且 ActionPlan regenerate 不会造成数据库级 FK 冲突或级联删除。
 *
 * 真实实现（已读码确认，本测试不修改）：
 *   - regenerate → `actionPlans.replacePlanContent`（`repositories.ts`）：
 *       ① `tx.actionStep.deleteMany({ where: { planId } })`  ← 旧 Step 全删
 *       ② `tx.actionPlan.update(...)`
 *       ③ `tx.actionStep.createMany(...)`                    ← 新 Step，**新 cuid**
 *   - `ProjectResult.sourceStepId` 是 `String`，**无 relation**（value reference，非 FK）
 *   - `ProjectResult.planId` 才是 FK（→ ActionPlan，`onDelete: Restrict`）
 *
 * 覆盖 §五 R1–R8（R8 仅记录不修、不加锁定性断言）。
 * **禁止 skip**：DB 不可达必须 FAIL（§六）。
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
import { createCreateActionPlanHandler, createRegenerateActionPlanHandler } from '../src/http/handlers/action-plans.ts';
import { systemClock } from '../src/ports/index.ts';
import { FakeValidProvider } from '../src/llm/fake-providers.ts';
import {
  createCreateProjectResultHandler,
  createAddProjectResultArtifactHandler,
  createGetProjectResultHandler,
} from '../src/http/handlers/project-results.ts';
import { bodyOf, extractSessionToken, postJson } from './fakes.ts';

process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '50';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');

test('前置：数据库必须可达（A2-4 Phase 2 禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

const auth = createAuthService({
  users: repos.users, sessions: repos.sessions,
  failures: createInMemoryFailureLimiter(systemClock), clock: systemClock,
});
const register = createRegisterHandler({ auth, secureCookies: false });

function planDeps(payload: unknown) {
  return {
    auth,
    provider: new FakeValidProvider(payload),
    matchRepo: repos.matches,
    capabilities: repos.capabilities,
    jdRepo: repos.jds,
    actionPlans: repos.actionPlans,
    usage: repos.llmUsage,
    clock: systemClock,
  };
}
const resultDeps = {
  auth,
  actionPlans: repos.actionPlans,
  projectResults: repos.projectResults,
  capabilities: repos.capabilities,
  clock: systemClock,
};

let seq = 0;
async function signUp(tag: string) {
  seq += 1;
  const res = await register(postJson('http://t/api/auth/register', {
    email: `a24p2_${tag}_${seq}_${stamp}@example.com`, password: 'password-1234',
  }));
  const token = extractSessionToken(res);
  assert.ok(token, '注册应下发会话 token');
  const body = (await bodyOf(res)) as { data: { user: { id: string } } };
  return { userId: body.data.user.id, token: token as string };
}

async function seedRun(userId: string) {
  const resume = await prisma.resume.create({ data: { userId, rawText: '技能：Python', sourceType: 'TEXT' } });
  const jd = await prisma.jobDescription.create({ data: { userId, rawText: 'JD', title: 'AI 应用工程师' } });
  const run = await prisma.matchRun.create({
    data: {
      userId, resumeId: resume.id, jdId: jd.id, matcherVersion: 'v1', summary: {},
      items: { create: [{ reqText: '熟悉 Kubernetes', status: 'MISSING', category: 'TECH', criticality: 'MUST', reason: 'r', basisType: 'INFERENCE', basisDetail: 'd' }] },
    },
  });
  return run.id;
}

const cleanup = (userId: string) => prisma.user.delete({ where: { id: userId } });

/** 一次完整生命周期的公共装配：建计划（2 步）→ 旧 Step 建成果 → regenerate → 复核 */
async function runLifecycle(tag: string) {
  const u = await signUp(tag);
  const runId = await seedRun(u.userId);

  // ── Step A：创建 ActionPlan（≥2 个 ActionStep） ──
  const createPlan = createCreateActionPlanHandler(planDeps({
    have: [], gaps: [],
    actions: [
      { title: '完成 K8s 课程', desc: 'd', type: 'LEARN', targetRequirement: '熟悉 Kubernetes' },
      { title: '做一个 demo', desc: 'd', type: 'PROJECT', targetRequirement: '熟悉 RAG' },
    ],
  }));
  const created = await createPlan(postJson('http://t/api/action-plans', { matchRunId: runId }, u.token));
  assert.equal(created.status, 201, '创建计划应 201');
  // 响应体只能读取一次（本项目已知约束）
  const createdPlan = (await bodyOf(created)) as {
    data: { id: string; actions: Array<{ id: string; title: string; targetRequirement: string | null }> };
  };
  const planId = createdPlan.data.id;

  const stepsBefore = createdPlan.data.actions;
  assert.equal(stepsBefore.length, 2, '应生成 2 个 ActionStep');
  const oldStep = stepsBefore[0];
  const oldStepId = oldStep.id;
  const oldStepTitle = oldStep.title;
  const oldStepTargetRequirement = oldStep.targetRequirement;
  assert.ok(oldStepId.length > 0 && oldStepTitle.length > 0);

  // ── Step B：基于旧 Step 通过**真实 ProjectResult 链路**创建成果 ──
  const createResult = createCreateProjectResultHandler(resultDeps);
  const addArtifact = createAddProjectResultArtifactHandler(resultDeps);
  const getResult = createGetProjectResultHandler(resultDeps);

  const madeResult = await createResult(postJson('http://t/api/project-results', {
    planId, sourceStepId: oldStepId, title: 'K8s 成果', summary: '完成课程并做了实验',
  }, u.token));
  assert.equal(madeResult.status, 201, '创建成果应 201');
  const createdBody = (await bodyOf(madeResult)) as {
    data: { id: string; sourceStepId: string; sourceStepTitle: string; sourceStepTargetRequirement: string | null; contentFingerprint: string | null };
  };
  const resultId = createdBody.data.id;

  assert.equal(createdBody.data.sourceStepId, oldStepId, 'B1: sourceStepId 必须等于旧 Step id');
  assert.equal(createdBody.data.sourceStepTitle, oldStepTitle, 'B2: snapshot title 必须等于旧 Step title');
  assert.equal(createdBody.data.sourceStepTargetRequirement, oldStepTargetRequirement, 'B3: snapshot targetRequirement 一致');

  const art = await addArtifact(postJson(`http://t/api/project-results/${resultId}/artifacts`, {
    kind: 'REPO', url: 'https://example.com/a24p2',
  }, u.token), resultId);
  assert.equal(art.status, 200, '添加凭据应 200');

  // 记录 regenerate 前的库内快照（用于 §四-E「不受破坏」逐字段比对）
  const beforeDb = await prisma.projectResult.findUniqueOrThrow({ where: { id: resultId } });
  const resultCountBefore = await prisma.projectResult.count({ where: { userId: u.userId } });

  // ── Step C：执行**真实 regenerate 路径** ──
  const regen = createRegenerateActionPlanHandler(planDeps({
    have: [], gaps: [],
    actions: [
      { title: '重新生成的步骤一', desc: 'd2', type: 'PRACTICE', targetRequirement: '熟悉 Kubernetes' },
      { title: '重新生成的步骤二', desc: 'd2', type: 'LEARN', targetRequirement: '熟悉 RAG' },
      { title: '重新生成的步骤三', desc: 'd2', type: 'PROJECT' },
    ],
  }));
  const regened = await regen(postJson(`http://t/api/action-plans/${planId}/regenerate`, {}, u.token), planId);
  assert.equal(regened.status, 200, 'regenerate 应 200');
  const stepsAfter = ((await bodyOf(regened)) as { data: { actions: Array<{ id: string; title: string; targetRequirement: string | null }> } }).data.actions;
  assert.equal(stepsAfter.length, 3, 'regenerate 后应是新的 3 个步骤');

  // ── Step D：旧 Step 消失 + 新 ID 不同 ──
  const newIds = stepsAfter.map((s) => s.id);
  const oldIds = stepsBefore.map((s) => s.id);

  const oldRow = await prisma.actionStep.findUnique({ where: { id: oldStepId } });
  const dbSteps = await prisma.actionStep.findMany({ where: { planId }, select: { id: true } });
  const dbIds = dbSteps.map((s) => s.id);

  return {
    u, planId, oldStepId, oldStepTitle, oldStepTargetRequirement, oldIds,
    resultId, beforeDb, resultCountBefore, stepsAfter, newIds, dbIds, oldRow, getResult,
  };
}

/* ═══════════ 主回归：完整生命周期 ═══════════ */

test('[R1-R7] regenerate 全生命周期：旧 Step 消失、ProjectResult 与 value snapshot 完整保留', async () => {
  const s = await runLifecycle('lifecycle');

  // R1：旧 Step ID 在 regenerate 后不存在（接口层 + 数据库层双重确认）
  assert.equal(s.dbIds.includes(s.oldStepId), false, 'R1: 旧 Step ID 不得出现在该 plan 的 Step 集合中');
  assert.equal(s.oldRow, null, 'R1: 旧 Step 行应已被删除');
  assert.equal(s.newIds.includes(s.oldStepId), false, 'R1: 接口返回的新步骤集合亦不含旧 ID');

  // R6：新旧 Step ID 完全不同（集合不相交）
  for (const id of s.oldIds) {
    assert.equal(s.newIds.includes(id), false, `R6: 新 Step ID 不得复用旧 ID（${id}）`);
  }
  assert.deepEqual(s.oldIds.filter((id) => s.newIds.includes(id)), [], 'R6: 新旧 ID 集合必须不相交');

  // R2：ProjectResult 仍存在，且总数未因 Step 删除而减少
  const afterDb = await prisma.projectResult.findUnique({ where: { id: s.resultId } });
  assert.ok(afterDb, 'R2: ProjectResult 不得因旧 ActionStep 被删除而被删除');
  assert.equal(await prisma.projectResult.count({ where: { userId: s.u.userId } }), s.resultCountBefore, 'R2: ProjectResult 总数不变');

  // R3：sourceStepId 仍指向**旧** ID
  assert.equal(afterDb!.sourceStepId, s.oldStepId, 'R3: sourceStepId 必须仍为旧 Step ID');
  assert.equal(afterDb!.sourceStepId, s.beforeDb.sourceStepId, 'R3: 与 regenerate 前一致');

  // R4/R5：snapshot 字段逐字不变
  assert.equal(afterDb!.sourceStepTitle, s.oldStepTitle, 'R4: snapshot title 不得变化');
  assert.equal(afterDb!.sourceStepTitle, s.beforeDb.sourceStepTitle, 'R4: 与 regenerate 前一致');
  assert.equal(afterDb!.sourceStepTargetRequirement, s.oldStepTargetRequirement, 'R5: snapshot targetRequirement 不得变化');
  assert.equal(afterDb!.sourceStepTargetRequirement, s.beforeDb.sourceStepTargetRequirement, 'R5: 与 regenerate 前一致');

  // 其余成果字段亦不受影响（生命周期 / 指纹 / 归属）
  assert.equal(afterDb!.contentFingerprint, s.beforeDb.contentFingerprint, 'contentFingerprint 不变');
  assert.equal(afterDb!.planId, s.beforeDb.planId, 'planId 不变');
  assert.equal(afterDb!.title, s.beforeDb.title);
  assert.equal(afterDb!.summary, s.beforeDb.summary);
  assert.equal(afterDb!.submittedAt, s.beforeDb.submittedAt);
  assert.equal(afterDb!.revokedAt, s.beforeDb.revokedAt);
  assert.equal(afterDb!.createdAt.getTime(), s.beforeDb.createdAt.getTime());
  // 成果凭据同样不受影响
  assert.equal(await prisma.resultArtifact.count({ where: { resultId: s.resultId } }), 1, '凭据不得被删除');

  // 通过真实只读接口复核（前端读到的就是这些字段）
  const got = await s.getResult(
    new Request(`http://t/api/project-results/${s.resultId}`, { headers: { cookie: `jp_session=${s.u.token}` } }),
    s.resultId,
  );
  assert.equal(got.status, 200, 'regenerate 后仍应能读取该成果');
  const gotBody = (await bodyOf(got)) as { data: { sourceStepId: string; sourceStepTitle: string; sourceStepTargetRequirement: string | null } };
  assert.equal(gotBody.data.sourceStepId, s.oldStepId);
  assert.equal(gotBody.data.sourceStepTitle, s.oldStepTitle);
  assert.equal(gotBody.data.sourceStepTargetRequirement, s.oldStepTargetRequirement);

  await cleanup(s.u.userId);
});

test('[R1/边界] 旧 Step 已不存在 → 无法再被 PATCH（删除是真实的，不是软删除）', async () => {
  const s = await runLifecycle('gone');

  // 用**正确的** planId 路径 + 已消失的 stepId：服务端应 404（不锁 R8 行为）
  const { createUpdateActionStepHandler } = await import('../src/http/handlers/action-plans.ts');
  const patch = createUpdateActionStepHandler(planDeps({ have: [], gaps: [], actions: [{ title: 'x', desc: 'd' }] }));
  const res = await patch(
    new Request(`http://t/api/action-plans/${s.planId}/steps/${s.oldStepId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: `jp_session=${s.u.token}` },
      body: JSON.stringify({ status: 'DONE' }),
    }),
    s.planId,
    s.oldStepId,
  );
  assert.equal(res.status, 404, '旧 Step 应已不存在 → PATCH 404');

  await cleanup(s.u.userId);
});

/* ═══════════ §四-F / R7：结构级证明「sourceStepId 不是 FK」 ═══════════ */

test('[R7] 数据库结构：ProjectResult.sourceStepId 无任何 FK（对照：planId 是 Restrict FK）', async () => {
  const fkOn = async (table: string, column: string) => {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f'
        AND t.relname = ${table}
        AND a.attname = ${column}
    `;
    return Number(rows[0].n);
  };

  // R7：不存在 ActionStep → ProjectResult 方向的 FK
  assert.equal(await fkOn('ProjectResult', 'sourceStepId'), 0, 'R7: sourceStepId 不得是 FK（必须保持 value reference）');

  // 对照（证明该查询确实能发现 FK，避免「假阴性」）
  assert.equal(await fkOn('ProjectResult', 'planId'), 1, '对照：planId 确实是 FK');
  assert.equal(await fkOn('CapabilityEvidence', 'resultArtifactId'), 1, '对照：Evidence→Artifact 确实是 FK');

  // planId FK 的删除语义仍是 Restrict（不得变成级联删除）
  const del = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
    SELECT c.confdeltype::text AS confdeltype
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND t.relname = 'ProjectResult' AND a.attname = 'planId'
  `;
  assert.equal(del[0].confdeltype, 'r', 'planId FK 必须仍是 Restrict（r），不得为 Cascade（c）');

  // schema 文本层面同样确认：ProjectResult 模型不引用 ActionStep
  const schema = read('prisma/schema.prisma');
  const block = schema.slice(schema.indexOf('model ProjectResult'), schema.indexOf('model ResultArtifact'));
  assert.ok(block.includes('sourceStepId                String'), 'sourceStepId 仍是普通 String 列');
  assert.equal(/ActionStep/.test(block), false, 'ProjectResult 模型不得引用 ActionStep（不新增 FK）');
  assert.ok(/plan\s+ActionPlan\s+@relation\([^)]*onDelete:\s*Restrict/.test(block), 'planId 关系仍是 Restrict');
});

/* ═══════════ §七 结构核验：零新增（entity / API / migration） ═══════════ */

test('[§七] 零新增：migration 仍 19（T6-4-A 授权 #17 + 2026-09-20 授权 #18 头像 + 2026-09-21 授权 #19 用户 LLM API Key）、无未授权 Entity、无未授权 API 路由（T6-4-A 授权 agent 6 路由）', () => {
  const migs = readdirSync(path.join(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory());
  assert.equal(migs.length, 19, `migration 必须仍为 19（#18 头像列 + #19 用户 LLM API Key），实际 ${migs.length}`);

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

  const apiRoot = readdirSync(path.join(process.cwd(), 'app/api'));
  for (const name of apiRoot) {
    // T3-A2-6 已授权 learning-tasks；T4-2 已授权 portfolio-projects；T4-5 已授权 interview-sessions（见下方 method+path 白名单）；
    // T5-A 已授权 rag（**恰好 2 个只读 endpoint**，见下方 method+path 白名单）；其余仍禁止
    if (
      name === 'learning-tasks' ||
      name === 'portfolio-projects' ||
      name === 'interview-sessions' ||
      name === 'rag' ||
      name === 'agent' // T6-4-A 授权：agent 目录扩至 6 路由（见 agent-guards 白名单）
    )
      continue;
    assert.equal(/learning|technical|mentor|portfolio|interview/i.test(name), false, `不得新增相关路由：${name}`);
  }

  // learning-tasks 仅允许已授权的 5 个 endpoint（HTTP method + route path 白名单）。
  // 不能只枚举 route 文件：GET 与 PATCH 共享 [id]/route.ts，必须解析导出的 HTTP method。
  const routeMethods = (rel: string): string[] => {
    const code = read(rel);
    const methods: string[] = [];
    const re = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) methods.push(m[1]);
    return methods.sort();
  };

  // 5 个已授权 endpoint 的 method+path 白名单（T3-A2-6 Phase 3 授权 GET /:id）
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

  // T4-5 已授权 interview-sessions 5 个 route 文件 / 6 methods（method+path 白名单）。
  const interviewEndpoints: Record<string, string[]> = {
    'app/api/interview-sessions/route.ts': ['GET', 'POST'],
    'app/api/interview-sessions/[id]/route.ts': ['GET'],
    'app/api/interview-sessions/[id]/end/route.ts': ['POST'],
    'app/api/interview-sessions/[id]/turns/route.ts': ['POST'],
    'app/api/interview-sessions/[id]/turns/[turnId]/route.ts': ['PATCH'],
  };
  assert.deepEqual(
    list('app/api/interview-sessions'),
    Object.keys(interviewEndpoints).sort(),
    'interview-sessions 路由文件集合必须与白名单一致（不得新增/删除 route 文件）',
  );
  for (const [rel, expectedMethods] of Object.entries(interviewEndpoints)) {
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

  // 无新 Entity：schema 中 ActionStep 仍无 type/kind 列
  const schema = read('prisma/schema.prisma');
  const stepBlock = schema.slice(schema.indexOf('model ActionStep'), schema.indexOf('model LlmUsage'));
  assert.equal(/^\s*(type|kind)\s+\w/m.test(stepBlock), false, 'ActionStep 不得新增 type/kind 字段');
});

test('[§八] R8 仅记录不修：源码事实（路径 planId 未参与查询）', () => {
  // 仅断言「现状事实」，**不锁定** R8 行为、不做任何修复
  const handler = read('src/http/handlers/action-plans.ts');
  const repo = read('src/db/repositories.ts');
  assert.ok(
    /async function PATCH\(request: Request, _id: string, stepId: string\)/.test(handler),
    'FACT: PATCH handler 的路径 planId 形参为 `_id`（未使用）',
  );
  assert.ok(
    /async updateStepStatus\(stepId: string, userId: string, status: string\)/.test(repo),
    'FACT: updateStepStatus 仅按 stepId + 归属用户查询',
  );
  // 归属校验仍然存在（因此不是越权漏洞，只是路径契约未参与查询）
  assert.ok(/step\.plan\.userId !== userId/.test(repo), 'FACT: 归属校验仍通过 step.plan.userId 完成');
});
