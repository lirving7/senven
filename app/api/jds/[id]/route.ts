import { buildJdListHandlerDeps, buildJdsHandlerDeps, requireSessionUser } from '../../../../src/http/deps.ts';
import { createGetJdHandler, createUpdateJdTitleHandler } from '../../../../src/http/handlers/jds.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await ctx.params;
  return createGetJdHandler(await buildJdsHandlerDeps(auth.user))(request, id);
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  // 改标题不消耗 provider：使用与 GET 列表相同的零 provider 装配点
  return createUpdateJdTitleHandler(buildJdListHandlerDeps())(request, id);
}
