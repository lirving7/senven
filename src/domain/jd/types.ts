/** T3 · JD 解析领域类型。零依赖，可离线单测。 */

export const REQUIREMENT_CATEGORY = {
  HARD: 'HARD',
  TECH: 'TECH',
  DUTY: 'DUTY',
  PLUS: 'PLUS',
  EDUCATION: 'EDUCATION',
  MAJOR: 'MAJOR',
  OTHER: 'OTHER',
} as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORY)[keyof typeof REQUIREMENT_CATEGORY];

export const CRITICALITY = {
  MUST: 'MUST',
  SHOULD: 'SHOULD',
  BONUS: 'BONUS',
} as const;
export type Criticality = (typeof CRITICALITY)[keyof typeof CRITICALITY];

export const JD_LANGUAGE = { ZH: 'ZH', EN: 'EN', MIXED: 'MIXED' } as const;
export type JdLanguage = (typeof JD_LANGUAGE)[keyof typeof JD_LANGUAGE];

export type ParsedRequirement = {
  /** 必须逐字来自 JD 原文，不得改写 */
  text: string;
  category: RequirementCategory;
  criticality: Criticality;
  /** 是否能在 JD 原文中命中（确定性校验，不是模型自述） */
  verbatim: boolean;
};

export type JdParseResult = {
  title: string | null;
  company: string | null;
  language: JdLanguage;
  requirements: ParsedRequirement[];
  /** 是否走了保底降级（英文 JD / 模型未返回条目） */
  degraded: boolean;
  multiPosting: boolean;
  warnings: string[];
  attempts: number;
};

export class JdTooShortError extends Error {
  code: string;
  length: number;

  constructor(length: number, minLength: number) {
    super(`JD 内容过短（${length} 字符，至少 ${minLength} 字符）`);
    this.name = 'JdTooShortError';
    this.code = 'TOO_SHORT';
    this.length = length;
  }
}

export class JdEmptyRequirementsError extends Error {
  code: string;

  constructor() {
    super('未能从 JD 中提取出任何要求条目');
    this.name = 'JdEmptyRequirementsError';
    this.code = 'EMPTY_REQUIREMENTS';
  }
}

export class JdShapeError extends Error {
  code: string;
  issues: string[];

  constructor(issues: string[]) {
    super(`模型输出结构不符合 schema：${issues.join('; ')}`);
    this.name = 'JdShapeError';
    this.code = 'INVALID_SHAPE';
    this.issues = issues;
  }
}
