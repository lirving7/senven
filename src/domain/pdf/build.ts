import { CLAIM_KIND, EVIDENCE_SOURCE, FACT_STATUS, VERDICT } from '../types.ts';
import type { ClaimKind, EvidenceRef, EvidenceSource, Fact, FactCategory } from '../types.ts';
import { verifyClaim } from '../verify.ts';
import { PDF_SECTION_ORDER, PdfContractError } from './types.ts';
import type { PdfBasics, PdfDocumentModel, PdfExcludedItem, PdfSectionItem } from './types.ts';

/**
 * T7 的安全核心：决定「哪些字段有资格进入 PDF」。
 *
 * 三道独立闸门（顺序执行，任一不过即排除并记录原因）：
 *   ① status === CONFIRMED
 *   ② 有可核验证据（来源可信 + locator + excerpt 均非空）
 *   ③ 重新执行 verifyClaim() 且结论为 ALLOW
 *
 * ③ 不是冗余：verifyClaim 的 findFact 取的是**首个同 key 事实**，
 * 当事实列表里存在同 key 的 MISSING / CONFIRMED 混杂时，
 * 仅靠 ① 会放行，而 ③ 会拦下。这正是不复用自己的结论、重新校验的意义。
 */

const TRUSTED_SOURCES: readonly EvidenceSource[] = [EVIDENCE_SOURCE.RESUME_TEXT, EVIDENCE_SOURCE.USER_STATEMENT];

export function usableEvidence(fact: Fact): EvidenceRef[] {
  return fact.evidence.filter(
    (r) =>
      TRUSTED_SOURCES.includes(r.source) &&
      r.locator.trim().length > 0 &&
      (r.excerpt ?? '').trim().length > 0,
  );
}

function claimKindFor(category: FactCategory): ClaimKind {
  if (category === 'PROJECT') return CLAIM_KIND.PROJECT;
  if (category === 'EXPERIENCE') return CLAIM_KIND.EXPERIENCE;
  // 技能与教育按 SKILL 断言处理；可信证据要求由第 ② 道闸门独立保证
  return CLAIM_KIND.SKILL;
}

function exclusionReason(fact: Fact): string | null {
  if (fact.status === FACT_STATUS.MISSING) return '没有对应事实';
  if (fact.status === FACT_STATUS.UNCONFIRMED) return '尚未经你确认';
  if (fact.status === FACT_STATUS.INFERRED) return 'AI 推断，未经你确认';
  return null;
}

export type BuildPdfResult = {
  model: PdfDocumentModel;
  /** 通过全部闸门的条目，供独立复核使用 */
  allowedKeys: Set<string>;
};

export function buildPdfModel(args: {
  resumeId: string;
  versionNo: number;
  basics: PdfBasics;
  facts: readonly Fact[];
}): BuildPdfResult {
  const sections: Record<FactCategory, PdfSectionItem[]> = {
    SKILL: [],
    PROJECT: [],
    EXPERIENCE: [],
    EDUCATION: [],
  };
  const excluded: PdfExcludedItem[] = [];
  const allowedKeys = new Set<string>();

  const name = (args.basics.name ?? '').trim();
  if (name.length === 0) {
    throw new PdfContractError(['姓名不能为空：没有姓名的简历无法投递']);
  }

  for (const fact of args.facts) {
    const category: FactCategory = fact.category ?? 'SKILL';

    // 闸门 ①
    const statusReason = exclusionReason(fact);
    if (statusReason !== null) {
      excluded.push({ category, text: fact.label, status: fact.status, reason: statusReason });
      continue;
    }

    // 闸门 ②
    const refs = usableEvidence(fact);
    if (refs.length === 0) {
      excluded.push({
        category,
        text: fact.label,
        status: fact.status,
        reason: '缺少可核验的原文位置（locator / excerpt）',
      });
      continue;
    }

    // 闸门 ③：重新执行，不复用任何上游结论
    const verdict = verifyClaim(
      { text: fact.label, topicKey: fact.key, kind: claimKindFor(category) },
      args.facts,
    );
    if (verdict.verdict !== VERDICT.ALLOW) {
      excluded.push({ category, text: fact.label, status: fact.status, reason: verdict.reason });
      continue;
    }

    sections[category].push({ category, text: fact.label, evidenceRefs: refs });
    allowedKeys.add(fact.key);
  }

  const model: PdfDocumentModel = {
    basics: { ...args.basics, name },
    sections,
    excluded,
    meta: {
      resumeId: args.resumeId,
      versionNo: args.versionNo,
      sourceFactCount: args.facts.length,
      confirmedCount: allowedKeys.size,
    },
  };

  assertPdfModelSafe(model, args.facts);
  return { model, allowedKeys };
}

/**
 * 独立复核：从原始事实重新推导「允许集合」，再断言模型里的每一个渲染条目都在其中。
 * 目的是让「只渲染 CONFIRMED」成为结构性保证，而不是依赖构建循环没有写错。
 */
export function assertPdfModelSafe(model: PdfDocumentModel, facts: readonly Fact[]): void {
  const issues: string[] = [];

  const allowedTexts = new Set<string>();
  for (const fact of facts) {
    if (fact.status !== FACT_STATUS.CONFIRMED) continue;
    if (usableEvidence(fact).length === 0) continue;
    const category: FactCategory = fact.category ?? 'SKILL';
    const verdict = verifyClaim(
      { text: fact.label, topicKey: fact.key, kind: claimKindFor(category) },
      facts,
    );
    if (verdict.verdict === VERDICT.ALLOW) allowedTexts.add(fact.label);
  }

  for (const category of PDF_SECTION_ORDER) {
    for (const item of model.sections[category]) {
      if (!allowedTexts.has(item.text)) {
        issues.push(`章节 ${category} 出现未通过闸门的条目：${item.text}`);
      }
      if (item.evidenceRefs.length === 0) {
        issues.push(`条目缺少证据：${item.text}`);
      }
      for (const ref of item.evidenceRefs) {
        if (ref.source === EVIDENCE_SOURCE.JD) issues.push(`条目证据来自 JD：${item.text}`);
        if (ref.locator.trim().length === 0) issues.push(`条目证据 locator 为空：${item.text}`);
        if ((ref.excerpt ?? '').trim().length === 0) issues.push(`条目证据 excerpt 为空：${item.text}`);
      }
    }
  }

  if (issues.length > 0) throw new PdfContractError(issues);
}

/** PDF 需要渲染出的纯文本（测试与确定性校验用） */
export function pdfPlainText(model: PdfDocumentModel): string[] {
  const lines: string[] = [model.basics.name];
  const contact = [model.basics.phone, model.basics.email, model.basics.city].filter(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  if (contact.length > 0) lines.push(contact.join(' · '));
  for (const category of PDF_SECTION_ORDER) {
    const items = model.sections[category];
    if (items.length === 0) continue;
    lines.push(category);
    for (const item of items) lines.push(item.text);
  }
  return lines;
}
