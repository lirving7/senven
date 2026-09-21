/**
 * T6-4-A —— Act HTTP 层：Confirm / Execute / Result。
 *
 * 授权依据：T6-4-A/B 授权书（Plan + Propose + Confirm + Execute + Result）。
 * 注意：T5-B 冻结的「agent-runs 仅 3 endpoint」边界由本批次授权解除；AgentRun /
 * AgentProposal 本身零改动（Act 状态机在独立 AgentAction 实体上）。
 *
 * 硬边界（T6-4 §二/§八）：
 *   - Confirm ≠ Execute：Confirm 创建 CONFIRMED 的 AgentAction；Execute 再次经服务端
 *     状态机 + 白名单 + schema 校验后才执行（§二核心原则）；
 *   - userId 只来自 session；body `.strict()`，任何 userId 注入键一律 400；
 *   - 幂等：重复 Confirm（同 proposal）→ 返回既有 Action；重复 Execute / 同 payload
 *     再 Confirm → 复用既有 SUCCEEDED 结果（§四）；
 *   - 执行失败：EXECUTING → FAILED + errorCode 落库（§三.5），不自动 retry；
 *   - 零 LLM：Act 全链路不调用 Provider / 不消耗 quota。
 */

import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AgentActionRepository, AgentRunRepository, ActionPlanRepository, ApplicationRepository, CareerGoalRepository, JdRepository, LearningTaskRepository, ResumeVersionRepository } from '../../ports/index.ts';
import { computeActIdempotencyKey } from '../../domain/agent/act.ts';
import { isActWhitelistedTool, ACT_TOOL_INPUT_SCHEMAS } from '../../agent/act-contracts.ts';
import { executeActAction } from '../../agent/act-executor.ts';

export type AgentActionsHandlerDeps = {
  auth: AuthService;
  runs: AgentRunRepository;
  agentActions: AgentActionRepository;
  // Act Tool 执行所需业务写入口（executor 依赖透传）
  careerGoals: CareerGoalRepository;
  applications: ApplicationRepository;
  learningTasks: LearningTaskRepository;
  jds: JdRepository;
  resumeVersions: ResumeVersionRepository;
  actionPlans: ActionPlanRepository;
};

async function requireUser(deps: AgentActionsHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

function toActionResponse(a: {
  id: string; userId: string; runId: string | null; proposalId: string | null;
  toolName: string; payload: unknown; status: string; idempotencyKey: string;
  result: unknown; errorCode: string | null; errorMessage: string | null;
  createdAt: Date; updatedAt: Date;
}) {
  return {
    id: a.id,
    runId: a.runId,
    proposalId: a.proposalId,
    toolName: a.toolName,
    payload: a.payload,
    status: a.status,
    result: a.result,
    errorCode: a.errorCode,
    errorMessage: a.errorMessage,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

/** Confirm 请求体：toolName + input（strict；模型不得自由命名工具） */
const ConfirmBodySchema = z
  .object({
    toolName: z.string().trim().min(1),
    input: z.record(z.string(), z.unknown()),
    runId: z.string().trim().min(1).nullish(),
  })
  .strict();

/** POST /api/agent/proposals/:proposalId/confirm —— PROPOSED → CONFIRMED（幂等） */
export function createConfirmActHandler(deps: AgentActionsHandlerDeps) {
  return async function POST(request: Request, proposalId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = ConfirmBodySchema.parse(await readJson(request));

      // Act 白名单（未知工具硬拒绝，§五/§六）
      if (!isActWhitelistedTool(body.toolName)) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, `工具 ${body.toolName} 不在 Act 白名单`);
      }
      // 输入 schema（多余字段含 userId 一律 400）
      const input = ACT_TOOL_INPUT_SCHEMAS[body.toolName].parse(body.input);

      // proposal 归属 + 存在性（AgentRun 归属链；跨用户一律 404 无 oracle）
      const proposal = await deps.runs.findProposalForUser(proposalId, user.id);
      if (proposal === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该提案');

      // proposal 幂等：同一 proposal 已有 Action → 返回既有（§四）
      const existing = await deps.agentActions.findByProposalId(proposalId);
      if (existing) {
        return jsonResponse(200, { data: toActionResponse(existing) });
      }

      // 全局幂等键：同 tool+payload 的历史 SUCCEEDED 复用（§四）
      const idempotencyKey = await computeActIdempotencyKey(body.toolName, input);
      const sameKey = await deps.agentActions.findByIdempotencyKey(idempotencyKey);
      if (sameKey) {
        return jsonResponse(200, { data: toActionResponse(sameKey) });
      }

      const created = await deps.agentActions.create({
        userId: user.id,
        runId: body.runId ?? proposal.runId,
        proposalId,
        toolName: body.toolName,
        payload: input,
        status: 'CONFIRMED',
        idempotencyKey,
      });
      return jsonResponse(201, { data: toActionResponse(created) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/agent/actions/:id/execute —— CONFIRMED → EXECUTING → SUCCEEDED/FAILED（幂等） */
export function createExecuteActHandler(deps: AgentActionsHandlerDeps) {
  return async function POST(request: Request, actionId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const action = await deps.agentActions.findForUser(actionId, user.id);
      if (action === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 Action');

      const final = await executeActAction(action, user.id, deps);
      return jsonResponse(200, { data: toActionResponse(final) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/agent/actions/:id —— 查询执行状态/结果（Result 步骤） */
export function createGetActActionHandler(deps: AgentActionsHandlerDeps) {
  return async function GET(request: Request, actionId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const action = await deps.agentActions.findForUser(actionId, user.id);
      if (action === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 Action');
      return jsonResponse(200, { data: toActionResponse(action) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
