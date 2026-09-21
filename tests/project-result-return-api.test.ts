/**
 * T3-A2-1 API / Security 层验收（真实 PostgreSQL，**禁止静默 skip**）
 *
 * 覆盖 §二十七 API + Security/IDOR + Provider + §二十六 源码 guard：
 *   201 首次声明 / 200 幂等重复 / 401 / 400（含 body userId 被 strict 拒绝）/ 404 / 422
 *   跨用户 result、跨用户 artifact、不存在资源 —— 响应必须一致（无 existence oracle）
 *   confirm 仍为唯一 CONFIRMED 入口；A2-1 回流路径不写 CONFIRMED
 *   provider calls = 0
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
  createRevokeProjectResultHandler,
  createDeclareProjectEvidenceHandler,
} from '../src/http/handlers/project-results.ts';
import { createConfirmCapabilityHandler, createGetCapabilityHandler } from '../src/http/handlers/capabilities.ts';
import { bodyOf, extractSessionToken, getJson, postJson } from './fakes.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

/** §二十八：关键 DB 测试禁止 skip —— DB 不可达时本文件必须失败 */
test('前置：数据库必须可达（A2-1 API 测试禁止静默 skip）', async () => {
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
  revoke: createRevokeProjectResultHandler(deps),
  declare: createDeclareProjectEvidenceHandler(deps),
  confirm: createConfirmCapabilityHandler(capDeps),
  getCapability: createGetCapabilityHandler(capDeps),
};

let seq = 0;
async function signUp(tag: string) {
  seq += 1;
  const res = await register(postJson('http://t/api/auth/register', {
    email: `pr_ret_api_${tag}_${seq}_${stamp}@example.com`, password: 'password-1234',
  }));
  const token = extractSessionToken(res);
  assert.ok(token, '注册应下发会话 token');
  const body = (await bodyOf(res)) as { data: { user: { id: string } } };
  return { userId: body.data.user.id, token: token as string };
}

async function seedResult(userId: string, opts?: { state?: 'DRAFT' | 'SUBMITTED' | 'REVOKED'; url?: string | null }) {
  const state = opts?.state ?? 'SUBMITTED';
  const url = opts?.url === undefined ? 'https://example.com/Repo' : opts.url;
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
  const artifact = await repos.projectResults.addArtifact(draft.id, userId, {
    kind: 'REPO', ...(url === null ? { excerpt: '仅文字' } : { url }),
  });
  if (state === 'SUBMITTED' || state === 'REVOKED') await repos.projectResults.submit(draft.id, userId, new Date());
  if (state === 'REVOKED') await repos.projectResults.revoke(draft.id, userId, new Date());
  return { draft, artifact };
}

const declareBody = (artifactId: string, key: string) => ({ artifactId, key, label: '示例能力' });
const declareUrl = (id: string) => `http://t/api/project-results/${id}/evidence`;
const cleanup = (userId: string) => prisma.user.delete({ where: { id: userId } });

// ─── 401 / 400 ────────────────────────────────────────────────────────

test('401：未登录声明 → UNAUTHENTICATED', async () => {
  const u = await signUp('a401');
  const { draft, artifact } = await seedResult(u.userId);
  const res = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, `k401_${stamp}`)), draft.id);
  assert.equal(res.status, 401);
  assert.equal(((await bodyOf(res)) as { error: { code: string } }).error.code, 'UNAUTHENTICATED');
  await cleanup(u.userId);
});

test('400：body 缺字段', async () => {
  const u = await signUp('a400a');
  const { draft } = await seedResult(u.userId);
  const res = await handlers.declare(postJson(declareUrl(draft.id), { artifactId: 'x' }, u.token), draft.id);
  assert.equal(res.status, 400);
  await cleanup(u.userId);
});

test('400：body 含 userId 必须被 strict schema 拒绝（不接受 body userId）', async () => {
  const u = await signUp('a400b');
  const other = await signUp('a400b2');
  const { draft, artifact } = await seedResult(u.userId);
  const res = await handlers.declare(
    postJson(declareUrl(draft.id), { ...declareBody(artifact.id, `k400b_${stamp}`), userId: other.userId }, u.token),
    draft.id,
  );
  assert.equal(res.status, 400);
  // 未产生任何能力
  assert.equal(await prisma.capability.count({ where: { userId: other.userId } }), 0);
  await cleanup(u.userId);
  await cleanup(other.userId);
});

test('400：未知字段一律拒绝', async () => {
  const u = await signUp('a400c');
  const { draft, artifact } = await seedResult(u.userId);
  const res = await handlers.declare(
    postJson(declareUrl(draft.id), { ...declareBody(artifact.id, `k400c_${stamp}`), sneaky: 1 }, u.token),
    draft.id,
  );
  assert.equal(res.status, 400);
  await cleanup(u.userId);
});

// ─── 404 / 无 existence oracle ────────────────────────────────────────

test('404：跨用户 result / 跨用户 artifact / 不存在资源 响应必须完全一致（无 existence oracle）', async () => {
  const alice = await signUp('alice');
  const bob = await signUp('bob');
  const a = await seedResult(alice.userId);
  const b = await seedResult(alice.userId);

  // ① bob 用 alice 的 result + artifact
  const crossUser = await handlers.declare(
    postJson(declareUrl(a.draft.id), declareBody(a.artifact.id, `x1_${stamp}`), bob.token), a.draft.id);
  // ② artifact 属于另一个 result
  const artifactMismatch = await handlers.declare(
    postJson(declareUrl(a.draft.id), declareBody(b.artifact.id, `x2_${stamp}`), alice.token), a.draft.id);
  // ③ 不存在的 result
  const missingResult = await handlers.declare(
    postJson(declareUrl('nope_result'), declareBody(a.artifact.id, `x3_${stamp}`), alice.token), 'nope_result');
  // ④ 不存在的 artifact
  const missingArtifact = await handlers.declare(
    postJson(declareUrl(a.draft.id), declareBody('nope_artifact', `x4_${stamp}`), alice.token), a.draft.id);
  // ⑤ 两者都不存在
  const bothMissing = await handlers.declare(
    postJson(declareUrl('nope_r2'), declareBody('nope_a2', `x5_${stamp}`), alice.token), 'nope_r2');

  for (const r of [crossUser, artifactMismatch, missingResult, missingArtifact, bothMissing]) {
    assert.equal(r.status, 404);
  }

  // 比较「对外可见语义」：status + code + message 必须完全一致
  // （响应体含每请求唯一的 requestId，故不做逐字节比较）
  const shapes = await Promise.all([crossUser, artifactMismatch, missingResult, missingArtifact, bothMissing]
    .map(async (r) => {
      const b = (await bodyOf(r)) as { error?: { code?: string; message?: string } };
      return JSON.stringify({ status: r.status, code: b.error?.code, message: b.error?.message });
    }));
  assert.equal(new Set(shapes).size, 1, '404 的 status/code/message 必须完全一致（不泄露资源是否存在）');
  assert.equal(JSON.parse(shapes[0]).code, 'NOT_FOUND');

  // 未登录 → 401（与 404 明确区分）
  const noToken = await handlers.declare(postJson(declareUrl(a.draft.id), declareBody(a.artifact.id, `x6_${stamp}`)), a.draft.id);
  assert.equal(noToken.status, 401);

  // 未产生任何副作用
  assert.equal(await prisma.capability.count({ where: { userId: bob.userId } }), 0);
  assert.equal(await prisma.capability.count({ where: { userId: alice.userId } }), 0);

  await cleanup(alice.userId);
  await cleanup(bob.userId);
});

// ─── 422 ─────────────────────────────────────────────────────────────

test('422：DRAFT 成果声明 → RESULT_NOT_SUBMITTED', async () => {
  const u = await signUp('a422d');
  const { draft, artifact } = await seedResult(u.userId, { state: 'DRAFT' });
  const res = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, `k422d_${stamp}`), u.token), draft.id);
  assert.equal(res.status, 422);
  assert.equal(((await bodyOf(res)) as { error: { code: string } }).error.code, 'RESULT_NOT_SUBMITTED');
  await cleanup(u.userId);
});

test('422：REVOKED 成果声明 → RESULT_NOT_SUBMITTED', async () => {
  const u = await signUp('a422r');
  const { draft, artifact } = await seedResult(u.userId, { state: 'REVOKED' });
  const res = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, `k422r_${stamp}`), u.token), draft.id);
  assert.equal(res.status, 422);
  assert.equal(((await bodyOf(res)) as { error: { code: string } }).error.code, 'RESULT_NOT_SUBMITTED');
  await cleanup(u.userId);
});

test('422：仅 excerpt 的凭据声明 → 拒绝，且 message 准确表达「缺少非空 URL」', async () => {
  const u = await signUp('a422u');
  const { draft, artifact } = await seedResult(u.userId, { url: null });
  const res = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, `k422u_${stamp}`), u.token), draft.id);
  assert.equal(res.status, 422);
  const body = (await bodyOf(res)) as { error: { code: string; message: string } };
  // O-A：本轮不新增第二个错误码，复用既有 422 码，但 message 必须准确表达缺失语义
  assert.equal(body.error.code, 'RESULT_HAS_NO_ARTIFACT');
  assert.match(body.error.message, /URL/);
  assert.match(body.error.message, /回流|确认/);
  assert.equal(await prisma.capabilityEvidence.count({ where: { resultArtifactId: artifact.id } }), 0);
  await cleanup(u.userId);
});

// ─── 成功路径 + 幂等 ──────────────────────────────────────────────────

test('201 首次声明 → UNCONFIRMED；200 幂等重复 → 同一条证据', async () => {
  const u = await signUp('ok');
  const { draft, artifact } = await seedResult(u.userId);
  const key = `k_ok_${stamp}`;

  const r1 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, key), u.token), draft.id);
  assert.equal(r1.status, 201);
  const b1 = (await bodyOf(r1)) as { data: { capability: { id: string; status: string; source: string }; evidence: { id: string; created: boolean } } };
  assert.equal(b1.data.capability.status, 'UNCONFIRMED');
  assert.equal(b1.data.capability.source, 'PROJECT_RESULT');
  assert.equal(b1.data.evidence.created, true);

  const r2 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, key), u.token), draft.id);
  assert.equal(r2.status, 200);
  const b2 = (await bodyOf(r2)) as { data: { capability: { id: string }; evidence: { id: string; created: boolean } } };
  assert.equal(b2.data.evidence.created, false);
  assert.equal(b2.data.evidence.id, b1.data.evidence.id);
  assert.equal(b2.data.capability.id, b1.data.capability.id);

  assert.equal(await prisma.capabilityEvidence.count({ where: { capabilityId: b1.data.capability.id } }), 1);
  await cleanup(u.userId);
});

test('闭环：declare → UNCONFIRMED → confirm（既有唯一入口）→ CONFIRMED；跨用户 confirm 404', async () => {
  const u = await signUp('loop');
  const other = await signUp('loop_other');
  const { draft, artifact } = await seedResult(u.userId);
  const key = `k_loop_${stamp}`;

  const r1 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, key), u.token), draft.id);
  assert.equal(r1.status, 201);
  const capId = ((await bodyOf(r1)) as { data: { capability: { id: string } } }).data.capability.id;

  // 声明后仍是候选态
  const g1 = await handlers.getCapability(getJson('http://t/api/capabilities', u.token), capId);
  assert.equal(((await bodyOf(g1)) as { data: { status: string } }).data.status, 'UNCONFIRMED');

  // 跨用户 confirm → 404
  const rc = await handlers.confirm(postJson(`http://t/api/capabilities/${capId}/confirm`, { confirmed: true }, other.token), capId);
  assert.equal(rc.status, 404);

  // 本人 confirm → 200 CONFIRMED
  const ro = await handlers.confirm(postJson(`http://t/api/capabilities/${capId}/confirm`, { confirmed: true }, u.token), capId);
  assert.equal(ro.status, 200);
  const g2 = await handlers.getCapability(getJson('http://t/api/capabilities', u.token), capId);
  const detail = (await bodyOf(g2)) as { data: { status: string; evidence: Array<{ type: string }> } };
  assert.equal(detail.data.status, 'CONFIRMED');
  assert.equal(detail.data.evidence.filter((e) => e.type === 'PROJECT_RESULT_EVIDENCE').length, 1);

  await cleanup(u.userId);
  await cleanup(other.userId);
});

test('确认闸门：成果 revoke 后 confirm → 422 且能力保持 UNCONFIRMED', async () => {
  const u = await signUp('revoke');
  const { draft, artifact } = await seedResult(u.userId);
  const key = `k_rev_${stamp}`;
  const r1 = await handlers.declare(postJson(declareUrl(draft.id), declareBody(artifact.id, key), u.token), draft.id);
  const capId = ((await bodyOf(r1)) as { data: { capability: { id: string } } }).data.capability.id;

  await handlers.revoke(postJson(`http://t/api/project-results/${draft.id}/revoke`, {}, u.token), draft.id);

  const rc = await handlers.confirm(postJson(`http://t/api/capabilities/${capId}/confirm`, { confirmed: true }, u.token), capId);
  assert.equal(rc.status, 422);
  assert.equal(((await bodyOf(rc)) as { error: { code: string } }).error.code, 'CAPABILITY_NOT_CONFIRMABLE');
  assert.equal((await prisma.capability.findUnique({ where: { id: capId } }))?.status, 'UNCONFIRMED');

  await cleanup(u.userId);
});

// ─── 源码 guard（§二十六） ────────────────────────────────────────────

test('源码 guard：A2-1 回流路径不写 CONFIRMED；Capability 的 CONFIRMED 写入点唯一且在 confirm 内', () => {
  const src = readFileSync('src/db/repositories.ts', 'utf8');

  const start = src.indexOf('async declareFromProjectArtifact');
  assert.ok(start > -1, '应存在 declareFromProjectArtifact');
  const end = src.indexOf('\n    },', src.indexOf('return {', start));
  const body = src.slice(start, end > start ? end : start + 6000);

  // ① 回流路径不得出现 CONFIRMED 字面量（UNCONFIRMED 除外）
  assert.equal(/'CONFIRMED'/.test(body.replace(/'UNCONFIRMED'/g, '')), false, '回流路径不得写 CONFIRMED');
  // ② 回流路径不得对 Capability 执行 UPDATE（M6：已存在者只读）
  assert.equal(/capability\.update/.test(body), false, '回流路径不得 UPDATE Capability');

  // ③ Capability 的 status='CONFIRMED' 写入点全库唯一，且位于 confirm 内
  const writes = [...src.matchAll(/capability\.update(?:Many)?\(\{[\s\S]{0,200}?status: 'CONFIRMED'/g)];
  assert.equal(writes.length, 1, 'Capability 的 CONFIRMED 写入点应唯一');
  const at = writes[0].index ?? -1;
  const confirmStart = src.indexOf('async confirm(id, userId)');
  const declareStart = src.indexOf('async declareFromProjectArtifact');
  assert.ok(at > confirmStart && at < declareStart, '唯一写入点必须位于 confirm 内');
});

// ─── Provider：零 LLM ─────────────────────────────────────────────────

test('Provider：A2-1 全链路 provider calls = 0，且 deps 无 provider 端口', async () => {
  const u = await signUp('zero');
  const { draft, artifact } = await seedResult(u.userId);
  const before = await prisma.llmUsage.count({ where: { userId: u.userId } });

  const r1 = await handlers.declare(
    postJson(declareUrl(draft.id), declareBody(artifact.id, `k_zero_${stamp}`), u.token), draft.id);
  assert.equal(r1.status, 201);

  assert.equal(await prisma.llmUsage.count({ where: { userId: u.userId } }), before, 'A2-1 不得产生任何 LLM 用量记录');
  assert.equal('provider' in deps, false);
  assert.deepEqual(Object.keys(deps).sort(), ['actionPlans', 'auth', 'capabilities', 'clock', 'projectResults']);

  await cleanup(u.userId);
});
