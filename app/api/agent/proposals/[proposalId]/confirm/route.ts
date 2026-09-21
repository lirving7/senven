import { buildAgentActionsHandlerDeps } from '../../../../../../src/http/deps.ts';
import { createConfirmActHandler } from '../../../../../../src/http/handlers/agent-actions.ts';

export const runtime = 'nodejs';

/** T6-4-A：POST /api/agent/proposals/:proposalId/confirm —— PROPOSED → CONFIRMED（幂等；userId 仅会话） */
export async function POST(request: Request, ctx: { params: Promise<{ proposalId: string }> }): Promise<Response> {
  const { proposalId } = await ctx.params;
  return createConfirmActHandler(buildAgentActionsHandlerDeps())(request, proposalId);
}
