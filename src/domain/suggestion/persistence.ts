import type { FactStatus } from '../types.ts';
import type { SuggestionDraft } from './types.ts';

export type SuggestionCreateInput = {
  resumeId: string;
  matchRunId: string | null;
  matchItemRef: string | null;
  requirement: string | null;
  kind: string;
  targetField: string;
  before: string | null;
  after: string | null;
  reason: string;
  verdict: FactStatus;
  verdictReason: string;
  evidenceRefs: unknown;
};

/** 纯函数映射：建议 → Prisma 写入形态（整批一次写入） */
export function toSuggestionCreateInputs(
  drafts: readonly SuggestionDraft[],
  args: { resumeId: string },
): SuggestionCreateInput[] {
  if (!args.resumeId || args.resumeId.trim().length === 0) {
    throw new Error('resumeId 不能为空');
  }
  if (drafts.length === 0) {
    throw new Error('拒绝写入：没有任何建议');
  }
  return drafts.map((d) => ({
    resumeId: args.resumeId,
    matchRunId: d.matchRunId,
    matchItemRef: d.matchItemRef,
    requirement: d.requirement,
    kind: d.kind,
    targetField: d.targetField,
    before: d.before,
    after: d.after,
    reason: d.reason,
    verdict: d.verdict,
    verdictReason: d.verdictReason,
    evidenceRefs: d.evidenceRefs,
  }));
}
