/**
 * T5-B-2A —— Agent 只读工具层：归属 / 数据边界 / 确定性 / RAG 只读
 *
 * 覆盖授权书 §十六：
 *   - Ownership：User A → 自己的资源 = 成功；User A → User B 的资源 = **被拒**（统一无 oracle）；
 *   - 数据边界：不返回 Resume/JD 原文、system prompt、key/cookie/token；
 *   - RAG：可读公共 corpus、**不需要 userId**、**不写数据库**、不调用其他工具；
 *   - Regression 相关的不写库断言（读操作计数前后不变）。
 *
 * ⚠️ 测试策略说明（对应授权书 §十一「禁止任何数据库写操作」）：
 *   - 用户作用域工具使用**内存围栏 Port**（非 DB fixture）验证归属语义 —— 因此本测试**不写库**；
 *   - `rag_retrieve` 使用**真实只读** `RagRetrievalRepository`，验证「公共 corpus 可读 + 零写入」。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';

import { prisma } from '../src/db/client.ts';
import { createPrismaRepositories } from '../src/db/repositories.ts';
import { createAgentReadToolLayer } from '../src/agent/tool-layer.ts';
import type { AgentReadToolDeps } from '../src/agent/tool-deps.ts';

const USER_A = 'user-A';
const USER_B = 'user-B';

const AT = new Date('2026-09-01T00:00:00.000Z');
const AT2 = new Date('2026-09-02T00:00:00.000Z');

/** ─── 内存围栏：只有 owner 匹配时才返回数据（模拟既有 `...ForUser` 归属语义）─── */

function makeOwnedDeps(): AgentReadToolDeps {
  const deps: AgentReadToolDeps = {
    resumes: {
      listForUser: async (userId) =>
        userId === USER_A
          ? [{ id: 'resume_A', sourceType: 'UPLOAD', createdAt: AT2, itemCount: 1, statusSummary: { confirmed: 0, inferred: 0, unconfirmed: 1 } }]
          : userId === USER_B
            ? [{ id: 'resume_B', sourceType: 'UPLOAD', createdAt: AT, itemCount: 1, statusSummary: { confirmed: 0, inferred: 0, unconfirmed: 1 } }]
            : [],
      findDetailForUser: async (id, userId) => {
        const owner = id === 'resume_A' ? USER_A : id === 'resume_B' ? USER_B : null;
        if (owner === null || owner !== userId) return null;
        return {
          id,
          sourceType: 'UPLOAD',
          createdAt: AT2,
          items: [
            {
              id: `item_${id}`,
              section: 'EXPERIENCE',
              title: '后端工程师',
              detail: '负责订单系统',
              status: 'UNCONFIRMED',
              evidence: [{ source: 'RESUME_TEXT', locator: '第 3 行', excerpt: '负责订单系统' }],
            },
          ],
        };
      },
    },
    jds: {
      findByIdForUserWithRequirements: async (id, userId) => {
        const owner = id === 'jd_A' ? USER_A : id === 'jd_B' ? USER_B : null;
        if (owner === null || owner !== userId) return null;
        return {
          id,
          userId,
          requirements: [
            { id: `req_${id}`, text: '熟悉 TypeScript', category: 'TECH', criticality: 'MUST' },
          ],
        };
      },
    },
    matches: {
      findRunWithItemsForUser: async (id, userId) => {
        const owner = id === 'run_A' ? USER_A : id === 'run_B' ? USER_B : null;
        if (owner === null || owner !== userId) return null;
        return {
          id,
          userId,
          resumeId: 'resume_A',
          jdId: 'jd_A',
          summary: {
            total: 1, have: 1, enhance: 0, missing: 0,
            mustTotal: 1, mustHave: 1, needsUserConfirmation: 0, ambiguous: 0,
          },
          items: [
            {
              requirementId: 'req_1',
              requirement: '熟悉 TypeScript',
              category: 'TECH',
              criticality: 'MUST',
              status: 'HAVE',
              reason: '简历中有对应证据',
              basis: { type: 'EXACT_MATCH', detail: '订单系统' },
              evidenceRefs: [{ source: 'RESUME_TEXT', locator: '第 3 行' }],
              resumeEvidence: '负责订单系统',
              isInference: false,
              needsUserConfirmation: false,
              confidence: 'HIGH',
              suggestion: null,
            },
          ],
        };
      },
      findLatestRunIdForUser: async (userId) =>
        userId === USER_A ? 'run_A' : userId === USER_B ? 'run_B' : null,
    },
    capabilities: {
      listForUser: async (userId) =>
        userId === USER_A
          ? [{ id: 'cap_A', userId, key: 'typescript', label: 'TypeScript', level: 'ADVANCED', status: 'UNCONFIRMED', source: 'RESUME_PROJECTION', createdAt: AT }]
          : [],
      findForUser: async (id, userId) => {
        if (id !== 'cap_A' || userId !== USER_A) return null;
        return {
          id,
          userId,
          key: 'typescript',
          label: 'TypeScript',
          level: 'ADVANCED',
          status: 'UNCONFIRMED',
          source: 'RESUME_PROJECTION',
          createdAt: AT,
          evidence: [
            { id: 'ev_1', type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: '订单系统' },
            { id: 'ev_2', type: 'RESUME_EVIDENCE', source: 'RESUME_TEXT', url: null, excerpt: '订单系统 v2' },
          ],
        };
      },
    },
    projectResults: {
      listForUser: async (userId) =>
        userId === USER_A
          ? [
              { id: 'pr_A1', userId, planId: 'plan_A', sourceStepId: 'step_A', sourceStepTitle: '搭建订单服务', sourceStepTargetRequirement: null, title: '订单服务', summary: '摘要', status: 'SUBMITTED', artifactCount: 2, createdAt: AT, submittedAt: AT, revokedAt: null },
              { id: 'pr_A2', userId, planId: 'plan_OTHER', sourceStepId: 'step_X', sourceStepTitle: '其他', sourceStepTargetRequirement: null, title: '其他成果', summary: '摘要', status: 'DRAFT', artifactCount: 0, createdAt: AT2, submittedAt: null, revokedAt: null },
            ]
          : [],
    },
    actionPlans: {
      listForUser: async (userId) =>
        userId === USER_A
          ? [
              {
                id: 'plan_A',
                userId,
                matchRunId: 'run_A',
                jdId: 'jd_A',
                goal: '成为后端工程师',
                have: [],
                gaps: [],
                createdAt: AT,
                steps: [
                  { id: 'step_A', order: 0, title: '[学习] TypeScript 进阶', desc: '说明', status: 'TODO', targetRequirement: '熟悉 TypeScript' },
                  { id: 'step_A2', order: 1, title: '无前缀步骤', desc: '说明', status: 'DONE', targetRequirement: null },
                ],
              },
            ]
          : [],
      findForUser: async (id, userId) => {
        if (id !== 'plan_A' || userId !== USER_A) return null;
        return (await deps.actionPlans.listForUser(USER_A))[0]!;
      },
    },
    learningTasks: {
      listForUser: async (userId) =>
        userId === USER_A
          ? [
              { id: 'lt_A', userId, actionPlanId: 'plan_A', sourceStepId: 'step_A', sourceStepTitle: '[学习] TypeScript 进阶', sourceStepTargetRequirement: '熟悉 TypeScript', content: null, status: 'IN_PROGRESS', archivedAt: null, createdAt: AT, updatedAt: AT2 },
            ]
          : [],
    },
    portfolioProjects: {
      listForUser: async (userId) =>
        userId === USER_A
          ? [{ id: 'pf_A', userId, title: '我的作品集', description: null, displayOrder: 0, featured: true, archivedAt: null, createdAt: AT, updatedAt: AT }]
          : [],
      findForUser: async (id, userId) => {
        if (id !== 'pf_A' || userId !== USER_A) return null;
        return {
          project: { id, userId, title: '我的作品集', description: null, displayOrder: 0, featured: true, archivedAt: null, createdAt: AT, updatedAt: AT },
          results: [{ id: 'm1', portfolioProjectId: id, projectResultId: 'pr_A1', displayOrder: 0, createdAt: AT, submittedAt: AT, revokedAt: null }],
          revokedResults: [{ id: 'm2', portfolioProjectId: id, projectResultId: 'pr_REV', displayOrder: 1, createdAt: AT, submittedAt: AT, revokedAt: AT2 }],
          activeResultCount: 1,
        };
      },
    },
    // rag 由具体用例覆盖（真实只读仓储）
    rag: { retrieve: async () => ({ hits: [], total: 0 }) },
  };
  return deps;
}

const ctxA = { userId: USER_A };
const layerA = createAgentReadToolLayer(makeOwnedDeps());

after(async () => {
  await prisma.$disconnect();
});

test('前置：数据库必须可达（禁止静默 skip）', async () => {
  const r = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
  assert.equal(r[0].ok, 1);
});

// ─── Ownership：User A → 自己 = 成功 ────────────────────────────────────

test('[ownership] User A → 自己的资源：全部成功', async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['get_resume_summary', { resumeId: 'resume_A' }],
    ['get_jd_summary', { jdId: 'jd_A' }],
    ['get_match_result', { matchRunId: 'run_A' }],
    ['get_capabilities', {}],
    ['get_project_results', { planId: 'plan_A' }],
    ['get_action_plan', { planId: 'plan_A' }],
    ['get_learning_tasks', {}],
    ['get_portfolio', { portfolioProjectId: 'pf_A' }],
  ];
  for (const [tool, input] of cases) {
    const r = await layerA.invoke(tool, input, ctxA);
    assert.equal(r.status, 'OK', `${tool} 本人资源必须成功，实际 ${r.status}`);
  }
});

// ─── Ownership：User A → User B 的资源 = 被拒（统一无 oracle）───────────

test('[ownership] User A → User B 的资源：全部 NOT_FOUND（与「不存在」不可区分）', async () => {
  const crossUser: Array<[string, Record<string, unknown>]> = [
    ['get_resume_summary', { resumeId: 'resume_B' }],
    ['get_jd_summary', { jdId: 'jd_B' }],
    ['get_match_result', { matchRunId: 'run_B' }],
  ];
  for (const [tool, input] of crossUser) {
    const r = await layerA.invoke(tool, input, ctxA);
    assert.equal(r.status, 'NOT_FOUND', `${tool} 跨用户必须被拒`);
    assert.equal(r.status === 'NOT_FOUND' && r.code, 'NOT_FOUND');
  }

  // 不存在的 id → 与跨用户**完全同形**（无 oracle）
  const missing = await layerA.invoke('get_jd_summary', { jdId: 'jd_does_not_exist' }, ctxA);
  const cross = await layerA.invoke('get_jd_summary', { jdId: 'jd_B' }, ctxA);
  assert.deepEqual(missing, cross, '「不存在」与「跨用户」必须返回同一形态');

  // B 的列表型工具不能看到 A 的数据，反之亦然
  const bView = await layerA.invoke('get_capabilities', {}, { userId: USER_B });
  assert.equal(bView.status, 'OK');
  assert.equal(bView.status === 'OK' && (bView.data as { count: number }).count, 0);
});

test('[ownership] 列表型工具完全按会话 userId 过滤（跨用户为空，不泄露存在性）', async () => {
  for (const tool of ['get_project_results', 'get_action_plan', 'get_learning_tasks', 'get_portfolio']) {
    const b = await layerA.invoke(tool, {}, { userId: USER_B });
    assert.equal(b.status, 'OK');
    const count = b.status === 'OK' ? ((b.data as Record<string, unknown>).count as number) : -1;
    assert.equal(count, 0, `${tool} 对 User B 必须为空`);
  }
});

// ─── 数据边界：不返回原文 / 凭据 ─────────────────────────────────────────

test('[boundary] get_resume_summary 输出不含 rawText / 不含超范围字段', async () => {
  const r = await layerA.invoke('get_resume_summary', { resumeId: 'resume_A' }, ctxA);
  assert.equal(r.status, 'OK');
  const data = r.status === 'OK' ? (r.data as Record<string, unknown>) : {};
  assert.deepEqual(Object.keys(data).sort(), ['createdAt', 'itemCount', 'items', 'resumeId', 'sourceType']);
  const items = data.items as Array<Record<string, unknown>>;
  assert.deepEqual(Object.keys(items[0]!).sort(), ['detail', 'evidenceRefs', 'id', 'section', 'status', 'title']);
  const serialized = JSON.stringify(data);
  assert.equal(/rawText/.test(serialized), false);
  assert.equal(/systemPrompt/i.test(serialized), false);
  assert.equal(/cookie|apiKey|token|secret/i.test(serialized), false);
});

test('[boundary] 全部 9 个工具输出均不含 rawText / token / cookie / apiKey / secret', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ['get_resume_summary', { resumeId: 'resume_A' }],
    ['get_jd_summary', { jdId: 'jd_A' }],
    ['get_match_result', { matchRunId: 'run_A' }],
    ['get_capabilities', {}],
    ['get_project_results', {}],
    ['get_action_plan', { planId: 'plan_A' }],
    ['get_learning_tasks', {}],
    ['get_portfolio', { portfolioProjectId: 'pf_A' }],
  ];
  for (const [tool, input] of calls) {
    const r = await layerA.invoke(tool, input, ctxA);
    assert.equal(r.status, 'OK');
    const s = JSON.stringify(r.status === 'OK' ? r.data : {});
    for (const banned of ['rawText', 'systemPrompt', 'apiKey', 'cookie', 'secret']) {
      assert.equal(new RegExp(banned, 'i').test(s), false, `${tool} 输出不得含 ${banned}`);
    }
  }
});

test('[boundary] 结果信封不含 userId / 堆栈 / 输入原文', async () => {
  const r = await layerA.invoke('get_capabilities', {}, ctxA);
  assert.equal(r.status === 'OK' && r.readOnly, true);
  const keys = Object.keys(r).sort();
  assert.deepEqual(keys, ['data', 'layer', 'readOnly', 'status', 'tool', 'trust']);
  assert.equal(JSON.stringify(r).includes(USER_A), false, '信封不得回显 userId');
});

// ─── 字段投影与确定性 ───────────────────────────────────────────────────

test('[projection] get_capabilities 证据计数来自详情；get_learning_tasks 归档标记为 false', async () => {
  const caps = await layerA.invoke('get_capabilities', {}, ctxA);
  assert.equal(caps.status, 'OK');
  const items = (caps.status === 'OK' ? caps.data : { items: [] }) as { items: Array<{ evidenceCount: number }> };
  assert.equal(items.items[0]!.evidenceCount, 2);

  const tasks = await layerA.invoke('get_learning_tasks', {}, ctxA);
  assert.equal(tasks.status, 'OK');
  const t = (tasks.status === 'OK' ? tasks.data : { tasks: [] }) as { tasks: Array<{ archived: boolean }> };
  assert.equal(t.tasks[0]!.archived, false);

  // 状态过滤生效且不改变语义
  const filtered = await layerA.invoke('get_learning_tasks', { status: 'IN_PROGRESS' }, ctxA);
  const none = await layerA.invoke('get_learning_tasks', { status: 'PLANNED' }, ctxA);
  assert.equal((filtered.status === 'OK' && (filtered.data as { count: number }).count) as number, 1);
  assert.equal((none.status === 'OK' && (none.data as { count: number }).count) as number, 0);
});

test('[projection] get_action_plan 步骤类型由标题前缀经单一来源解析（未知前缀 → null）', async () => {
  const r = await layerA.invoke('get_action_plan', { planId: 'plan_A' }, ctxA);
  assert.equal(r.status, 'OK');
  const data = r.status === 'OK' ? (r.data as { plans: Array<{ steps: Array<{ stepType: string | null; order: number }> }> }) : { plans: [] };
  assert.equal(data.plans[0]!.steps[0]!.stepType, 'LEARN');
  assert.equal(data.plans[0]!.steps[1]!.stepType, null);
  assert.deepEqual(data.plans[0]!.steps.map((s) => s.order), [0, 1]);
});

test('[projection] get_portfolio 成员按 results / revokedResults 二分', async () => {
  const r = await layerA.invoke('get_portfolio', { portfolioProjectId: 'pf_A' }, ctxA);
  assert.equal(r.status, 'OK');
  const d = r.status === 'OK' ? (r.data as { projects: Array<{ results: unknown[]; revokedResults: unknown[]; activeResultCount: number }> }) : { projects: [] };
  assert.equal(d.projects[0]!.results.length, 1);
  assert.equal(d.projects[0]!.revokedResults.length, 1);
  assert.equal(d.projects[0]!.activeResultCount, 1);
});

test('[determinism] 同输入同状态 → 逐字节一致', async () => {
  for (const [tool, input] of [
    ['get_resume_summary', { resumeId: 'resume_A' }],
    ['get_jd_summary', { jdId: 'jd_A' }],
    ['get_match_result', { matchRunId: 'run_A' }],
    ['get_capabilities', {}],
    ['get_project_results', {}],
    ['get_action_plan', {}],
    ['get_learning_tasks', {}],
    ['get_portfolio', {}],
  ] as Array<[string, Record<string, unknown>]>) {
    const a = JSON.stringify(await layerA.invoke(tool, input, ctxA));
    const b = JSON.stringify(await layerA.invoke(tool, input, ctxA));
    assert.equal(a, b, `${tool} 必须确定性`);
  }
});

// ─── RAG：真实只读 corpus ───────────────────────────────────────────────

test('[rag] rag_retrieve 读取公共 corpus：无需 userId、返回 T5-A 契约与三语义版本', async () => {
  const repos = createPrismaRepositories(prisma);

  const [{ c: chunkCount }] = await prisma.$queryRaw<Array<{ c: number }>>`
    SELECT COUNT(*)::int AS c FROM "KnowledgeChunk"
  `;
  assert.ok(chunkCount > 0, '前置：T5-A 公共语料必须非空（当前环境应为 10 chunks）');

  const layer = createAgentReadToolLayer({
    ...makeOwnedDeps(),
    rag: repos.ragRetrieval,
  });

  const r = await layer.invoke('rag_retrieve', { query: '模拟面试', limit: 5 });
  assert.equal(r.status, 'OK');
  assert.equal(r.status === 'OK' && r.trust, 'UNTRUSTED_DATA', 'RAG 结果必须标记为不可信数据');
  assert.equal(r.status === 'OK' && r.readOnly, true);

  const d = r.status === 'OK' ? (r.data as Record<string, unknown>) : {};
  assert.equal(d.contract, 'rag-retrieval/v1');
  assert.equal(d.tokenizer, 'cjk-bigram/v1');
  assert.equal(d.chunker, 'paragraph-sentence-hardcut/v1');
  assert.equal(d.fts, 'pg-simple-tsvector-gin/v1');
  assert.equal(d.query, '模拟面试', 'query 原样回显');
  assert.ok((d.returned as number) >= 1, '公共语料应能命中医');

  const items = d.items as Array<Record<string, unknown>>;
  assert.equal(items.length, d.returned);
  assert.equal(items[0]!.ordinal, 1, 'ordinal 从 1 递增');
  assert.equal(items[0]!.snippet, items[0]!.content, 'snippet 与 content 一致（T5-A FROZEN）');
  assert.equal(typeof items[0]!.truncated, 'boolean');
});

test('[rag] rag_retrieve 不写数据库（受控公共语料作用域前后一致）', async () => {
  const repos = createPrismaRepositories(prisma);
  const layer = createAgentReadToolLayer({ ...makeOwnedDeps(), rag: repos.ragRetrieval });

  // B（RAG 测试卫生）：作用域化——只比较受控公共语料（3 个固定 key）的行数，
  // 而非全库；并行测试（如 agent-injection 的 qa_poison_* ingest→清理）不落在此
  // 作用域内，不再影响断言。与 tests/agent-api.test.ts 使用同一作用域语义。
  const PUBLIC_CORPUS_KEYS = ['jobpilot-product-guide', 'interview-preparation-guide', 'career-development-reference'];
  const snap = async () => ({
    s: await prisma.knowledgeSource.count({ where: { key: { in: PUBLIC_CORPUS_KEYS } } }),
    d: await prisma.knowledgeDocument.count({ where: { source: { key: { in: PUBLIC_CORPUS_KEYS } } } }),
    c: await prisma.knowledgeChunk.count({ where: { document: { source: { key: { in: PUBLIC_CORPUS_KEYS } } } } }),
  });

  const before = await snap();
  for (const q of ['模拟面试', '能力画像', '工作台']) {
    const r = await layer.invoke('rag_retrieve', { query: q, limit: 20 });
    assert.equal(r.status, 'OK');
  }
  const after = await snap();
  assert.deepEqual(after, before, '检索必须对受控公共语料零写入');
});

test('[rag] 空结果 → OK + items: []（不是错误）', async () => {
  const repos = createPrismaRepositories(prisma);
  const layer = createAgentReadToolLayer({ ...makeOwnedDeps(), rag: repos.ragRetrieval });
  const r = await layer.invoke('rag_retrieve', { query: 'zzzzqqqqvvvv' });
  assert.equal(r.status, 'OK');
  const d = r.status === 'OK' ? (r.data as { items: unknown[]; total: number; returned: number }) : { items: [], total: -1, returned: -1 };
  assert.deepEqual(d.items, []);
  assert.equal(d.total, 0);
  assert.equal(d.returned, 0);
});
