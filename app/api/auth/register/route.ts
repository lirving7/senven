import { buildAuthHandlerDeps } from '../../../../src/http/deps.ts';
import { createRegisterHandler } from '../../../../src/http/handlers/auth.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return createRegisterHandler(buildAuthHandlerDeps())(request);
}
