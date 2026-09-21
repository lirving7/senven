import { normalizeForMatch } from '../jd/preprocess.ts';
import type { MatchItemOutput } from '../match/types.ts';
import { assertSuggestionsValid, findInventedNumbers, summarizeSuggestions } from './contract.ts';
import { planSuggestions } from './targeting.ts';
import type { ResumeEntryRef } from './targeting.ts';
import { SUGGESTION_KIND, SUGGESTION_STATE } from './types.ts';
import type { RejectedSuggestion, SuggestionDraft, SuggestionOutcome } from './types.ts';
import type { RephrasePort } from './rephrase.ts';

/** 改写长度上限：不超过原文 2 倍 + 40 字，防止整段重写 */
const MAX_LENGTH_RATIO = 2;
const MAX_LENGTH_SLACK = 40;

export type ConfirmedFactRef = { key: string; label: string; excerpt: string };

export type GenerateSuggestionsArgs = {
  matchRunId: string | null;
  items: readonly MatchItemOutput[];
  resumeEntries: readonly ResumeEntryRef[];
  /** 可用于改写的已确认事实（key / label / 证据原文） */
  confirmedFacts: readonly ConfirmedFactRef[];
};

export type GenerateSuggestionsDeps = {
  /** 不注入则不产出 REPHRASE（宁可不建议，也不产出未经校验的内容） */
  rephrase?: RephrasePort;
};

export async function generateSuggestions(
  args: GenerateSuggestionsArgs,
  deps: GenerateSuggestionsDeps = {},
): Promise<SuggestionOutcome> {
  const plans = planSuggestions({ items: args.items, resumeEntries: args.resumeEntries });

  if (plans.length === 0) {
    return {
      ok: false,
      state: SUGGESTION_STATE.NOTHING_TO_SUGGEST,
      message: '当前简历表达已较清晰，没有需要修改的地方。',
    };
  }

  const allowedKeys = new Set(args.confirmedFacts.map((f) => normalizeForMatch(f.key)));
  const evidenceTexts = args.confirmedFacts.map((f) => f.excerpt);
  const drafts: SuggestionDraft[] = [];
  const rejected: RejectedSuggestion[] = [];

  for (const plan of plans) {
    if (plan.kind !== SUGGESTION_KIND.REPHRASE) {
      drafts.push({
        matchRunId: args.matchRunId,
        matchItemRef: plan.matchItemRef,
        requirement: plan.requirement,
        kind: plan.kind,
        targetField: plan.targetField,
        before: plan.before,
        after: null,
        reason: plan.reason,
        verdict: plan.verdict,
        verdictReason: plan.verdictReason,
        evidenceRefs: plan.evidenceRefs,
        needsUserConfirmation: true,
      });
      continue;
    }

    if (!deps.rephrase) {
      rejected.push({ requirement: plan.requirement, reason: '未启用改写端口，不产出未经校验的内容' });
      continue;
    }

    const before = plan.before ?? '';
    const result = await deps.rephrase({
      before,
      requirement: plan.requirement,
      confirmedFacts: args.confirmedFacts.map((f) => ({ key: f.key, label: f.label, excerpt: f.excerpt })),
    });

    // 防线 1：引用的事实必须全部来自已确认列表
    const unknown = result.usedFactKeys.filter((k) => !allowedKeys.has(normalizeForMatch(k)));
    if (unknown.length > 0) {
      rejected.push({ requirement: plan.requirement, reason: `改写引用了未确认的事实：${unknown.join('、')}` });
      continue;
    }

    // 防线 2：不得出现原文与证据里都没有的数字
    const invented = findInventedNumbers(result.after, before, evidenceTexts);
    if (invented.length > 0) {
      rejected.push({ requirement: plan.requirement, reason: `改写引入了原文没有的数字：${invented.join('、')}` });
      continue;
    }

    // 防线 3：长度上限，防止整段重写
    if (result.after.length > before.length * MAX_LENGTH_RATIO + MAX_LENGTH_SLACK) {
      rejected.push({ requirement: plan.requirement, reason: '改写幅度过大，接近重写而非润色' });
      continue;
    }

    drafts.push({
      matchRunId: args.matchRunId,
      matchItemRef: plan.matchItemRef,
      requirement: plan.requirement,
      kind: SUGGESTION_KIND.REPHRASE,
      targetField: plan.targetField,
      before,
      after: result.after,
      reason: result.reason,
      verdict: plan.verdict,
      verdictReason: plan.verdictReason,
      evidenceRefs: plan.evidenceRefs,
      needsUserConfirmation: true,
    });
  }

  if (drafts.length === 0) {
    return {
      ok: false,
      state: SUGGESTION_STATE.NOTHING_TO_SUGGEST,
      message: rejected.length > 0 ? '所有候选建议都未通过安全校验，未产出任何建议。' : '没有需要修改的地方。',
    };
  }

  assertSuggestionsValid(drafts);

  return { ok: true, drafts, rejected };
}

export { summarizeSuggestions };
