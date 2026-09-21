/**
 * T5-B-2B —— Agent PLAN payload 契约（`agent-plan/v1`，**严格**）
 *
 * 依据 T5-B-2B 授权书 §八：
 *   - 顶层键**恰好** `{ kind, summary, steps, nextAction }`，`kind` 必须为 `"PLAN"`；
 *   - `summary` 1–800；`steps` 1–8；每步**恰好** `{ order, title, action, rationale }`；
 *   - `order` 必须为 `1..N` 连续整数；`title` 1–80；`action` 1–300；`rationale` 1–300；
 *   - `nextAction` 1–200；
 *   - 禁止额外顶层字段 / 额外 step 字段 / URL / email / 密钥；
 *   - 序列化后 **≤ 8 KB**（**严于** T5-B-1 的 16 KB 通用上限）。
 *
 * 设计原则（与 T5-B-1 `validation.ts` 一致）：
 *   - 纯函数 + 零依赖（无 Prisma / DB client / raw SQL / HTTP / node API）；
 *   - 返回**判别结果**而非抛异常，由调用方决定映射；
 *   - 字段级长度上限使「整段原文复制」在结构上不可达（无需启发式判断）。
 */

import { z } from 'zod';

import { AGENT_PAYLOAD_FORBIDDEN_KEYS } from './validation.ts';

/** v1 唯一允许的 PLAN kind（与 `AgentProposal_kind_check` / T5-B-1 一致） */
export const AGENT_PLAN_KIND = 'PLAN';

export const AGENT_PLAN_SUMMARY_MAX = 800;
export const AGENT_PLAN_STEPS_MIN = 1;
export const AGENT_PLAN_STEPS_MAX = 8;
export const AGENT_PLAN_STEP_TITLE_MAX = 80;
export const AGENT_PLAN_STEP_ACTION_MAX = 300;
export const AGENT_PLAN_STEP_RATIONALE_MAX = 300;
export const AGENT_PLAN_NEXT_ACTION_MAX = 200;

/** PLAN payload 序列化上限：**8 KB**（严于通用 16 KB） */
export const AGENT_PLAN_PAYLOAD_MAX_BYTES = 8 * 1024;

/** PLAN 的 JSON Schema（用于 `schemaInPrompt: true` 引导；最终约束仍由本模块 strict 校验兜底） */
export const AGENT_PLAN_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'summary', 'steps', 'nextAction'],
  properties: {
    kind: { type: 'string', enum: [AGENT_PLAN_KIND] },
    summary: { type: 'string', minLength: 1, maxLength: AGENT_PLAN_SUMMARY_MAX },
    steps: {
      type: 'array',
      minItems: AGENT_PLAN_STEPS_MIN,
      maxItems: AGENT_PLAN_STEPS_MAX,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['order', 'title', 'action', 'rationale'],
        properties: {
          order: { type: 'integer', minimum: 1, maximum: AGENT_PLAN_STEPS_MAX },
          title: { type: 'string', minLength: 1, maxLength: AGENT_PLAN_STEP_TITLE_MAX },
          action: { type: 'string', minLength: 1, maxLength: AGENT_PLAN_STEP_ACTION_MAX },
          rationale: { type: 'string', minLength: 1, maxLength: AGENT_PLAN_STEP_RATIONALE_MAX },
        },
      },
    },
    nextAction: { type: 'string', minLength: 1, maxLength: AGENT_PLAN_NEXT_ACTION_MAX },
  },
};

// ─── zod strict 结构（未知键一律拒绝）─────────────────────────────────────

const planStepSchema = z
  .object({
    order: z.number().int().min(1).max(AGENT_PLAN_STEPS_MAX),
    title: z.string().min(1).max(AGENT_PLAN_STEP_TITLE_MAX),
    action: z.string().min(1).max(AGENT_PLAN_STEP_ACTION_MAX),
    rationale: z.string().min(1).max(AGENT_PLAN_STEP_RATIONALE_MAX),
  })
  .strict();

export const agentPlanPayloadSchema = z
  .object({
    kind: z.literal(AGENT_PLAN_KIND),
    summary: z.string().min(1).max(AGENT_PLAN_SUMMARY_MAX),
    steps: z.array(planStepSchema).min(AGENT_PLAN_STEPS_MIN).max(AGENT_PLAN_STEPS_MAX),
    nextAction: z.string().min(1).max(AGENT_PLAN_NEXT_ACTION_MAX),
  })
  .strict();

export type AgentPlanStep = z.infer<typeof planStepSchema>;
export type AgentPlanPayload = z.infer<typeof agentPlanPayloadSchema>;

// ─── 机械附加约束：外部引用 / 密钥痕迹 ───────────────────────────────────

const EXTERNAL_REFERENCE_PATTERN = /:\/\/|\bwww\./i;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/;

function allStrings(value: unknown, acc: string[], depth = 0): void {
  if (depth > 16) return;
  if (typeof value === 'string') {
    acc.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) allStrings(item, acc, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const v of Object.values(value)) allStrings(v, acc, depth + 1);
  }
}

function allKeys(value: unknown, acc: string[], depth = 0): void {
  if (depth > 16) return;
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, acc, depth + 1);
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      acc.push(k);
      allKeys(v, acc, depth + 1);
    }
  }
}

export type AgentPlanValidationResult =
  | { ok: true; plan: AgentPlanPayload; serialized: string; bytes: number }
  | { ok: false; reason: string };

/** 序列化（**确定性**：固定键序由 schema 推导，同一 payload 恒得同一字符串） */
export function serializeAgentPlanPayload(plan: AgentPlanPayload): string {
  return JSON.stringify({
    kind: plan.kind,
    summary: plan.summary,
    steps: plan.steps.map((s) => ({
      order: s.order,
      title: s.title,
      action: s.action,
      rationale: s.rationale,
    })),
    nextAction: plan.nextAction,
  });
}

/**
 * PLAN payload 严格校验（单一入口）。
 *
 * 顺序：① zod strict 结构 → ② `order` 连续性 → ③ 禁止键 → ④ 外部引用 / email → ⑤ 8 KB 上限。
 * 任一步失败 → `{ ok: false, reason }`，由 Runtime 映射为 `LLM_INVALID_PLAN`（**不重试**）。
 */
export function validateAgentPlanPayload(value: unknown): AgentPlanValidationResult {
  const parsed = agentPlanPayloadSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first && first.path.length > 0 ? first.path.join('.') : '(root)';
    return { ok: false, reason: `PLAN 结构不合法：${path}: ${first ? first.message : 'unknown'}` };
  }
  const plan = parsed.data;

  // ② order 必须为 1..N 连续整数
  for (let i = 0; i < plan.steps.length; i += 1) {
    if (plan.steps[i]!.order !== i + 1) {
      return { ok: false, reason: `steps[${i}].order 必须为 ${i + 1}（必须 1..N 连续）` };
    }
  }

  // ③ 禁止键（大小写不敏感，递归）
  const keys: string[] = [];
  allKeys(plan, keys);
  const forbidden = new Set<string>(AGENT_PAYLOAD_FORBIDDEN_KEYS);
  for (const key of keys) {
    if (forbidden.has(key.toLowerCase())) {
      return { ok: false, reason: `PLAN 含禁止键：${key}` };
    }
  }

  // ④ 外部引用 / email（不得出现 URL / 邮箱 / 外部引用）
  const strings: string[] = [];
  allStrings(plan, strings);
  for (const s of strings) {
    if (EXTERNAL_REFERENCE_PATTERN.test(s)) {
      return { ok: false, reason: 'PLAN 不得包含 URL / 外部引用' };
    }
    if (EMAIL_PATTERN.test(s)) {
      return { ok: false, reason: 'PLAN 不得包含 email' };
    }
  }

  // ⑤ 8 KB 上限（严于 T5-B-1 的 16 KB）
  const serialized = serializeAgentPlanPayload(plan);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > AGENT_PLAN_PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: `PLAN payload 超过 ${AGENT_PLAN_PAYLOAD_MAX_BYTES} 字节（实际 ${bytes}）` };
  }

  return { ok: true, plan, serialized, bytes };
}
