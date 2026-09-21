/**
 * T5-B-2C —— Agent API handlers（**恰好 3 个 endpoint**）
 *
 *   POST /api/agent/runs            创建并执行一次 Agent Run（经 Runtime；userId 只来自 session）
 *   GET  /api/agent/runs/:id        读取本人 Run（含 ACTIVE proposal；跨用户一律 404，无 oracle）
 *   POST /api/agent/runs/:id/cancel 取消本人 Run（复用既有状态机；终态/PROPOSED → 409）
 *
 * 硬边界（授权书 §二 / §十）：
 *   - API 层**只做** HTTP → 认证 → 输入校验 → Runtime 调用 → 响应映射；
 *     不得出现 Prisma / raw SQL / provider 直调 / Tool 直调 / RAG 仓储直调 / 事实层写入；
 *   - **userId 只来自 session**：请求体 `.strict()`，任何 userId / tool / provider / model /
 *     quota / system prompt 注入键一律 400；
 *   - **O-5**：POST 响应以**数据库最终 Run 状态**为准（Runtime 返回值仅用于定位 runId，
 *     并发取消等竞态下二者可能不同）；
 *   - **quota 语义**：配额拒绝已在 Runtime 内固化为 `CREATED → FAILED + LLM_QUOTA_EXCEEDED`
 *     （AF-3，T5-B-2B 修复项），本层不引入第二种 quota 错误体系；
 *   - 409 状态冲突由 handler 依据仓储**类型化结果**直接映射（复用既有错误信封形状），
 *     不新增 errors.ts / error-mapping.ts 条目（冻结指纹不动）；
 *   - 不新增任何第四个 endpoint（无 execute / confirm / tool / streaming / Agent Loop）。
 */

import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { Clock } from '../../ports/index.ts';
import type { AgentProposalRecord, AgentRunRecord, AgentRunRepository } from '../../ports/index.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import type { AgentPlanRuntime } from '../../agent/runtime.ts';
import { RETRIEVAL_QUERY_MAX_CHARS } from '../../domain/rag/retrieval.ts';

/**
 * deps（全部注入；生产装配在 `deps.ts` 的唯一 Agent 装配点）。
 *
 * ⚠️ 刻意**不含**：Tool Layer（Runtime 内部使用）、RAG / 事实层仓储、usage、quota ——
 * API 层不得越过 Runtime 直接触达任何查询或 LLM 能力。
 */
export type AgentRunsHandlerDeps = {
  auth: AuthService;
  runtime: AgentPlanRuntime;
  /** 传给 Runtime 的单次 provider（由生产装配点提供；本层不直调） */
  provider: LLMProvider;
  /** O-5 终态复读 + GET / cancel（全部强制 userId ownership） */
  runs: AgentRunRepository;
  clock: Clock;
};

async function requireUser(deps: AgentRunsHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/**
 * 请求契约 = Runtime 已冻结输入的**客户端可见子集**：
 *   - `targets`：只允许既有的 8 个目标键（id 归属由 Tool Layer 的 `...ForUser` 强制）；
 *   - `request`：额外用户诉求（Runtime `AgentPlanRuntimeInput.request`）；
 *   - `.strict()`：userId / tool 名 / provider / model / quota / system prompt 等
 *     其余一切键 → 400 VALIDATION_FAILED。
 * 不发明第二套 Agent input schema —— 键名与 `AgentRuntimeTargets` 逐一对应。
 */
const CreateRunBodySchema = z
  .object({
    targets: z
      .object({
        resumeId: z.string().min(1).max(64).optional(),
        jdId: z.string().min(1).max(64).optional(),
        matchRunId: z.string().min(1).max(64).optional(),
        planId: z.string().min(1).max(64).optional(),
        portfolioProjectId: z.string().min(1).max(64).optional(),
        capabilityStatus: z.string().min(1).max(32).optional(),
        learningTaskStatus: z.string().min(1).max(32).optional(),
        ragQuery: z.string().min(1).max(RETRIEVAL_QUERY_MAX_CHARS).optional(),
      })
      .strict()
      .optional(),
    request: z.string().min(1).max(500).optional(),
  })
  .strict();

/** Run 响应视图 = AgentRun 冻结字段全量（不含任何派生 / 敏感内容） */
function toRunView(run: AgentRunRecord) {
  return {
    id: run.id,
    userId: run.userId,
    goalKind: run.goalKind,
    status: run.status,
    modelVersion: run.modelVersion,
    semanticVersions: run.semanticVersions,
    promptTemplateVersion: run.promptTemplateVersion,
    quotaUsage: run.quotaUsage,
    providerRequestId: run.providerRequestId,
    errorCode: run.errorCode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    endedAt: run.endedAt,
  };
}

/** Proposal 响应视图 = AgentProposal 冻结字段全量（payload / basedOnRefs 原样保留） */
function toProposalView(p: AgentProposalRecord) {
  return {
    id: p.id,
    runId: p.runId,
    revision: p.revision,
    kind: p.kind,
    payload: p.payload,
    basedOnRefs: p.basedOnRefs,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function activeProposalOf(proposals: readonly AgentProposalRecord[]): AgentProposalRecord | null {
  return proposals.find((p) => p.status === 'ACTIVE') ?? null;
}

/**
 * `POST /api/agent/runs` —— 认证 → 严格校验 → Runtime → **按 DB 终态**响应。
 *
 * - Run 资源被创建即返回 201（无论计划终态如何）：
 *   `status = PROPOSED` 附 ACTIVE proposal；`status = FAILED` 携带 `errorCode`
 *   （含冻结的 `LLM_QUOTA_EXCEEDED` 配额拒绝，provider = 0）；
 *   `status = CANCELLED` 为并发取消竞态下的 DB 终态（O-5）。
 */
export function createCreateAgentRunHandler(deps: AgentRunsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = CreateRunBodySchema.parse(await readJson(request));

      const outcome = await deps.runtime.run({
        userId: user.id,
        provider: deps.provider,
        ...(body.targets === undefined ? {} : { targets: body.targets }),
        ...(body.request === undefined ? {} : { request: body.request }),
      });

      // O-5：不以 Runtime 返回值为准 —— 重新读取数据库最终 Run 状态
      if (outcome.status === 'NOT_FOUND' || outcome.runId === null) {
        throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      }
      const run = await deps.runs.findRunForUser(outcome.runId, user.id);
      if (run === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');

      const proposals = outcome.status === 'PROPOSED' ? ((await deps.runs.listProposalsForRun(run.id, user.id)) ?? []) : [];
      const active = activeProposalOf(proposals);

      return jsonResponse(201, {
        data: { run: toRunView(run), proposal: active ? toProposalView(active) : null },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * `GET /api/agent/runs/:id` —— 认证 + ownership（非本人 / 不存在 → 404，不泄露存在性）。
 * 仅返回冻结字段；不返回 system prompt / 工具原始结果 / RAG chunks / 任何凭据。
 */
export function createGetAgentRunHandler(deps: AgentRunsHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const run = await deps.runs.findRunForUser(id, user.id);
      if (run === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      const proposals = (await deps.runs.listProposalsForRun(id, user.id)) ?? [];
      const active = activeProposalOf(proposals);
      return jsonResponse(200, {
        data: { run: toRunView(run), proposal: active ? toProposalView(active) : null },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * `POST /api/agent/runs/:id/cancel` —— 认证 + ownership + 既有状态机。
 *
 * 语义（全部来自既有 Repository / Domain，本层零新增状态机）：
 *   - `CREATED → CANCELLED` / `PLANNING → CANCELLED` → 200（终态写 `endedAt`）；
 *   - 重复取消（已 CANCELLED，NOOP）→ 200（既有幂等语义）；
 *   - `PROPOSED / FAILED / EXPIRED → CANCELLED`（FORBIDDEN_TRANSITION）及其它类型化冲突 → 409；
 *   - 非本人 / 不存在 → 404（无 oracle）。
 *
 * 409 通过**类型化结果直接映射**（复用既有 `{ error: { code, message, requestId } }` 信封形状），
 * 不新增 errors.ts / error-mapping.ts 条目（两文件指纹冻结）。
 */
const CANCEL_CONFLICT = {
  code: 'AGENT_RUN_NOT_TRANSITIONABLE',
  message: '当前状态不允许取消',
} as const;

export function createCancelAgentRunHandler(deps: AgentRunsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const outcome = await deps.runs.transitionRun(id, user.id, 'CANCELLED', deps.clock.now());
      if (outcome.kind === 'NOT_FOUND') throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      if (outcome.kind !== 'UPDATED') {
        return jsonResponse(409, {
          error: { code: CANCEL_CONFLICT.code, message: CANCEL_CONFLICT.message, requestId },
        });
      }
      return jsonResponse(200, { data: { run: toRunView(outcome.run) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
