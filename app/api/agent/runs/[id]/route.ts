import { buildAgentRunsHandlerDeps, requireSessionUser } from '../../../../../src/http/deps.ts';
import { createGetAgentRunHandler } from '../../../../../src/http/handlers/agent-runs.ts';

export const runtime = 'nodejs';

/** T5-B-2C：`GET /api/agent/runs/:id`（仅 GET；跨用户一律 404，无 oracle） */
export async function GET(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await _ctx.params;
  return createGetAgentRunHandler(await buildAgentRunsHandlerDeps(auth.user))(request, id);
}
