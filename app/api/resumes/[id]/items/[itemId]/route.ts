import { buildResumeItemsHandlerDeps } from '../../../../../../src/http/deps.ts';
import { createConfirmItemHandler } from '../../../../../../src/http/handlers/resume-items.ts';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  ctx: { params: Promise<{ id: string; itemId: string }> },
): Promise<Response> {
  const { id, itemId } = await ctx.params;
  return createConfirmItemHandler(buildResumeItemsHandlerDeps())(request, id, itemId);
}
