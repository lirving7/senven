import { buildRagHandlerDeps } from '../../../../src/http/deps.ts';
import { createRagRetrieveHandler } from '../../../../src/http/handlers/rag-retrieval.ts';

export const runtime = 'nodejs';

/** T5-A：`POST /api/rag/retrieve`（唯一检索 endpoint；只读、LLM-free、零持久化） */
export async function POST(request: Request): Promise<Response> {
  return createRagRetrieveHandler(buildRagHandlerDeps())(request);
}
