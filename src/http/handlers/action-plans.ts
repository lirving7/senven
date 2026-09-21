import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import { generateJsonWithUsage } from '../../llm/usage-gate.ts';
import { LLMFormatError } from '../../llm/provider.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import {
  ACTION_PLAN_JSON_SCHEMA,
  ACTION_PLAN_SYSTEM_PROMPT,
  buildActionPlanPrompt,
  deriveHaveGaps,
  parseActionPlanOutput,
  type ActionPlanContext,
} from '../../domain/action-plan/generate.ts';
import { LLM_FEATURE } from '../../ports/index.ts';
import type {
  ActionPlanRecord,
  ActionStepInput,
  CapabilityRepository,
  ActionPlanRepository,
  JdRepository,
  LlmUsageRepository,
  MatchRepository,
  Clock,
  LlmFeature,
} from '../../ports/index.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
/** T3-A2-4 Phase 1：类型前缀契约的**唯一来源**（服务端与前端共用，禁止各自手写映射） */
import { applyStepTypePrefix } from '../../domain/action-plan/step-type.ts';

export type ActionPlansHandlerDeps = {
  auth: AuthService;
  provider: LLMProvider;
  matchRepo: MatchRepository;
  capabilities: CapabilityRepository;
  jdRepo: JdRepository;
  actionPlans: ActionPlanRepository;
  usage: LlmUsageRepository;
  clock: Clock;
};

async function requireUser(deps: ActionPlansHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/** LLM 的 type 折叠进标题，ActionStep 无独立 type 列（保持 T2 第1步 schema 不变） */
function toStepInput(a: { title: string; desc: string; type?: string; targetRequirement?: string }, idx: number): ActionStepInput {
  return {
    order: idx + 1,
    // 合法 type → 精确前缀 `[标签] `；缺失/非法 → 标题原样（降级语义沿用既有实现）
    title: applyStepTypePrefix(a.title, a.type),
    desc: a.desc,
    targetRequirement: a.targetRequirement ?? null,
  };
}

function toPlanResponse(plan: ActionPlanRecord) {
  return {
    id: plan.id,
    matchRunId: plan.matchRunId,
    jdId: plan.jdId,
    goal: plan.goal,
    have: plan.have,
    gaps: plan.gaps,
    actions: plan.steps.map((s) => ({
      id: s.id,
      order: s.order,
      title: s.title,
      desc: s.desc,
      status: s.status,
      targetRequirement: s.targetRequirement,
    })),
    createdAt: plan.createdAt.toISOString(),
  };
}

/** 从 MatchRun + 用户已确认能力派生 have/gaps，并组装 LLM 上下文 */
async function buildContext(
  deps: ActionPlansHandlerDeps,
  userId: string,
  run: { id: string; jdId: string; items: Parameters<typeof deriveHaveGaps>[1] },
): Promise<{ goal: string; ctx: ActionPlanContext; have: unknown[]; gaps: unknown[] }> {
  // C3（安全网 / consistency reconcile）：
  // 覆盖历史数据、直写 DB、以及任何未经 C2 confirm path 的 CONFIRMED 事实。
  // 必须在 listForUser 之前 —— 否则本次 reconcile 对本次 ActionPlan 无效。
  // 失败时不吞异常：交由调用方的既有 catch → errorResponse 处理（不新增错误码），
  // 且绝不伪造 Capability，也不会读取一个实际不存在的能力。
  await deps.capabilities.projectConfirmedSkills(userId);

  const caps = await deps.capabilities.listForUser(userId);
  const { have, gaps } = deriveHaveGaps(caps, run.items);

  let goal = '能力提升计划';
  const jd = await deps.jdRepo.findByIdForUser(run.jdId, userId);
  if (jd && jd.title) goal = jd.title;

  const ctx: ActionPlanContext = {
    goal,
    confirmedHave: caps
      .filter((c) => c.status === 'CONFIRMED')
      .map((c) => ({ key: c.key, label: c.label, level: c.level })),
    gaps: gaps.map((g) => ({ requirement: (g as { requirement: string }).requirement, category: (g as { category: string }).category, criticality: (g as { criticality: string }).criticality })),
  };
  return { goal, ctx, have, gaps };
}

/** POST /api/action-plans —— 用户主动触发；基于指定 MatchRun；Quota Gate 在前；事务写入 */
export function createCreateActionPlanHandler(deps: ActionPlansHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      // 拒绝 body 中的 userId（A2）：strict 多字段即 400
      const body = z.object({ matchRunId: z.string().trim().min(1, 'matchRunId 不能为空') }).strict().parse(await readJson(request));

      // A2 所属权：非本人 run 一律 null → 404
      const run = await deps.matchRepo.findRunWithItemsForUser(body.matchRunId, user.id);
      if (!run) throw appError(ERROR_CODE.NOT_FOUND, '未找到该匹配记录');

      const { goal, ctx, have, gaps } = await buildContext(deps, user.id, run);

      // A4 Quota Gate（在 provider 之前，不足则 429 且 provider 0 调用）
      const raw = await generateJsonWithUsage<unknown>(
        { usage: deps.usage, clock: deps.clock },
        {
          userId: user.id,
          feature: LLM_FEATURE.ACTION_PLAN as LlmFeature,
          provider: deps.provider,
          request: {
            system: ACTION_PLAN_SYSTEM_PROMPT,
            prompt: buildActionPlanPrompt(ctx),
            schema: ACTION_PLAN_JSON_SCHEMA,
            timeoutMs: 30_000,
          },
        },
      );

      // 结构化校验：失败抛 LLMFormatError → 502，且尚未写库（A3 不落半个 ActionPlan）
      const parsed = parseActionPlanOutput(raw, deps.provider.name);

      // A5 事实安全：have/gaps 用服务端派生值覆盖 LLM，actions 用 LLM 输出
      const steps = parsed.actions.map((a, idx) => toStepInput(a, idx));

      // A3 事务写入
      const plan = await deps.actionPlans.createPlanWithSteps({
        userId: user.id,
        matchRunId: run.id,
        jdId: run.jdId,
        goal,
        have,
        gaps,
        steps,
      });

      return jsonResponse(201, { data: toPlanResponse(plan) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/action-plans —— 仅本人（A1：Match 后此处为 []，不会自动生成） */
export function createListActionPlansHandler(deps: ActionPlansHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const plans = await deps.actionPlans.listForUser(user.id);
      return jsonResponse(200, { data: { items: plans.map(toPlanResponse) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/action-plans/:id —— 非本人/不存在 → 404（A2） */
export function createGetActionPlanHandler(deps: ActionPlansHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const plan = await deps.actionPlans.findForUser(id, user.id);
      if (!plan) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');
      return jsonResponse(200, { data: toPlanResponse(plan) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/action-plans/:id/regenerate —— 重跑 LLM，复用 Quota Gate，事务替换内容 */
export function createRegenerateActionPlanHandler(deps: ActionPlansHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);

      const existing = await deps.actionPlans.findForUser(id, user.id);
      if (!existing) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');

      const run = await deps.matchRepo.findRunWithItemsForUser(existing.matchRunId, user.id);
      if (!run) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应的匹配记录');

      const { goal, ctx, have, gaps } = await buildContext(deps, user.id, run);

      const raw = await generateJsonWithUsage<unknown>(
        { usage: deps.usage, clock: deps.clock },
        {
          userId: user.id,
          feature: LLM_FEATURE.ACTION_PLAN as LlmFeature,
          provider: deps.provider,
          request: {
            system: ACTION_PLAN_SYSTEM_PROMPT,
            prompt: buildActionPlanPrompt(ctx),
            schema: ACTION_PLAN_JSON_SCHEMA,
            timeoutMs: 30_000,
          },
        },
      );

      const parsed = parseActionPlanOutput(raw, deps.provider.name);
      const steps = parsed.actions.map((a, idx) => toStepInput(a, idx));

      const updated = await deps.actionPlans.replacePlanContent(id, user.id, { goal, have, gaps, steps });
      if (!updated) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');

      return jsonResponse(200, { data: toPlanResponse(updated) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/action-plans/:id/steps/:stepId —— 更新单步状态，跨用户 step → 404 */
export function createUpdateActionStepHandler(deps: ActionPlansHandlerDeps) {
  return async function PATCH(request: Request, _id: string, stepId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = z
        .object({ status: z.enum(['TODO', 'IN_PROGRESS', 'DONE']) })
        .strict()
        .parse(await readJson(request));

      const updated = await deps.actionPlans.updateStepStatus(stepId, user.id, body.status);
      if (!updated) throw appError(ERROR_CODE.NOT_FOUND, '未找到该步骤');

      return jsonResponse(200, {
        data: {
          id: updated.id,
          order: updated.order,
          title: updated.title,
          desc: updated.desc,
          status: updated.status,
          targetRequirement: updated.targetRequirement,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
