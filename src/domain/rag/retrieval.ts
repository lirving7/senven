/**
 * T5-A RAG-Lite —— Retrieval Contract（`rag-retrieval/v1`）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md`（ADR-016）§7 / §8。
 *
 * 本模块只提供**确定性纯函数 + 契约常量**：
 *   - 输入边界（query trim 后 1–200；limit 1–20，默认 5）——T5A-F-46；
 *   - 响应契约标识与三个语义版本——T5A-F-47 / 裁定 29；
 *   - content 截断上限 1200——T5A-F-48；
 *   - 查询侧 tokenizer 复用（**不得**另建第二套）——T5A-F-36 / T5A-F-40。
 *
 * 硬边界：
 *   - **零持久化**：本层不写库、不缓存 query 或结果（T5A-F-49）；
 *   - **LLM-free**：不调用 provider、不消耗 quota（T5A-F-02 / §14）；
 *   - **非事实权威**：输出不得成为 Evidence / CapabilityEvidence / CONFIRMED 依据（T5A-F-53 / T5A-F-74）。
 */

import { CHUNKER_VERSION, FTS_VERSION, TOKENIZER_VERSION } from './contract.ts';
import { tokenize } from './tokenizer.ts';

/** 检索响应契约标识（T5A-F-47） */
export const RETRIEVAL_CONTRACT = 'rag-retrieval/v1';

/** query trim 后的长度下界（T5A-F-46） */
export const RETRIEVAL_QUERY_MIN_CHARS = 1;
/** query trim 后的长度上界（T5A-F-46） */
export const RETRIEVAL_QUERY_MAX_CHARS = 200;

/** limit 缺省值（T5A-F-46） */
export const RETRIEVAL_DEFAULT_LIMIT = 5;
/** limit 下界（T5A-F-46） */
export const RETRIEVAL_MIN_LIMIT = 1;
/** limit 上界（T5A-F-42 / T5A-F-46） */
export const RETRIEVAL_MAX_LIMIT = 20;

/** 单条 item 的 content 截断上限（T5A-F-48） */
export const RETRIEVAL_CONTENT_MAX_CHARS = 1200;

/** 响应中必须出现的三个语义版本（裁定 29；FROZEN，不得修改） */
export const RETRIEVAL_SEMANTIC_VERSIONS = {
  tokenizer: TOKENIZER_VERSION,
  chunker: CHUNKER_VERSION,
  fts: FTS_VERSION,
} as const;

/**
 * 查询侧检索串：与文档侧 `searchText` 使用**同一个** `cjk-bigram/v1` tokenizer，
 * 以单空格连接后交给 `plainto_tsquery('simple', ...)`（T5A-F-36 / T5A-F-40）。
 */
export function buildQuerySearchText(query: string): string {
  return tokenize(query).join(' ');
}

/**
 * content 截断（T5A-F-48）：超过 1200 截断并置 `truncated = true`；
 * `snippet` 与 `content` 相等（FROZEN 语义，由调用方直接复用返回值）。
 *
 * 长度口径：UTF-16 code unit（确定性；与 DB `String` 存储一致）。
 */
export function truncateContent(content: string): { content: string; truncated: boolean } {
  if (content.length <= RETRIEVAL_CONTENT_MAX_CHARS) {
    return { content, truncated: false };
  }
  return { content: content.slice(0, RETRIEVAL_CONTENT_MAX_CHARS), truncated: true };
}
