import { buildSuggestionsHandlerDeps, requireSessionUser } from '../../../../src/http/deps.ts';
import { createResolveSuggestionHandler } from '../../../../src/http/handlers/suggestions.ts';

export const runtime = 'nodejs';

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await ctx.params;
  return createResolveSuggestionHandler(await buildSuggestionsHandlerDeps(auth.user))(request, id);
}
