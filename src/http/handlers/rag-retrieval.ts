/**
 * T5-A RAG-Lite —— HTTP handlers（`POST /api/rag/retrieve`、`GET /api/rag/sources`）
 *
 * 依据：`JobPilot_ADR_T5-A_RAG_Freeze.md`（ADR-016）§8 / §9。
 *
 * 硬边界：
 *   - 两个 endpoint 均**必须认证**；未登录 → 401 `UNAUTHENTICATED`（T5A-F-78）；
 *   - **LLM-free**：本文件不 import provider / quota，不产生任何 LLM 调用（T5A-F-02 / §14）；
 *   - **零持久化**：不写库、不记录 query / result 历史（T5A-F-49）；
 *   - **日志纪律**：不得输出完整 query 或 chunk content（T5A-F-70）——本层不记录二者；
 *   - `GET /sources` 只返回 enabled 的 source 且**不暴露 provenance**（T5A-F-58）；
 *   - 检索输出**不是事实权威**：不写 Capability / CapabilityEvidence / Evidence / CONFIRMED（T5A-F-74）。
 */

import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { RagRetrievalRepository } from '../../ports/index.ts';
import {
  RETRIEVAL_CONTRACT,
  RETRIEVAL_DEFAULT_LIMIT,
  RETRIEVAL_MAX_LIMIT,
  RETRIEVAL_MIN_LIMIT,
  RETRIEVAL_QUERY_MAX_CHARS,
  RETRIEVAL_SEMANTIC_VERSIONS,
  buildQuerySearchText,
  truncateContent,
} from '../../domain/rag/retrieval.ts';

/**
 * ⚠️ 刻意**不含** provider / llmUsage / quota —— RAG 检索 Provider call count = 0（T5A-F-02）。
 * 亦不含任何事实层写仓储（T5A-F-54 / T5A-F-75）。
 */
export type RagHandlerDeps = {
  auth: AuthService;
  rag: RagRetrievalRepository;
};

async function requireUser(deps: RagHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/**
 * 输入契约（T5A-F-46）：
 *   - `query`：trim 后 1–200 字符；空 / 纯空白 → 400 VALIDATION_FAILED；
 *   - `limit`：int，1..20，默认 5；越界 → 400；
 *   - **v1 无 filters**：unknown keys 一律拒绝（`.strict()`）。
 */
const RetrieveBodySchema = z
  .object({
    query: z.string(),
    limit: z.number().int().min(RETRIEVAL_MIN_LIMIT).max(RETRIEVAL_MAX_LIMIT).optional(),
  })
  .strict();

/**
 * `POST /api/rag/retrieve`
 * 空结果 → 200 + `items: []`（T5A-F-50）；不落库、不调 LLM、不消耗 quota。
 */
export function createRagRetrieveHandler(deps: RagHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      await requireUser(deps, request);
      const body = RetrieveBodySchema.parse(await readJson(request));

      const trimmed = body.query.trim();
      if (trimmed.length < 1 || trimmed.length > RETRIEVAL_QUERY_MAX_CHARS) {
        throw appError(
          ERROR_CODE.VALIDATION_FAILED,
          `query 长度必须为 1–${RETRIEVAL_QUERY_MAX_CHARS} 字符`,
        );
      }

      const limit = body.limit ?? RETRIEVAL_DEFAULT_LIMIT;
      const { hits, total } = await deps.rag.retrieve({
        searchText: buildQuerySearchText(body.query),
        limit,
      });

      const items = hits.map((hit, index) => {
        const { content, truncated } = truncateContent(hit.content);
        return {
          chunkId: hit.chunkId,
          documentId: hit.documentId,
          sourceId: hit.sourceId,
          sourceKey: hit.sourceKey,
          sourceType: hit.sourceType,
          title: hit.title,
          content,
          // FROZEN：snippet 与 content 完全相同（T5A-F-48）
          snippet: content,
          truncated,
          rank: hit.rank,
          ordinal: index + 1,
        };
      });

      return jsonResponse(200, {
        data: {
          contract: RETRIEVAL_CONTRACT,
          tokenizer: RETRIEVAL_SEMANTIC_VERSIONS.tokenizer,
          chunker: RETRIEVAL_SEMANTIC_VERSIONS.chunker,
          fts: RETRIEVAL_SEMANTIC_VERSIONS.fts,
          // 原样回显（T5A-F-47）
          query: body.query,
          items,
          total,
          returned: items.length,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * `GET /api/rag/sources`
 * 仅返回 `enabled = true` 的 source；最小字段 `key/title/sourceType/enabled`；
 * **不暴露 provenance**（T5A-F-58）。
 */
export function createRagSourcesHandler(deps: RagHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      await requireUser(deps, request);
      const items = await deps.rag.listEnabledSources();
      return jsonResponse(200, { data: { items } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
