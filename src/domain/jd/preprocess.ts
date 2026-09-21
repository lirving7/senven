import { JdTooShortError, JD_LANGUAGE } from './types.ts';
import type { JdLanguage, ParsedRequirement } from './types.ts';

export const MIN_JD_LENGTH = 50;
export const MAX_JD_LENGTH = 20_000;

/** 清洗：只去噪，不改写措辞（保留原始 wording 是硬要求） */
export function normalizeJdText(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function assertJdLength(cleaned: string): void {
  if (cleaned.length < MIN_JD_LENGTH) {
    throw new JdTooShortError(cleaned.length, MIN_JD_LENGTH);
  }
}

export function truncateJd(cleaned: string): { text: string; truncated: boolean } {
  if (cleaned.length <= MAX_JD_LENGTH) return { text: cleaned, truncated: false };
  return { text: cleaned.slice(0, MAX_JD_LENGTH), truncated: true };
}

/** 语言判定：按中文字符占比。用于决定是否需要「保底降级」。 */
export function detectLanguage(text: string): JdLanguage {
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = cjk + latin;
  if (total === 0) return JD_LANGUAGE.ZH;
  const ratio = cjk / total;
  if (ratio >= 0.6) return JD_LANGUAGE.ZH;
  if (ratio <= 0.15) return JD_LANGUAGE.EN;
  return JD_LANGUAGE.MIXED;
}

/**
 * 多岗位检测（启发式）。
 * 已知局限：单份 JD 若重复出现「岗位职责」标题会误报；拼接多份 JD 若只有一份带标题会漏报。
 * 因此只作为 warning 提示，不阻断解析。
 */
export function detectMultiPosting(text: string): boolean {
  const titleMarkers =
    text.match(/(^|\n)\s*(岗位名称|职位名称|招聘职位|岗位[:：]|职位[:：]|Job Title|Position)\s*[:：]/g) ?? [];
  const dutyMarkers = text.match(/岗位职责|职位描述|工作内容|Responsibilities/g) ?? [];
  return titleMarkers.length >= 2 || dutyMarkers.length >= 2;
}

/** 归一化后比对，用于 verbatim 判定与去重 */
export function normalizeForMatch(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[，。、；：（）()【】\[\],.;:!?！？"'“”‘’·\-—_/\\|~]/g, '')
    .toLowerCase();
}

/** 确定性 verbatim 校验：要求文本是否真的出现在 JD 原文里 */
export function isVerbatim(requirement: string, sourceText: string): boolean {
  const target = normalizeForMatch(requirement);
  if (target.length === 0) return false;
  return normalizeForMatch(sourceText).includes(target);
}

export function dedupeRequirements(items: ParsedRequirement[]): ParsedRequirement[] {
  const seen = new Set<string>();
  const out: ParsedRequirement[] = [];
  for (const item of items) {
    const key = normalizeForMatch(item.text);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/**
 * 保底解析：模型未返回条目时（典型场景：英文 JD），
 * 直接从 JD 原文抽取有效行，全部标 OTHER + SHOULD。
 * 保证「英文 JD 也必须产出非空 Requirement」。
 */
export function fallbackRequirements(cleaned: string): ParsedRequirement[] {
  const lines = cleaned
    .split('\n')
    .map((line) => line.replace(/^[\s\-•*·●○\d.、)）]+/, '').trim())
    .filter((line) => line.length >= 6);

  const out: ParsedRequirement[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const key = normalizeForMatch(line);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push({ text: line, category: 'OTHER', criticality: 'SHOULD', verbatim: true });
    if (out.length >= 20) break;
  }
  return out;
}
