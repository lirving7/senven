/**
 * T5-A-2 Phase 1 —— RAG tokenizer / chunker / fingerprint / chunkHash（纯 Domain，无数据库）
 *
 * 覆盖授权书 §七：
 *   - Tokenizer：CJK bigram / 单 CJK / Latin / digits / lowercase / punctuation /
 *     whitespace / 中英数字混合 / token 顺序 / 不 deduplicate / NFKC / ingest==query 同源
 *   - Chunker：paragraph / sentence boundary / 800 边界 / 超长 hard-cut / CRLF·CR /
 *     空 chunk / chunkOrder 从 0 / overlap=0 / Markdown 普通文本 / reproducibility
 *   - Fingerprint / Hash：normalization 一致性 / 相同输入同指纹 / 相同 chunk 同 hash /
 *     不同 chunkOrder 不同 hash / deterministic
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { tokenize } from '../src/domain/rag/tokenizer.ts';
import { chunkText, CHUNK_MAX_CHARS, CHUNK_OVERLAP } from '../src/domain/rag/chunker.ts';
import {
  contentFingerprint,
  chunkHash,
  normalizeTextForFingerprint,
  CHUNK_HASH_SEPARATOR,
} from '../src/domain/rag/fingerprint.ts';
import {
  TOKENIZER_VERSION,
  CHUNKER_VERSION,
  FTS_VERSION,
} from '../src/domain/rag/contract.ts';

// ─── Tokenizer ────────────────────────────────────────────────────────

test('[tokenizer] 语义版本标识固定为 cjk-bigram/v1', () => {
  assert.equal(TOKENIZER_VERSION, 'cjk-bigram/v1');
  assert.equal(CHUNKER_VERSION, 'paragraph-sentence-hardcut/v1');
  assert.equal(FTS_VERSION, 'pg-simple-tsvector-gin/v1');
});

test('[tokenizer] 示例（FROZEN）：模拟面试 ABC123 → 模拟 拟面 面试 abc123', () => {
  assert.deepEqual(tokenize('模拟面试 ABC123'), ['模拟', '拟面', '面试', 'abc123']);
});

test('[tokenizer] CJK bigram：中文测试 → 中文 文测 测试', () => {
  assert.deepEqual(tokenize('中文测试'), ['中文', '文测', '测试']);
});

test('[tokenizer] 单个 CJK 字符保留 unigram：中 / 面', () => {
  assert.deepEqual(tokenize('中'), ['中']);
  assert.deepEqual(tokenize('面'), ['面']);
});

test('[tokenizer] Latin run 单 token 且 lowercase：Hello → hello', () => {
  assert.deepEqual(tokenize('Hello'), ['hello']);
  assert.deepEqual(tokenize('WORLD'), ['world']);
});

test('[tokenizer] digits run 单 token：123 / 2024', () => {
  assert.deepEqual(tokenize('123'), ['123']);
  assert.deepEqual(tokenize('2024'), ['2024']);
});

test('[tokenizer] Latin+digit 连续 run 合并：ABC123 → abc123', () => {
  assert.deepEqual(tokenize('ABC123'), ['abc123']);
});

test('[tokenizer] punctuation 作为边界：a,b → [a, b]；v1.2 → [v1, 2]', () => {
  assert.deepEqual(tokenize('a,b'), ['a', 'b']);
  // `.` 为 punctuation（ADR-016 §6 规则 6：punctuation 作为边界）
  assert.deepEqual(tokenize('v1.2'), ['v1', '2']);
});

test('[tokenizer] whitespace 作为边界：hello world → [hello, world]', () => {
  assert.deepEqual(tokenize('hello world'), ['hello', 'world']);
  assert.deepEqual(tokenize('hello\tworld'), ['hello', 'world']);
});

test('[tokenizer] 中英数字混合：2024年 ABC面试 → [2024, 年, abc, 面试]', () => {
  assert.deepEqual(tokenize('2024年 ABC面试'), ['2024', '年', 'abc', '面试']);
});

test('[tokenizer] 保留 token 顺序', () => {
  assert.deepEqual(tokenize('ab中cd'), ['ab', '中', 'cd']);
});

test('[tokenizer] 不 deduplicate：aaa aaa → [aaa, aaa]；面试面试 → [面试, 试面, 面试]', () => {
  assert.deepEqual(tokenize('aaa aaa'), ['aaa', 'aaa']);
  assert.deepEqual(tokenize('面试面试'), ['面试', '试面', '面试']);
});

test('[tokenizer] NFKC：全角 ＡＢＣ１２３ → abc123', () => {
  assert.deepEqual(tokenize('ＡＢＣ１２３'), ['abc123']);
  assert.deepEqual(tokenize('Ｔｅｓｔ'), ['test']);
});

test('[tokenizer] ingest 与 query 同源（同一函数、逐字节一致）', () => {
  const doc = '模拟面试 ABC123 2024';
  assert.deepEqual(tokenize(doc), tokenize(doc));
});

// ─── Chunker ──────────────────────────────────────────────────────────

test('[chunker] 语义版本标识固定为 paragraph-sentence-hardcut/v1；常量冻结', () => {
  assert.equal(CHUNKER_VERSION, 'paragraph-sentence-hardcut/v1');
  assert.equal(CHUNK_MAX_CHARS, 800);
  assert.equal(CHUNK_OVERLAP, 0);
});

test('[chunker] paragraph boundary：连续空行切分，且不跨段合并', () => {
  const r = chunkText('第一段\n\n第二段');
  assert.deepEqual(r.map((c) => c.content), ['第一段', '第二段']);
  assert.deepEqual(r.map((c) => c.chunkOrder), [0, 1]);
});

test('[chunker] sentence boundary：按句号切句后再按 800 打包（在句边界分界）', () => {
  const s1 = 'a'.repeat(700) + '。';
  const s2 = 'b'.repeat(200) + '。';
  const r = chunkText(s1 + s2);
  assert.equal(r.length, 2);
  assert.equal(r[0].content, s1); // 701 字符，结束于句号，未被 800 硬切
  assert.equal(r[1].content, s2);
});

test('[chunker] 800 字符边界：1500 无标点 → [800, 700]', () => {
  const r = chunkText('a'.repeat(1500));
  assert.equal(r.length, 2);
  assert.equal(r[0].content.length, 800);
  assert.equal(r[1].content.length, 700);
});

test('[chunker] 超长 sentence hard-cut：900 字符 → [800, 100]', () => {
  const r = chunkText('b'.repeat(900));
  assert.equal(r.length, 2);
  assert.equal(r[0].content.length, 800);
  assert.equal(r[1].content.length, 100);
});

test('[chunker] CRLF / CR → LF', () => {
  const r = chunkText('a\r\nb\rc');
  assert.equal(r.length, 1);
  assert.equal(r[0].content, 'a\nb\nc');
});

test('[chunker] 删除空 chunk：纯空行与纯 whitespace 段落不产出', () => {
  const r = chunkText('a\n\n\n\nb\n\n   \n\nc');
  assert.deepEqual(r.map((c) => c.content), ['a', 'b', 'c']);
});

test('[chunker] chunkOrder 从 0 递增', () => {
  const r = chunkText('p1\n\np2\n\np3');
  assert.deepEqual(r.map((c) => c.chunkOrder), [0, 1, 2]);
});

test('[chunker] overlap = 0：无重叠（相邻 chunk 不共享字符）', () => {
  const text = 'x'.repeat(1500);
  const r = chunkText(text);
  assert.equal(r[0].content + r[1].content, text); // 精确拼接无重叠
});

test('[chunker] Markdown 按普通文本处理（符号保留、不解析标题/代码块）', () => {
  const r = chunkText('# 标题\n\n正文 ```code``` 结束');
  assert.deepEqual(r.map((c) => c.content), ['# 标题', '正文 ```code``` 结束']);
});

test('[chunker] reproducibility：相同输入 → 相同输出（逐字节）', () => {
  const input = '第一段内容。\n\n第二段 with ABC123 内容！';
  assert.deepEqual(chunkText(input), chunkText(input));
});

// ─── contentFingerprint / chunkHash ──────────────────────────────────

test('[fingerprint] normalization：trim + CRLF/CR→LF 后一致性', () => {
  assert.equal(normalizeTextForFingerprint('  A\nB  '), 'A\nB');
  assert.equal(normalizeTextForFingerprint('A\r\nB'), 'A\nB');
  assert.equal(normalizeTextForFingerprint('A\rB'), 'A\nB');
  assert.equal(normalizeTextForFingerprint('  A  '), 'A');
});

test('[fingerprint] 相同输入 → 相同 fingerprint；输出 64 位 lowercase hex', () => {
  const a = contentFingerprint('hello 世界');
  const b = contentFingerprint('hello 世界');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('[fingerprint] normalization 后等价（换行/外层空白/全角）→ 相同 fingerprint', () => {
  assert.equal(contentFingerprint('A\nB'), contentFingerprint('A\r\nB'));
  assert.equal(contentFingerprint('ＡＢ'), contentFingerprint('AB'));
  assert.equal(contentFingerprint('  AB  '), contentFingerprint('AB'));
});

test('[fingerprint] 不同内容 → 不同 fingerprint', () => {
  assert.notEqual(contentFingerprint('AB'), contentFingerprint('AC'));
});

test('[chunkHash] 相同 chunk → 相同 hash；输出 64 位 lowercase hex', () => {
  const h1 = chunkHash(contentFingerprint('doc'), 0, 'chunk content');
  const h2 = chunkHash(contentFingerprint('doc'), 0, 'chunk content');
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/);
});

test('[chunkHash] 不同 chunkOrder → 不同 hash', () => {
  const f = contentFingerprint('doc');
  assert.notEqual(chunkHash(f, 0, 'chunk'), chunkHash(f, 1, 'chunk'));
});

test('[chunkHash] 不同 content → 不同 hash', () => {
  const f = contentFingerprint('doc');
  assert.notEqual(chunkHash(f, 0, 'chunkA'), chunkHash(f, 0, 'chunkB'));
});

test('[chunkHash] deterministic（跨调用稳定）', () => {
  const f = contentFingerprint('doc');
  const h1 = chunkHash(f, 3, 'content');
  const h2 = chunkHash(f, 3, 'content');
  assert.equal(h1, h2);
});

test('[chunkHash] 分隔符为固定常量且参与拼接', async () => {
  assert.equal(CHUNK_HASH_SEPARATOR, ':');
  const f = contentFingerprint('doc');
  const h = chunkHash(f, 0, 'x');
  // 与手动拼接 SHA-256 一致（间接证明拼接形式稳定）
  const { createHash } = await import('node:crypto');
  const manual = createHash('sha256').update(`${f}:0:x`, 'utf8').digest('hex');
  assert.equal(h, manual);
});
