import { EVIDENCE_SOURCE, FACT_STATUS } from '../types.ts';
import type { EvidenceRef, EvidenceSource, Fact, FactStatus } from '../types.ts';
import { BASIS_TYPE, CONFIDENCE } from '../ai/judgment.ts';
import type { BasisType, Confidence } from '../ai/judgment.ts';
import { normalizeForMatch } from '../jd/preprocess.ts';
import { MATCH_STATE, MATCH_STATUS } from './types.ts';
import type { MatchItemOutput, MatchOutcome, MatchRequirement, MatchSummary, MatchStatus } from './types.ts';
import { assertMatchItemsValid, summarizeMatch } from './contract.ts';

export const MATCHER_VERSION = 'v1';

/**
 * O-1（T6-3-G-5）：语义匹配受控并发上限。
 *
 * 选择 4 的依据：
 *   - 对照的墙钟主要来自「确定性未命中」的 requirement 逐条串行 LLM 调用；
 *     实测一次 18 条要求的对照全部走 semantic（SEMANTIC_MATCH=13 + ABSENT=5，EXACT_MATCH=0）。
 *   - 上限 4 把 18 次串行压缩为约 5 波（≈4 倍墙钟改善），同时把对上游 Provider 的
 *     瞬时并发压力保持在保守水平（降低 429 RATE_LIMIT 概率）；
 *   - quota 是「次数」限制（20 次/小时内存计数）而非速率限制，并发不改变总消耗次数；
 *   - 不使用无限 Promise.all，避免 requirement 数量增大时打爆上游。
 */
export const SEMANTIC_CONCURRENCY = 4;

/** 受控并发映射：结果按输入顺序回填；任一任务抛错则等全部在途任务结束后抛出首个错误（不吞异常） */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown = null;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!);
      } catch (err) {
        firstError ??= err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}

/** 可用于支撑简历侧判断的证据来源 */
const RESUME_SOURCES: readonly EvidenceSource[] = [
  EVIDENCE_SOURCE.RESUME_TEXT,
  EVIDENCE_SOURCE.USER_STATEMENT,
  EVIDENCE_SOURCE.OCR,
];
/** 只有用户自己提供的内容才算「已确认」 */
const TRUSTED_SOURCES: readonly EvidenceSource[] = [EVIDENCE_SOURCE.RESUME_TEXT, EVIDENCE_SOURCE.USER_STATEMENT];

const MIN_TOKEN_LENGTH = 2;

export type SemanticFact = { key: string; label: string; status: FactStatus; evidenceText: string };
export type SemanticMatcherRequest = { requirement: string; facts: SemanticFact[] };
export type SemanticMatcherResult = { matchedKeys: string[]; detail: string };
export type SemanticMatcher = (req: SemanticMatcherRequest) => Promise<SemanticMatcherResult>;

export type RunMatchOptions = {
  /** 语义匹配端口；不注入则只做确定性匹配 */
  semantic?: SemanticMatcher;
};

/* ------------------------------------------------------------------ */
/* 证据筛选：来源必须是简历侧，且 locator 与 excerpt 都非空（T4 §8/§23-19） */
/* ------------------------------------------------------------------ */

function resumeEvidenceOf(fact: Fact): EvidenceRef[] {
  return fact.evidence.filter(
    (r) =>
      RESUME_SOURCES.includes(r.source) &&
      r.locator.trim().length > 0 &&
      (r.excerpt ?? '').trim().length > 0,
  );
}

function hasTrustedEvidence(refs: readonly EvidenceRef[]): boolean {
  return refs.some((r) => TRUSTED_SOURCES.includes(r.source));
}

/** 简历是否已存在任何 CONFIRMED 事实（T4 §11） */
export function hasConfirmedFacts(facts: readonly Fact[]): boolean {
  return facts.some((f) => f.status === FACT_STATUS.CONFIRMED);
}

/* ------------------------------------------------------------------ */
/* 第一阶段：确定性匹配（不调用 LLM）                                    */
/* ------------------------------------------------------------------ */

export function findDeterministicCandidates(requirement: string, facts: readonly Fact[]): Fact[] {
  const hay = normalizeForMatch(requirement);
  if (hay.length === 0) return [];
  return facts.filter((fact) => {
    const keys = [fact.key, fact.label, ...(fact.aliases ?? [])]
      .map(normalizeForMatch)
      .filter((k) => k.length >= MIN_TOKEN_LENGTH);
    return keys.some((k) => hay.includes(k));
  });
}

/* ------------------------------------------------------------------ */
/* 事实安全门控：把「有哪些事实」映射为 HAVE / ENHANCE / MISSING          */
/* ------------------------------------------------------------------ */

type Resolution = Pick<
  MatchItemOutput,
  | 'status'
  | 'reason'
  | 'basis'
  | 'evidenceRefs'
  | 'resumeEvidence'
  | 'isInference'
  | 'needsUserConfirmation'
  | 'confidence'
  | 'suggestion'
>;

type NoMatchReason = 'NONE' | 'UNCONFIRMED_ONLY' | 'SEMANTIC_EMPTY';

function makeAbsent(reasonCode: NoMatchReason, detail: string): Resolution {
  const reason =
    reasonCode === 'UNCONFIRMED_ONLY'
      ? '简历中出现过相关内容，但该事实尚未经你确认，因此不计入覆盖。确认后才会重新判断。'
      : '在已确认的简历事实中，没有找到支持该要求的证据。这不代表你在现实中不具备该能力。';
  return {
    status: MATCH_STATUS.MISSING,
    reason,
    basis: { type: BASIS_TYPE.ABSENT, detail },
    evidenceRefs: [],
    resumeEvidence: null,
    isInference: false,
    needsUserConfirmation: reasonCode === 'UNCONFIRMED_ONLY',
    confidence: CONFIDENCE.HIGH,
    suggestion: reasonCode === 'UNCONFIRMED_ONLY' ? '确认这条事实' : '加入能力缺口',
  };
}

export function resolveFromFacts(
  candidates: readonly Fact[],
  basisType: BasisType,
  basisPrefix: string,
): Resolution {
  const material = candidates
    .map((f) => ({ fact: f, refs: resumeEvidenceOf(f) }))
    .filter((x) => x.refs.length > 0);

  const ambiguous = material.length > 1;

  const trusted = material.filter((x) => x.fact.status === FACT_STATUS.CONFIRMED && hasTrustedEvidence(x.refs));
  if (trusted.length > 0) {
    const refs = trusted.flatMap((x) => x.refs);
    return {
      status: MATCH_STATUS.HAVE,
      reason: ambiguous
        ? '简历中有多项已确认事实支持该要求，需要你指定以哪一项为主证据。'
        : '简历中有已确认的事实支持该要求。',
      basis: {
        type: basisType,
        detail: ambiguous
          ? `${basisPrefix}命中多个候选：${trusted.map((x) => x.fact.key).join('、')}`
          : `${basisPrefix}命中 ${trusted[0].fact.key}`,
      },
      evidenceRefs: refs,
      resumeEvidence: trusted[0].fact.label,
      isInference: false,
      needsUserConfirmation: ambiguous,
      confidence: ambiguous ? CONFIDENCE.MEDIUM : CONFIDENCE.HIGH,
      suggestion: '保留',
    };
  }

  const ocrOnly = material.filter((x) => x.fact.status === FACT_STATUS.CONFIRMED && !hasTrustedEvidence(x.refs));
  if (ocrOnly.length > 0) {
    return {
      status: MATCH_STATUS.ENHANCE,
      reason: '存在相关证据，但来源是扫描 / OCR，需要你核验后才能计入已确认。',
      basis: { type: basisType, detail: `${basisPrefix}命中 ${ocrOnly.map((x) => x.fact.key).join('、')}，来源为 OCR` },
      evidenceRefs: ocrOnly.flatMap((x) => x.refs),
      resumeEvidence: ocrOnly[0].fact.label,
      isInference: false,
      needsUserConfirmation: true,
      confidence: CONFIDENCE.MEDIUM,
      suggestion: '确认这条事实',
    };
  }

  const inferred = material.filter((x) => x.fact.status === FACT_STATUS.INFERRED);
  if (inferred.length > 0) {
    return {
      status: MATCH_STATUS.ENHANCE,
      reason: '该能力是模型从材料中推断出来的，尚未经你确认，因此不能算作已具备。',
      basis: {
        type: BASIS_TYPE.MODEL_INFERENCE,
        detail: `${basisPrefix}指向 ${inferred.map((x) => x.fact.key).join('、')}，但该事实为推断来源`,
      },
      evidenceRefs: inferred.flatMap((x) => x.refs),
      resumeEvidence: inferred[0].fact.label,
      isInference: true,
      needsUserConfirmation: true,
      confidence: CONFIDENCE.MEDIUM,
      suggestion: '确认这条事实',
    };
  }

  const unconfirmed = material.filter((x) => x.fact.status === FACT_STATUS.UNCONFIRMED);
  if (unconfirmed.length > 0) {
    return makeAbsent('UNCONFIRMED_ONLY', `${basisPrefix}命中 ${unconfirmed.map((x) => x.fact.key).join('、')}，但状态为未确认`);
  }

  return makeAbsent('NONE', '已确认的简历事实中没有可支撑该要求的条目');
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export async function runMatch(
  input: { requirements: readonly MatchRequirement[]; facts: readonly Fact[] },
  options: RunMatchOptions = {},
): Promise<MatchOutcome> {
  // §11：没有任何 CONFIRMED 事实时，不产出看似正常的匹配结果
  if (!hasConfirmedFacts(input.facts)) {
    return {
      ok: false,
      state: MATCH_STATE.NEEDS_RESUME_CONFIRMATION,
      message: '请先完成简历确认。只有你确认过的事实才会用于对照。',
    };
  }

  const items: MatchItemOutput[] = new Array(input.requirements.length);

  // 第一遍：确定性匹配（纯内存）。未命中的收集为语义任务，统一受控并发执行（O-1）。
  const semanticPending: Array<{ index: number; requirement: MatchRequirement }> = [];
  input.requirements.forEach((req, index) => {
    const deterministic = findDeterministicCandidates(req.text, input.facts);
    if (deterministic.length > 0) {
      items[index] = {
        requirementId: req.id,
        requirement: req.text,
        category: req.category,
        criticality: req.criticality,
        ...resolveFromFacts(deterministic, BASIS_TYPE.EXACT_MATCH, '精确匹配'),
      };
    } else {
      semanticPending.push({ index, requirement: req });
    }
  });

  if (options.semantic) {
    if (semanticPending.length > 0) {
      // facts 载荷与每条 requirement 无关，构造一次共享（内容与原先逐条重建完全一致）
      const factsPayload = input.facts.map((f) => ({
        key: f.key,
        label: f.label,
        status: f.status,
        evidenceText: resumeEvidenceOf(f)
          .map((r) => r.excerpt ?? '')
          .join(' / '),
      }));
      await mapWithConcurrency(semanticPending, SEMANTIC_CONCURRENCY, async ({ index, requirement }) => {
        // 第二阶段：仅在确定性匹配无结果时才调用语义匹配
        const semanticResult = await options.semantic!({
          requirement: requirement.text,
          facts: factsPayload,
        });
        const keys = new Set(semanticResult.matchedKeys.map((k) => normalizeForMatch(k)));
        const semanticCandidates = input.facts.filter((f) => keys.has(normalizeForMatch(f.key)));
        const resolution =
          semanticCandidates.length > 0
            ? resolveFromFacts(semanticCandidates, BASIS_TYPE.SEMANTIC_MATCH, `语义匹配（${semanticResult.detail}）`)
            : makeAbsent('SEMANTIC_EMPTY', '确定性匹配与语义匹配均未命中');
        items[index] = {
          requirementId: requirement.id,
          requirement: requirement.text,
          category: requirement.category,
          criticality: requirement.criticality,
          ...resolution,
        };
      });
    }
  } else {
    for (const { index, requirement } of semanticPending) {
      items[index] = {
        requirementId: requirement.id,
        requirement: requirement.text,
        category: requirement.category,
        criticality: requirement.criticality,
        ...makeAbsent('NONE', '确定性匹配未命中，且未启用语义匹配'),
      };
    }
  }

  assertMatchItemsValid(items);

  return { ok: true, items, summary: summarizeMatch(items) };
}

export type { MatchItemOutput, MatchSummary, MatchStatus };
