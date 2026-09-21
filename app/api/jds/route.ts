import { buildJdListHandlerDeps, buildJdsHandlerDeps, requireSessionUser } from '../../../src/http/deps.ts';
import { createCreateJdHandler, createListJdsHandler } from '../../../src/http/handlers/jds.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createCreateJdHandler(await buildJdsHandlerDeps(auth.user))(request);
}

export async function GET(request: Request): Promise<Response> {
  return createListJdsHandler(buildJdListHandlerDeps())(request);
}
