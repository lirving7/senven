/**
 * T5-B-2A —— Agent 只读工具层：9 个 Tool 适配器（**全部只读、服务端确定性**）
 *
 * 依据 ADR-017 §4 / §5 / §7：
 *   - 每个适配器只调用**既有只读 Port**（授权书 §五：不得新建第二套业务查询逻辑）；
 *   - 归属一律经既有 `...ForUser(id, userId)` —— userId 来自 `ctx`（会话注入），**绝不**来自输入；
 *   - 输出为**结构化、字段受限**的投影：不含 Resume/JD 原文、不含 system prompt / key / cookie / token
 *     （授权书 §十；ADR T5B-F-38 / F-49）；
 *   - `rag_retrieve` 结果标记为 **UNTRUSTED**（T5B-F-30），且**不得触发任何工具**（T5B-F-31）；
 *   - 输出顺序一律**确定性**（显式排序 + id 兜底 tie-break），不依赖 DB 默认顺序。
 *
 * 本文件**不含**：Prisma / DB client / raw SQL / HTTP / 网络 / 文件系统 / LLM / Provider / quota /
 * 任何写方法 / 任何事实层符号。
 */

import {
  RETRIEVAL_CONTRACT,
  RETRIEVAL_DEFAULT_LIMIT,
  RETRIEVAL_QUERY_MAX_CHARS,
  RETRIEVAL_SEMANTIC_VERSIONS,
  buildQuerySearchText,
  truncateContent,
} from '../domain/rag/retrieval.ts';
import { STEP_TYPES, STEP_TYPE_BRACKET } from '../domain/action-plan/step-type.ts';
import type { AgentReadToolContext, AgentReadToolDeps } from './tool-deps.ts';
import type { AgentReadToolPayload } from './tool-outcome.ts';
import type {
  GetActionPlanInputT,
  GetCapabilitiesInputT,
  GetJdSummaryInputT,
  GetLearningTasksInputT,
  GetMatchResultInputT,
  GetPortfolioInputT,
  GetProjectResultsInputT,
  GetResumeSummaryInputT,
  RagRetrieveInputT,
} from './tool-schemas.ts';

/** 步骤类型（复用 `src/domain/action-plan/step-type.ts` 单一来源；无法识别 → null） */
export type AgentStepType = (typeof STEP_TYPES)[number] | null;

// ─── 确定性排序工具（纯函数）────────────────────────────────────────────

function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 倒序（新 → 旧），以 id 升序作 tie-break；保证同输入同顺序 */
function byNewestThenId<T extends { createdAt: Date; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || compareId(a.id, b.id),
  );
}

function latestOf<T extends { createdAt: Date; id: string }>(rows: readonly T[]): T | null {
  return byNewestThenId(rows)[0] ?? null;
}

/** 由标题前缀解析步骤类型（与前端同一常量；缺失 / 未知 → null，降级不臆造） */
function resolveStepType(title: string): AgentStepType {
  for (const t of STEP_TYPES) {
    if (title.startsWith(STEP_TYPE_BRACKET[t])) return t;
  }
  return null;
}

// ─── 1. get_resume_summary ──────────────────────────────────────────────

export type ResumeSummaryItemOutput = {
  id: string;
  section: string;
  title: string;
  detail: string | null;
  status: string;
  /** 证据引用（**不含** Resume 原文；`excerpt` 为既有条目级短引用，可空） */
  evidenceRefs: Array<{ source: string; locator: string; excerpt: string | null }>;
};

export type GetResumeSummaryOutput = {
  resumeId: string;
  sourceType: string;
  createdAt: Date;
  itemCount: number;
  items: ResumeSummaryItemOutput[];
};

export async function adaptResumeSummary(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetResumeSummaryInputT,
): Promise<AgentReadToolPayload<GetResumeSummaryOutput>> {
  let resumeId = input.resumeId ?? null;
  if (resumeId === null) {
    const latest = latestOf(await deps.resumes.listForUser(ctx.userId));
    if (latest === null) return { ok: false, reason: 'NOT_FOUND' };
    resumeId = latest.id;
  }
  const detail = await deps.resumes.findDetailForUser(resumeId, ctx.userId);
  if (detail === null) return { ok: false, reason: 'NOT_FOUND' };

  const items = [...detail.items]
    .sort((a, b) => compareId(a.id, b.id))
    .map((it) => ({
      id: it.id,
      section: String(it.section),
      title: it.title,
      detail: it.detail,
      status: it.status,
      evidenceRefs: it.evidence.map((e) => ({
        source: String(e.source),
        locator: e.locator,
        excerpt: e.excerpt ?? null,
      })),
    }));

  return {
    ok: true,
    data: {
      resumeId: detail.id,
      sourceType: detail.sourceType,
      createdAt: detail.createdAt,
      itemCount: items.length,
      items,
    },
  };
}

// ─── 2. get_jd_summary ──────────────────────────────────────────────────

export type JdRequirementOutput = {
  id: string;
  text: string;
  category: string;
  criticality: string;
};

export type GetJdSummaryOutput = {
  jdId: string;
  requirementCount: number;
  requirements: JdRequirementOutput[];
};

export async function adaptJdSummary(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetJdSummaryInputT,
): Promise<AgentReadToolPayload<GetJdSummaryOutput>> {
  const jd = await deps.jds.findByIdForUserWithRequirements(input.jdId, ctx.userId);
  if (jd === null) return { ok: false, reason: 'NOT_FOUND' };

  const requirements = [...jd.requirements]
    .sort((a, b) => compareId(a.id, b.id))
    .map((r) => ({
      id: r.id,
      text: r.text,
      category: String(r.category),
      criticality: String(r.criticality),
    }));

  return { ok: true, data: { jdId: jd.id, requirementCount: requirements.length, requirements } };
}

// ─── 3. get_match_result ────────────────────────────────────────────────

export type MatchItemSummaryOutput = {
  requirementId: string | null;
  requirement: string;
  category: string;
  criticality: string;
  status: string;
  reason: string;
  isInference: boolean;
  needsUserConfirmation: boolean;
  evidenceRefCount: number;
};

export type GetMatchResultOutput = {
  matchRunId: string;
  resumeId: string;
  jdId: string;
  itemCount: number;
  items: MatchItemSummaryOutput[];
};

export async function adaptMatchResult(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetMatchResultInputT,
): Promise<AgentReadToolPayload<GetMatchResultOutput>> {
  let runId = input.matchRunId ?? null;
  if (runId === null) runId = await deps.matches.findLatestRunIdForUser(ctx.userId);
  if (runId === null) return { ok: false, reason: 'NOT_FOUND' };

  const run = await deps.matches.findRunWithItemsForUser(runId, ctx.userId);
  if (run === null) return { ok: false, reason: 'NOT_FOUND' };

  // 条目顺序即既有 MatchItem 顺序（服务端既有确定性顺序），仅做字段投影
  const items = run.items.map((it) => ({
    requirementId: it.requirementId ?? null,
    requirement: it.requirement,
    category: String(it.category),
    criticality: String(it.criticality),
    status: String(it.status),
    reason: it.reason,
    isInference: it.isInference,
    needsUserConfirmation: it.needsUserConfirmation,
    evidenceRefCount: it.evidenceRefs.length,
  }));

  return {
    ok: true,
    data: {
      matchRunId: run.id,
      resumeId: run.resumeId,
      jdId: run.jdId,
      itemCount: items.length,
      items,
    },
  };
}

// ─── 4. get_capabilities ────────────────────────────────────────────────

export type CapabilitySummaryOutput = {
  id: string;
  key: string;
  label: string;
  status: string;
  level: string | null;
  /** 证据计数（来自单条详情；不输出证据正文） */
  evidenceCount: number;
};

export type GetCapabilitiesOutput = {
  count: number;
  items: CapabilitySummaryOutput[];
};

export async function adaptCapabilities(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetCapabilitiesInputT,
): Promise<AgentReadToolPayload<GetCapabilitiesOutput>> {
  const rows = await deps.capabilities.listForUser(ctx.userId);
  const filtered = input.status === undefined ? rows : rows.filter((r) => r.status === input.status);
  const ordered = [...filtered].sort((a, b) => compareId(a.key, b.key) || compareId(a.id, b.id));

  // 证据计数需逐条读取详情（既有 Port 无「列表带计数」方法）；Promise.all 保序 → 确定性
  const items = await Promise.all(
    ordered.map(async (c) => {
      const detail = await deps.capabilities.findForUser(c.id, ctx.userId);
      return {
        id: c.id,
        key: c.key,
        label: c.label,
        status: c.status,
        level: c.level,
        evidenceCount: detail === null ? 0 : detail.evidence.length,
      };
    }),
  );

  return { ok: true, data: { count: items.length, items } };
}

// ─── 5. get_project_results ─────────────────────────────────────────────

export type ProjectResultSummaryOutput = {
  id: string;
  planId: string;
  title: string;
  status: string;
  artifactCount: number;
  createdAt: Date;
  submittedAt: Date | null;
  revokedAt: Date | null;
};

export type GetProjectResultsOutput = {
  count: number;
  items: ProjectResultSummaryOutput[];
};

export async function adaptProjectResults(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetProjectResultsInputT,
): Promise<AgentReadToolPayload<GetProjectResultsOutput>> {
  const rows = await deps.projectResults.listForUser(ctx.userId);
  const filtered = input.planId === undefined ? rows : rows.filter((r) => r.planId === input.planId);

  const items = byNewestThenId(filtered).map((r) => ({
    id: r.id,
    planId: r.planId,
    title: r.title,
    status: String(r.status),
    artifactCount: r.artifactCount,
    createdAt: r.createdAt,
    submittedAt: r.submittedAt,
    revokedAt: r.revokedAt,
  }));

  return { ok: true, data: { count: items.length, items } };
}

// ─── 6. get_action_plan ─────────────────────────────────────────────────

export type ActionStepSummaryOutput = {
  id: string;
  order: number;
  title: string;
  /** 步骤类型（由标题前缀经**单一来源**常量解析；未知 / 缺失 → null） */
  stepType: AgentStepType;
  status: string;
  targetRequirement: string | null;
};

export type ActionPlanSummaryOutput = {
  planId: string;
  goal: string;
  createdAt: Date;
  stepCount: number;
  steps: ActionStepSummaryOutput[];
};

export type GetActionPlanOutput = {
  count: number;
  plans: ActionPlanSummaryOutput[];
};

function toPlanSummary(plan: {
  id: string;
  goal: string;
  createdAt: Date;
  steps: Array<{
    id: string;
    order: number;
    title: string;
    status: string;
    targetRequirement: string | null;
  }>;
}): ActionPlanSummaryOutput {
  const steps = [...plan.steps]
    .sort((a, b) => a.order - b.order || compareId(a.id, b.id))
    .map((s) => ({
      id: s.id,
      order: s.order,
      title: s.title,
      stepType: resolveStepType(s.title),
      status: s.status,
      targetRequirement: s.targetRequirement,
    }));
  return { planId: plan.id, goal: plan.goal, createdAt: plan.createdAt, stepCount: steps.length, steps };
}

export async function adaptActionPlan(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetActionPlanInputT,
): Promise<AgentReadToolPayload<GetActionPlanOutput>> {
  if (input.planId === undefined) {
    const plans = byNewestThenId(await deps.actionPlans.listForUser(ctx.userId)).map(toPlanSummary);
    return { ok: true, data: { count: plans.length, plans } };
  }
  const plan = await deps.actionPlans.findForUser(input.planId, ctx.userId);
  if (plan === null) return { ok: false, reason: 'NOT_FOUND' };
  return { ok: true, data: { count: 1, plans: [toPlanSummary(plan)] } };
}

// ─── 7. get_learning_tasks ──────────────────────────────────────────────

export type LearningTaskSummaryOutput = {
  id: string;
  actionPlanId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  status: string;
  /** 归档标记（见 `tool-deps.ts` BLOCK-1 注：既有只读能力下恒为 false） */
  archived: boolean;
  updatedAt: Date;
};

export type GetLearningTasksOutput = {
  count: number;
  tasks: LearningTaskSummaryOutput[];
};

export async function adaptLearningTasks(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetLearningTasksInputT,
): Promise<AgentReadToolPayload<GetLearningTasksOutput>> {
  const rows = await deps.learningTasks.listForUser(ctx.userId);
  const filtered = input.status === undefined ? rows : rows.filter((r) => r.status === input.status);

  const tasks = byNewestThenId(filtered).map((t) => ({
    id: t.id,
    actionPlanId: t.actionPlanId,
    sourceStepId: t.sourceStepId,
    sourceStepTitle: t.sourceStepTitle,
    status: String(t.status),
    archived: t.archivedAt !== null,
    updatedAt: t.updatedAt,
  }));

  return { ok: true, data: { count: tasks.length, tasks } };
}

// ─── 8. get_portfolio ───────────────────────────────────────────────────

export type PortfolioMemberOutput = {
  projectResultId: string;
  displayOrder: number;
};

export type PortfolioProjectSummaryOutput = {
  id: string;
  title: string;
  description: string | null;
  displayOrder: number;
  featured: boolean;
  archivedAt: Date | null;
  activeResultCount: number;
  results: PortfolioMemberOutput[];
  revokedResults: PortfolioMemberOutput[];
};

export type GetPortfolioOutput = {
  count: number;
  projects: PortfolioProjectSummaryOutput[];
};

export async function adaptPortfolio(
  deps: AgentReadToolDeps,
  ctx: AgentReadToolContext,
  input: GetPortfolioInputT,
): Promise<AgentReadToolPayload<GetPortfolioOutput>> {
  const ids =
    input.portfolioProjectId === undefined
      ? (await deps.portfolioProjects.listForUser(ctx.userId)).map((p) => p.id)
      : [input.portfolioProjectId];

  // 既有 Port 的列表视图不含成员 → 逐个取详情（Promise.all 保序）；非本人 / 不存在 → 跳过或整体 404
  const details = await Promise.all(
    ids.map((id) => deps.portfolioProjects.findForUser(id, ctx.userId)),
  );

  if (input.portfolioProjectId !== undefined && details[0] === null) {
    return { ok: false, reason: 'NOT_FOUND' };
  }

  const projects = details
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .map((d) => ({
      id: d.project.id,
      title: d.project.title,
      description: d.project.description,
      displayOrder: d.project.displayOrder,
      featured: d.project.featured,
      archivedAt: d.project.archivedAt,
      activeResultCount: d.activeResultCount,
      results: [...d.results]
        .sort((a, b) => a.displayOrder - b.displayOrder || compareId(a.id, b.id))
        .map((m) => ({ projectResultId: m.projectResultId, displayOrder: m.displayOrder })),
      revokedResults: [...d.revokedResults]
        .sort((a, b) => a.displayOrder - b.displayOrder || compareId(a.id, b.id))
        .map((m) => ({ projectResultId: m.projectResultId, displayOrder: m.displayOrder })),
    }));

  return { ok: true, data: { count: projects.length, projects } };
}

// ─── 9. rag_retrieve（公共/受控语料；untrusted）─────────────────────────

export type RagRetrieveItemOutput = {
  chunkId: string;
  documentId: string;
  sourceId: string;
  sourceKey: string;
  sourceType: string;
  title: string;
  content: string;
  snippet: string;
  truncated: boolean;
  rank: number;
  ordinal: number;
};

export type RagRetrieveOutput = {
  contract: string;
  tokenizer: string;
  chunker: string;
  fts: string;
  query: string;
  items: RagRetrieveItemOutput[];
  total: number;
  returned: number;
};

/** `query` 归一后越界（trim 后 1–200）；由调用方映射为 `VALIDATION_FAILED` */
export async function adaptRagRetrieve(
  deps: AgentReadToolDeps,
  _ctx: AgentReadToolContext | null,
  input: RagRetrieveInputT,
): Promise<AgentReadToolPayload<RagRetrieveOutput>> {
  const trimmed = input.query.trim();
  if (trimmed.length < 1 || trimmed.length > RETRIEVAL_QUERY_MAX_CHARS) {
    return { ok: false, reason: 'INVALID_QUERY' };
  }

  const limit = input.limit ?? RETRIEVAL_DEFAULT_LIMIT;
  const { hits, total } = await deps.rag.retrieve({ searchText: buildQuerySearchText(input.query), limit });

  const items = hits.map((hit, index) => {
    const { content, truncated } = truncateContent(hit.content);
    return {
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      sourceId: hit.sourceId,
      sourceKey: hit.sourceKey,
      sourceType: hit.sourceType,
      title: hit.title,
      content,
      snippet: content,
      truncated,
      rank: hit.rank,
      ordinal: index + 1,
    };
  });

  return {
    ok: true,
    data: {
      contract: RETRIEVAL_CONTRACT,
      tokenizer: RETRIEVAL_SEMANTIC_VERSIONS.tokenizer,
      chunker: RETRIEVAL_SEMANTIC_VERSIONS.chunker,
      fts: RETRIEVAL_SEMANTIC_VERSIONS.fts,
      query: input.query,
      items,
      total,
      returned: items.length,
    },
  };
}
