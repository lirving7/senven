/**
 * T5-B-2B —— Agent Runtime 失败分类（`errorCode` 取值）
 *
 * 依据 T5-B-2B 授权书 §十二：至少区分
 *   `LLM_QUOTA_EXCEEDED` / `LLM_PROVIDER_ERROR` / `LLM_TIMEOUT` /
 *   `LLM_INVALID_PLAN` / `AGENT_TOOL_ERROR` / `AGENT_CANCELLED`
 * （外加一个仅用于**并发状态冲突**的内部码 `AGENT_STATE_CONFLICT`）。
 *
 * 纪律：
 *   - **不新增 HTTP 错误码**：本文件不修改 `src/errors.ts`；`AgentRun.errorCode` 是自由字符串列
 *     （Migration #14 既有），因此这些取值不进入既有错误码体系；
 *   - 其中 `LLM_QUOTA_EXCEEDED` 与既有 `ERROR_CODE.LLM_QUOTA_EXCEEDED` **逐字相同**
 *     （由测试断言，保证复用既有 convention）；
 *   - 纯函数 + 零依赖（不 import Prisma / DB / HTTP / errors.ts），用**鸭子类型**分类异常。
 */

/** Runtime 可写入 `AgentRun.errorCode` 的全部取值（v1 冻结集合） */
export const AGENT_RUN_ERROR_CODE = {
  /** 配额不足（provider **未**被调用；与 `ERROR_CODE.LLM_QUOTA_EXCEEDED` 同字面量） */
  LLM_QUOTA_EXCEEDED: 'LLM_QUOTA_EXCEEDED',
  /** provider 调用失败（非超时） */
  LLM_PROVIDER_ERROR: 'LLM_PROVIDER_ERROR',
  /** provider 超时 */
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  /** provider 返回内容未通过 strict PLAN 契约（**不重试**） */
  LLM_INVALID_PLAN: 'LLM_INVALID_PLAN',
  /** 只读工具装配 / 执行失败 */
  AGENT_TOOL_ERROR: 'AGENT_TOOL_ERROR',
  /** Run 在 Runtime 继续前已被取消（不调用 provider、不写 proposal） */
  AGENT_CANCELLED: 'AGENT_CANCELLED',
  /** 并发状态冲突：提交时 Run 已不处于 PLANNING（如并发取消） */
  AGENT_STATE_CONFLICT: 'AGENT_STATE_CONFLICT',
} as const;

export type AgentRunErrorCode = (typeof AGENT_RUN_ERROR_CODE)[keyof typeof AGENT_RUN_ERROR_CODE];

/** 所有 terminal failure 都必须写 `endedAt` 的错误码集合（用于测试与守卫） */
export const AGENT_RUN_FAILURE_ERROR_CODES: readonly AgentRunErrorCode[] = [
  AGENT_RUN_ERROR_CODE.LLM_QUOTA_EXCEEDED,
  AGENT_RUN_ERROR_CODE.LLM_PROVIDER_ERROR,
  AGENT_RUN_ERROR_CODE.LLM_TIMEOUT,
  AGENT_RUN_ERROR_CODE.LLM_INVALID_PLAN,
  AGENT_RUN_ERROR_CODE.AGENT_TOOL_ERROR,
  AGENT_RUN_ERROR_CODE.AGENT_STATE_CONFLICT,
];

function codeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * 把抛出物映射为 `AgentRun.errorCode`。
 *
 * 复用既有约定（不新增错误体系）：
 *   - `code === 'LLM_QUOTA_EXCEEDED'`（既有 `AppError`，usage-gate 抛出）→ `LLM_QUOTA_EXCEEDED`
 *   - `code === 'TIMEOUT'`（既有 `LLMError` 子类）→ `LLM_TIMEOUT`
 *   - 其余 `LLMError`（`FORMAT` / `AUTH` / `RATE_LIMIT` / `UPSTREAM`）→ `LLM_PROVIDER_ERROR`
 *   - 其它 → `LLM_PROVIDER_ERROR`（保守归类，不臆造新码）
 */
export function classifyAgentProviderFailure(err: unknown): AgentRunErrorCode {
  const code = codeOf(err);
  if (code === AGENT_RUN_ERROR_CODE.LLM_QUOTA_EXCEEDED) {
    return AGENT_RUN_ERROR_CODE.LLM_QUOTA_EXCEEDED;
  }
  if (code === 'TIMEOUT') return AGENT_RUN_ERROR_CODE.LLM_TIMEOUT;
  return AGENT_RUN_ERROR_CODE.LLM_PROVIDER_ERROR;
}

/** 是否是「配额不足」（provider 未被调用）——决定 providerCalls 必须为 0 */
export function isQuotaRejection(err: unknown): boolean {
  return codeOf(err) === AGENT_RUN_ERROR_CODE.LLM_QUOTA_EXCEEDED;
}
