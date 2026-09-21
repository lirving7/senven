/**
 * T5-A Phase 2 —— RAG 隔离 / 注入 / 事实权威 守卫（**源码扫描，无 DB**）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md`（ADR-016）
 *   - §13 T5A-F-75/76：Frozen Zone 全只读、零反向关系；
 *   - §14 T5A-F-79：检索路径零引用任何用户表；
 *   - §12 T5A-F-71/72/73：不新增 EvidenceSource / CapabilityEvidence.type / CONFIRMED 写入点；
 *   - §9 T5A-F-56/57：**恰好 2 个** RAG endpoint；
 *   - §10 T5A-F-02：LLM-free（Provider call count = 0）；
 *   - §15 T5A-F-83/84：Migration #13 不得含 `CREATE EXTENSION`。
 *
 * 本文件只做**机械断言**，不依赖数据库；动态行为（enabled 门控、poisoned knowledge 零写入）
 * 由 `scripts/qa-t5a-rag.mjs` 的真实 HTTP QA 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function strip(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function read(rel: string): string {
  return strip(readFileSync(path.join(process.cwd(), rel), 'utf8'));
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next') continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walkTs(rel, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** RAG 生产实现的全部源码文件（domain + handler + routes） */
const RAG_FILES = [
  'src/domain/rag/contract.ts',
  'src/domain/rag/tokenizer.ts',
  'src/domain/rag/chunker.ts',
  'src/domain/rag/fingerprint.ts',
  'src/domain/rag/retrieval.ts',
  'src/domain/rag/ingest-plan.ts',
  'src/http/handlers/rag-retrieval.ts',
  'app/api/rag/retrieve/route.ts',
  'app/api/rag/sources/route.ts',
];

/** 冻结事实层 / 用户私有数据标识（检索路径绝不允许出现） */
const FORBIDDEN_FACT_SYMBOLS = [
  'Capability',
  'CapabilityEvidence',
  'EvidenceSource',
  'ProjectResult',
  'ResultArtifact',
  'LearningTask',
  'ActionPlan',
  'ActionStep',
  'ResumeVersion',
  'PortfolioProject',
  'InterviewSession',
  'InterviewTurn',
  'FactFlag',
  'verifyClaim',
  'CONFIRMED',
];

test('[§14] 检索路径零引用任何用户表 / Frozen Zone 标识', () => {
  for (const rel of RAG_FILES) {
    const code = read(rel);
    for (const forbidden of FORBIDDEN_FACT_SYMBOLS) {
      assert.equal(
        code.includes(forbidden),
        false,
        `${rel} 不得引用冻结事实层标识 ${forbidden}`,
      );
    }
  }
});

test('[§14/§10] 检索路径 LLM-free：零 provider / 零 LLM 槽位 / 零 quota / 零 usage', () => {
  for (const rel of RAG_FILES) {
    const code = read(rel);
    for (const forbidden of [
      'providerFromEnv',
      'LLM_FEATURE',
      'llmUsage',
      'LlmUsage',
      'llmCounter',
      'quota',
      'openai',
    ]) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得引用 ${forbidden}`);
    }
  }
});

test('[§10] RAG deps 装配点不含 provider（Provider call count = 0）', () => {
  const code = read('src/http/deps.ts');
  const start = code.indexOf('export function buildRagHandlerDeps');
  assert.ok(start >= 0, 'buildRagHandlerDeps 必须存在');
  const fn = code.slice(start, code.indexOf('}', code.indexOf('return {', start)) + 1);
  for (const forbidden of ['provider', 'llmUsage', 'llmCounter', 'capabilities', 'skills']) {
    assert.equal(fn.includes(forbidden), false, `buildRagHandlerDeps 不得包含 ${forbidden}`);
  }
});

test('[§14] 检索仓储（ragRetrieval）只 JOIN 3 张 RAG 表，且不用 SELECT *', () => {
  const code = read('src/db/repositories.ts');
  const start = code.indexOf('const ragRetrieval: RagRetrievalRepository = {');
  const end = code.indexOf('const knowledgeIngest: KnowledgeIngestRepository = {');
  assert.ok(start >= 0 && end > start, '必须能定位 ragRetrieval 实现块');
  const block = code.slice(start, end);

  // JOIN 目标必须 ⊆ {KnowledgeChunk, KnowledgeDocument, KnowledgeSource}
  const joins = [...block.matchAll(/JOIN\s+"([A-Za-z]+)"/g)].map((m) => m[1]);
  const allowed = new Set(['KnowledgeChunk', 'KnowledgeDocument', 'KnowledgeSource']);
  for (const j of joins) {
    assert.ok(allowed.has(j), `ragRetrieval 不得 JOIN 非 RAG 表：${j}`);
  }
  assert.ok(joins.length >= 2, 'ragRetrieval 应显式 JOIN KnowledgeDocument / KnowledgeSource');

  // Unsupported("tsvector") 保护：不得 SELECT *
  assert.equal(/SELECT\s+\*/i.test(block), false, 'ragRetrieval 不得使用 SELECT *（会触碰 searchVector）');
  assert.equal(/RETURNING\s+\*/i.test(block), false, 'ragRetrieval 不得使用 RETURNING *');
});

test('[§15] 受控 ingest 块不写任何事实层 / 不新增 CONFIRMED 写入点', () => {
  const code = read('src/db/repositories.ts');
  const start = code.indexOf('const knowledgeIngest: KnowledgeIngestRepository = {');
  const end = code.indexOf('return {', start);
  assert.ok(start >= 0 && end > start, '必须能定位 knowledgeIngest 实现块');
  const block = code.slice(start, end);
  for (const forbidden of ['Capability', 'CapabilityEvidence', 'Evidence', 'CONFIRMED', 'verifyClaim']) {
    assert.equal(block.includes(forbidden), false, `knowledgeIngest 不得写入 ${forbidden}`);
  }
});

test('[§9] 恰好 2 个 RAG endpoint（method + path 白名单）', () => {
  const files: string[] = [];
  const walk = (cur: string) => {
    for (const e of readdirSync(path.join(process.cwd(), cur), { withFileTypes: true })) {
      const rel = `${cur}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name === 'route.ts') files.push(rel);
    }
  };
  walk('app/api/rag');
  assert.deepEqual(files.sort(), [
    'app/api/rag/retrieve/route.ts',
    'app/api/rag/sources/route.ts',
  ]);

  const methods = (rel: string): string[] => {
    const re = /export\s+async\s+function\s+(GET|POST|PATCH|PUT|DELETE|HEAD|OPTIONS)\b/g;
    const out: string[] = [];
    let m: RegExpExecArray | null;
    const src = read(rel);
    while ((m = re.exec(src)) !== null) out.push(m[1]);
    return out.sort();
  };
  assert.deepEqual(methods('app/api/rag/retrieve/route.ts'), ['POST']);
  assert.deepEqual(methods('app/api/rag/sources/route.ts'), ['GET']);
});

test('[§3.1] KnowledgeSource 不得有 userId（公共/受控语料，T5A-F-12）', () => {
  const schema = readFileSync(path.join(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const start = schema.indexOf('model KnowledgeSource');
  const end = schema.indexOf('model KnowledgeDocument');
  assert.ok(start >= 0 && end > start);
  const block = schema.slice(start, end);
  assert.equal(/userId/.test(block), false, 'KnowledgeSource 不得出现 userId');
  // provenance 必须 required（非 nullable）
  assert.ok(/provenance\s+Json\b/.test(block), 'provenance 必须为 required Json');
  assert.equal(/provenance\s+Json\?/.test(block), false, 'provenance 不得为 nullable');
  // 无 Prisma enum：sourceType 为 String + CHECK
  assert.ok(/sourceType\s+String\b/.test(block), 'sourceType 必须为 String + CHECK');
});

test('[§15] Migration #13 不得含 CREATE EXTENSION / pgvector / pg_trgm / zhparser；migration 基线 18', () => {
  const migDir = path.join(process.cwd(), 'prisma/migrations');
  const dirs = readdirSync(migDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  // 伴生基线：T5-A 13 → #14 Agent / #15 CareerGoal / #16 ApplicationTracker（T5A-F-88 口径）
  // #18 = 20260920210000_user_avatar_url（2026-09-20 授权：自定义头像上传）
  // #19 = 20260921000000_user_llm_api_key（2026-09-21 授权：用户自带 LLM API Key）
  assert.equal(dirs.length, 19, `migration 基线必须为 19（新增 #19 用户 LLM API Key），实际 ${dirs.length}`);
  assert.ok(
    dirs.includes('20260919000100_rag_knowledge_base'),
    'Migration #13 目录必须存在且未被改名',
  );
  assert.equal(/^20260919000100_rag_knowledge_base$/.test(dirs[12]), true, 'RAG Migration 必须仍是第 13 条');
  assert.equal(/^20260919025710_agent_domain_persistence$/.test(dirs[13]), true, 'Migration #14 必须仍是第 14 条');
  assert.equal(/^20260919151000_career_goal$/.test(dirs[14]), true, 'Migration #15（CareerGoal）必须仍是第 15 条');
  assert.equal(/^20260919170000_application_tracker$/.test(dirs[15]), true, 'Migration #16（Application Tracker）必须是第 16 条');
  assert.equal(/^20260920010000_agent_act$/.test(dirs[16]), true, 'Migration #17（Agent Act）必须是第 17 条');
  assert.equal(
    /^20260920210000_user_avatar_url$/.test(dirs[17]),
    true,
    'Migration #18（User.avatarUrl）必须是最后一条',
  );

  const sql = readFileSync(path.join(migDir, dirs[12], 'migration.sql'), 'utf8');
  assert.equal(/CREATE\s+EXTENSION/i.test(sql), false, 'Migration #13 不得 CREATE EXTENSION');
  for (const banned of ['pgvector', 'pg_trgm', 'zhparser', 'ivfflat', 'hnsw', 'embedding']) {
    assert.equal(new RegExp(banned, 'i').test(sql), false, `Migration #13 不得出现 ${banned}`);
  }
  assert.ok(/USING\s+GIN/i.test(sql), 'Migration #13 必须有 GIN 索引');
  assert.ok(/searchVector.*GENERATED ALWAYS AS/s.test(sql), 'Migration #13 必须有生成列');
  assert.ok(/KnowledgeSource_sourceType_check/.test(sql), 'Migration #13 必须有 sourceType CHECK');
});

test('[§17] RAG 域模块不得反向依赖 HTTP / DB / 端口层（保持纯函数）', () => {
  const dir = 'src/domain/rag';
  for (const rel of walkTs(dir)) {
    const code = read(rel);
    for (const forbidden of ['../../db/', '../../http/', '../../ports/', '@prisma/client']) {
      assert.equal(code.includes(forbidden), false, `${rel} 不得依赖 ${forbidden}`);
    }
  }
});
