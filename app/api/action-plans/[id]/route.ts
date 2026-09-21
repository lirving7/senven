import { buildActionPlansHandlerDeps, requireSessionUser } from '../../../../src/http/deps.ts';
import { createGetActionPlanHandler } from '../../../../src/http/handlers/action-plans.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await _ctx.params;
  return createGetActionPlanHandler(await buildActionPlansHandlerDeps(auth.user))(request, id);
}
