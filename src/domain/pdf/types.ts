import type { EvidenceRef, FactCategory, FactStatus } from '../types.ts';

/**
 * T7 · PDF 导出领域类型
 *
 * ADR-010：**T6 的安全边界不是 T7 的信任边界。**
 * 每一个进入 PDF 的字段都在这里**重新**执行 verifyClaim()，不复用 T6 的 accepted 结论。
 */

export type PdfBasics = {
  name: string;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
};

export type PdfSectionItem = {
  category: FactCategory;
  /** 展示文本 */
  text: string;
  /** 该条目对应的证据位置，PDF 不留存但快照保留，便于日后追溯 */
  evidenceRefs: EvidenceRef[];
};

/** 被挡在 PDF 之外的条目 —— 必须如实告知用户，不静默丢弃 */
export type PdfExcludedItem = {
  category: FactCategory | null;
  text: string;
  status: FactStatus | null;
  reason: string;
};

export type PdfDocumentModel = {
  basics: PdfBasics;
  sections: Record<FactCategory, PdfSectionItem[]>;
  excluded: PdfExcludedItem[];
  meta: {
    resumeId: string;
    versionNo: number;
    /** 生成时的事实来源标记，便于审计 */
    sourceFactCount: number;
    confirmedCount: number;
  };
};

export const PDF_SECTION_ORDER: readonly FactCategory[] = ['SKILL', 'PROJECT', 'EXPERIENCE', 'EDUCATION'];

export const PDF_SECTION_TITLE: Record<FactCategory, string> = {
  SKILL: '技能',
  PROJECT: '项目经历',
  EXPERIENCE: '实习与工作',
  EDUCATION: '教育经历',
};

export class PdfContractError extends Error {
  code: string;
  issues: string[];

  constructor(issues: string[]) {
    super(`PDF 内容未通过契约校验：${issues.join('; ')}`);
    this.name = 'PdfContractError';
    this.code = 'PDF_CONTRACT_VIOLATION';
    this.issues = issues;
  }
}
