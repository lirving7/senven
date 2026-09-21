import { buildAuthHandlerDeps } from '../../../../src/http/deps.ts';
import { createLoginHandler } from '../../../../src/http/handlers/auth.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return createLoginHandler(buildAuthHandlerDeps())(request);
}
