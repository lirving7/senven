import { buildInterviewHandlerDeps, requireSessionUser } from '../../../../../src/http/deps.ts';
import { createEndInterviewSessionHandler } from '../../../../../src/http/handlers/interview-sessions.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await _ctx.params;
  return createEndInterviewSessionHandler(await buildInterviewHandlerDeps(auth.user))(request, id);
}
