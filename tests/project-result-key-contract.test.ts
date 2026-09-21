/**
 * T3-A2-3 —— Capability Identity & Adoption Consistency（真实 PostgreSQL，**禁止静默 skip**）
 *
 * 覆盖指令 §六.5–§六.14 与 C-3：
 *   - A2-1 writer：`Docker` / `DOCKER` / ` Docker ` 必须收敛到同一 canonical 行
 *   - 首次 201 / 重复 200 / 非法 key 400 `VALIDATION_FAILED` 且**零写入**
 *   - 已存在 Capability 的 status / level / source / label **全部保持原值**，只新增正确 Evidence
 *   - 并发 `Docker` × `docker` → 只剩 1 个 canonical Capability
 *   - DB 不变量：`Capability.key === normalizeCapabilityKey(Capability.key)`
 *   - 第三 writer（Resume Projection）写边界同样受 §6.1 强制
 *   - A2-3 不写 Skill；CONFIRMED 仍只由既有 confirm 入口产生
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { systemClock } from '../src/ports/index.ts';
import {
  createCreateProjectResultHandler,
  createAddProjectResultArtifactHandler,
  createSubmitProjectResultHandler,
  createDeclareProjectEvidenceHandler,
} from '../src/http/handlers/project-results.ts';
import { createConfirmCapabilityHandler } from '../src/http/handlers/capabilities.ts';
import { normalizeCapabilityKey } from '../src/domain/capability/key.ts';
import { bodyOf, extractSessionToken, postJson } from './fakes.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/** §十二 测试纪律：关键 DB 测试禁止 skip —— DB 不可达必须 FAIL */
test('前置：数据库必须可达（A2-3 关键 DB 测试禁止静默 skip）', async () => {
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

const register = createRegisterHandler({ auth, secureCookies: false });
const handlers = {
  create: createCreateProjectResultHandler(deps),
  addArtifact: createAddProjectResultArtifactHandler(deps),
  submit: createSubmitProjectResultHandler(deps),
  declare: createDeclareProjectEvidenceHandler(deps),
  confirm: createConfirmCapabilityHandler(capDeps),
};

let seq = 0;
async function signUp(tag: string) {
  seq += 1;
  const res = await register(postJson('http://t/api/auth/register', {
    email: `pr_key_${tag}_${seq}_${stamp}@example.com`, password: 'password-1234',
  }));
  const token = extractSessionToken(res);
  assert.ok(token, '注册应下发会话 token');
  const body = (await bodyOf(res)) as { data: { user: { id: string } } };
  return { userId: body.data.user.id, token: token as string };
}

/**
 * 造一个 SUBMITTED 成果，并挂上 §1 个或多个**带 URL**的凭据。
 * 注意：成果提交后不可再增删凭据（`RESULT_NOT_EDITABLE`），故凭据必须**提交前**全部加上。
 */
async function seedSubmitted(userId: string, urls: string[] = ['https://example.com/Repo']) {
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
    sourceStepTargetRequirement: 'r', title: '成果', summary: '描述',
  });
  const artifacts = [];
  for (const [i, url] of urls.entries()) {
    artifacts.push(await repos.projectResults.addArtifact(draft.id, userId, { kind: 'REPO', url: `${url}#a${i}` }));
  }
  await repos.projectResults.submit(draft.id, userId, new Date());
  return { draft, artifacts };
}

const declareBody = (artifactId: string, key: string) => ({ artifactId, key, label: '示例能力' });
const declareUrl = (id: string) => `http://t/api/project-results/${id}/evidence`;
const cleanup = (userId: string) => prisma.user.delete({ where: { id: userId } });
const capsOf = (userId: string) => prisma.capability.findMany({ where: { userId } });
const capCount = (userId: string) => prisma.capability.count({ where: { userId } });
const evCount = (userId: string) => prisma.capabilityEvidence.count({ where: { capability: { userId } } });

// ─── §六.5–§六.7：canonical 收敛 + 201 / 200 ───────────────────────────

test('[§六.5-7] 先建 docker，再声明 Docker / "  DOCKER  " → Capability 只有 1 行且 key=canonical', async () => {
  const u = await signUp('converge');
  const { draft, artifacts } = await seedSubmitted(u.userId, ['https://example.com/r1', 'https://example.com/r2']);
  const [a1, a2] = artifacts;

  // 首次：小写 docker → 201
  const r1 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(a1.id, 'docker'), u.token), draft.id);
  assert.equal(r1.status, 201);
  const b1 = (await bodyOf(r1)) as { data: { capability: { id: string; status: string; source: string }; evidence: { created: boolean } } };
  assert.equal(b1.data.capability.status, 'UNCONFIRMED');
  assert.equal(b1.data.capability.source, 'PROJECT_RESULT');
  assert.equal(b1.data.evidence.created, true);

  // 第二个凭据 + 大写 Docker → 必须命中**同一** Capability
  const r2 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(a2.id, 'Docker'), u.token), draft.id);
  assert.equal(r2.status, 201, '不同凭据 → 新证据 201');
  const b2 = (await bodyOf(r2)) as { data: { capability: { id: string }; evidence: { created: boolean } } };
  assert.equal(b2.data.capability.id, b1.data.capability.id, 'Docker 必须收敛到同一 Capability');
  assert.equal(b2.data.evidence.created, true);

  // 同一凭据 + 大小写与空白混排 → 幂等 200
  const r3 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(a2.id, '  DOCKER  '), u.token), draft.id);
  assert.equal(r3.status, 200);
  const b3 = (await bodyOf(r3)) as { data: { capability: { id: string }; evidence: { created: boolean } } };
  assert.equal(b3.data.capability.id, b1.data.capability.id);
  assert.equal(b3.data.evidence.created, false);

  // 收敛结果
  const caps = await capsOf(u.userId);
  assert.equal(caps.length, 1, '必须只有 1 行 Capability');
  assert.equal(caps[0].key, 'docker');
  assert.equal(caps[0].status, 'UNCONFIRMED');
  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: caps[0].id } }), 2, '两个凭据 → 两条证据');

  await cleanup(u.userId);
});

test('[§六.2/§六.5] A2-1 亦执行 §6.1 归一：全角 key 与连续空白 key 收敛', async () => {
  const u = await signUp('nfkc');
  const { draft, artifacts } = await seedSubmitted(u.userId, ['https://example.com/n1', 'https://example.com/n2', 'https://example.com/n3']);
  const [a1, a2, a3] = artifacts;

  const r1 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(a1.id, 'ＰＹＴＨＯＮ'), u.token), draft.id);
  assert.equal(r1.status, 201);
  const cid = ((await bodyOf(r1)) as { data: { capability: { id: string } } }).data.capability.id;

  const r2 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(a2.id, 'python'), u.token), draft.id);
  assert.equal(r2.status, 201);
  assert.equal(((await bodyOf(r2)) as { data: { capability: { id: string } } }).data.capability.id, cid, '全角 PYTHON 必须与 python 同行为');

  const r3 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(a3.id, 'machine   learning'), u.token), draft.id);
  assert.equal(r3.status, 201);

  const caps = await capsOf(u.userId);
  assert.equal(caps.length, 2);
  const keys = caps.map((c) => c.key).sort();
  assert.deepEqual(keys, ['machine learning', 'python']);

  await cleanup(u.userId);
});

// ─── §六.8：非法 key → 400 + 零写入 ───────────────────────────────────

test('[§六.8] 非法 key → 400 VALIDATION_FAILED，且 Capability / Evidence 均 0 新增', async () => {
  const u = await signUp('invalid');
  const { draft, artifacts } = await seedSubmitted(u.userId);
  const beforeCaps = await capCount(u.userId);
  const beforeEv = await evCount(u.userId);
  assert.equal(beforeCaps, 0);
  assert.equal(beforeEv, 0);

  const invalidKeys: Array<[string, string]> = [
    ['斜杠', 'ci/cd'],
    ['和号', 'r&d'],
    ['emoji', '😀'],
    ['超长', 'x'.repeat(65)],
    ['空字符串', ''],
    ['纯空白', '   '],
    ['引号', 'a"b'],
  ];

  for (const [label, key] of invalidKeys) {
    const res = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifacts[0].id, key), u.token), draft.id);
    assert.equal(res.status, 400, `${label} ${JSON.stringify(key)} 应 400`);
    const b = (await bodyOf(res)) as { error?: { code?: string } };
    assert.equal(b.error?.code, 'VALIDATION_FAILED', `${label} 应为 VALIDATION_FAILED`);
  }

  assert.equal(await capCount(u.userId), 0, '不得新增任何 Capability');
  assert.equal(await evCount(u.userId), 0, '不得新增任何 Evidence');

  await cleanup(u.userId);
});

test('[§六.8] 非法 key 不因资源不存在而变成 404/422 之外的意外结果（400 优先于资源查询）', async () => {
  const u = await signUp('invalidprec');
  const res = await handlers.declare(postJson(declareUrl('nope_result'), declareBody('nope_artifact', 'ci/cd'), u.token), 'nope_result');
  assert.equal(res.status, 400, 'body 级契约校验先于资源查询');
  const b = (await bodyOf(res)) as { error?: { code?: string } };
  assert.equal(b.error?.code, 'VALIDATION_FAILED');
  await cleanup(u.userId);
});

// ─── §六.9：已存在 Capability 只读 ────────────────────────────────────

test('[§六.9] 已存在 Capability：status / level / source / label 全部保持原值，仅新增正确 Evidence', async () => {
  const u = await signUp('existing');
  const { draft, artifacts } = await seedSubmitted(u.userId);

  const existing = await prisma.capability.create({
    data: {
      userId: u.userId, key: 'docker', label: '既有 Docker 能力',
      level: 'ADVANCED', status: 'CONFIRMED', source: 'RESUME_PROJECTION',
    },
  });

  const res = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifacts[0].id, 'Docker'), u.token), draft.id);
  assert.equal(res.status, 201, '新证据 → 201');
  const b = (await bodyOf(res)) as { data: { capability: { id: string; status: string; source: string }; evidence: { created: boolean } } };
  assert.equal(b.data.capability.id, existing.id);
  assert.equal(b.data.capability.status, 'CONFIRMED', '返回既有状态，不得降级');
  assert.equal(b.data.evidence.created, true);

  const after = await prisma.capability.findUniqueOrThrow({ where: { id: existing.id } });
  assert.equal(after.status, 'CONFIRMED');
  assert.equal(after.level, 'ADVANCED');
  assert.equal(after.source, 'RESUME_PROJECTION');
  assert.equal(after.label, '既有 Docker 能力');

  const evs = await prisma.capabilityEvidence.findMany({ where: { capabilityId: existing.id } });
  assert.equal(evs.length, 1);
  assert.equal(evs[0].type, 'PROJECT_RESULT_EVIDENCE');
  assert.equal(evs[0].resultArtifactId, artifacts[0].id);
  assert.equal(evs[0].source, 'PROJECT_RESULT');

  await cleanup(u.userId);
});

// ─── §六.10：并发 Docker × docker ─────────────────────────────────────

test('[§六.10] 并发：两个不同成果同时以 Docker / docker 声明 → 最终只有 1 行 canonical Capability', async () => {
  const u = await signUp('race');
  const a = await seedSubmitted(u.userId, ['https://example.com/x1']);
  const b = await seedSubmitted(u.userId, ['https://example.com/x2']);

  const [r1, r2] = await Promise.all([
    handlers.declare(postJson(declareUrl(a.draft.id), declareBody(a.artifacts[0].id, 'Docker'), u.token), a.draft.id),
    handlers.declare(postJson(declareUrl(b.draft.id), declareBody(b.artifacts[0].id, 'docker'), u.token), b.draft.id),
  ]);

  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);

  const caps = await capsOf(u.userId);
  assert.equal(caps.length, 1, '并发下必须只有 1 行 Capability');
  assert.equal(caps[0].key, 'docker');
  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: caps[0].id } }), 2, '两个成果 → 两条证据，且同属一个 Capability');

  await cleanup(u.userId);
});

// ─── §六.11：DB 不变量 ────────────────────────────────────────────────

test('[§六.11] DB 不变量：本用例创建的 Capability.key 均满足 key === normalizeCapabilityKey(key)', async () => {
  const u = await signUp('invariant');
  const { draft, artifacts } = await seedSubmitted(u.userId, ['https://example.com/i1', 'https://example.com/i2']);
  await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifacts[0].id, 'Ｄｏｃｋｅｒ'), u.token), draft.id);
  await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifacts[1].id, 'Machine   Learning'), u.token), draft.id);

  const caps = await capsOf(u.userId);
  assert.equal(caps.length, 2);
  for (const c of caps) {
    assert.equal(c.key, normalizeCapabilityKey(c.key), `key 非 canonical：${JSON.stringify(c.key)}`);
  }

  await cleanup(u.userId);
});

// ─── C-3：第三 writer（Resume Projection）写边界 ──────────────────────

test('[C-3] Resume Projection 写边界：可归一 key 被归一，不可归一 key 被跳过（不产生错行）', async () => {
  const u = await signUp('projection');
  const resume = await prisma.resume.create({ data: { userId: u.userId, rawText: '技能', sourceType: 'TEXT' } });
  await prisma.skill.create({
    data: {
      resumeId: resume.id, key: 'ＰＹＴＨＯＮ', label: 'Python（全角 key）', level: null, status: 'CONFIRMED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'l1', excerpt: 'e1' }] },
    },
  });
  await prisma.skill.create({
    data: {
      resumeId: resume.id, key: 'r&d', label: 'R&D', level: null, status: 'CONFIRMED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'l2', excerpt: 'e2' }] },
    },
  });

  const result = await repos.capabilities.projectConfirmedSkills(u.userId);
  assert.equal(result.created, 1, '只有 1 条可归一为合法 canonical key');
  assert.equal(result.skipped, 1, '不可归一的源条目必须被跳过');

  const caps = await capsOf(u.userId);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].key, 'python', '全角 key 必须被归一');
  assert.equal(caps[0].source, 'RESUME_PROJECTION');
  assert.equal(caps[0].status, 'CONFIRMED');
  assert.equal(caps[0].level, null);
  assert.equal(await prisma.capability.count({ where: { userId: u.userId, key: 'r&d' } }), 0, '不得写出不合规 key 的行');

  await cleanup(u.userId);
});

test('[C-3] Resume Projection 的既有语义不变：普通 key 的 created / unchanged 行为与契约前一致', async () => {
  const u = await signUp('projectsem');
  const resume = await prisma.resume.create({ data: { userId: u.userId, rawText: '技能', sourceType: 'TEXT' } });
  await prisma.skill.create({
    data: {
      resumeId: resume.id, key: 'docker', label: 'Docker', level: '熟练', status: 'CONFIRMED',
      evidence: { create: [{ source: 'RESUME_TEXT', locator: 'l', excerpt: 'e' }] },
    },
  });

  const first = await repos.capabilities.projectConfirmedSkills(u.userId);
  assert.equal(first.created, 1);
  assert.equal(first.skipped, 0);

  const second = await repos.capabilities.projectConfirmedSkills(u.userId);
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, 1, '重复投影必须幂等');
  assert.equal(second.skipped, 0);

  const caps = await capsOf(u.userId);
  assert.equal(caps.length, 1);
  assert.equal(caps[0].key, 'docker');
  assert.equal(caps[0].level, '熟练');

  await cleanup(u.userId);
});

// ─── §六.13 / §六.14：confirm 唯一入口 + 不写 Skill ───────────────────

test('[§六.13/14] declare → UNCONFIRMED；CONFIRMED 仍只由既有 confirm 入口产生；全程不写 Skill', async () => {
  const u = await signUp('confirm');
  const resume = await prisma.resume.create({ data: { userId: u.userId, rawText: '技能', sourceType: 'TEXT' } });
  await prisma.skill.create({ data: { resumeId: resume.id, key: 'docker', label: 'Docker', level: 'BEGINNER', status: 'UNCONFIRMED' } });
  const { draft, artifacts } = await seedSubmitted(u.userId, ['https://example.com/c1']);

  const skillsBefore = await prisma.skill.findMany({
    where: { resume: { userId: u.userId } },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { id: 'asc' },
  });

  const d = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifacts[0].id, 'Docker'), u.token), draft.id);
  assert.equal(d.status, 201);
  const capId = ((await bodyOf(d)) as { data: { capability: { id: string } } }).data.capability.id;

  const mid = await prisma.capability.findUniqueOrThrow({ where: { id: capId } });
  assert.equal(mid.status, 'UNCONFIRMED', '回流只能产生 UNCONFIRMED');

  const c = await handlers.confirm(postJson('http://t/api/capabilities', { confirmed: true }, u.token), capId);
  assert.equal(c.status, 200);
  assert.equal((await prisma.capability.findUniqueOrThrow({ where: { id: capId } })).status, 'CONFIRMED');

  const skillsAfter = await prisma.skill.findMany({
    where: { resume: { userId: u.userId } },
    select: { id: true, key: true, label: true, level: true, status: true },
    orderBy: { id: 'asc' },
  });
  assert.deepEqual(skillsAfter, skillsBefore, 'A2-3 不得写入或修改任何 Skill');

  await cleanup(u.userId);
});

// ─── §六.12：A2-2 红线源码守卫 ────────────────────────────────────────

/** 源码守卫必须剔除注释：禁止项常被写在注释里做说明，误判会造成假失败 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

test('[§六.12] A2-2 红线：仍复用 key.ts；分析 handler 仍无 Capability/Skill 写权限', () => {
  const analyzeSrc = readFileSync('src/domain/ai/analyze-project.ts', 'utf8');
  assert.match(analyzeSrc, /validateCapabilityKey/, 'A2-2 必须继续复用 key.ts');
  assert.match(analyzeSrc, /AiAnalysisInvalidResponseError/, '非法 AI key → 502 的既有策略不得改变');

  const handlerCode = stripComments(readFileSync('src/http/handlers/project-ai-analysis.ts', 'utf8'));
  assert.equal(/CapabilityRepository/.test(handlerCode), false, '分析 handler 不得含 CapabilityRepository');
  assert.equal(/\.capabilities\b/.test(handlerCode), false, '分析 handler 不得引用 capabilities 仓储');
  assert.equal(/SkillRepository/.test(handlerCode), false, '分析 handler 不得含 Skill 仓储');

  const depsSrc = readFileSync('src/http/deps.ts', 'utf8');
  const a21 = depsSrc.slice(
    depsSrc.indexOf('buildProjectResultsHandlerDeps'),
    depsSrc.indexOf('buildProjectAiAnalysisHandlerDeps'),
  );
  assert.equal(/provider/.test(stripComments(a21)), false, 'A2-1 deps 不得含 provider');
});

test('[§六.13] 源码守卫：Capability 的 CONFIRMED 写入点仍然唯一且在 confirm 内', () => {
  const raw = readFileSync('src/db/repositories.ts', 'utf8');
  const src = stripComments(raw);

  const writes = [...src.matchAll(/capability\.update(?:Many)?\(\{[\s\S]{0,240}?status: 'CONFIRMED'/g)];
  assert.equal(writes.length, 1, `CONFIRMED 写入点必须唯一，实际 ${writes.length}`);

  const confirmIdx = src.indexOf('async confirm(');
  const declareIdx = src.indexOf('async declareFromProjectArtifact(');
  const projectIdx = src.indexOf('async projectConfirmedSkills(');
  const at = writes[0].index ?? -1;
  assert.ok(confirmIdx > 0 && at > confirmIdx, '唯一写入点必须位于 confirm 内');
  assert.ok(declareIdx === -1 || at < declareIdx, '回流路径不得出现 CONFIRMED 写入');
  assert.ok(projectIdx === -1 || at < projectIdx, '投影路径不得出现 CONFIRMED 写入');

  // A2-3 的写边界强制必须复用 key.ts，且不得改用 Match / fingerprint 归一化
  assert.match(src, /validateCapabilityKey/, 'Capability writer 必须经 key.ts 校验');
  assert.equal(/normalizeForMatch\s*\(/.test(src) && /key:\s*normalizeForMatch/.test(src), true,
    'FACT：resume 创建路径仍以 normalizeForMatch 派生 Skill.key（§6.4），故写边界必须自行归一');
  assert.equal(/normalizeFingerprintText\s*\(/.test(stripComments(readFileSync('src/domain/capability/key.ts', 'utf8'))), false,
    'key.ts 不得依赖 fingerprint 归一化');
  assert.equal(/normalizeForMatch/.test(stripComments(readFileSync('src/domain/capability/key.ts', 'utf8'))), false,
    'key.ts 不得依赖 Match 归一化');
});
