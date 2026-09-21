import type { EvidenceRef } from '../types.ts';
import type { BasisType, Confidence } from '../ai/judgment.ts';
import type { Criticality, RequirementCategory } from '../jd/types.ts';

/** T4 · 简历 × JD 匹配领域类型。零依赖，可离线单测。 */

export const MATCH_STATUS = {
  HAVE: 'HAVE',
  ENHANCE: 'ENHANCE',
  MISSING: 'MISSING',
} as const;
export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

export const MATCH_STATE = {
  /** 简历没有任何 CONFIRMED 事实：正常业务状态，不是异常 */
  NEEDS_RESUME_CONFIRMATION: 'NEEDS_RESUME_CONFIRMATION',
} as const;
export type MatchState = (typeof MATCH_STATE)[keyof typeof MATCH_STATE];

export type MatchRequirement = {
  id: string | null;
  /** JD 原文，必须保持 wording */
  text: string;
  category: RequirementCategory;
  criticality: Criticality;
};

export type MatchItemOutput = {
  requirementId: string | null;
  requirement: string;
  category: RequirementCategory;
  criticality: Criticality;
  status: MatchStatus;
  /** 为什么这样判断 */
  reason: string;
  /** 依据是什么：type 复用 AI 契约词表 */
  basis: { type: BasisType; detail: string };
  /** 原始证据在哪 */
  evidenceRefs: EvidenceRef[];
  resumeEvidence: string | null;
  /** 哪些是推断 */
  isInference: boolean;
  /** 哪些需要用户确认 */
  needsUserConfirmation: boolean;
  confidence: Confidence;
  suggestion: string | null;
};

export type MatchSummary = {
  total: number;
  have: number;
  enhance: number;
  missing: number;
  /** 必须具备项总数 */
  mustTotal: number;
  /** 必须具备项中已覆盖数（用于「必须具备覆盖 n/m」，不使用百分比） */
  mustHave: number;
  needsUserConfirmation: number;
  ambiguous: number;
};

export type MatchOutcome =
  | { ok: true; items: MatchItemOutput[]; summary: MatchSummary }
  | { ok: false; state: MatchState; message: string };

export class MatchContractError extends Error {
  code: string;
  issues: string[];

  constructor(issues: string[]) {
    super(`匹配结果未通过契约校验：${issues.join('; ')}`);
    this.name = 'MatchContractError';
    this.code = 'MATCH_CONTRACT_VIOLATION';
    this.issues = issues;
  }
}
