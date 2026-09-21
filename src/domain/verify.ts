import { FACT_STATUS, CLAIM_KIND, VERDICT } from './types.ts';
import type { Claim, EvidenceRef, Fact, VerifyResult } from './types.ts';

export function normalizeKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '');
}

export function findFact(claim: Claim, facts: readonly Fact[]): Fact | undefined {
  const target = normalizeKey(claim.topicKey);
  return facts.find((f) => {
    if (normalizeKey(f.key) === target) return true;
    return (f.aliases ?? []).some((a) => normalizeKey(a) === target);
  });
}

/**
 * 确定性事实验证层（T5 核心）。
 * 只做判定，不生成任何用户经历内容 —— 这是与 prompt 软约束的关键区别。
 */
export function verifyClaim(claim: Claim, facts: readonly Fact[]): VerifyResult {
  const fact = findFact(claim, facts);

  if (!fact) {
    return {
      verdict: VERDICT.BLOCK,
      status: FACT_STATUS.UNCONFIRMED,
      reason: `未找到与「${claim.text}」对应的用户证据，需先由用户提供或确认。`,
      evidence: [],
    };
  }

  if (fact.status === FACT_STATUS.MISSING) {
    return {
      verdict: VERDICT.BLOCK,
      status: FACT_STATUS.MISSING,
      reason: `资料中标记「${fact.label}」为缺失，不可写入简历。`,
      evidence: fact.evidence,
    };
  }

  if (fact.status === FACT_STATUS.UNCONFIRMED) {
    return {
      verdict: VERDICT.BLOCK,
      status: FACT_STATUS.UNCONFIRMED,
      reason: `「${fact.label}」尚未经用户确认，不可写入简历。`,
      evidence: fact.evidence,
    };
  }

  if (fact.status === FACT_STATUS.INFERRED) {
    if (claim.kind === CLAIM_KIND.EXPERIENCE) {
      return {
        verdict: VERDICT.BLOCK,
        status: FACT_STATUS.INFERRED,
        reason: `「${fact.label}」为推断来源，不能作为用户经历写入。`,
        evidence: fact.evidence,
      };
    }
    return {
      verdict: VERDICT.ALLOW_WITH_LABEL,
      status: FACT_STATUS.INFERRED,
      label: `推断（待确认）：${fact.label}`,
      reason: '来源为 AI/OCR 推断，须带标注且待用户确认。',
      evidence: fact.evidence,
    };
  }

  const trusted = (refs: readonly EvidenceRef[]) =>
    refs.some((e) => e.source === 'RESUME_TEXT' || e.source === 'USER_STATEMENT');

  if (claim.kind === CLAIM_KIND.EXPERIENCE && !trusted(fact.evidence)) {
    return {
      verdict: VERDICT.ALLOW_WITH_LABEL,
      status: FACT_STATUS.CONFIRMED,
      label: `来源待核验：${fact.label}`,
      reason: '仅有 OCR 或间接来源，标注为待核验后可用。',
      evidence: fact.evidence,
    };
  }

  return {
    verdict: VERDICT.ALLOW,
    status: FACT_STATUS.CONFIRMED,
    reason: '有用户提供的确证证据支撑。',
    evidence: fact.evidence,
  };
}

export function verifyClaims(claims: readonly Claim[], facts: readonly Fact[]): VerifyResult[] {
  return claims.map((c) => verifyClaim(c, facts));
}

/** 只有 ALLOW / ALLOW_WITH_LABEL 可写入简历；ALLOW_WITH_LABEL 必须携带标注。 */
export function canWrite(result: VerifyResult): boolean {
  if (result.verdict === VERDICT.ALLOW) return true;
  if (result.verdict === VERDICT.ALLOW_WITH_LABEL) return Boolean(result.label);
  return false;
}

export function writeBlockedResults(results: readonly VerifyResult[]): VerifyResult[] {
  return results.filter((r) => !canWrite(r));
}
