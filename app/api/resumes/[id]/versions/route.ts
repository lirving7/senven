import { buildResumeVersionsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createCreateVersionHandler, createListVersionsHandler } from '../../../../../src/http/handlers/resume-versions.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createCreateVersionHandler(buildResumeVersionsHandlerDeps())(request, id);
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createListVersionsHandler(buildResumeVersionsHandlerDeps())(request, id);
}
