/**
 * T5-A RAG-Lite —— 受控语料 ingest 脚本（**无 HTTP 入口**）
 *
 * 用法：
 *   node scripts/ingest-rag-corpus.mjs            # ingest 内置受控语料
 *   node scripts/ingest-rag-corpus.mjs <file.json> # ingest 指定语料文件
 *
 * 依据：ADR-016 §10 T5A-F-61/62 —— v1 不提供 ingest endpoint；
 * 语料经**受控脚本**一次性、可复现、可审计地入库，并写入 provenance（含入库时间与执行者）。
 *
 * 硬边界：
 *   - 只写 3 张 RAG 表；零 Capability / CapabilityEvidence / Evidence / CONFIRMED 写入；
 *   - 严禁用户私有数据（本脚本只读取显式给出的 JSON 语料文件）；
 *   - 幂等：重复执行不产生重复 Document / Chunk。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';

import { createPrismaRepositories } from '../src/db/repositories.ts';
import { ingestCorpus } from './rag-ingest-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(here, 'fixtures', 'rag-corpus.json');

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));

const prisma = new PrismaClient();
try {
  const repos = createPrismaRepositories(prisma);
  const result = await ingestCorpus(repos, corpus, 'jobpilot-controlled-ingest');

  console.log(`corpus file : ${corpusPath}`);
  console.log(`sources     : ${result.sources.length}`);
  for (const s of result.sources) console.log(`  - ${s.key} (${s.id})`);
  console.log(`documents   : ${result.documents.length}`);
  for (const d of result.documents) {
    console.log(`  - [${d.outcome}] ${d.sourceKey} / ${d.title}  chunks=${d.plannedChunkCount}  fp=${d.contentFingerprint.slice(0, 16)}`);
  }
  console.log('INGEST DONE');
} finally {
  await prisma.$disconnect();
}
