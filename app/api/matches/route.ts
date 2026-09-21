import { buildMatchesHandlerDeps, requireSessionUser } from '../../../src/http/deps.ts';
import { createCreateMatchHandler } from '../../../src/http/handlers/matches.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createCreateMatchHandler(await buildMatchesHandlerDeps(auth.user))(request);
}
