import type { MatchItemOutput, MatchSummary } from './types.ts';

export type MatchItemCreateInput = {
  requirementId: string | null;
  reqText: string;
  status: MatchItemOutput['status'];
  category: MatchItemOutput['category'];
  criticality: MatchItemOutput['criticality'];
  reason: string;
  basisType: string;
  basisDetail: string;
  resumeEvidence: string | null;
  evidenceRefs: unknown;
  isInference: boolean;
  needsUserConfirmation: boolean;
  confidence: string;
  suggestion: string | null;
};

export type MatchRunCreateInput = {
  userId: string;
  resumeId: string;
  jdId: string;
  matcherVersion: string;
  summary: MatchSummary;
  items: { create: MatchItemCreateInput[] };
};

/**
 * 纯函数映射：匹配结果 → Prisma 写入形态。
 * 一次 run 的全部 MatchItem 必须随 MatchRun 原子写入，杜绝半成品。
 */
export function toMatchRunCreateInput(
  result: { items: readonly MatchItemOutput[]; summary: MatchSummary },
  args: { userId: string; resumeId: string; jdId: string; matcherVersion: string },
): MatchRunCreateInput {
  if (!args.userId || args.userId.trim().length === 0) {
    throw new Error('userId 必须来自会话，不能为空或来自请求体');
  }
  if (result.items.length === 0) {
    throw new Error('拒绝写入：没有任何 MatchItem');
  }

  return {
    userId: args.userId,
    resumeId: args.resumeId,
    jdId: args.jdId,
    matcherVersion: args.matcherVersion,
    summary: result.summary,
    items: {
      create: result.items.map((item) => ({
        requirementId: item.requirementId,
        reqText: item.requirement,
        status: item.status,
        category: item.category,
        criticality: item.criticality,
        reason: item.reason,
        basisType: item.basis.type,
        basisDetail: item.basis.detail,
        resumeEvidence: item.resumeEvidence,
        evidenceRefs: item.evidenceRefs,
        isInference: item.isInference,
        needsUserConfirmation: item.needsUserConfirmation,
        confidence: item.confidence,
        suggestion: item.suggestion,
      })),
    },
  };
}
