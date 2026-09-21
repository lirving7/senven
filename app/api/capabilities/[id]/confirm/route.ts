import { buildCapabilitiesHandlerDeps } from '../../../../../src/http/deps.ts';
import { createConfirmCapabilityHandler } from '../../../../../src/http/handlers/capabilities.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createConfirmCapabilityHandler(buildCapabilitiesHandlerDeps())(request, id);
}
