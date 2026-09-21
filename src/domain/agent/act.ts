/**
 * T6-4-A —— Act 领域契约（状态机 + Tool 白名单 + 幂等键）。
 *
 * 授权依据：T6-4-A/B 授权书 §三（状态机）/ §五（首批 5 Tool）/ §四（幂等）。
 *
 * 硬边界：
 *   - 状态机：只有 PROPOSED→CONFIRMED→EXECUTING→SUCCEEDED/FAILED；
 *     PROPOSED→CANCELLED；禁止 PROPOSED→EXECUTING 直跳；
 *     CANCELLED / SUCCEEDED 不得再执行（T6-4 §三）；
 *   - Act Tool 白名单**恰好 5 个**（§五），任何增删属 Contract Change；
 *   - 本模块纯函数 + 零依赖（不得 import Prisma / DB client）。
 */

/** Act Tool 白名单（§五，恰好 5 个；顺序即授权书顺序） */
export const ACT_TOOL_NAMES = [
  'create_career_goal',
  'attach_jd_to_goal',
  'create_application',
  'update_application_stage',
  'create_learning_task',
] as const;

export type ActToolName = (typeof ACT_TOOL_NAMES)[number];

export function isActToolName(value: unknown): value is ActToolName {
  return typeof value === 'string' && (ACT_TOOL_NAMES as readonly string[]).includes(value);
}

/** Act Tool Contract 版本（本批次交付；后续变更须授权） */
export const ACT_TOOL_CONTRACT_VERSION = 'agent-act-tool-contract/v1';

/** Act Action 状态机（§三） */
export const ACT_ACTION_STATUSES = [
  'PROPOSED',
  'CONFIRMED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;

export type ActActionStatus = (typeof ACT_ACTION_STATUSES)[number];

export function isActActionStatus(value: unknown): value is ActActionStatus {
  return typeof value === 'string' && (ACT_ACTION_STATUSES as readonly string[]).includes(value);
}

/** §三 合法转移表（唯一真源；DB CHECK 兜底状态集合，本表兜底转移语义） */
const ALLOWED_TRANSITIONS: Record<ActActionStatus, readonly ActActionStatus[]> = {
  PROPOSED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['EXECUTING'],
  EXECUTING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [], // FAILED 是否允许 retry：§三.6 保留为服务端明确控制，本版不开放
  CANCELLED: [],
};

/** 状态机判定：from → to 是否合法转移 */
export function canTransitionActStatus(from: ActActionStatus, to: ActActionStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/** execute 的合法起点：只有 CONFIRMED（§三.2 / §三.7 禁止 PROPOSED→EXECUTING） */
export function canExecute(status: ActActionStatus): boolean {
  return status === 'CONFIRMED';
}

/** 终态：不得再转移 */
export function isActTerminalStatus(status: ActActionStatus): boolean {
  return status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * §四 幂等键：sha256(toolName + '\n' + canonicalJson(payload))。
 * canonicalJson：对象键排序后序列化（同一 Action 重复 Confirm/提交得到同一 key）。
 */
export async function computeActIdempotencyKey(
  toolName: ActToolName,
  payload: unknown,
): Promise<string> {
  const { createHash } = await import('node:crypto');
  const canonical = canonicalJson(payload);
  return createHash('sha256').update(`${toolName}\n${canonical}`).digest('hex');
}

/** 键排序的稳定序列化（数组保持顺序；undefined 剔除） */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
