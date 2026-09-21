/**
 * T5-B-1 —— AgentProposal 领域契约（**单一来源**）
 *
 * 依据：T5-B-1 授权书 §四。
 *
 * 硬约束（不得违反）：
 *   - `kind` v1 仅 `PLAN`（Migration #14 `AgentProposal_kind_check` 同一集合）；
 *   - `status` v1 仅 `ACTIVE`（Migration #14 `AgentProposal_status_check` 同一集合）；
 *   - **不得提前加入** `SUPERSEDED` / `DISMISSED` / `CONFIRMED` / `EXECUTED`；
 *   - `revision` v1 恒为 **1**（不支持多 revision）；唯一性由 DB `@@unique([runId, revision])` 兜底；
 *   - 本模块纯函数 + 零依赖（不得 import Prisma / DB client / raw SQL）。
 */

/** v1 允许的 proposal kind */
export const AGENT_PROPOSAL_KINDS = ['PLAN'] as const;
export type AgentProposalKind = (typeof AGENT_PROPOSAL_KINDS)[number];

/** v1 允许的 proposal status（**不得**出现 SUPERSEDED / DISMISSED / CONFIRMED / EXECUTED） */
export const AGENT_PROPOSAL_STATUSES = ['ACTIVE'] as const;
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number];

/** v1 唯一的 revision 取值 */
export const AGENT_PROPOSAL_V1_REVISION = 1;

export function isAgentProposalKind(value: unknown): value is AgentProposalKind {
  return typeof value === 'string' && (AGENT_PROPOSAL_KINDS as readonly string[]).includes(value);
}

export function isAgentProposalStatus(value: unknown): value is AgentProposalStatus {
  return typeof value === 'string' && (AGENT_PROPOSAL_STATUSES as readonly string[]).includes(value);
}

/** v1 只接受 revision = 1（整数） */
export function isAgentProposalRevision(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value === AGENT_PROPOSAL_V1_REVISION;
}
