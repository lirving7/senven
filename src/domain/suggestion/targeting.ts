import { FACT_STATUS } from '../types.ts';
import type { EvidenceRef, FactStatus } from '../types.ts';
import type { MatchItemOutput } from '../match/types.ts';
import { SUGGESTION_KIND } from './types.ts';
import type { SuggestionKind } from './types.ts';

/** 简历里可被改写的条目。targetField 形如 ResumeProject:<id>.outcome */
export type ResumeEntryRef = {
  targetField: string;
  text: string;
  status: FactStatus;
  evidenceRefs: EvidenceRef[];
};

export type SuggestionPlan = {
  matchItemRef: string | null;
  requirement: string;
  kind: SuggestionKind;
  targetField: string;
  before: string | null;
  reason: string;
  verdict: FactStatus;
  verdictReason: string;
  evidenceRefs: EvidenceRef[];
};

/** 表达偏弱的确定性判据（不调 LLM） */
export function isWeakExpression(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.length < 12) return true;
  const vague = /相关|一些|等等|方面|若干|参与|协助/;
  return vague.test(t) && t.length < 40;
}

function usableRefs(entry: ResumeEntryRef): EvidenceRef[] {
  return entry.evidenceRefs.filter((r) => r.locator.trim().length > 0 && (r.excerpt ?? '').trim().length > 0);
}

function findByLocator(entries: readonly ResumeEntryRef[], refs: readonly EvidenceRef[]): ResumeEntryRef | null {
  const locators = new Set(refs.map((r) => r.locator));
  for (const entry of entries) {
    if (entry.evidenceRefs.some((r) => locators.has(r.locator))) return entry;
  }
  return null;
}

/**
 * 规则化产出建议计划：
 *   HAVE      → 表达弱时才 REPHRASE，否则不给建议
 *   ENHANCE   → CONFIRM_FACT（推断 / 仅 OCR，事实未确认前不能改写）
 *   MISSING   → GUIDANCE（只给指引，不产出内容）
 */
export function planSuggestions(args: {
  items: readonly MatchItemOutput[];
  resumeEntries: readonly ResumeEntryRef[];
}): SuggestionPlan[] {
  const plans: SuggestionPlan[] = [];

  for (const item of args.items) {
    const entry = findByLocator(args.resumeEntries, item.evidenceRefs);

    if (item.status === 'MISSING') {
      plans.push({
        matchItemRef: item.requirementId,
        requirement: item.requirement,
        kind: SUGGESTION_KIND.GUIDANCE,
        targetField: 'Resume.draft',
        before: null,
        reason: `当前简历中没有支持「${item.requirement}」的已确认事实，只能给出补充指引，不能代写内容。`,
        verdict: FACT_STATUS.MISSING,
        verdictReason: '无对应事实',
        evidenceRefs: [],
      });
      continue;
    }

    if (item.status === 'ENHANCE') {
      plans.push({
        matchItemRef: item.requirementId,
        requirement: item.requirement,
        kind: SUGGESTION_KIND.CONFIRM_FACT,
        targetField: entry?.targetField ?? 'Resume.unknown',
        before: entry?.text ?? null,
        reason: item.isInference
          ? '该条为模型推断，需你先确认事实，确认后才能改写表达。'
          : '该条证据来源为扫描 / OCR，需你先核验，核验后才能改写表达。',
        verdict: FACT_STATUS.UNCONFIRMED,
        verdictReason: '事实尚未确认',
        evidenceRefs: item.evidenceRefs,
      });
      continue;
    }

    // HAVE：只在表达确实偏弱时才建议改写
    if (item.status === 'HAVE') {
      if (!entry) continue; // 找不到可安全改写的位置，就不给建议
      const refs = usableRefs(entry);
      if (refs.length === 0) continue;
      if (!isWeakExpression(entry.text)) continue;
      plans.push({
        matchItemRef: item.requirementId,
        requirement: item.requirement,
        kind: SUGGESTION_KIND.REPHRASE,
        targetField: entry.targetField,
        before: entry.text,
        reason: `该条已有已确认事实，但表述偏弱，可在不改动事实的前提下补充具体场景与工具。`,
        verdict: FACT_STATUS.CONFIRMED,
        verdictReason: '有已确认证据',
        evidenceRefs: refs,
      });
    }
  }

  return plans;
}
