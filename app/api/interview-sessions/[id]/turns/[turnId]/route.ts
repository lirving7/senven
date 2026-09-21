import { buildInterviewHandlerDeps, requireSessionUser } from '../../../../../../src/http/deps.ts';
import { createPatchInterviewTurnHandler } from '../../../../../../src/http/handlers/interview-sessions.ts';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  _ctx: { params: Promise<{ id: string; turnId: string }> },
): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id, turnId } = await _ctx.params;
  return createPatchInterviewTurnHandler(await buildInterviewHandlerDeps(auth.user))(request, id, turnId);
}
