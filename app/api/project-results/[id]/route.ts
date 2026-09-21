import { buildProjectResultsHandlerDeps } from '../../../../src/http/deps.ts';
import { createGetProjectResultHandler } from '../../../../src/http/handlers/project-results.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createGetProjectResultHandler(buildProjectResultsHandlerDeps())(request, id);
}
