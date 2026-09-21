/**
 * Project V2 Phase 0 —— 项目执行指导 handler（**零写入**）
 *
 * M1 构造性保证：本 handler 使用**独立 Deps 类型**，只允许
 *   provider / ActionPlan 只读 / quota-usage gate / clock / auth。
 * **不包含**任何 Capability / Skill / ProjectResult / LearningTask 写仓储，
 * 从依赖类型层面即不可能写入任何事实数据。
 *
 * 执行顺序（严格）：
 *   auth → plan ownership/404 → step 归属校验 → quota gate → provider → 严格校验 → 只返回建议
 * 配额闸门在 provider **之前**（由 `generateJsonWithUsage` 保证）。
 *
 * 复用既有契约（零 Frozen 文件改动）：
 *   - 错误码：复用 AI_ANALYSIS_INVALID_RESPONSE（error-mapping 既有 AiAnalysisInvalidResponseError 映射 → 502）
 *   - 配额槽位：复用 LLM_FEATURE.PROJECT_MENTOR
 *   - `<data>` 隔离范式 / `.strict()` 空体校验 / 404 无存在性泄露：与 project-ai-analysis.ts 同构
 */

import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import { generateJsonWithUsage } from '../../llm/usage-gate.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import {
  generateProjectGuide,
  toGuideContext,
  type ProjectGuideOutput,
} from '../../domain/ai/project-guide.ts';
import { LLM_FEATURE } from '../../ports/index.ts';
import type {
  ActionPlanRepository,
  Clock,
  LlmFeature,
  LlmUsageRepository,
} from '../../ports/index.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';

/**
 * ⚠️ 独立 Deps：**故意不含**任何写仓储（ActionPlanRepository 仅用于只读 ownership 查询）。
 * 新增字段前请确认不会破坏「LLM 零写入」的构造性保证。
 */
export type ProjectGuideHandlerDeps = {
  auth: AuthService;
  provider: LLMProvider;
  /** 只读用途：plan ownership + 步骤归属 */
  actionPlans: Pick<ActionPlanRepository, 'findForUser'>;
  /** 配额闸门 + 用量留痕 */
  usage: LlmUsageRepository;
  clock: Clock;
};

/** 空体严格 schema：拒绝任何字段（含 userId） */
const EmptyBodySchema = z.object({}).strict();

async function requireUser(deps: ProjectGuideHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

export function toGuideResponse(guide: ProjectGuideOutput) {
  return {
    guide,
    /** 明确标注建议性质：本次生成**未写入任何数据**，且不代表用户已完成任何内容 */
    suggestionOnly: true as const,
  };
}

/**
 * POST /api/action-plans/:planId/steps/:stepId/guide —— 仅用户显式触发；**零数据库写入**。
 */
export function createStepGuideHandler(deps: ProjectGuideHandlerDeps) {
  return async function POST(request: Request, planId: string, stepId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);

      // 空体严格校验：body 出现 userId 等任何字段 → 400
      const rawBody = await readJson(request).catch(() => ({}));
      EmptyBodySchema.parse(rawBody ?? {});

      // ownership：非本人 / 不存在一律 404（不泄露存在性）
      const plan = await deps.actionPlans.findForUser(planId, user.id);
      if (!plan) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');

      const step = plan.steps.find((s) => s.id === stepId);
      if (!step) throw appError(ERROR_CODE.VALIDATION_FAILED, '该步骤不属于该行动计划');

      const ctx = toGuideContext(plan, step);

      // 配额闸门 + provider：**每次尝试都先过闸门**，配额不足时 provider 0 调用
      const guide = await generateProjectGuide(ctx, {
        providerName: deps.provider.name,
        callProvider: (req) =>
          generateJsonWithUsage<unknown>(
            { usage: deps.usage, clock: deps.clock },
            {
              userId: user.id,
              feature: LLM_FEATURE.PROJECT_MENTOR as LlmFeature,
              provider: deps.provider,
              request: req,
            },
          ),
      });

      // 只返回建议：本 handler 全程无任何写操作
      return jsonResponse(200, { data: toGuideResponse(guide) });
    } catch (err) {
      // AiAnalysisInvalidResponseError 由 error-mapping 既有分支映射为 502 AI_ANALYSIS_INVALID_RESPONSE
      return errorResponse(err, requestId);
    }
  };
}
