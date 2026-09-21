import { buildMatchesHandlerDeps, requireSessionUser } from '../../../../src/http/deps.ts';
import { createGetMatchHandler } from '../../../../src/http/handlers/matches.ts';

export const runtime = 'nodejs';

/** V1 修订 P1：GET /api/matches/:id —— 已持久化 Match 结果只读回看（userId 仅来自会话） */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await ctx.params;
  return createGetMatchHandler(await buildMatchesHandlerDeps(auth.user))(request, id);
}
