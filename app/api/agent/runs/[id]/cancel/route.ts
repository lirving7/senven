import { buildAgentRunsHandlerDeps, requireSessionUser } from '../../../../../../src/http/deps.ts';
import { createCancelAgentRunHandler } from '../../../../../../src/http/handlers/agent-runs.ts';

export const runtime = 'nodejs';

/** T5-B-2C：`POST /api/agent/runs/:id/cancel`（仅 POST；状态冲突 → 409，跨用户 → 404） */
export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await _ctx.params;
  return createCancelAgentRunHandler(await buildAgentRunsHandlerDeps(auth.user))(request, id);
}
