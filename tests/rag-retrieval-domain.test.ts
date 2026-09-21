/**
 * T5-A Phase 2 —— Retrieval Contract / 受控 ingest 计划（**纯 Domain，无 DB**）
 *
 * 依据：ADR-016 §8（retrieve 输入/输出契约）、§3.2/§3.3（fingerprint / chunkHash）、§5/§6（chunker / tokenizer）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RETRIEVAL_CONTRACT,
  RETRIEVAL_CONTENT_MAX_CHARS,
  RETRIEVAL_DEFAULT_LIMIT,
  RETRIEVAL_MAX_LIMIT,
  RETRIEVAL_MIN_LIMIT,
  RETRIEVAL_QUERY_MAX_CHARS,
  RETRIEVAL_SEMANTIC_VERSIONS,
  buildQuerySearchText,
  truncateContent,
} from '../src/domain/rag/retrieval.ts';
import { planDocumentIngest } from '../src/domain/rag/ingest-plan.ts';
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP } from '../src/domain/rag/chunker.ts';

test('[retrieval] 契约标识与三个语义版本（裁定 29）', () => {
  assert.equal(RETRIEVAL_CONTRACT, 'rag-retrieval/v1');
  assert.equal(RETRIEVAL_SEMANTIC_VERSIONS.tokenizer, 'cjk-bigram/v1');
  assert.equal(RETRIEVAL_SEMANTIC_VERSIONS.chunker, 'paragraph-sentence-hardcut/v1');
  assert.equal(RETRIEVAL_SEMANTIC_VERSIONS.fts, 'pg-simple-tsvector-gin/v1');
});

test('[retrieval] 输入边界常量：query 1–200、limit 1–20、默认 5（T5A-F-46）', () => {
  assert.equal(RETRIEVAL_QUERY_MAX_CHARS, 200);
  assert.equal(RETRIEVAL_DEFAULT_LIMIT, 5);
  assert.equal(RETRIEVAL_MIN_LIMIT, 1);
  assert.equal(RETRIEVAL_MAX_LIMIT, 20);
});

test('[retrieval] 查询串复用 cjk-bigram/v1（不建第二套 tokenizer）', () => {
  assert.equal(buildQuerySearchText('模拟面试'), '模拟 拟面 面试');
  assert.equal(buildQuerySearchText('ABC123'), 'abc123');
  assert.equal(buildQuerySearchText('模拟面试 ABC123'), '模拟 拟面 面试 abc123');
  // 与 ingest 侧同源：对同一串调用结果逐字节一致
  assert.equal(buildQuerySearchText('一致性检查'), buildQuerySearchText('一致性检查'));
});

test('[retrieval] content 截断：≤1200 不截断；>1200 截断为恰好 1200 且 truncated=true（T5A-F-48）', () => {
  const exact = 'x'.repeat(RETRIEVAL_CONTENT_MAX_CHARS);
  const under = 'x'.repeat(RETRIEVAL_CONTENT_MAX_CHARS - 1);
  const over = 'x'.repeat(RETRIEVAL_CONTENT_MAX_CHARS + 5);

  assert.deepEqual(truncateContent(exact), { content: exact, truncated: false });
  assert.deepEqual(truncateContent(under), { content: under, truncated: false });

  const t = truncateContent(over);
  assert.equal(t.truncated, true);
  assert.equal(t.content.length, RETRIEVAL_CONTENT_MAX_CHARS);
  assert.equal(t.content, over.slice(0, RETRIEVAL_CONTENT_MAX_CHARS));
});

test('[ingest-plan] 确定性：同一 content → 同一 fingerprint / 同一 chunk 序列 / 同一 chunkHash', () => {
  const content = '第一段内容。\n\n第二段 content with ABC123。';
  const a = planDocumentIngest(content);
  const b = planDocumentIngest(content);
  assert.deepEqual(a, b);
});

test('[ingest-plan] chunkOrder 从 0 递增；searchText 由 tokenizer 生成；chunkHash 为 64 位 hex', () => {
  const content = '甲。\n\n乙。\n\n丙。';
  const plan = planDocumentIngest(content);
  assert.equal(plan.chunks.length, 3);
  assert.deepEqual(plan.chunks.map((c) => c.chunkOrder), [0, 1, 2]);
  for (const c of plan.chunks) {
    assert.match(c.chunkHash, /^[0-9a-f]{64}$/);
    assert.equal(c.searchText, buildQuerySearchText(c.content));
  }
  assert.match(plan.contentFingerprint, /^[0-9a-f]{64}$/);
});

test('[ingest-plan] 内容变化 → fingerprint 变化（T5A-F-17 依据）', () => {
  const a = planDocumentIngest('内容 A');
  const b = planDocumentIngest('内容 B');
  assert.notEqual(a.contentFingerprint, b.contentFingerprint);
  assert.notEqual(a.chunks[0].chunkHash, b.chunks[0].chunkHash);
});

test('[ingest-plan] 切片沿用 FROZEN chunker 参数（800 / overlap 0）', () => {
  assert.equal(CHUNK_MAX_CHARS, 800);
  assert.equal(CHUNK_OVERLAP, 0);
  const plan = planDocumentIngest('y'.repeat(1700));
  assert.deepEqual(plan.chunks.map((c) => c.content.length), [800, 800, 100]);
  assert.deepEqual(plan.chunks.map((c) => c.chunkOrder), [0, 1, 2]);
});

test('[ingest-plan] NFKC / 换行归一化在 fingerprint 前生效（CRLF 与 LF 等价）', () => {
  const lf = planDocumentIngest('A\nB');
  const crlf = planDocumentIngest('A\r\nB');
  assert.equal(lf.contentFingerprint, crlf.contentFingerprint);
});
