/**
 * T5-B-2A —— Agent 只读工具层：装配（依赖注入）与**静态分派**
 *
 * 依据 ADR-017 §13 Security Model 与 T5B-F-16 / F-17 / F-61：
 *   - **封闭 allowlist**：非 9 个冻结工具名 → `UNKNOWN_TOOL` **硬失败**，无兜底、无模糊匹配；
 *   - **禁止动态分派**：分派使用**显式 `switch` 字面量分支**（9 个），
 *     **不得**写成 `adapters[name]` / `table[input.tool]` 这类按输入索引的函数表；
 *   - **禁止 Tool → Tool**：任一分支只调用自己的适配器，适配器不回调本层（无递归）；
 *   - `userId` 只来自会话上下文（`ctx`），输入 schema 全部 `.strict()` 因而不可能承载它；
 *   - 本层**零 LLM / 零 Provider / 零 quota / 零写库**：依赖类型只含只读 Port（见 `tool-deps.ts`）。
 */

import { ERROR_CODE } from '../errors.ts';

import {
  AGENT_READ_TOOL_LAYER_VERSION,
  AGENT_READ_TOOL_NAMES,
  agentReadToolRequiresUserScope,
  agentReadToolTrust,
  isAgentReadToolName,
} from './contracts.ts';
import type { AgentReadToolName } from './contracts.ts';
import type { AgentReadToolContext, AgentReadToolDeps } from './tool-deps.ts';
import type { AgentReadToolOutcome, AgentReadToolPayload } from './tool-outcome.ts';
import {
  GetActionPlanInput,
  GetCapabilitiesInput,
  GetJdSummaryInput,
  GetLearningTasksInput,
  GetMatchResultInput,
  GetPortfolioInput,
  GetProjectResultsInput,
  GetResumeSummaryInput,
  RagRetrieveInput,
} from './tool-schemas.ts';
import {
  adaptActionPlan,
  adaptCapabilities,
  adaptJdSummary,
  adaptLearningTasks,
  adaptMatchResult,
  adaptPortfolio,
  adaptProjectResults,
  adaptRagRetrieve,
  adaptResumeSummary,
} from './tool-adapters.ts';

/** 调用上下文（`userId` 由**服务端会话**注入；公共语料工具可不传） */
export type AgentReadToolInvokeContext = { userId?: string };

const MAX_REPORTED_ISSUES = 8;

function toIssues(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string[] {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`);
}

function wrap<T>(tool: AgentReadToolName, payload: AgentReadToolPayload<T>): AgentReadToolOutcome {
  if (!payload.ok) {
    return { status: 'NOT_FOUND', tool, code: ERROR_CODE.NOT_FOUND };
  }
  return {
    status: 'OK',
    tool,
    layer: AGENT_READ_TOOL_LAYER_VERSION,
    trust: agentReadToolTrust(tool),
    readOnly: true,
    data: payload.data,
  };
}

export type AgentReadToolLayer = {
  layer: string;
  toolNames: readonly AgentReadToolName[];
  /** 唯一入口：按**冻结工具名**分派；`rawName` / `rawInput` 均视为不可信输入 */
  invoke(
    rawName: unknown,
    rawInput: unknown,
    ctx?: AgentReadToolInvokeContext,
  ): Promise<AgentReadToolOutcome>;
};

/**
 * 创建只读工具层。
 *
 * ⚠️ 生产装配点（把 `AgentReadToolDeps` 接到真实仓储）**不在本阶段**：
 * 授权书 §十四 规定修改 `src/http/deps.ts` 需先 STOP，故本阶段只交付可注入的库，
 * 装配留给 T5-B-2B（Runtime）/ 2C（API）阶段按授权接入。
 */
export function createAgentReadToolLayer(deps: AgentReadToolDeps): AgentReadToolLayer {
  async function invoke(
    rawName: unknown,
    rawInput: unknown,
    ctx?: AgentReadToolInvokeContext,
  ): Promise<AgentReadToolOutcome> {
    // ── 封闭 allowlist：未知工具名硬失败（T5B-F-17.1）──────────────────
    if (!isAgentReadToolName(rawName)) {
      return {
        status: 'UNKNOWN_TOOL',
        tool: typeof rawName === 'string' ? rawName.slice(0, 64) : '',
        code: ERROR_CODE.VALIDATION_FAILED,
        message: '未授权的工具名',
      };
    }
    const tool = rawName;

    // ── 归属作用域：userId 只能来自会话上下文（T5B-F-17.3）────────────
    let scope: AgentReadToolContext | null = null;
    if (agentReadToolRequiresUserScope(tool)) {
      const userId = ctx?.userId;
      if (typeof userId !== 'string' || userId.length === 0) {
        return {
          status: 'INVALID_INPUT',
          tool,
          code: ERROR_CODE.VALIDATION_FAILED,
          issues: ['调用上下文缺少会话 userId（不得由工具输入提供）'],
        };
      }
      scope = { userId };
    }

    try {
      switch (tool) {
        case 'get_resume_summary': {
          const parsed = GetResumeSummaryInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptResumeSummary(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_jd_summary': {
          const parsed = GetJdSummaryInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptJdSummary(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_match_result': {
          const parsed = GetMatchResultInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptMatchResult(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_capabilities': {
          const parsed = GetCapabilitiesInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptCapabilities(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_project_results': {
          const parsed = GetProjectResultsInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptProjectResults(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_action_plan': {
          const parsed = GetActionPlanInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptActionPlan(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_learning_tasks': {
          const parsed = GetLearningTasksInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptLearningTasks(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'get_portfolio': {
          const parsed = GetPortfolioInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          return wrap(tool, await adaptPortfolio(deps, scope as AgentReadToolContext, parsed.data));
        }
        case 'rag_retrieve': {
          const parsed = RagRetrieveInput.safeParse(rawInput);
          if (!parsed.success) {
            return { status: 'INVALID_INPUT', tool, code: ERROR_CODE.VALIDATION_FAILED, issues: toIssues(parsed.error) };
          }
          const result = await adaptRagRetrieve(deps, null, parsed.data);
          if (!result.ok) {
            return result.reason === 'INVALID_QUERY'
              ? {
                  status: 'INVALID_INPUT',
                  tool,
                  code: ERROR_CODE.VALIDATION_FAILED,
                  issues: ['query 归一后必须为 1–200 字符'],
                }
              : { status: 'NOT_FOUND', tool, code: ERROR_CODE.NOT_FOUND };
          }
          return wrap(tool, result);
        }
        default:
          // 类型上不可达；保留为**硬失败兜底**（绝不落到任何隐式分派）
          return {
            status: 'UNKNOWN_TOOL',
            tool: String(tool),
            code: ERROR_CODE.VALIDATION_FAILED,
            message: '未授权的工具名',
          };
      }
    } catch {
      // 不向调用方回显内部细节（无堆栈、无输入原文、无 PII）
      return { status: 'FAILED', tool, code: ERROR_CODE.INTERNAL_ERROR };
    }
  }

  return { layer: AGENT_READ_TOOL_LAYER_VERSION, toolNames: AGENT_READ_TOOL_NAMES, invoke };
}
