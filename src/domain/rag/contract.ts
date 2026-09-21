/**
 * T5-A RAG-Lite —— 语义版本与 Domain Contract 类型（**单一来源**）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md`（ADR-016）
 *   - §2 T5A-F-09：检索语义由三个版本标识共同冻结；
 *   - §5 T5A-F-29：chunker = `paragraph-sentence-hardcut/v1`；
 *   - §6 T5A-F-33：tokenizer = `cjk-bigram/v1`；
 *   - §7 T5A-F-37：fts = `pg-simple-tsvector-gin/v1`。
 *
 * 硬约束（不得违反）：
 *   - 三个版本字符串**禁止修改**（任一变更 = Contract Change，见 ADR-016 §17）；
 *   - 本 Phase（T5-A-2 Phase 1）只实际实现 tokenizer 与 chunker 两个版本；
 *     `pg-simple-tsvector-gin/v1` 仅为标识常量，供后续检索层引用，本 Phase 不实现。
 *
 * 本模块纯常量 + 类型 + 零依赖，供 domain / repository / 测试共同引用。
 */

/** Tokenizer 语义版本（ADR-016 §6 T5A-F-33，FROZEN） */
export const TOKENIZER_VERSION = 'cjk-bigram/v1';

/** Chunker 语义版本（ADR-016 §5 T5A-F-29，FROZEN） */
export const CHUNKER_VERSION = 'paragraph-sentence-hardcut/v1';

/** PostgreSQL FTS 语义版本（ADR-016 §7 T5A-F-37，FROZEN；本 Phase 不实现） */
export const FTS_VERSION = 'pg-simple-tsvector-gin/v1';

/** 切片的最小返回粒度（ADR-016 §3.3 T5A-F-19：检索最小返回粒度 = Chunk） */
export interface RAGChunk {
  /** 从 0 开始递增，由 chunker 确定性生成，禁止人工重排（T5A-F-24） */
  chunkOrder: number;
  /** 归一化（NFKC + CRLF/CR→LF）后的切片文本 */
  content: string;
}
