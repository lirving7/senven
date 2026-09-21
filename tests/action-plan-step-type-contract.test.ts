/**
 * T3-A2-4 Phase 1 —— ActionStep 类型前缀契约（**精确前缀**，禁止 weak `includes`）
 *
 * 覆盖授权书 §七 验收标准：
 *   1 合法 LEARN    → `[学习] xxx`
 *   2 合法 PRACTICE → `[实践] xxx`
 *   3 合法 PROJECT  → `[项目] xxx`
 *   4 前端 parseStepKind 精确识别三种前缀
 *   5 不再以 `includes('学习')` 作为类型契约测试
 *   6 type 缺失 / 非法**不会**被错误宣称为合法类型
 *   7 schema 无变化
 *   8 migration 仍为 9
 *   9 A2-2 / A2-3 未变化
 *  10 Phase 0 已验收功能保持通过（见 project-result-step-entry.test.ts 与本文件 §D）
 *
 * 并含「服务端产出 ↔ 前端解析」跨层一致性证明（§七.4 的关键）。
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
import { createCreateActionPlanHandler } from '../src/http/handlers/action-plans.ts';
import { systemClock } from '../src/ports/index.ts';
import { FakeValidProvider } from '../src/llm/fake-providers.ts';
import {
  STEP_TYPE_BRACKET,
  STEP_TYPE_LABEL,
  STEP_TYPE_PREFIX,
  STEP_TYPES,
  applyStepTypePrefix,
  isStepType,
  resolveStepTypePrefix,
  type StepType,
} from '../src/domain/action-plan/step-type.ts';
import { parseStepKind, STEP_KIND_LABEL } from '../app/_lib/step-entry.ts';
import { bodyOf, extractSessionToken, postJson } from './fakes.ts';

process.env.LLM_QUOTA_ACTION_PLAN_PER_DAY = '50';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
const code = (rel: string) =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('前置：数据库必须可达（A2-4 Phase 1 禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

/* ═══════════ A. 契约模块本身（纯函数） ═══════════ */

test('[§七.1-3] 契约常量：三种类型与标签、精确前缀（含尾随空格）逐字一致', () => {
  assert.deepEqual([...STEP_TYPES], ['LEARN', 'PRACTICE', 'PROJECT']);
  assert.deepEqual(
    { ...STEP_TYPE_LABEL },
    { LEARN: '学习', PRACTICE: '实践', PROJECT: '项目' },
  );

  // 精确前缀：**必须含一个尾随空格**（服务端折叠格式 `[${label}] ${title}`）
  assert.equal(STEP_TYPE_PREFIX.LEARN, '[学习] ');
  assert.equal(STEP_TYPE_PREFIX.PRACTICE, '[实践] ');
  assert.equal(STEP_TYPE_PREFIX.PROJECT, '[项目] ');

  // 解析用括号形式无尾随空格，且与精确前缀关系可核验
  assert.equal(STEP_TYPE_BRACKET.LEARN, '[学习]');
  assert.equal(STEP_TYPE_BRACKET.PRACTICE, '[实践]');
  assert.equal(STEP_TYPE_BRACKET.PROJECT, '[项目]');
  for (const t of STEP_TYPES) {
    assert.equal(STEP_TYPE_PREFIX[t], `${STEP_TYPE_BRACKET[t]} `, `${t}: 精确前缀 = 括号形式 + 单空格`);
  }
});

test('[§七.6] isStepType 严格：仅三个合法常量，大小写敏感', () => {
  for (const t of STEP_TYPES) assert.equal(isStepType(t), true, `${t} 应合法`);

  for (const bad of ['learn', 'Learn', 'FOO', 'LEARNX', '[学习]', '学习', '', ' ', '  LEARN', 'LEARN ']) {
    assert.equal(isStepType(bad), false, `${JSON.stringify(bad)} 不得被判为合法类型`);
  }
  for (const bad of [undefined, null, 0, 1, {}, [], true]) {
    assert.equal(isStepType(bad), false, `${String(bad)} 不得被判为合法类型`);
  }
});

test('[§七.1-3] resolveStepTypePrefix：合法三种 → 精确前缀；大小写不敏感', () => {
  assert.equal(resolveStepTypePrefix('LEARN'), '[学习] ');
  assert.equal(resolveStepTypePrefix('PRACTICE'), '[实践] ');
  assert.equal(resolveStepTypePrefix('PROJECT'), '[项目] ');

  // 大小写不敏感（沿用既有 toUpperCase）
  assert.equal(resolveStepTypePrefix('learn'), '[学习] ');
  assert.equal(resolveStepTypePrefix('Practice'), '[实践] ');
  assert.equal(resolveStepTypePrefix('project'), '[项目] ');
});

test('[§七.6] type 缺失 / 非法 → 空前缀（既有降级语义，未被重新设计）', () => {
  // 缺失
  assert.equal(resolveStepTypePrefix(undefined), '');
  assert.equal(resolveStepTypePrefix(null), '');
  assert.equal(resolveStepTypePrefix(''), '');

  // 非法
  for (const bad of ['FOO', 'LEARNX', '[学习]', '学习', '项目', '其它', '123']) {
    assert.equal(resolveStepTypePrefix(bad), '', `非法 type ${JSON.stringify(bad)} 必须降级为空前缀`);
  }

  /**
   * FACT（既有语义，Phase 1 **未改**）：纯函数为 `type.toUpperCase()` 后精确查表，**不做 trim**，
   * 故 `' LEARN '` 在**函数级**为非法 → 空前缀。此处按真值断言。
   * 注意：端到端行为不同 —— `actionItemSchema.type` 是 `z.string().trim()`，
   * 上游会先把 `' LEARN '` 归一为 `'LEARN'`（见本文件 §D 端到端用例）。
   */
  assert.equal(resolveStepTypePrefix(' LEARN '), '', '纯函数不做 trim：函数级视为非法');
});

test('[§七.1-3/6] applyStepTypePrefix：合法 → 精确 `[标签] 标题`；缺失/非法 → 标题原样', () => {
  assert.equal(applyStepTypePrefix('完成 K8s 课程', 'LEARN'), '[学习] 完成 K8s 课程');
  assert.equal(applyStepTypePrefix('部署一个 demo', 'PRACTICE'), '[实践] 部署一个 demo');
  assert.equal(applyStepTypePrefix('做一个 RAG 应用', 'PROJECT'), '[项目] 做一个 RAG 应用');

  // 缺失 / 非法：标题**逐字不变**（不得凭空加前缀）
  const title = '补 Kubernetes';
  assert.equal(applyStepTypePrefix(title, undefined), title);
  assert.equal(applyStepTypePrefix(title, ''), title);
  assert.equal(applyStepTypePrefix(title, 'FOO'), title);

  // 反向：标题里恰好含中文标签但**无方括号**时，绝不能被当成已带前缀
  assert.equal(applyStepTypePrefix('学习 K8s', 'FOO'), '学习 K8s');
  assert.equal(parseStepKind('学习 K8s'), 'GENERIC', '无方括号前缀必须降级');
});

/* ═══════════ B. 跨层一致性：服务端产出 ↔ 前端解析 ═══════════ */

test('[§七.4] 跨层契约：服务端折叠出的标题必须能被前端精确还原类型', () => {
  for (const t of STEP_TYPES) {
    const folded = applyStepTypePrefix('动作标题', t);
    assert.equal(parseStepKind(folded), t, `${t} 折叠后必须被 parseStepKind 精确还原`);
  }
});

test('[§七.4] 前端 parseStepKind：三种前缀精确识别；纯括号形式亦可识别', () => {
  assert.equal(parseStepKind('[学习] 完成 K8s 课程'), 'LEARN');
  assert.equal(parseStepKind('[实践] 部署一个 demo'), 'PRACTICE');
  assert.equal(parseStepKind('[项目] 做一个 RAG 应用'), 'PROJECT');

  // 仅前缀（无正文）——服务端虽不会产出该形态，但解析层必须稳健
  for (const t of STEP_TYPES) {
    assert.equal(parseStepKind(STEP_TYPE_BRACKET[t]), t, `${t} 纯括号形式应可识别`);
  }

  // 降级：无前缀 / 未知前缀 / 空白
  for (const bad of ['补 Kubernetes', '[未知] 某动作', '', '   ', '学习 K8s']) {
    assert.equal(parseStepKind(bad), 'GENERIC', `${JSON.stringify(bad)} 必须降级为 GENERIC`);
  }
  assert.equal(parseStepKind('  [实践] 有前导空格'), 'PRACTICE', '容忍前导空格');
});

test('[§七.4] 前后端标签一致：STEP_KIND_LABEL 的三种合法类型取自共享契约', () => {
  for (const t of STEP_TYPES) {
    assert.equal(STEP_KIND_LABEL[t], STEP_TYPE_LABEL[t], `${t} 标签必须与契约一致`);
  }
  assert.equal(STEP_KIND_LABEL.GENERIC, '提升', 'GENERIC 是前端专有降级类别');
});

/* ═══════════ C. 源码守卫：禁止映射分叉与弱断言回归 ═══════════ */

test('[§三] 前端前缀映射必须由契约派生，不得再手写中文字面前缀', () => {
  const src = code('app/_lib/step-entry.ts');
  assert.ok(src.includes("from '../../src/domain/action-plan/step-type.ts'"), '必须引用共享契约');
  assert.ok(src.includes('STEP_TYPES.map'), '映射应由 STEP_TYPES 派生');

  // 不得再出现硬编码的中文前缀字面量
  for (const literal of ["'[学习]'", '"[学习]"', "'[实践]'", "'[项目]'"]) {
    assert.equal(src.includes(literal), false, `不得硬编码前缀字面量 ${literal}`);
  }
});

test('[§三] 服务端不得再定义私有 STEP_TYPE_LABEL 副本', () => {
  const src = code('src/http/handlers/action-plans.ts');
  assert.equal(/const\s+STEP_TYPE_LABEL/.test(src), false, 'handler 不得再持有私有映射副本');
  assert.ok(src.includes('applyStepTypePrefix'), 'handler 必须复用共享契约');
});

test('[§三] 全仓仅契约模块可定义 STEP_TYPE_LABEL（防止再次分叉）', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.next') continue;
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(rel);
    }
  };
  walk('src');
  walk('app');

  const definers = files.filter((f) => /(const|export const)\s+STEP_TYPE_LABEL/.test(code(f)));
  assert.deepEqual(definers, ['src/domain/action-plan/step-type.ts'], `STEP_TYPE_LABEL 只能定义一次，实际：${definers.join(', ')}`);
});

test('[§七.5] 类型契约测试不再使用 includes("学习") 式弱断言', () => {
  const legacy = code('tests/t2-action-plan-api.test.ts');
  assert.equal(/title\.includes\('学习'\)/.test(legacy), false, '不得再用 includes 作为类型契约断言');
  assert.equal(/title\.includes\('项目'\)/.test(legacy), false);
  assert.ok(legacy.includes('STEP_TYPE_PREFIX.LEARN'), '应改为精确前缀断言');
});

test('[§七.9] A2-2 / A2-3 未被牵连：不得引用 step-type 契约', () => {
  for (const rel of ['src/domain/ai/analyze-project.ts', 'src/domain/capability/key.ts', 'src/http/handlers/project-ai-analysis.ts']) {
    assert.equal(/step-type/.test(code(rel)), false, `${rel} 不得引用 ActionStep 类型契约`);
  }
});

test('[§七.7] schema 无变化：ActionStep 模型仍无独立 type 列', () => {
  const schema = read('prisma/schema.prisma');
  const block = schema.slice(schema.indexOf('model ActionStep'), schema.indexOf('model ActionStep') + 700);
  assert.ok(block.length > 0, '应能定位 ActionStep 模型');
  assert.equal(/^\s*type\s+\w/m.test(block), false, 'ActionStep 不得新增 type 字段');
  assert.ok(/status\s+String\s+@default\("TODO"\)/.test(block), 'status 仍是既有 String + 默认 TODO');
  assert.ok(/targetRequirement\s+String\?/.test(block), 'targetRequirement 保持既有形态');
});

test('[§七.8] migration 仍为 18（伴生基线：#15=CareerGoal / #16=ApplicationTracker / #17=AgentAct / #18=UserAvatar 均已授权落地）', () => {
  const migs = readdirSync(path.join(process.cwd(), 'prisma/migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  assert.equal(migs.length, 19, `migration 数量必须为 19（#18 User.avatarUrl + #19 用户自带 LLM API Key），实际 ${migs.length}`);
});

/* ═══════════ D. 端到端：真实 handler + 可控 LLM ═══════════ */

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

let seq = 0;
async function signUp(tag: string) {
  seq += 1;
  const res = await register(postJson('http://t/api/auth/register', {
    email: `a24p1_${tag}_${seq}_${stamp}@example.com`, password: 'password-1234',
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

test('[§七.1-3] 端到端：三种合法 type 各自折叠为**精确前缀**', async () => {
  const u = await signUp('three');
  const runId = await seedRun(u.userId);

  const payload = {
    have: [], gaps: [],
    actions: [
      { title: '完成 K8s 实战', desc: 'd', type: 'LEARN', targetRequirement: '熟悉 Kubernetes' },
      { title: '部署一个 demo', desc: 'd', type: 'PRACTICE' },
      { title: '做一个 RAG 应用', desc: 'd', type: 'PROJECT' },
    ],
  };
  const handler = createCreateActionPlanHandler(planDeps(payload));
  const res = await handler(postJson('http://t/api/action-plans', { matchRunId: runId }, u.token));
  assert.equal(res.status, 201, '创建计划应 201');

  const actions = ((await bodyOf(res)) as { data: { actions: Array<{ title: string }> } }).data.actions;
  assert.equal(actions.length, 3);
  assert.equal(actions[0].title, `${STEP_TYPE_PREFIX.LEARN}完成 K8s 实战`);
  assert.equal(actions[1].title, `${STEP_TYPE_PREFIX.PRACTICE}部署一个 demo`);
  assert.equal(actions[2].title, `${STEP_TYPE_PREFIX.PROJECT}做一个 RAG 应用`);

  // 落库标题同样带精确前缀（不是只在响应层折叠）
  const rows = await prisma.actionStep.findMany({ where: { plan: { userId: u.userId } }, orderBy: { order: 'asc' } });
  assert.deepEqual(rows.map((r) => r.title), actions.map((a) => a.title));

  // 端到端跨层：前端解析落库标题，必须精确还原三种类型（§七.4）
  assert.deepEqual(rows.map((r) => parseStepKind(r.title)), ['LEARN', 'PRACTICE', 'PROJECT']);

  await cleanup(u.userId);
});

test('[§七.6] 端到端：type 缺失 / 非法 → 标题原样，且不得被宣称为合法类型', async () => {
  const u = await signUp('degrade');
  const runId = await seedRun(u.userId);

  const payload = {
    have: [], gaps: [],
    actions: [
      { title: '无类型动作', desc: 'd' },
      { title: '非法类型动作', desc: 'd', type: 'FOO' },
      { title: '带空白类型动作', desc: 'd', type: ' LEARN ' },
      { title: '小写合法动作', desc: 'd', type: 'project' },
    ],
  };
  const handler = createCreateActionPlanHandler(planDeps(payload));
  const res = await handler(postJson('http://t/api/action-plans', { matchRunId: runId }, u.token));
  assert.equal(res.status, 201);

  const actions = ((await bodyOf(res)) as { data: { actions: Array<{ title: string }> } }).data.actions;
  assert.equal(actions[0].title, '无类型动作', 'type 缺失 → 标题原样');
  assert.equal(actions[1].title, '非法类型动作', '非法 type → 标题原样，不得加任何前缀');
  // 端到端事实：zod `z.string().trim()` 先归一，故「去空白后合法」= 合法（既有行为，未改）
  assert.equal(actions[2].title, `${STEP_TYPE_PREFIX.LEARN}带空白类型动作`, '端到端：上游 schema 先 trim，` LEARN ` 视为合法');
  assert.equal(actions[3].title, `${STEP_TYPE_PREFIX.PROJECT}小写合法动作`, '大小写不敏感');

  // 降级的两条必须被前端判为 GENERIC，而不得被误判为合法类型
  const rows = await prisma.actionStep.findMany({ where: { plan: { userId: u.userId } }, orderBy: { order: 'asc' } });
  assert.deepEqual(rows.map((r) => parseStepKind(r.title)), ['GENERIC', 'GENERIC', 'LEARN', 'PROJECT']);

  await cleanup(u.userId);
});

test('[§七.10] Phase 0 入口准入仍基于同一前缀契约（回归保持）', async () => {
  // Phase 0 的准入判定直接复用 parseStepKind；此处验证三种前缀下的准入结果不变
  const { canSubmitResultForTitle } = await import('../app/_lib/step-result-entry.ts');
  assert.equal(canSubmitResultForTitle(applyStepTypePrefix('x', 'LEARN')), true);
  assert.equal(canSubmitResultForTitle(applyStepTypePrefix('x', 'PROJECT')), true);
  assert.equal(canSubmitResultForTitle(applyStepTypePrefix('x', 'PRACTICE')), false, 'O-A2-4-1 已 DEFERRED：[实践] 仍不开放提交入口');
  assert.equal(canSubmitResultForTitle('无前缀动作'), false);
});

test('[§七.10] C4 展示层回归保持：StepEntry 仍为纯展示（无写操作）', () => {
  const src = code('app/_components/StepEntry.tsx');
  assert.equal(/fetch\(|api<|method: 'POST'|method: 'PATCH'/.test(src), false, 'StepEntry 不得引入写操作');
  assert.ok(src.includes('parseStepKind'), 'StepEntry 仍按前缀判定入口形态');
  assert.ok(src.includes('STEP_KIND_LABEL'), 'StepEntry 仍展示类型标签');
});

test('契约类型导出可用于编译期收窄（StepType 为三值联合）', () => {
  const t: StepType = 'LEARN';
  assert.equal(STEP_TYPE_PREFIX[t], '[学习] ');
});
