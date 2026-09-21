import { buildApplicationsHandlerDeps } from '../../../../src/http/deps.ts';
import { createGetApplicationDetailHandler, createUpdateApplicationHandler } from '../../../../src/http/handlers/applications.ts';

export const runtime = 'nodejs';

/** T6-2：`GET /api/applications/:id` 详情（ownership；跨用户 404 无 oracle） */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createGetApplicationDetailHandler(buildApplicationsHandlerDeps())(request, id);
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  return createUpdateApplicationHandler(buildApplicationsHandlerDeps())(request, id);
}
