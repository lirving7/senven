/**
 * V2 · T3-A2-2 —— 项目成果 AI 分析 handler（**零写入**）
 *
 * M1 构造性保证：本 handler 使用**独立 Deps 类型**，只允许
 *   provider / ProjectResult 只读 / quota-usage gate / clock / auth。
 * **不包含** CapabilityRepository、CapabilityEvidence 写仓储、Skill 仓储，
 * 从依赖类型层面即不可能写入 Capability / Skill / Evidence。
 *
 * 特别说明：**不得**把 provider 加进 A2-1 的 `ProjectResultsHandlerDeps`——
 * A2-1 的冻结测试断言 `'provider' in deps === false`。
 *
 * 执行顺序（严格）：
 *   auth → ProjectResult ownership/404 → status 校验 → quota gate → provider → 严格校验 → 只返回建议
 * 配额闸门在 provider **之前**（由 `generateJsonWithUsage` 保证）。
 */

import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import { generateJsonWithUsage } from '../../llm/usage-gate.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import {
  analyzeProjectResult,
  toAnalysisContext,
  type AnalysisResult,
} from '../../domain/ai/analyze-project.ts';
import { LLM_FEATURE } from '../../ports/index.ts';
import type {
  Clock,
  LlmFeature,
  LlmUsageRepository,
  ProjectResultRepository,
} from '../../ports/index.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';

/**
 * ⚠️ 独立 Deps：**故意不含**任何 Capability / Skill 写能力。
 * 新增字段前请确认不会破坏「LLM 零写入」的构造性保证。
 */
export type ProjectAiAnalysisHandlerDeps = {
  auth: AuthService;
  provider: LLMProvider;
  /** 只读用途：ownership + 组装分析上下文 */
  projectResults: ProjectResultRepository;
  /** 配额闸门 + 用量留痕 */
  usage: LlmUsageRepository;
  clock: Clock;
};

/** 空体严格 schema：拒绝任何字段（含 userId） */
const EmptyBodySchema = z.object({}).strict();

async function requireUser(deps: ProjectAiAnalysisHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/**
 * Phase 1 响应形状（**加性兼容**）：
 * - candidates 原样保留（= capability candidates，现有消费者零破坏）；
 * - 新增 strengths / weaknesses / evidence / nextSteps 四段（纯建议，零写入）。
 */
export function toAnalysisResponse(result: AnalysisResult) {
  return {
    candidates: result.candidates.map((c) => ({
      artifactId: c.artifactId,
      key: c.key,
      label: c.label,
      ...(c.rationale === undefined ? {} : { rationale: c.rationale }),
    })),
    strengths: result.strengths,
    weaknesses: result.weaknesses,
    evidence: result.evidence,
    nextSteps: result.nextSteps,
    /** 明确标注建议性质：本次分析**未写入任何数据** */
    suggestionOnly: true as const,
  };
}

/**
 * POST /api/project-results/:id/analyze —— 仅用户显式触发；**零数据库写入**。
 * 采纳仍必须调用 A2-1 的 POST /api/project-results/:id/evidence。
 */
export function createAnalyzeProjectResultHandler(deps: ProjectAiAnalysisHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);

      // 空体严格校验：body 出现 userId 等任何字段 → 400
      const rawBody = await readJson(request).catch(() => ({}));
      EmptyBodySchema.parse(rawBody ?? {});

      // ownership：非本人 / 不存在一律 404（不泄露存在性）
      const result = await deps.projectResults.findForUser(id, user.id);
      if (!result) throw appError(ERROR_CODE.NOT_FOUND, '未找到该成果');

      // 状态：仅 SUBMITTED 可分析（复用 A2-1 既有 422 码）
      if (result.status !== 'SUBMITTED') {
        throw appError(ERROR_CODE.RESULT_NOT_SUBMITTED, '只有已提交的成果才能进行 AI 分析');
      }

      const ctx = toAnalysisContext(result);
      const allowedArtifactIds = new Set(result.artifacts.map((a) => a.id));

      // 配额闸门 + provider：**每次尝试都先过闸门**，配额不足时 provider 0 调用
      const analysis = await analyzeProjectResult(ctx, {
        providerName: deps.provider.name,
        allowedArtifactIds,
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
      return jsonResponse(200, { data: toAnalysisResponse(analysis) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
