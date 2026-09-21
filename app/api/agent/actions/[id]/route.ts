import { buildAgentActionsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createGetActActionHandler } from '../../../../../src/http/handlers/agent-actions.ts';

export const runtime = 'nodejs';

/** T6-4-A：GET /api/agent/actions/:id —— 查询执行状态与 Result（userId 仅会话） */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createGetActActionHandler(buildAgentActionsHandlerDeps())(request, id);
}
