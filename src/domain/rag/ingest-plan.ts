/**
 * T5-A RAG-Lite —— 受控 ingest 的**纯计划函数**（无 IO）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md`（ADR-016）§3.2 / §3.3 / §5 / §6。
 *
 * 职责：把一篇文档正文转换为「可写入 KnowledgeDocument / KnowledgeChunk 的确定性行」：
 *   - `contentFingerprint`（T5A-F-18，FROZEN 算法，来自 fingerprint.ts）；
 *   - 切片（T5A-F-29~32，来自 chunker.ts）；
 *   - `searchText` = 该切片经 **同一个** `cjk-bigram/v1` tokenizer 生成、以单空格连接
 *     （T5A-F-36：文档侧与查询侧必须同源）；
 *   - `chunkHash` = `SHA-256(fp:order:content)`（T5A-F-22）。
 *
 * 关键约束：
 *   - **不重新实现** tokenizer / chunker / fingerprint（唯一实现分别在各域模块内）；
 *   - 不得读取任何用户私有数据（本函数只接受调用方传入的公共语料正文）；
 *   - 本函数**不写库**、不调用 LLM、不产生任何事实层写入。
 */

import type { RAGChunk } from './contract.ts';
import { chunkText } from './chunker.ts';
import { chunkHash, contentFingerprint } from './fingerprint.ts';
import { tokenize } from './tokenizer.ts';

/** 一片待写入的 chunk（含派生字段；不含 id / 时间戳，由 repository 生成） */
export interface PlannedChunk {
  chunkOrder: number;
  /** 归一化（NFKC + CRLF/CR→LF）后的切片正文 */
  content: string;
  /** tokenizer 输出以单空格连接（tsvector 生成列的输入） */
  searchText: string;
  /** SHA-256(fp:order:content) */
  chunkHash: string;
}

/** 一篇待写入的文档（含量派生字段） */
export interface PlannedDocument {
  contentFingerprint: string;
  chunks: PlannedChunk[];
}

/**
 * 把文档正文规划为确定性写入行。
 * 同一 content 恒定产出同一 fingerprint / 同一 chunk 序列 / 同一 chunkHash。
 */
export function planDocumentIngest(content: string): PlannedDocument {
  const fingerprint = contentFingerprint(content);
  const chunks = chunkText(content).map(
    (chunk: RAGChunk): PlannedChunk => ({
      chunkOrder: chunk.chunkOrder,
      content: chunk.content,
      searchText: tokenize(chunk.content).join(' '),
      chunkHash: chunkHash(fingerprint, chunk.chunkOrder, chunk.content),
    }),
  );
  return { contentFingerprint: fingerprint, chunks };
}
