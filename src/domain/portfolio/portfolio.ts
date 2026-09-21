/**
 * T4-2：Portfolio 纯逻辑域（零 Prisma / 零 HTTP / 零 provider / 零 LLM）。
 *
 * 只负责：
 * - 输入合法性（title 1–120、description 0–2000、description 清空归一化为 null）
 * - archive 状态规则（archivedAt 非空 = 终态）
 * - duplicate / membership eligibility 判定
 * - 排序比较器（displayOrder ASC → createdAt ASC → id ASC）
 *
 * 依据 ADR-014（P-1 ~ P-16、G-1a ~ G-6）。
 */

export const PORTFOLIO_TITLE_MIN = 1;
export const PORTFOLIO_TITLE_MAX = 120;
export const PORTFOLIO_DESCRIPTION_MAX = 2000;

/** 成员（PortfolioProjectResult）的唯一业务身份：portfolioProjectId + projectResultId */
export type PortfolioMembershipKey = {
  portfolioProjectId: string;
  projectResultId: string;
};

/** ProjectResult 加入 Portfolio 的资格判定输入（只读事实） */
export type ProjectResultEligibilityInput = {
  submittedAt: Date | null;
  revokedAt: Date | null;
};

export type EligibilityResult = 'ELIGIBLE' | 'DRAFT' | 'REVOKED';

/**
 * P-1：ProjectResult 只有在 submittedAt != null 且 revokedAt == null 时才允许加入。
 * 返回三态：ELIGIBLE / DRAFT / REVOKED。
 */
export function evaluateProjectResultEligibility(input: ProjectResultEligibilityInput): EligibilityResult {
  if (input.revokedAt !== null) return 'REVOKED';
  if (input.submittedAt === null) return 'DRAFT';
  return 'ELIGIBLE';
}

/**
 * 校验 title 长度边界（1–120）。返回 true = 合法。
 */
export function isValidTitle(title: string): boolean {
  const t = title.trim();
  return t.length >= PORTFOLIO_TITLE_MIN && t.length <= PORTFOLIO_TITLE_MAX;
}

/**
 * 校验 description 长度边界（0–2000）。空串/null 均合法（清空语义）。
 */
export function isValidDescription(description: string | null): boolean {
  if (description === null) return true;
  return description.length <= PORTFOLIO_DESCRIPTION_MAX;
}

/**
 * G-3 / NOTE-2：description 清空归一化。
 * `null` 或 `""` 均归一化为 `null`；不保留 `""`。
 */
export function normalizeDescription(description: string | null | undefined): string | null {
  if (description === undefined || description === null) return null;
  if (description.trim().length === 0) return null;
  return description;
}

/**
 * 归一化 title（trim）。长度边界由 isValidTitle 另行校验。
 */
export function normalizeTitle(title: string): string {
  return title.trim();
}

/**
 * P-6 / P-9：排序比较器。
 * displayOrder ASC → createdAt ASC → id ASC。
 */
export function comparePortfolioOrder(
  a: { displayOrder: number; createdAt: Date; id: string },
  b: { displayOrder: number; createdAt: Date; id: string },
): number {
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
  const at = a.createdAt.getTime();
  const bt = b.createdAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
