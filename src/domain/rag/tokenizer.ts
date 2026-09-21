/**
 * T5-A RAG-Lite —— CJK Bigram Tokenizer（`cjk-bigram/v1`）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md` §6（T5A-F-33 ~ T5A-F-36）。
 *
 * 十条规则（FROZEN）：
 *   1. NFKC 归一化；
 *   2. 连续 CJK 字符拆成相邻 bigram；
 *   3. 单个 CJK 字符保留为 unigram；
 *   4. Latin / digit 连续 run 作为**一个** token；
 *   5. Latin / digit 一律 lowercase；
 *   6. punctuation / whitespace 作为边界（不产出 token）；
 *   7. 不使用 stopwords；
 *   8. 不 deduplicate；
 *   9. 保留 token 顺序；
 *  10. ingest 与 query 使用完全相同的 tokenizer（即本函数为唯一实现）。
 *
 * 示例（FROZEN）：`模拟面试 ABC123` → `模拟 拟面 面试 abc123`
 *
 * CJK 判定范围：Han（含中文）/ Hiragana / Katakana / Hangul。
 * 纯函数 + 零依赖，供文档侧 `searchText` 与查询侧 query 串共同引用。
 */

import { TOKENIZER_VERSION } from './contract.ts';

/** 本 tokenizer 的语义版本标识（与 contract.ts 单一来源一致） */
export const TOKENIZER = TOKENIZER_VERSION;

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_DIGIT_RE = /[\p{Script=Latin}0-9]/u;

/**
 * 按 `cjk-bigram/v1` 规则对输入文本分词，返回**有序** token 列表。
 *
 * - 输入不假设已归一化；本函数内部先做 NFKC（规则 1）。
 * - 返回数组**不 deduplicate**（规则 8）、**保留顺序**（规则 9）。
 */
export function tokenize(raw: string): string[] {
  // 规则 1：NFKC；并按 code point 迭代（避免代理对把 astral 字符拆成半个单元）。
  const chars = [...raw.normalize('NFKC')];
  const tokens: string[] = [];

  let i = 0;
  while (i < chars.length) {
    const ch = chars[i];

    if (CJK_RE.test(ch)) {
      // 规则 2 / 3：连续 CJK 段
      let j = i;
      while (j < chars.length && CJK_RE.test(chars[j])) j += 1;
      const run = chars.slice(i, j);
      if (run.length === 1) {
        // 规则 3：单个 CJK 字符保留 unigram
        tokens.push(run[0]);
      } else {
        // 规则 2：相邻 bigram
        for (let k = 0; k + 1 < run.length; k += 1) {
          tokens.push(run[k] + run[k + 1]);
        }
      }
      i = j;
    } else if (LATIN_DIGIT_RE.test(ch)) {
      // 规则 4 / 5：Latin/digit 连续 run → 一个 token，并 lowercase
      let j = i;
      while (j < chars.length && LATIN_DIGIT_RE.test(chars[j])) j += 1;
      tokens.push(chars.slice(i, j).join('').toLowerCase());
      i = j;
    } else {
      // 规则 6：punctuation / whitespace / 其它 → 边界，跳过
      i += 1;
    }
  }

  return tokens;
}
