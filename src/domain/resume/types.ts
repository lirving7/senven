import { FACT_STATUS } from '../types.ts';
import type { EvidenceSource, FactStatus } from '../types.ts';

/**
 * T2 · Resume Parser
 *
 * 铁律：
 *   1. 解析结果**永不自动变成 CONFIRMED**。默认规则：
 *        文本中逐字可查 → UNCONFIRMED（有据可依，待用户确认）
 *        模型改写/推断   → INFERRED（推断来源，待确认）
 *   2. 每条 Fact 必须有 Evidence，且 **locator 与 excerpt 都不能缺**。
 *      excerpt 缺失会让 T4 无法把已存在的事实认定为 HAVE/ENHANCE —— 这是历史踩过的坑。
 *   3. 原始文件不落盘，只保留抽取后的文本。
 */

export const RESUME_SOURCE_TYPE = {
  TEXT: 'TEXT',
  PDF: 'PDF',
  DOCX: 'DOCX',
} as const;
export type ResumeSourceType = (typeof RESUME_SOURCE_TYPE)[keyof typeof RESUME_SOURCE_TYPE];

/** 抽取出的原文 + 其来源类型 */
export type ExtractedText = {
  text: string;
  sourceType: ResumeSourceType;
  /** 抽取告警（如「超出部分已截断」） */
  warnings: string[];
};

export const RESUME_SECTION = {
  SKILL: 'SKILL',
  PROJECT: 'PROJECT',
  EDUCATION: 'EDUCATION',
  EXPERIENCE: 'EXPERIENCE',
} as const;
export type ResumeSection = (typeof RESUME_SECTION)[keyof typeof RESUME_SECTION];

/** LLM 返回的原始条目（evidenceQuote 用于服务端定位，模型不得给行号） */
export type RawItem = {
  section: ResumeSection;
  title: string;
  detail: string | null;
  evidenceQuote: string;
};

/** 定位成功后的条目 */
export type LocatedItem = RawItem & {
  locator: string;
  excerpt: string;
  /** 该条目文本是否能在原文中逐字找到 */
  verbatim: boolean;
  status: FactStatus;
  needsUserConfirmation: boolean;
};

export type ParsedResume = {
  items: LocatedItem[];
  /** 因无法定位证据而被丢弃的条目 —— 如实返回，不静默丢弃 */
  rejected: Array<{ title: string; reason: string }>;
  rawText: string;
  sourceType: ResumeSourceType;
  warnings: string[];
  /** 供落库使用的规范证据来源 */
  evidenceSource: EvidenceSource;
};

export type ResumeOutcome =
  | { ok: true; parsed: ParsedResume }
  | { ok: false; state: ResumeState; message: string };

export const RESUME_STATE = {
  /** 没有解析出任何可定位证据的条目 */
  NOTHING_PARSED: 'NOTHING_PARSED',
  /** 需要用户先自行录入（图片/扫描件） */
  SCAN_NOT_SUPPORTED: 'SCAN_NOT_SUPPORTED',
} as const;
export type ResumeState = (typeof RESUME_STATE)[keyof typeof RESUME_STATE];

export class IntakeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IntakeError';
    this.code = code;
  }
}

export class ResumeShapeError extends Error {
  code = 'RESUME_SHAPE_INVALID';
  constructor(message: string) {
    super(`简历解析结果结构异常：${message}`);
    this.name = 'ResumeShapeError';
  }
}

/** 初始 FactStatus：绝不返回 CONFIRMED */
export function initialFactStatus(verbatim: boolean): FactStatus {
  return verbatim ? FACT_STATUS.UNCONFIRMED : FACT_STATUS.INFERRED;
}
