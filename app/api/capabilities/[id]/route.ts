import { buildCapabilitiesHandlerDeps } from '../../../../src/http/deps.ts';
import { createGetCapabilityHandler } from '../../../../src/http/handlers/capabilities.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createGetCapabilityHandler(buildCapabilitiesHandlerDeps())(request, id);
}
