export const FACT_STATUS = {
  CONFIRMED: 'CONFIRMED',
  INFERRED: 'INFERRED',
  UNCONFIRMED: 'UNCONFIRMED',
  MISSING: 'MISSING',
} as const;
export type FactStatus = (typeof FACT_STATUS)[keyof typeof FACT_STATUS];

export const EVIDENCE_SOURCE = {
  RESUME_TEXT: 'RESUME_TEXT',
  USER_STATEMENT: 'USER_STATEMENT',
  OCR: 'OCR',
  JD: 'JD',
} as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCE)[keyof typeof EVIDENCE_SOURCE];

export const CLAIM_KIND = {
  SKILL: 'SKILL',
  EXPERIENCE: 'EXPERIENCE',
  PROJECT: 'PROJECT',
  ACHIEVEMENT: 'ACHIEVEMENT',
} as const;
export type ClaimKind = (typeof CLAIM_KIND)[keyof typeof CLAIM_KIND];

export const VERDICT = {
  ALLOW: 'ALLOW',
  ALLOW_WITH_LABEL: 'ALLOW_WITH_LABEL',
  BLOCK: 'BLOCK',
} as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];

export const MATCH_STATUS = {
  HAVE: 'HAVE',
  ENHANCE: 'ENHANCE',
  MISSING: 'MISSING',
} as const;
export type MatchStatus = (typeof MATCH_STATUS)[keyof typeof MATCH_STATUS];

export type EvidenceRef = {
  source: EvidenceSource;
  locator: string;
  excerpt?: string;
};

/** 事实在简历里的归属分类（T7 需要按章节分组；T4/T6 不使用） */
export const FACT_CATEGORY = {
  SKILL: 'SKILL',
  PROJECT: 'PROJECT',
  EDUCATION: 'EDUCATION',
  EXPERIENCE: 'EXPERIENCE',
} as const;
export type FactCategory = (typeof FACT_CATEGORY)[keyof typeof FACT_CATEGORY];

export type Fact = {
  key: string;
  label: string;
  status: FactStatus;
  evidence: EvidenceRef[];
  aliases?: string[];
  /** 可选：仅用于分组展示（PDF 章节）。老调用方不传也不受影响 */
  category?: FactCategory;
};

export type Claim = {
  text: string;
  topicKey: string;
  kind: ClaimKind;
};

export type VerifyResult = {
  verdict: Verdict;
  status: FactStatus;
  reason: string;
  label?: string;
  evidence: EvidenceRef[];
};

export type CandidateState = {
  facts: Fact[];
  userId: string;
};
