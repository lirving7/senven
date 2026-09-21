import { z } from 'zod';
import { EVIDENCE_SOURCE, FACT_STATUS } from '../types.ts';
import type { EvidenceSource, EvidenceRef, FactStatus } from '../types.ts';

/**
 * AI 输出统一契约（V1）
 *
 * 为什么需要统一契约：12 项 AI 能力如果各自返回一种 JSON，
 * 「可解释性」与「绝不编造」就无法在代码层统一强制，只能逐处靠 prompt 自觉。
 * 这里把两者的强制点收敛到一处：所有能力都返回 AiJudgment[]。
 *
 * 对应「AI 判断必须能够解释」的五问：
 *   为什么这样判断   → reason
 *   依据是什么       → basis.type + basis.detail
 *   原始证据在哪里   → evidenceRefs[].locator + excerpt
 *   哪些内容是推断   → isInference（由 status / basis 推导，且校验一致）
 *   哪些需要用户确认 → needsUserConfirmation（同上）
 */

export const BASIS_TYPE = {
  /** 规则精确命中（normalizeKey 完全相等） */
  EXACT_MATCH: 'EXACT_MATCH',
  /** 语义匹配（LLM 判定语义等价，需给出一致的判定说明） */
  SEMANTIC_MATCH: 'SEMANTIC_MATCH',
  /** 规则推导（如学历门槛比对、年限计算） */
  RULE: 'RULE',
  /** 模型推断（材料里没有明说，模型推出来的） */
  MODEL_INFERENCE: 'MODEL_INFERENCE',
  /** 判定为不存在 */
  ABSENT: 'ABSENT',
} as const;
export type BasisType = (typeof BASIS_TYPE)[keyof typeof BASIS_TYPE];

export const CONFIDENCE = { HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW' } as const;
export type Confidence = (typeof CONFIDENCE)[keyof typeof CONFIDENCE];

export type AiJudgment = {
  /** 被判断的对象（JD 要求原文 / 待检查的简历表述） */
  requirement: string;
  status: FactStatus;
  /** 为什么这样判断 */
  reason: string;
  basis: { type: BasisType; detail: string };
  /** 命中的简历表述，逐字引用；未命中为 null */
  resumeEvidence: string | null;
  /** 原始证据位置 */
  evidenceRefs: EvidenceRef[];
  isInference: boolean;
  needsUserConfirmation: boolean;
  confidence: Confidence;
  /** 可执行动作；没有合适动作时为 null（不允许空泛占位） */
  suggestion: string | null;
};

/** 允许把状态标为 CONFIRMED 的证据来源：只有用户自己提供的内容算 */
const TRUSTED_SOURCES: readonly EvidenceSource[] = [EVIDENCE_SOURCE.RESUME_TEXT, EVIDENCE_SOURCE.USER_STATEMENT];

const MIN_REASON_LENGTH = 8;

export const aiJudgmentSchema = z.object({
  requirement: z.string().trim().min(1),
  status: z.enum(['CONFIRMED', 'INFERRED', 'UNCONFIRMED', 'MISSING']),
  reason: z.string().trim().min(MIN_REASON_LENGTH, `reason 至少 ${MIN_REASON_LENGTH} 字，不允许敷衍`),
  basis: z.object({
    type: z.enum(['EXACT_MATCH', 'SEMANTIC_MATCH', 'RULE', 'MODEL_INFERENCE', 'ABSENT']),
    detail: z.string().trim().min(1),
  }),
  resumeEvidence: z.string().nullable(),
  evidenceRefs: z.array(
    z.object({
      source: z.enum(['RESUME_TEXT', 'USER_STATEMENT', 'OCR', 'JD']),
      locator: z.string().trim().min(1),
      excerpt: z.string().optional(),
    }),
  ),
  isInference: z.boolean(),
  needsUserConfirmation: z.boolean(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  suggestion: z.string().nullable(),
});

export const aiJudgmentListSchema = z.object({ judgments: z.array(aiJudgmentSchema) });

/** 供模型使用的 JSON schema 描述（不依赖厂商 strict 模式） */
export const AI_JUDGMENT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string', description: '被判断的对象原文' },
          status: { type: 'string', enum: ['CONFIRMED', 'INFERRED', 'UNCONFIRMED', 'MISSING'] },
          reason: { type: 'string', description: '为什么这样判断，至少 8 字' },
          basis: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['EXACT_MATCH', 'SEMANTIC_MATCH', 'RULE', 'MODEL_INFERENCE', 'ABSENT'],
              },
              detail: { type: 'string' },
            },
            required: ['type', 'detail'],
          },
          resumeEvidence: { type: ['string', 'null'], description: '逐字引用简历原文，未命中填 null' },
          evidenceRefs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                source: { type: 'string', enum: ['RESUME_TEXT', 'USER_STATEMENT', 'OCR', 'JD'] },
                locator: { type: 'string', description: '如 resume:line:42' },
                excerpt: { type: 'string' },
              },
              required: ['source', 'locator'],
            },
          },
          isInference: { type: 'boolean' },
          needsUserConfirmation: { type: 'boolean' },
          confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
          suggestion: { type: ['string', 'null'] },
        },
        required: [
          'requirement',
          'status',
          'reason',
          'basis',
          'resumeEvidence',
          'evidenceRefs',
          'isInference',
          'needsUserConfirmation',
          'confidence',
          'suggestion',
        ],
      },
    },
  },
  required: ['judgments'],
};

/**
 * 契约校验。这是「绝不编造」在代码层的强制点：
 * 模型返回的任何一条判断，只要声称 CONFIRMED 却没有可信证据，一律判为不合法。
 */
export function validateJudgment(j: AiJudgment): string[] {
  const issues: string[] = [];

  if (j.reason.trim().length < MIN_REASON_LENGTH) {
    issues.push('reason 过短，无法解释判断依据');
  }
  if (j.basis.detail.trim().length === 0) {
    issues.push('basis.detail 不能为空');
  }

  // I1 声称已确认，必须拿出可信证据
  if (j.status === FACT_STATUS.CONFIRMED) {
    if (j.evidenceRefs.length === 0) {
      issues.push('status=CONFIRMED 但没有任何证据引用');
    } else if (!j.evidenceRefs.some((r) => TRUSTED_SOURCES.includes(r.source))) {
      issues.push('status=CONFIRMED 但证据仅来自 OCR/JD，必须降级为 INFERRED 或 UNCONFIRMED');
    }
    if (j.isInference) {
      issues.push('status=CONFIRMED 与 isInference=true 矛盾');
    }
  }

  // I2 声明缺失，就不该有证据
  if (j.status === FACT_STATUS.MISSING) {
    if (j.evidenceRefs.length > 0) {
      issues.push('status=MISSING 但存在证据引用，判定矛盾');
    }
    if (j.resumeEvidence !== null) {
      issues.push('status=MISSING 但填写了 resumeEvidence，判定矛盾');
    }
  }

  // I3 推断标记必须与状态、依据类型一致
  const statusImpliesInference = j.status === FACT_STATUS.INFERRED;
  const typeImpliesInference = j.basis.type === BASIS_TYPE.MODEL_INFERENCE;
  if (j.isInference !== (statusImpliesInference || typeImpliesInference)) {
    issues.push('isInference 与 status / basis.type 不一致');
  }

  // I4 只要不是 CONFIRMED，就必须交给用户确认
  if (j.status !== FACT_STATUS.CONFIRMED && !j.needsUserConfirmation) {
    issues.push('非 CONFIRMED 的判断必须标记 needsUserConfirmation=true');
  }
  if (j.status === FACT_STATUS.CONFIRMED && j.needsUserConfirmation) {
    issues.push('status=CONFIRMED 不应再要求用户确认');
  }

  // I5 判定不存在时，依据类型必须是 ABSENT
  if (j.status === FACT_STATUS.MISSING && j.basis.type !== BASIS_TYPE.ABSENT) {
    issues.push('status=MISSING 时 basis.type 应为 ABSENT');
  }

  // I6 证据定位符不允许空串（防止"有证据"占位）
  if (j.evidenceRefs.some((r) => r.locator.trim().length === 0)) {
    issues.push('evidenceRefs 存在空 locator');
  }

  return issues;
}

export function validateJudgments(list: readonly AiJudgment[]): { index: number; issues: string[] }[] {
  const out: { index: number; issues: string[] }[] = [];
  list.forEach((j, index) => {
    const issues = validateJudgment(j);
    if (issues.length > 0) out.push({ index, issues });
  });
  return out;
}

/** 校验失败即抛错：不返回半成品 */
export function assertJudgmentsValid(list: readonly AiJudgment[]): void {
  const bad = validateJudgments(list);
  if (bad.length > 0) {
    const detail = bad.map((b) => `#${b.index}: ${b.issues.join('; ')}`).join(' | ');
    throw new Error(`AI 判断未通过契约校验：${detail}`);
  }
}

/** 给 UI 用的覆盖计数（替代百分比分数） */
export function summarizeJudgments(list: readonly AiJudgment[]): {
  total: number;
  confirmed: number;
  inferred: number;
  unconfirmed: number;
  missing: number;
  needsUserConfirmation: number;
} {
  return {
    total: list.length,
    confirmed: list.filter((j) => j.status === FACT_STATUS.CONFIRMED).length,
    inferred: list.filter((j) => j.status === FACT_STATUS.INFERRED).length,
    unconfirmed: list.filter((j) => j.status === FACT_STATUS.UNCONFIRMED).length,
    missing: list.filter((j) => j.status === FACT_STATUS.MISSING).length,
    needsUserConfirmation: list.filter((j) => j.needsUserConfirmation).length,
  };
}
