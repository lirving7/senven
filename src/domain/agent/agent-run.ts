/**
 * T5-B-1 —— AgentRun 领域契约（**单一来源**）
 *
 * 依据：T5-B-1 授权书 §三 / §九 / §十二（ADR-016 §18 T5-B 边界：Plan/Propose + User Confirmation，
 * 非自主 Act；本阶段只做持久化与领域校验，零 API / 零 Tool / 零 LLM / 零 quota）。
 *
 * 硬约束（不得违反）：
 *   - `goalKind` v1 仅 `CAREER_ASSISTANCE`（Migration #14 CHECK 固定同一集合）；
 *   - `status` 仅 6 值，**不得出现 `CONFIRMED`**；
 *   - 终态：`PROPOSED` / `CANCELLED` / `FAILED` / `EXPIRED`；进入终态时写 `endedAt`；
 *   - **明确禁止** `PROPOSED → CANCELLED`，以及任何终态"复活"式转移；
 *   - 本模块纯函数 + 零依赖：**不得 import Prisma / DB client**，**不得使用 `$queryRaw`/`$executeRaw`**。
 */

/** v1 允许的 goalKind（Migration #14 `AgentRun_goalKind_check` 同一集合） */
export const AGENT_GOAL_KINDS = ['CAREER_ASSISTANCE'] as const;
export type AgentGoalKind = (typeof AGENT_GOAL_KINDS)[number];

/** v1 允许的 run status（Migration #14 `AgentRun_status_check` 同一集合） */
export const AGENT_RUN_STATUSES = [
  'CREATED',
  'PLANNING',
  'PROPOSED',
  'CANCELLED',
  'FAILED',
  'EXPIRED',
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** 终态（进入即写 `endedAt`） */
export const AGENT_RUN_TERMINAL_STATUSES = ['PROPOSED', 'CANCELLED', 'FAILED', 'EXPIRED'] as const;

/**
 * 状态转移表（**唯一权威**，与授权书 §三 逐条一致）：
 *   CREATED    → PLANNING | CANCELLED | FAILED
 *   PLANNING   → PROPOSED | CANCELLED | FAILED
 *   PROPOSED   → EXPIRED
 *   CANCELLED  → (无)
 *   FAILED     → (无)
 *   EXPIRED    → (无)
 */
const AGENT_RUN_TRANSITIONS: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  CREATED: ['PLANNING', 'CANCELLED', 'FAILED'],
  PLANNING: ['PROPOSED', 'CANCELLED', 'FAILED'],
  PROPOSED: ['EXPIRED'],
  CANCELLED: [],
  FAILED: [],
  EXPIRED: [],
};

export function isAgentGoalKind(value: unknown): value is AgentGoalKind {
  return typeof value === 'string' && (AGENT_GOAL_KINDS as readonly string[]).includes(value);
}

export function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return typeof value === 'string' && (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isTerminalAgentRunStatus(value: unknown): boolean {
  return (
    typeof value === 'string' && (AGENT_RUN_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

/** 该状态是否有任何出边（用于守卫断言） */
export function agentRunStatusHasOutgoing(status: AgentRunStatus): boolean {
  return AGENT_RUN_TRANSITIONS[status].length > 0;
}

/**
 * 判定状态转移。
 * - 同值 → `NOOP`
 * - 表内允许 → `ALLOWED`
 * - 其余（含终态再次转移、`PROPOSED → CANCELLED`）→ `FORBIDDEN`
 */
export type AgentRunTransitionVerdict = 'ALLOWED' | 'NOOP' | 'FORBIDDEN';

export function evaluateAgentRunTransition(
  from: AgentRunStatus,
  to: AgentRunStatus,
): AgentRunTransitionVerdict {
  if (from === to) return 'NOOP';
  return AGENT_RUN_TRANSITIONS[from].includes(to) ? 'ALLOWED' : 'FORBIDDEN';
}

/** 布尔封装：仅 `FORBIDDEN` 返回 false（`NOOP` 可接受） */
export function canTransitionAgentRun(from: AgentRunStatus, to: AgentRunStatus): boolean {
  return evaluateAgentRunTransition(from, to) !== 'FORBIDDEN';
}

/**
 * `endedAt` 规则（T5-B-1 §三）：**进入终态时**写 `endedAt`。
 * - 目标非终态 → 保持不变（一般为 null）
 * - 目标为终态且当前 `endedAt` 为 null → 写入 `now`
 * - 目标为终态且当前 `endedAt` 已有值（如 `PROPOSED → EXPIRED`）→ **保留首次进入终态的时间**
 */
export function resolveAgentRunEndedAt(
  currentEndedAt: Date | null,
  to: AgentRunStatus,
  now: Date,
): Date | null {
  if (!isTerminalAgentRunStatus(to)) return currentEndedAt;
  return currentEndedAt ?? now;
}
