/**
 * T5-A RAG-Lite —— 受控 ingest 共享库（**仅脚本 / fixture 使用**）
 *
 * 依据：ADR-016 §10（T5A-F-61 ~ T5A-F-65）。
 *   - v1 **无 HTTP ingest**；语料只能经受控脚本 / QA fixture 入库；
 *   - `provenance` required，必须表达 来源 / 许可 / 版本 / 入库时间 / 执行者（T5A-F-14 / §20）；
 *   - `(sourceId, contentFingerprint)` 幂等（T5A-F-63）；内容变化 → 新 Document + 旧行停用（T5A-F-17）；
 *   - 事务性：整体成功或整体回滚（T5A-F-64）。
 *
 * 本库**不重新实现**切片 / 分词 / 指纹逻辑：一律复用 `src/domain/rag/*`（唯一实现，T5A-F-36）。
 */
import { CHUNKER_VERSION, TOKENIZER_VERSION } from '../src/domain/rag/contract.ts';
import { planDocumentIngest } from '../src/domain/rag/ingest-plan.ts';

/** chunk 级元数据（记录切片/分词版本，便于审计；不参与检索排序） */
export function chunkMetadata() {
  return { chunker: CHUNKER_VERSION, tokenizer: TOKENIZER_VERSION };
}

/** 组装 required provenance（ADR-016 §3.1 / §20） */
export function buildProvenance(source, ingestedBy = 'jobpilot-controlled-ingest') {
  return {
    origin: source.origin,
    uri: source.uri,
    license: source.license,
    version: source.version ?? 'v1',
    checksum: source.checksum ?? null,
    ingestedBy,
    ingestedAt: new Date().toISOString(),
  };
}

/** 幂等注册 / 更新 source；返回 [{ key, id }] */
export async function upsertSources(repos, sources, ingestedBy) {
  const out = [];
  for (const s of sources) {
    const r = await repos.knowledgeIngest.upsertSource({
      key: s.key,
      title: s.title,
      sourceType: s.sourceType,
      description: s.description ?? null,
      provenance: buildProvenance(s, ingestedBy),
    });
    out.push({ key: s.key, id: r.id });
  }
  return out;
}

/** 幂等 ingest 文档；返回逐篇结果（含 outcome: CREATED / DUPLICATE） */
export async function ingestDocuments(repos, documents) {
  const out = [];
  for (const d of documents) {
    const plan = planDocumentIngest(d.content);
    const outcome = await repos.knowledgeIngest.ingestDocument({
      sourceKey: d.sourceKey,
      title: d.title,
      content: d.content,
      contentFingerprint: plan.contentFingerprint,
      language: d.language ?? 'zh',
      chunks: plan.chunks.map((c) => ({
        chunkOrder: c.chunkOrder,
        content: c.content,
        searchText: c.searchText,
        chunkHash: c.chunkHash,
        metadata: chunkMetadata(),
      })),
    });
    out.push({
      sourceKey: d.sourceKey,
      title: d.title,
      contentFingerprint: plan.contentFingerprint,
      plannedChunkCount: plan.chunks.length,
      outcome: outcome.kind,
      documentId: 'documentId' in outcome ? outcome.documentId : null,
    });
  }
  return out;
}

/** 一次性 ingest（source upsert + document ingest） */
export async function ingestCorpus(repos, corpus, ingestedBy) {
  const sources = await upsertSources(repos, corpus.sources, ingestedBy);
  const documents = await ingestDocuments(repos, corpus.documents);
  return { sources, documents };
}
