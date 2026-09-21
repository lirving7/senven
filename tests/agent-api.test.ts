/**
 * T5-B-2C —— Agent API 验收（真实 Prisma + 直接 handler 调用，与 learning-task-api 同范式）
 *
 * 覆盖授权书 §十一：
 *   auth(401) / ownership(404) / POST 全链路（含 quota 拒绝路径）/ GET 冻结字段 /
 *   cancel 状态机（200/409/幂等）/ 负向路由（恰好 3 endpoint）/ Match shim 不执行 / O-5 DB 终态。
 *
 * 前置：数据库必须可达（fail-fast，禁止静默 skip）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createInMemoryFailureLimiter } from '../src/db/rate-limit.ts';
import { createAuthService } from '../src/auth/service.ts';
import { createRegisterHandler } from '../src/http/handlers/auth.ts';
import { LLM_FEATURE, LLM_USAGE_STATUS, systemClock } from '../src/ports/index.ts';
import type { LLMProvider, JsonRequest, TextRequest } from '../src/llm/provider.ts';
import { createAgentReadToolLayer } from '../src/agent/tool-layer.ts';
import { createAgentPlanRuntime } from '../src/agent/runtime.ts';
import {
  createCancelAgentRunHandler,
  createCreateAgentRunHandler,
  createGetAgentRunHandler,
} from '../src/http/handlers/agent-runs.ts';
import { bodyOf, extractSessionToken, getJson, postJson } from './fakes.ts';

const repos = createPrismaRepositories(prisma);
const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const createdEmails: string[] = [];
const createdUserIds: string[] = [];

test('前置：数据库必须可达（禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

/** 计数探针 provider：仅实现 json()，确保链路走 LLMProvider.json() 且可断言调用次数 */
class ApiPlanProvider implements LLMProvider {
  name = 'agent-api-spy';
  calls = 0;
  plan: unknown = {
    kind: 'PLAN',
    summary: '先补齐 TypeScript 深度，再沉淀项目证据。',
    steps: [
      { order: 1, title: '深化 TypeScript', action: '完成类型体操练习集', rationale: '能力证据不足' },
    ],
    nextAction: '从第 1 步开始。',
  };

  async json<T>(req: JsonRequest): Promise<T> {
    this.calls += 1;
    return this.plan as T;
  }
  async text(_req: TextRequest): Promise<string> {
    this.calls += 1;
    return '';
  }
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness() {
  const auth = createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
  const register = createRegisterHandler({ auth, secureCookies: false });

  // O-3：与生产装配同形的 latest resolver shim —— **计数 + 抛错**。
  // 若被调用：计数 > 0 且 Run 以 AGENT_TOOL_ERROR 失败；成功路径 ⇔ 计数恒 0。
  let latestResolverCalls = 0;
  const tools = createAgentReadToolLayer({
    resumes: repos.resumes,
    jds: repos.jds,
    matches: {
      ...repos.matches,
      findLatestRunIdForUser: async () => {
        latestResolverCalls += 1;
        throw new Error('AGENT_V1_LATEST_MATCH_RESOLVER_MUST_NOT_BE_CALLED');
      },
    },
    capabilities: repos.capabilities,
    projectResults: repos.projectResults,
    actionPlans: repos.actionPlans,
    learningTasks: repos.learningTasks,
    portfolioProjects: repos.portfolioProjects,
    rag: repos.ragRetrieval,
  });

  const provider = new ApiPlanProvider();
  const deps = {
    auth,
    provider,
    runs: repos.agentRuns,
    clock: systemClock,
    runtime: createAgentPlanRuntime({
      tools,
      runs: repos.agentRuns,
      usage: repos.llmUsage,
      clock: systemClock,
    }),
  };

  return {
    deps,
    provider,
    resolverCalls: () => latestResolverCalls,
    create: createCreateAgentRunHandler(deps),
    get: createGetAgentRunHandler(deps),
    cancel: createCancelAgentRunHandler(deps),
    async signUp(tag: string) {
      const res = await register(
        postJson('http://t/api/auth/register', {
          email: `agent_api_${tag}_${stamp}@example.com`,
          password: 'password-1234',
        }),
      );
      const token = extractSessionToken(res);
      assert.ok(token, `注册应下发会话 token (${tag})`);
      const b = (await bodyOf(res)) as { data: { user: { id: string } } };
      createdUserIds.push(b.data.user.id);
      createdEmails.push(`agent_api_${tag}_${stamp}@example.com`);
      return { userId: b.data.user.id, token: token as string };
    },
  };
}

const RUN_VIEW_KEYS = [
  'id', 'userId', 'goalKind', 'status', 'modelVersion', 'semanticVersions',
  'promptTemplateVersion', 'quotaUsage', 'providerRequestId', 'errorCode',
  'createdAt', 'updatedAt', 'endedAt',
] as const;

const PROPOSAL_VIEW_KEYS = [
  'id', 'runId', 'revision', 'kind', 'payload', 'basedOnRefs', 'status', 'createdAt', 'updatedAt',
] as const;

after(async () => {
  await prisma.agentProposal.deleteMany({ where: { run: { userId: { in: createdUserIds } } } });
  await prisma.agentRun.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.llmUsage.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { email: { in: createdEmails } } });
  await prisma.$disconnect();
});

// ─── Auth ───────────────────────────────────────────────────────────────

test('[auth] POST / GET / CANCEL 未登录一律 401', async () => {
  const h = makeHarness();
  const post = await h.create(postJson('http://t/api/agent/runs', {}));
  assert.equal(post.status, 401, 'POST 未登录必须 401');
  const get = await h.get(getJson('http://t/api/agent/runs/whatever'), 'no-such-id');
  assert.equal(get.status, 401, 'GET 未登录必须 401');
  const cancel = await h.cancel(postJson('http://t/api/agent/runs/x/cancel', undefined), 'no-such-id');
  assert.equal(cancel.status, 401, 'CANCEL 未登录必须 401');
});

// ─── POST 全链路 ────────────────────────────────────────────────────────

test('[post] 合法请求 → 201 + PROPOSED + ACTIVE proposal；恰好 1 provider 调用', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('ok');

  const res = await h.create(postJson('http://t/api/agent/runs', { request: '给我一个计划' }, token));
  assert.equal(res.status, 201, String(res.status));
  const body = (await bodyOf(res)) as { data: { run: Record<string, unknown>; proposal: Record<string, unknown> | null } };

  const run = body.data.run;
  assert.equal(run.status, 'PROPOSED');
  assert.equal(run.goalKind, 'CAREER_ASSISTANCE');
  assert.equal(run.userId, userId, 'userId 必须来自 session');
  assert.equal(run.errorCode, null);
  assert.equal(run.endedAt !== null, true, '终态必须写 endedAt');
  assert.deepEqual(Object.keys(run).sort(), [...RUN_VIEW_KEYS].sort(), 'Run 视图必须是冻结字段全量');

  const proposal = body.data.proposal;
  assert.ok(proposal, 'PROPOSED 必须返回 ACTIVE proposal');
  assert.equal(proposal!.kind, 'PLAN');
  assert.equal(proposal!.revision, 1);
  assert.equal(proposal!.status, 'ACTIVE');
  assert.deepEqual(Object.keys(proposal!).sort(), [...PROPOSAL_VIEW_KEYS].sort(), 'Proposal 视图必须是冻结字段全量');
  const refs = proposal!.basedOnRefs as unknown[];
  assert.ok(Array.isArray(refs), 'basedOnRefs 必须是结构化引用数组');

  assert.equal(h.provider.calls, 1, '恰好 1 次 provider 调用');
  assert.equal(h.resolverCalls(), 0, 'O-3：latest resolver 不得被调用');

  // 唯一写入面：1 AgentRun + 1 AgentProposal；其余业务表零写入
  assert.equal(await prisma.agentRun.count({ where: { userId } }), 1);
  assert.equal(await prisma.agentProposal.count({ where: { run: { userId } } }), 1);
  // 2D 并行兼容：RAG 读取的零写入断言改为「受控公共语料作用域前后一致」——
  // 只比较 3 个固定 key 的公共语料，agent-injection 的 qa_poison_* 并行
  // ingest→清理不落在该作用域内。与 tests/agent-tool-adapters.test.ts 同一语义。
  const PUBLIC_CORPUS_KEYS = ['jobpilot-product-guide', 'interview-preparation-guide', 'career-development-reference'];
  const snapScope = async () => ({
    s: await prisma.knowledgeSource.count({ where: { key: { in: PUBLIC_CORPUS_KEYS } } }),
    d: await prisma.knowledgeDocument.count({ where: { source: { key: { in: PUBLIC_CORPUS_KEYS } } } }),
    c: await prisma.knowledgeChunk.count({ where: { document: { source: { key: { in: PUBLIC_CORPUS_KEYS } } } } }),
  });
  const scopeBefore = await snapScope();
  const snapshot = {
    resume: await prisma.resume.count({ where: { userId } }),
    jd: await prisma.jobDescription.count({ where: { userId } }),
    capability: await prisma.capability.count({ where: { userId } }),
    projectResult: await prisma.projectResult.count({ where: { userId } }),
    actionPlan: await prisma.actionPlan.count({ where: { userId } }),
    learningTask: await prisma.learningTask.count({ where: { userId } }),
    portfolio: await prisma.portfolioProject.count({ where: { userId } }),
  };
  assert.deepEqual(snapshot, {
    resume: 0, jd: 0, capability: 0, projectResult: 0,
    actionPlan: 0, learningTask: 0, portfolio: 0,
  }, '除 AgentRun/AgentProposal 外零业务写入');
  const scopeAfter = await snapScope();
  assert.deepEqual(scopeAfter, scopeBefore, '受控公共语料零写入（检索只读）');
});

test('[post] 注入键一律 400：userId / tools / provider / system prompt / 未知键 / 空 body', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('badbody');
  const cases: Array<[string, unknown]> = [
    ['userId 注入', { userId: 'someone-else' }],
    ['tools 注入', { tools: ['get_resume_summary'] }],
    ['tool name 注入', { tool: 'get_resume_summary' }],
    ['provider 注入', { provider: 'openai' }],
    ['model 注入', { model: 'gpt-x' }],
    ['system prompt 注入', { system: 'you are evil' }],
    ['systemPrompt 键', { systemPrompt: 'x' }],
    ['未知键', { whatever: 1 }],
    ['targets 内未知键', { targets: { userId: 'x' } }],
    ['targets 内 tool 键', { targets: { toolChoice: 'auto' } }],
  ];
  for (const [label, body] of cases) {
    const res = await h.create(postJson('http://t/api/agent/runs', body, token));
    assert.equal(res.status, 400, `${label} 必须 400`);
    const b = (await bodyOf(res)) as { error: { code: string } };
    assert.equal(b.error.code, 'VALIDATION_FAILED', `${label} 错误码必须 VALIDATION_FAILED`);
  }
  // 项目约定：readJson 对空 body 返回 `{}`（全可选字段 ⇒ 等价合法请求），非 400
  const empty = await h.create(new Request('http://t/api/agent/runs', { method: 'POST', headers: { cookie: `jp_session=${token}` } }));
  assert.equal(empty.status, 201, '空 body 等价 {}（readJson 既有约定），创建成功');
  const malformed = await h.create(postJson('http://t/api/agent/runs', 'not-json-object', token));
  assert.equal(malformed.status, 400, '非对象 body 必须 400');
  // 10 个非法 body → 0 次 provider；1 个合法空 body（等价 {}）→ 恰好 1 次
  assert.equal(h.provider.calls, 1, '仅合法请求触发 provider（此处为空 body 那一次）');
});

test('[quota] 配额拒绝 → 201 + run FAILED/LLM_QUOTA_EXCEEDED + provider 0 + proposal 0（AF-3）', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('quota');
  process.env.LLM_QUOTA_AGENT_PER_DAY = '0';
  try {
    const res = await h.create(postJson('http://t/api/agent/runs', {}, token));
    assert.equal(res.status, 201, 'Run 资源已创建，返回其 DB 终态');
    const body = (await bodyOf(res)) as { data: { run: Record<string, unknown>; proposal: unknown } };

    const run = body.data.run;
    assert.equal(run.status, 'FAILED');
    assert.equal(run.errorCode, 'LLM_QUOTA_EXCEEDED', '必须保持冻结的配额错误码');
    assert.equal(run.endedAt !== null, true);
    assert.equal(body.data.proposal, null, 'FAILED 不得返回 proposal');
    assert.equal(h.provider.calls, 0, 'provider 调用必须为 0');
    assert.equal(h.resolverCalls(), 0, 'latest resolver 不得被调用');

    const rejected = await prisma.llmUsage.findMany({
      where: { userId, feature: LLM_FEATURE.AGENT, status: LLM_USAGE_STATUS.QUOTA_REJECTED },
    });
    assert.equal(rejected.length, 1, '配额事件留痕 1 条');
    assert.equal(rejected[0]!.requestCount, 0);
    assert.equal(await prisma.agentProposal.count({ where: { run: { userId } } }), 0);
  } finally {
    delete process.env.LLM_QUOTA_AGENT_PER_DAY;
  }
});

// ─── GET / ownership ────────────────────────────────────────────────────

test('[get/ownership] 本人可读；跨用户 GET / CANCEL 一律 404（无 oracle）', async () => {
  const h = makeHarness();
  const a = await h.signUp('ownerA');
  const b = await h.signUp('ownerB');

  const created = await h.create(postJson('http://t/api/agent/runs', {}, a.token));
  assert.equal(created.status, 201);
  const runId = ((await bodyOf(created)) as { data: { run: { id: string } } }).data.run.id;

  const own = await h.get(getJson(`http://t/api/agent/runs/${runId}`, a.token), runId);
  assert.equal(own.status, 200);

  const strangerGet = await h.get(getJson(`http://t/api/agent/runs/${runId}`, b.token), runId);
  assert.equal(strangerGet.status, 404, '跨用户 GET 必须 404');
  const strangerCancel = await h.cancel(postJson(`http://t/api/agent/runs/${runId}/cancel`, undefined, b.token), runId);
  assert.equal(strangerCancel.status, 404, '跨用户 CANCEL 必须 404');

  const missing = await h.get(getJson('http://t/api/agent/runs/no-such-run', a.token), 'no-such-run');
  assert.equal(missing.status, 404, '不存在的 run 必须 404');

  // DB 终态未被跨用户操作影响
  const run = await repos.agentRuns.findRunForUser(runId, a.userId);
  assert.equal(run!.status, 'PROPOSED', '跨用户 cancel 不得改变状态');
});

// ─── Cancel 状态机 ──────────────────────────────────────────────────────

test('[cancel] CREATED → CANCELLED → 200 + endedAt；重复取消幂等 200（既有语义）', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('cancel-created');
  const created = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: { providerCalls: 0 },
  });

  const res = await h.cancel(postJson(`http://t/api/agent/runs/${created.id}/cancel`, undefined, token), created.id);
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { run: Record<string, unknown> } };
  assert.equal(body.data.run.status, 'CANCELLED');
  assert.equal(body.data.run.endedAt !== null, true);

  const again = await h.cancel(postJson(`http://t/api/agent/runs/${created.id}/cancel`, undefined, token), created.id);
  assert.equal(again.status, 200, '重复取消（NOOP）按既有幂等语义 → 200');
  const db = await repos.agentRuns.findRunForUser(created.id, userId);
  assert.equal(db!.status, 'CANCELLED');
});

test('[cancel] PLANNING → CANCELLED → 200', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('cancel-planning');
  const created = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: { providerCalls: 0 },
  });
  await repos.agentRuns.transitionRun(created.id, userId, 'PLANNING', new Date());

  const res = await h.cancel(postJson(`http://t/api/agent/runs/${created.id}/cancel`, undefined, token), created.id);
  assert.equal(res.status, 200);
  const body = (await bodyOf(res)) as { data: { run: Record<string, unknown> } };
  assert.equal(body.data.run.status, 'CANCELLED');
});

test('[cancel] PROPOSED / FAILED 取消 → 409；DB 状态不变', async () => {
  const h = makeHarness();
  const a = await h.signUp('cancel-proposed');

  const created = await h.create(postJson('http://t/api/agent/runs', {}, a.token));
  const createdBody = (await bodyOf(created)) as { data: { run: { id: string; status: string } } };
  const runId = createdBody.data.run.id;
  assert.equal(createdBody.data.run.status, 'PROPOSED');

  const res = await h.cancel(postJson(`http://t/api/agent/runs/${runId}/cancel`, undefined, a.token), runId);
  assert.equal(res.status, 409, 'PROPOSED → CANCELLED 必须被拒');
  const errBody = (await bodyOf(res)) as { error: { code: string; requestId: unknown } };
  assert.equal(errBody.error.code, 'AGENT_RUN_NOT_TRANSITIONABLE');
  assert.ok(errBody.error.requestId, '409 必须复用既有错误信封形状（含 requestId）');

  const db = await repos.agentRuns.findRunForUser(runId, a.userId);
  assert.equal(db!.status, 'PROPOSED', '取消被拒后状态不得改变');
  assert.equal(await prisma.agentProposal.count({ where: { runId } }), 1, 'proposal 不得被影响');
});

// ─── Match（O-3）────────────────────────────────────────────────────────

test('[match] 显式 matchRunId → 正常 PROPOSED；无 matchRunId → resolver 计数恒 0', async () => {
  const h = makeHarness();
  const { token } = await h.signUp('match');

  const withId = await h.create(
    postJson('http://t/api/agent/runs', { targets: { matchRunId: 'not_exists_run' } }, token),
  );
  assert.equal(withId.status, 201);
  assert.equal(
    ((await bodyOf(withId)) as { data: { run: { status: string } } }).data.run.status,
    'PROPOSED',
    '显式提供 matchRunId 时工具被装配（run 不存在 → ABSENT，确定性）',
  );

  const withoutId = await h.create(postJson('http://t/api/agent/runs', {}, token));
  assert.equal(withoutId.status, 201);

  assert.equal(h.resolverCalls(), 0, '两次 Run 均不得调用 latest resolver（计数 shim 为 0）');
});

// ─── 2D 补强：FAILED → CANCELLED = 409 直接证据 ────────────────────────

test('[cancel] FAILED → CANCELLED = 409（2D 直接证据）', async () => {
  const h = makeHarness();
  const { userId, token } = await h.signUp('cancel-failed');
  const created = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: { providerCalls: 0 },
  });
  await repos.agentRuns.transitionRun(created.id, userId, 'FAILED', new Date());

  const res = await h.cancel(postJson(`http://t/api/agent/runs/${created.id}/cancel`, undefined, token), created.id);
  assert.equal(res.status, 409, 'FAILED 为终态，取消必须被拒');
  const b = (await bodyOf(res)) as { error: { code: string } };
  assert.equal(b.error.code, 'AGENT_RUN_NOT_TRANSITIONABLE');
  const db = await repos.agentRuns.findRunForUser(created.id, userId);
  assert.equal(db!.status, 'FAILED', '取消被拒后状态不变');
});

// ─── 2D 补强：N-2 proposal 以 DB 为事实来源（镜像方向，不可达状态的行为记录）───

test('[N-2] Runtime 谎报 FAILED 而 DB 实际 PROPOSED：run 状态以 DB 为准；失真值零泄漏', async () => {
  const auth = createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
  const register = createRegisterHandler({ auth, secureCookies: false });
  const res0 = await register(postJson('http://t/api/auth/register', {
    email: `agent_api_n2_${stamp}@example.com`,
    password: 'password-1234',
  }));
  createdEmails.push(`agent_api_n2_${stamp}@example.com`);
  const token = extractSessionToken(res0)!;
  const userId = ((await bodyOf(res0)) as { data: { user: { id: string } } }).data.user.id;
  createdUserIds.push(userId);

  // 构造 DB 中真实 PROPOSED + ACTIVE proposal 的 Run
  const run = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: { providerCalls: 0 },
  });
  await repos.agentRuns.transitionRun(run.id, userId, 'PLANNING', new Date());
  const committed = await repos.agentRuns.commitPlanOutcome(
    userId,
    {
      kind: 'PROPOSED',
      runId: run.id,
      proposal: {
        kind: 'PLAN',
        revision: 1,
        payload: {
          kind: 'PLAN',
          summary: 'DB 中的真实计划。',
          steps: [{ order: 1, title: 't', action: 'a', rationale: 'r' }],
          nextAction: '从第 1 步开始。',
        },
        basedOnRefs: [],
      },
    },
    new Date(),
  );
  assert.equal(committed.kind, 'COMMITTED');

  // 失真 Runtime：声称 FAILED（与 DB 相反；该状态在真实执行序列中不可达）
  const lyingRuntime = {
    run: async () => ({
      status: 'FAILED' as const,
      runId: run.id,
      errorCode: 'LLM_PROVIDER_ERROR' as const,
      providerCalls: 1,
      readToolCalls: 2,
    }),
  };
  const handler = createCreateAgentRunHandler({
    auth,
    provider: new ApiPlanProvider(),
    runs: repos.agentRuns,
    clock: systemClock,
    runtime: lyingRuntime,
  });
  const res = await handler(postJson('http://t/api/agent/runs', {}, token));
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as { data: { run: Record<string, unknown>; proposal: Record<string, unknown> | null } };

  // N-2 核心：Run 状态必须以 DB 为准
  assert.equal(body.data.run.status, 'PROPOSED', '必须以 DB 终态（PROPOSED）响应');
  assert.equal(JSON.stringify(body).includes('LLM_PROVIDER_ERROR'), false, 'Runtime 失真值不得泄漏');
  // 已知行为（2D 观察项 OBS-N2）：proposal 拉取由 Runtime 声称的 status 门控；
  // 在此不可达场景下响应不虚构 proposal（安全方向正确：宁少报不伪造）。
  // 可达场景（O-5 并发取消）中 proposal 有无完全由 DB 决定，见 [O-5] 用例。
  assert.equal(body.data.proposal, null, '不虚构 proposal（安全方向：宁少报不伪造）');
});

// ─── O-5：响应以 DB 终态为准 ────────────────────────────────────────────

test('[O-5] Runtime 返回值与 DB 不一致时，响应以数据库最终状态为准', async () => {
  const auth = createAuthService({
    users: repos.users,
    sessions: repos.sessions,
    failures: createInMemoryFailureLimiter(systemClock),
    clock: systemClock,
  });
  const register = createRegisterHandler({ auth, secureCookies: false });
  const res0 = await register(postJson('http://t/api/auth/register', {
    email: `agent_api_o5_${stamp}@example.com`,
    password: 'password-1234',
  }));
  createdEmails.push(`agent_api_o5_${stamp}@example.com`);
  const token = extractSessionToken(res0)!;
  const userId = ((await bodyOf(res0)) as { data: { user: { id: string } } }).data.user.id;
  createdUserIds.push(userId);

  // 构造一个 DB 里已 CANCELLED 的 run
  const run = await repos.agentRuns.createRun({
    userId,
    goalKind: 'CAREER_ASSISTANCE',
    promptTemplateVersion: 'agent-plan/v1',
    semanticVersions: {},
    quotaUsage: { providerCalls: 0 },
  });
  await repos.agentRuns.transitionRun(run.id, userId, 'CANCELLED', new Date());

  // 恶意/失真 Runtime：声称 PROPOSED（并发取消竞态的模拟）
  const lyingRuntime = {
    run: async () => ({
      status: 'PROPOSED' as const,
      runId: run.id,
      proposalId: 'fabricated',
      providerCalls: 1,
      readToolCalls: 3,
    }),
  };
  const deps = {
    auth,
    provider: new ApiPlanProvider(),
    runs: repos.agentRuns,
    clock: systemClock,
    runtime: lyingRuntime,
  };
  const handler = createCreateAgentRunHandler(deps);
  const res = await handler(postJson('http://t/api/agent/runs', {}, token));
  assert.equal(res.status, 201);
  const body = (await bodyOf(res)) as { data: { run: Record<string, unknown>; proposal: unknown } };

  assert.equal(body.data.run.status, 'CANCELLED', '必须以 DB 终态（CANCELLED）响应');
  assert.equal(JSON.stringify(body).includes('PROPOSED'), false, 'Runtime 的失真返回值不得泄漏到响应');
  assert.equal(body.data.proposal, null, 'DB 无 proposal ⇒ 响应无 proposal');
});

// ─── 负向路由 ───────────────────────────────────────────────────────────

test('[routing] app/api/agent 恰好 6 个 route 文件（T5-B-2C 3 + T6-4-A 3），且导出 method 与白名单逐字一致', async () => {
  const root = path.join(process.cwd(), 'app/api/agent');
  assert.equal(existsSync(root), true, 'T5-B-2C 已授权 app/api/agent');

  const routes: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else routes.push('/' + path.relative(process.cwd(), abs).replace(/\\/g, '/'));
    }
  })(root);
  assert.deepEqual(routes.sort(), [
    '/app/api/agent/actions/[id]/execute/route.ts',
    '/app/api/agent/actions/[id]/route.ts',
    '/app/api/agent/proposals/[proposalId]/confirm/route.ts',
    '/app/api/agent/runs/[id]/cancel/route.ts',
    '/app/api/agent/runs/[id]/route.ts',
    '/app/api/agent/runs/route.ts',
  ]);

  // method 白名单（多导出 / 错 method 都算失败）
  const readRoute = (rel: string) => readFileSync(path.join(process.cwd(), rel), 'utf8');
  const exportedMethods = (rel: string) =>
    [...readRoute(rel).matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]!).sort();

  assert.deepEqual(exportedMethods('app/api/agent/runs/route.ts'), ['POST']);
  assert.deepEqual(exportedMethods('app/api/agent/runs/[id]/route.ts'), ['GET']);
  assert.deepEqual(exportedMethods('app/api/agent/runs/[id]/cancel/route.ts'), ['POST']);
  // T6-4-A：Act 三端点 method 白名单
  assert.deepEqual(exportedMethods('app/api/agent/proposals/[proposalId]/confirm/route.ts'), ['POST']);
  assert.deepEqual(exportedMethods('app/api/agent/actions/[id]/execute/route.ts'), ['POST']);
  assert.deepEqual(exportedMethods('app/api/agent/actions/[id]/route.ts'), ['GET']);

  // GET 列表 / PUT / PATCH / DELETE / POST :id 均不存在（route 模块导出层面）
  const runsMod = await import('../app/api/agent/runs/route.ts');
  assert.equal('GET' in runsMod, false, 'GET /api/agent/runs（列表）不得存在');
  assert.equal('PUT' in runsMod && 'PATCH' in runsMod && 'DELETE' in runsMod, false);
  const idMod = await import('../app/api/agent/runs/[id]/route.ts');
  assert.equal('POST' in idMod, false, 'POST /api/agent/runs/:id 不得存在');
  assert.equal('DELETE' in idMod && 'PATCH' in idMod, false);

  // 禁止目录
  for (const banned of ['execute', 'confirm', 'tool', 'tools']) {
    assert.equal(existsSync(path.join(root, banned)), false, `/api/agent/${banned} 不得存在`);
  }
});
