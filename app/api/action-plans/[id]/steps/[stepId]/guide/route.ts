import { buildProjectGuideHandlerDeps, requireSessionUser } from '../../../../../../../src/http/deps.ts';
import { createStepGuideHandler } from '../../../../../../../src/http/handlers/project-guide.ts';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; stepId: string }> },
): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id, stepId } = await ctx.params;
  return createStepGuideHandler(await buildProjectGuideHandlerDeps(auth.user))(request, id, stepId);
}
