import { buildResumeReadHandlerDeps } from '../../../../src/http/deps.ts';
import { createGetResumeHandler } from '../../../../src/http/handlers/resume-read.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createGetResumeHandler(buildResumeReadHandlerDeps())(request, id);
}
