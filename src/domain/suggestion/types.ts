import type { EvidenceRef, FactStatus } from '../types.ts';

/**
 * T6 · 简历修改建议（模式 A：保守修改）
 *
 * 核心边界（T4 → T6）：
 *   T4 负责发现「缺什么」，T6 只能告诉用户「如何补强」。
 *   T6 **永远不能**替用户创造「已经做过什么」。
 */

export const SUGGESTION_KIND = {
  /** 已有 CONFIRMED 事实，只改表达 */
  REPHRASE: 'REPHRASE',
  /** 有材料但未确认（INFERRED / 仅 OCR），先请用户确认事实 */
  CONFIRM_FACT: 'CONFIRM_FACT',
  /** 没有对应事实：只给指引，不产出任何内容 */
  GUIDANCE: 'GUIDANCE',
} as const;
export type SuggestionKind = (typeof SUGGESTION_KIND)[keyof typeof SUGGESTION_KIND];

export const SUGGESTION_ACTION = { ACCEPT: 'ACCEPT', SKIP: 'SKIP' } as const;
export type SuggestionAction = (typeof SUGGESTION_ACTION)[keyof typeof SUGGESTION_ACTION];

export type SuggestionDraft = {
  matchRunId: string | null;
  matchItemRef: string | null;
  requirement: string;
  kind: SuggestionKind;
  /** 写入目标，如 ResumeProject:<id>.outcome */
  targetField: string;
  before: string | null;
  /** 只有 REPHRASE 允许非空；GUIDANCE / CONFIRM_FACT 必须为 null */
  after: string | null;
  reason: string;
  verdict: FactStatus;
  verdictReason: string;
  evidenceRefs: EvidenceRef[];
  needsUserConfirmation: boolean;
};

export type RejectedSuggestion = {
  requirement: string;
  /** 为什么这条建议被丢弃（例如可能引入了新事实） */
  reason: string;
};

export type SuggestionOutcome =
  | { ok: true; drafts: SuggestionDraft[]; rejected: RejectedSuggestion[] }
  | { ok: false; state: SuggestionState; message: string };

export const SUGGESTION_STATE = {
  NEEDS_RESUME_CONFIRMATION: 'NEEDS_RESUME_CONFIRMATION',
  NOTHING_TO_SUGGEST: 'NOTHING_TO_SUGGEST',
} as const;
export type SuggestionState = (typeof SUGGESTION_STATE)[keyof typeof SUGGESTION_STATE];

export class SuggestionContractError extends Error {
  code: string;
  issues: string[];

  constructor(issues: string[]) {
    super(`修改建议未通过契约校验：${issues.join('; ')}`);
    this.name = 'SuggestionContractError';
    this.code = 'SUGGESTION_CONTRACT_VIOLATION';
    this.issues = issues;
  }
}
