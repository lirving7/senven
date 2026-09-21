import { buildAuthHandlerDeps } from '../../../../src/http/deps.ts';
import { createLogoutHandler } from '../../../../src/http/handlers/auth.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return createLogoutHandler(buildAuthHandlerDeps())(request);
}
