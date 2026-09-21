/**
 * Evidence 定位：**服务端确定性定位**。
 *
 * 模型只允许返回 evidenceQuote（它依据的原文片段），**绝不允许返回行号** ——
 * 模型给的行号不可信，而且换一段文本就会错位。这里把 quote 反查回原文，
 * 用带索引映射的归一化字符串定位，再换算回原始字符偏移与行号。
 */

export const MIN_QUOTE_CHARS = 4;
export const MAX_EXCERPT_CHARS = 200;

export type LocationResult = {
  locator: string;
  excerpt: string;
  start: number;
  end: number;
};

/** 归一化并保留「归一化下标 → 原文下标」的映射 */
function normalizeWithMap(source: string): { norm: string; map: number[] } {
  let norm = '';
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    // 去掉空白、标点与不可见字符；保留字母/数字/CJK
    if (/[\s\p{P}\p{Z}\p{C}]/u.test(ch)) continue;
    norm += ch.toLowerCase();
    map.push(i);
  }
  return { norm, map };
}

export function normalizeForLocate(text: string): string {
  return normalizeWithMap(text).norm;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * 在原文中定位 quote。定位不到返回 null —— 调用方必须丢弃该条目，而不是编造一个位置。
 *
 * @param source 抽取后的简历原文（唯一事实来源）
 * @param quote  模型给出的原文片段
 */
export function locateQuote(source: string, quote: string): LocationResult | null {
  const quoteNorm = normalizeForLocate(quote);
  if (quoteNorm.length < MIN_QUOTE_CHARS) return null;

  const { norm, map } = normalizeWithMap(source);
  const idx = norm.indexOf(quoteNorm);
  if (idx === -1) return null;

  const start = map[idx];
  const end = map[idx + quoteNorm.length - 1];
  if (start === undefined || end === undefined) return null;

  const rawExcerpt = source.slice(start, end + 1).replace(/\s+/g, ' ').trim();
  if (rawExcerpt.length === 0) return null;

  const excerpt =
    rawExcerpt.length > MAX_EXCERPT_CHARS ? `${rawExcerpt.slice(0, MAX_EXCERPT_CHARS)}…` : rawExcerpt;

  return { locator: `resume:line:${lineOf(source, start)}`, excerpt, start, end };
}

/** 条目文本是否能在原文中逐字（归一化后）找到 */
export function isVerbatim(source: string, text: string): boolean {
  const t = normalizeForLocate(text);
  if (t.length === 0) return false;
  return normalizeWithMap(source).norm.includes(t);
}
