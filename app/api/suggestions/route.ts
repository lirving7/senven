import { buildSuggestionsHandlerDeps, requireSessionUser } from '../../../src/http/deps.ts';
import { createGenerateSuggestionsHandler } from '../../../src/http/handlers/suggestions.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createGenerateSuggestionsHandler(await buildSuggestionsHandlerDeps(auth.user))(request);
}
