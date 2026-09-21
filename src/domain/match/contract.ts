import { EVIDENCE_SOURCE } from '../types.ts';
import type { EvidenceSource } from '../types.ts';
import { BASIS_TYPE } from '../ai/judgment.ts';
import { MATCH_STATUS } from './types.ts';
import type { MatchItemOutput, MatchSummary } from './types.ts';
import { MatchContractError } from './types.ts';

/**
 * MatchItem 契约校验 —— T4 的安全底线。
 *
 * 与 AiJudgment 的契约共享 basis / evidence 词表，但**不变量集合不同**：
 * MatchStatus(HAVE/ENHANCE/MISSING) 与 FactStatus(CONFIRMED/...) 是两套语义，
 * 不能直接复用同一组不变量。
 */

/** 简历侧来源：JD 绝不能作为「用户会某项能力」的证据（T4 §8） */
const RESUME_SOURCES: readonly EvidenceSource[] = [
  EVIDENCE_SOURCE.RESUME_TEXT,
  EVIDENCE_SOURCE.USER_STATEMENT,
  EVIDENCE_SOURCE.OCR,
];

const MIN_REASON_LENGTH = 6;

export function validateMatchItem(item: MatchItemOutput): string[] {
  const issues: string[] = [];

  if (item.requirement.trim().length === 0) {
    issues.push('requirement 不能为空');
  }
  if (item.reason.trim().length < MIN_REASON_LENGTH) {
    issues.push('reason 过短，无法解释判断依据');
  }
  if (item.basis.detail.trim().length === 0) {
    issues.push('basis.detail 不能为空');
  }

  // 证据来源与完整性
  for (const ref of item.evidenceRefs) {
    if (ref.source === EVIDENCE_SOURCE.JD) {
      issues.push('证据来源为 JD：JD 要求不能当作简历证据');
    } else if (!RESUME_SOURCES.includes(ref.source)) {
      issues.push(`证据来源非法：${ref.source}`);
    }
    if (ref.locator.trim().length === 0) {
      issues.push('证据 locator 不能为空');
    }
    if ((ref.excerpt ?? '').trim().length === 0) {
      issues.push('证据 excerpt 不能为空');
    }
  }

  if (item.status === MATCH_STATUS.HAVE) {
    if (item.evidenceRefs.length === 0) {
      issues.push('status=HAVE 必须带证据');
    }
    if (item.isInference) {
      issues.push('status=HAVE 与 isInference=true 矛盾：推断结果不能算已具备');
    }
    if (item.resumeEvidence === null) {
      issues.push('status=HAVE 必须给出命中的简历表述');
    }
  }

  if (item.status === MATCH_STATUS.ENHANCE && item.evidenceRefs.length === 0) {
    issues.push('status=ENHANCE 必须带证据');
  }

  if (item.status === MATCH_STATUS.MISSING) {
    if (item.evidenceRefs.length > 0) {
      issues.push('status=MISSING 不得携带证据');
    }
    if (item.resumeEvidence !== null) {
      issues.push('status=MISSING 不得填写 resumeEvidence');
    }
    if (item.basis.type !== BASIS_TYPE.ABSENT) {
      issues.push('status=MISSING 的 basis.type 必须是 ABSENT');
    }
  }

  return issues;
}

export function validateMatchItems(items: readonly MatchItemOutput[]): { index: number; issues: string[] }[] {
  const out: { index: number; issues: string[] }[] = [];
  items.forEach((item, index) => {
    const issues = validateMatchItem(item);
    if (issues.length > 0) out.push({ index, issues });
  });
  return out;
}

/** 校验失败即抛错：不允许半成品写入数据库 */
export function assertMatchItemsValid(items: readonly MatchItemOutput[]): void {
  const bad = validateMatchItems(items);
  if (bad.length > 0) {
    throw new MatchContractError(bad.map((b) => `#${b.index}: ${b.issues.join('; ')}`));
  }
}

/** 覆盖计数（替代百分比评分，T4 §16） */
export function summarizeMatch(items: readonly MatchItemOutput[]): MatchSummary {
  const must = items.filter((i) => i.criticality === 'MUST');
  return {
    total: items.length,
    have: items.filter((i) => i.status === MATCH_STATUS.HAVE).length,
    enhance: items.filter((i) => i.status === MATCH_STATUS.ENHANCE).length,
    missing: items.filter((i) => i.status === MATCH_STATUS.MISSING).length,
    mustTotal: must.length,
    mustHave: must.filter((i) => i.status === MATCH_STATUS.HAVE).length,
    needsUserConfirmation: items.filter((i) => i.needsUserConfirmation).length,
    // HAVE 却要求确认，只可能来自「多个候选证据待指定」这一种情况
    ambiguous: items.filter((i) => i.status === MATCH_STATUS.HAVE && i.needsUserConfirmation).length,
  };
}
