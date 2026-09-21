import { buildCapabilitiesHandlerDeps } from '../../../src/http/deps.ts';
import { createListCapabilitiesHandler } from '../../../src/http/handlers/capabilities.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return createListCapabilitiesHandler(buildCapabilitiesHandlerDeps())(request);
}
