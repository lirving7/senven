import { buildActionPlansHandlerDeps, requireSessionUser } from '../../../../../../src/http/deps.ts';
import { createUpdateActionStepHandler } from '../../../../../../src/http/handlers/action-plans.ts';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; stepId: string }> },
): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id, stepId } = await ctx.params;
  return createUpdateActionStepHandler(await buildActionPlansHandlerDeps(auth.user))(request, id, stepId);
}
