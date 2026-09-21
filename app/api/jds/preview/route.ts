import { buildJdsHandlerDeps, requireSessionUser } from '../../../../src/http/deps.ts';
import { createPreviewJdHandler } from '../../../../src/http/handlers/jds.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createPreviewJdHandler(await buildJdsHandlerDeps(auth.user))(request);
}
