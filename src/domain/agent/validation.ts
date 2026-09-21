/**
 * T5-B-1 —— Agent 领域**严格结构校验**（server-side；不落库、不调用 LLM）
 *
 * 依据：T5-B-1 授权书 §五（basedOnRefs）/ §六（payload）/ §七（semanticVersions）/ §八（quotaUsage）。
 *
 * 设计原则：
 *   - 只做**机械最小限制**，不引入新的业务字段；
 *   - 全部为纯函数 + 零依赖（不得 import Prisma / DB client / raw SQL）；
 *   - 返回判别结果而非抛异常，由调用方（repository / 未来 handler）决定映射。
 */

import { isAgentGoalKind } from './agent-run.ts';
import {
  isAgentProposalKind,
  isAgentProposalRevision,
  isAgentProposalStatus,
} from './agent-proposal.ts';

export type AgentValidationResult = { ok: true } | { ok: false; reason: string };

function ok(): AgentValidationResult {
  return { ok: true };
}
function bad(reason: string): AgentValidationResult {
  return { ok: false, reason };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── §六 payload ────────────────────────────────────────────────────────

/** payload 序列化后上限：16 KB */
export const AGENT_PAYLOAD_MAX_BYTES = 16 * 1024;

/**
 * payload 禁止键（**大小写不敏感**，递归检查所有层级）。
 * 目的：payload 不得成为任意正文 / 密钥存储容器。
 */
export const AGENT_PAYLOAD_FORBIDDEN_KEYS = [
  'rawtext',
  'content',
  'prompt',
  'systemprompt',
  'answer',
  'transcript',
  'cookie',
  'token',
  'apikey',
  'secret',
  'password',
] as const;

function collectKeys(value: unknown, acc: string[], depth = 0): void {
  if (depth > 32) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, acc, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      acc.push(k);
      collectKeys(v, acc, depth + 1);
    }
  }
}

/**
 * payload 校验：
 *   1. 必须是**普通对象**（非 null / 非数组 / 非标量）；
 *   2. 必须可 JSON 序列化；
 *   3. 序列化字节数 ≤ 16 KB；
 *   4. 任意层级不得出现禁止键（大小写不敏感）。
 */
export function validateAgentProposalPayload(payload: unknown): AgentValidationResult {
  if (!isPlainObject(payload)) return bad('payload 必须是 JSON 对象（非 null / 非数组 / 非标量）');

  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return bad('payload 不是可序列化的 JSON');
  }
  if (serialized === undefined) return bad('payload 不是可序列化的 JSON');

  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > AGENT_PAYLOAD_MAX_BYTES) {
    return bad(`payload 超过上限 ${AGENT_PAYLOAD_MAX_BYTES} 字节（实际 ${bytes}）`);
  }

  const keys: string[] = [];
  collectKeys(payload, keys);
  const forbidden = new Set<string>(AGENT_PAYLOAD_FORBIDDEN_KEYS);
  for (const key of keys) {
    if (forbidden.has(key.toLowerCase())) {
      return bad(`payload 含禁止键：${key}（不得作为正文 / 密钥容器）`);
    }
  }

  return ok();
}

// ─── §五 basedOnRefs ────────────────────────────────────────────────────

/** v1 允许的引用实体类型（唯一 allowlist） */
export const AGENT_BASED_ON_ENTITY_TYPES = [
  'RESUME',
  'JD',
  'MATCH_RUN',
  'CAPABILITY',
  'PROJECT_RESULT',
  'ACTION_PLAN',
  'LEARNING_TASK',
  'PORTFOLIO',
  'KNOWLEDGE_CHUNK',
] as const;
export type AgentBasedOnEntityType = (typeof AGENT_BASED_ON_ENTITY_TYPES)[number];

/** 每个引用允许的键（穷尽；不得出现 URL / 正文 / 任意外部引用） */
export const AGENT_BASED_ON_ALLOWED_KEYS = ['entityType', 'entityId', 'version', 'fingerprint'] as const;

export function isAgentBasedOnEntityType(value: unknown): value is AgentBasedOnEntityType {
  return (
    typeof value === 'string' && (AGENT_BASED_ON_ENTITY_TYPES as readonly string[]).includes(value)
  );
}

/** 外部引用 / URL 的机械判定（entityId 必须是本地不透明 id） */
function looksLikeExternalReference(value: string): boolean {
  return /:\/\//.test(value) || /^https?:/i.test(value) || value.startsWith('//');
}

/**
 * basedOnRefs 校验：必须是数组；每项为**仅含 allowlist 键**的对象，
 * `entityType` 在 allowlist 内，`entityId` 为非空字符串且**不得为 URL / 外部引用**；
 * `version` / `fingerprint` 可选且若存在必须为字符串。
 */
export function validateAgentBasedOnRefs(refs: unknown): AgentValidationResult {
  if (!Array.isArray(refs)) return bad('basedOnRefs 必须是数组');

  const allowedKeys = new Set<string>(AGENT_BASED_ON_ALLOWED_KEYS);

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    if (!isPlainObject(ref)) return bad(`basedOnRefs[${i}] 必须是对象`);

    for (const key of Object.keys(ref)) {
      if (!allowedKeys.has(key)) {
        return bad(`basedOnRefs[${i}] 含不允许的键：${key}`);
      }
    }

    if (!isAgentBasedOnEntityType(ref.entityType)) {
      return bad(`basedOnRefs[${i}].entityType 不在 allowlist 内`);
    }

    if (typeof ref.entityId !== 'string' || ref.entityId.trim().length === 0) {
      return bad(`basedOnRefs[${i}].entityId 必须是非空字符串`);
    }
    if (looksLikeExternalReference(ref.entityId)) {
      return bad(`basedOnRefs[${i}].entityId 不得为 URL / 外部引用`);
    }

    if (ref.version !== undefined && typeof ref.version !== 'string') {
      return bad(`basedOnRefs[${i}].version 必须是字符串`);
    }
    if (ref.fingerprint !== undefined && typeof ref.fingerprint !== 'string') {
      return bad(`basedOnRefs[${i}].fingerprint 必须是字符串`);
    }
  }

  return ok();
}

// ─── §七 semanticVersions ───────────────────────────────────────────────

/** 允许的最小结构键（**不得修改 T5-A 的 tokenizer / chunker / FTS 版本值**，此处只校验形状） */
export const AGENT_SEMANTIC_VERSION_KEYS = ['tokenizer', 'chunker', 'fts'] as const;

export function validateAgentSemanticVersions(value: unknown): AgentValidationResult {
  if (!isPlainObject(value)) return bad('semanticVersions 必须是对象');

  const allowed = new Set<string>(AGENT_SEMANTIC_VERSION_KEYS);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return bad(`semanticVersions 含不允许的键：${key}`);
  }
  for (const key of AGENT_SEMANTIC_VERSION_KEYS) {
    const v = value[key];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length === 0) {
      return bad(`semanticVersions.${key} 必须是非空字符串`);
    }
  }

  return ok();
}

// ─── §八 quotaUsage ─────────────────────────────────────────────────────

/** 允许的键（服务器生成；本阶段**不实现 AGENT quota slot**） */
export const AGENT_QUOTA_USAGE_KEYS = [
  'providerCalls',
  'inputTokens',
  'outputTokens',
  'totalTokens',
] as const;

export function validateAgentQuotaUsage(value: unknown): AgentValidationResult {
  if (!isPlainObject(value)) return bad('quotaUsage 必须是对象');

  const allowed = new Set<string>(AGENT_QUOTA_USAGE_KEYS);
  for (const [key, v] of Object.entries(value)) {
    if (!allowed.has(key)) return bad(`quotaUsage 含不允许的键：${key}`);
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      return bad(`quotaUsage.${key} 必须是非负整数`);
    }
  }

  return ok();
}

// ─── 组合：AgentRun 创建输入 ────────────────────────────────────────────

export type AgentRunCreateValidationInput = {
  goalKind: unknown;
  promptTemplateVersion: unknown;
  semanticVersions: unknown;
  quotaUsage: unknown;
};

/**
 * 创建 AgentRun 的领域校验（goalKind / promptTemplateVersion / semanticVersions / quotaUsage）。
 * `modelVersion` / `providerRequestId` / `errorCode` 为可选 nullable 字段，创建期不强制。
 */
export function validateAgentRunCreateInput(input: AgentRunCreateValidationInput): AgentValidationResult {
  if (!isAgentGoalKind(input.goalKind)) {
    return bad('goalKind 不在 v1 allowlist 内（仅 CAREER_ASSISTANCE）');
  }
  if (typeof input.promptTemplateVersion !== 'string' || input.promptTemplateVersion.trim().length === 0) {
    return bad('promptTemplateVersion 必须是非空字符串');
  }

  const semantic = validateAgentSemanticVersions(input.semanticVersions);
  if (!semantic.ok) return semantic;

  const quota = validateAgentQuotaUsage(input.quotaUsage);
  if (!quota.ok) return quota;

  return ok();
}

// ─── 组合：AgentProposal 创建输入 ───────────────────────────────────────

export type AgentProposalCreateValidationInput = {
  kind: unknown;
  revision: unknown;
  payload: unknown;
  basedOnRefs: unknown;
  status?: unknown;
};

/**
 * 创建 AgentProposal 的领域校验（kind / revision / payload / basedOnRefs / 可选 status）。
 */
export function validateAgentProposalCreateInput(
  input: AgentProposalCreateValidationInput,
): AgentValidationResult {
  if (!isAgentProposalKind(input.kind)) {
    return bad('proposal kind 不在 v1 allowlist 内（仅 PLAN）');
  }
  if (!isAgentProposalRevision(input.revision)) {
    return bad(`revision v1 只允许 ${1}`);
  }

  const payload = validateAgentProposalPayload(input.payload);
  if (!payload.ok) return payload;

  const refs = validateAgentBasedOnRefs(input.basedOnRefs);
  if (!refs.ok) return refs;

  if (input.status !== undefined && !isAgentProposalStatus(input.status)) {
    return bad('proposal status 不在 v1 allowlist 内（仅 ACTIVE）');
  }

  return ok();
}
