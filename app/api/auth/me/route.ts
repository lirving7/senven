import { buildAuthHandlerDeps } from '../../../../src/http/deps.ts';
import { createMeHandler, createUpdateMeHandler } from '../../../../src/http/handlers/auth.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return createMeHandler(buildAuthHandlerDeps())(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return createUpdateMeHandler(buildAuthHandlerDeps())(request);
}
