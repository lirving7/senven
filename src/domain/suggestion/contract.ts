import { EVIDENCE_SOURCE, FACT_STATUS } from '../types.ts';
import type { EvidenceSource } from '../types.ts';
import { SUGGESTION_KIND } from './types.ts';
import type { SuggestionDraft } from './types.ts';
import { SuggestionContractError } from './types.ts';

/** 简历侧来源：证据不得来自 JD */
const RESUME_SOURCES: readonly EvidenceSource[] = [
  EVIDENCE_SOURCE.RESUME_TEXT,
  EVIDENCE_SOURCE.USER_STATEMENT,
  EVIDENCE_SOURCE.OCR,
];

const MIN_REASON_LENGTH = 6;

/**
 * 数字保护：改写里出现的新数字，必须在原文或已确认证据里出现过。
 * 拦的是「提升 30%」「服务 5 万用户」这类凭空生成的量化成果。
 */
export function findInventedNumbers(
  after: string,
  before: string | null,
  evidenceTexts: readonly string[],
): string[] {
  const pick = (s: string): string[] => s.match(/\d+(?:\.\d+)?%?/g) ?? [];
  const allowed = new Set<string>([...pick(before ?? ''), ...evidenceTexts.flatMap(pick)]);
  return [...new Set(pick(after))].filter((n) => !allowed.has(n));
}

export function validateSuggestion(d: SuggestionDraft): string[] {
  const issues: string[] = [];

  if (d.requirement.trim().length === 0) issues.push('requirement 不能为空');
  if (d.targetField.trim().length === 0) issues.push('targetField 不能为空');
  if (d.reason.trim().length < MIN_REASON_LENGTH) issues.push('reason 过短，无法解释建议依据');

  // 核心安全不变量：只有 REPHRASE 才允许产出内容
  if (d.kind === SUGGESTION_KIND.GUIDANCE && d.after !== null) {
    issues.push('kind=GUIDANCE 不得产出 after：T6 不能替用户创造经历');
  }
  if (d.kind === SUGGESTION_KIND.CONFIRM_FACT && d.after !== null) {
    issues.push('kind=CONFIRM_FACT 不得产出 after：事实未确认前不能改写');
  }

  if (d.kind === SUGGESTION_KIND.REPHRASE) {
    if (d.after === null) issues.push('kind=REPHRASE 必须有 after');
    if (d.before === null) issues.push('kind=REPHRASE 必须有 before');
    if (d.evidenceRefs.length === 0) issues.push('kind=REPHRASE 必须带证据');
    if (d.verdict !== FACT_STATUS.CONFIRMED) {
      issues.push('kind=REPHRASE 的 verdict 必须是 CONFIRMED');
    }
  }

  for (const ref of d.evidenceRefs) {
    if (ref.source === EVIDENCE_SOURCE.JD) {
      issues.push('证据来源为 JD：JD 要求不能作为改写依据');
    } else if (!RESUME_SOURCES.includes(ref.source)) {
      issues.push(`证据来源非法：${ref.source}`);
    }
    if (ref.locator.trim().length === 0) issues.push('证据 locator 不能为空');
    if ((ref.excerpt ?? '').trim().length === 0) issues.push('证据 excerpt 不能为空');
  }

  if (d.verdict === FACT_STATUS.MISSING && d.evidenceRefs.length > 0) {
    issues.push('verdict=MISSING 不得携带证据');
  }

  return issues;
}

export function validateSuggestions(drafts: readonly SuggestionDraft[]): { index: number; issues: string[] }[] {
  const out: { index: number; issues: string[] }[] = [];
  drafts.forEach((d, index) => {
    const issues = validateSuggestion(d);
    if (issues.length > 0) out.push({ index, issues });
  });
  return out;
}

export function assertSuggestionsValid(drafts: readonly SuggestionDraft[]): void {
  const bad = validateSuggestions(drafts);
  if (bad.length > 0) {
    throw new SuggestionContractError(bad.map((b) => `#${b.index}: ${b.issues.join('; ')}`));
  }
}

export function summarizeSuggestions(drafts: readonly SuggestionDraft[]): {
  total: number;
  rephrase: number;
  confirmFact: number;
  guidance: number;
} {
  return {
    total: drafts.length,
    rephrase: drafts.filter((d) => d.kind === SUGGESTION_KIND.REPHRASE).length,
    confirmFact: drafts.filter((d) => d.kind === SUGGESTION_KIND.CONFIRM_FACT).length,
    guidance: drafts.filter((d) => d.kind === SUGGESTION_KIND.GUIDANCE).length,
  };
}
