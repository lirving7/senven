/**
 * T5-A RAG-Lite —— Paragraph/Sentence Chunker（`paragraph-sentence-hardcut/v1`）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md` §5（T5A-F-29 ~ T5A-F-32）。
 *
 * 固定参数（FROZEN）：
 *   - CHUNK_MAX_CHARS = 800
 *   - CHUNK_OVERLAP = 0
 *
 * 切分规则（FROZEN）：
 *   1. NFKC 归一化；
 *   2. CRLF / CR → LF；
 *   3. 连续空行（两个及以上 `\n`）作为 paragraph boundary；
 *   4. 段落内按 sentence punctuation 切句，标点集合固定为 `。！？；.!?;`；
 *   5. 单个片段最大 800 字符；
 *   6. 超长 sentence 必须 hard-cut（直接按 800 字符截断）；
 *   7. overlap = 0（无重叠）；
 *   8. 删除空 chunk（归一化后为空 / 纯 whitespace 的片段不产出）；
 *   9. chunkOrder 从 0 开始递增；
 *  10. 不允许人工重排；
 *  11. Markdown v1 按普通文本处理；
 *  12. code block v1 不做特殊解析。
 *
 * 纯函数 + 零依赖。chunk 内容为 NFKC + LF 归一化后的原文（不 trim，仅删除纯空白片段）。
 */

import { CHUNKER_VERSION, type RAGChunk } from './contract.ts';

/** 本 chunker 的语义版本标识（与 contract.ts 单一来源一致） */
export const CHUNKER = CHUNKER_VERSION;

/** 单个 chunk 最大字符数（ADR-016 §5 T5A-F-30，FROZEN） */
export const CHUNK_MAX_CHARS = 800;

/** chunk 之间的重叠字符数（ADR-016 §5 T5A-F-30，FROZEN，恒为 0） */
export const CHUNK_OVERLAP = 0;

/** sentence punctuation 集合（ADR-016 §5 T5A-F-32.4，FROZEN） */
const SENTENCE_PUNCTUATION = '。！？；.!?;';

/**
 * 段落内切句：遇到 sentence punctuation 即断句（标点归属前一句）。
 * 无标点段落整体作为一个句子单元，后续由 hard-cut 兜底。
 */
function splitSentences(paragraph: string): string[] {
  const sentences: string[] = [];
  let buf = '';
  for (const ch of paragraph) {
    buf += ch;
    if (SENTENCE_PUNCTUATION.includes(ch)) {
      sentences.push(buf);
      buf = '';
    }
  }
  if (buf.length > 0) sentences.push(buf);
  return sentences;
}

/** 片段是否为「空 / 纯 whitespace」（规则 8 的删除判据） */
function isBlank(content: string): boolean {
  return content.trim().length === 0;
}

/**
 * 按 `paragraph-sentence-hardcut/v1` 规则切分文本，返回 `RAGChunk[]`。
 * `chunkOrder` 从 0 开始确定性递增；空 chunk 已被删除。
 */
export function chunkText(raw: string): RAGChunk[] {
  // 规则 1 / 2：NFKC + CRLF/CR → LF
  const normalized = raw.normalize('NFKC').replace(/\r\n|\r/g, '\n');

  // 规则 3：连续空行作为 paragraph boundary
  const paragraphs = normalized.split(/\n{2,}/);

  const contents: string[] = [];

  for (const paragraph of paragraphs) {
    const sentences = splitSentences(paragraph);
    let current = '';

    for (const sentence of sentences) {
      if (current === '') {
        current = sentence;
      } else if (current.length + sentence.length <= CHUNK_MAX_CHARS) {
        current += sentence;
      } else {
        pushIfNotBlank(contents, current);
        current = sentence;
      }

      // 规则 5 / 6：单个片段超 800 → 直接 hard-cut（overlap = 0）
      while (current.length > CHUNK_MAX_CHARS) {
        pushIfNotBlank(contents, current.slice(0, CHUNK_MAX_CHARS));
        current = current.slice(CHUNK_MAX_CHARS);
      }
    }

    // 段落收尾
    pushIfNotBlank(contents, current);
  }

  // 规则 9：chunkOrder 从 0 开始递增
  return contents.map((content, index): RAGChunk => ({ chunkOrder: index, content }));
}

function pushIfNotBlank(contents: string[], content: string): void {
  // 规则 8：删除空 / 纯 whitespace chunk
  if (!isBlank(content)) contents.push(content);
}
