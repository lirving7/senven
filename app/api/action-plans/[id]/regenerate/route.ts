import { buildActionPlansHandlerDeps, requireSessionUser } from '../../../../../src/http/deps.ts';
import { createRegenerateActionPlanHandler } from '../../../../../src/http/handlers/action-plans.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await ctx.params;
  return createRegenerateActionPlanHandler(await buildActionPlansHandlerDeps(auth.user))(request, id);
}
