import { buildAgentActionsHandlerDeps } from '../../../../../../src/http/deps.ts';
import { createExecuteActHandler } from '../../../../../../src/http/handlers/agent-actions.ts';

export const runtime = 'nodejs';

/** T6-4-A：POST /api/agent/actions/:id/execute —— CONFIRMED → EXECUTING → SUCCEEDED/FAILED（幂等；userId 仅会话） */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createExecuteActHandler(buildAgentActionsHandlerDeps())(request, id);
}
