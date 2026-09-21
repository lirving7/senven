import { buildRagHandlerDeps } from '../../../../src/http/deps.ts';
import { createRagSourcesHandler } from '../../../../src/http/handlers/rag-retrieval.ts';

export const runtime = 'nodejs';

/** T5-A：`GET /api/rag/sources`（仅 enabled；最小字段；不暴露 provenance） */
export async function GET(request: Request): Promise<Response> {
  return createRagSourcesHandler(buildRagHandlerDeps())(request);
}
