import { buildProjectResultsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createSubmitProjectResultHandler } from '../../../../../src/http/handlers/project-results.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createSubmitProjectResultHandler(buildProjectResultsHandlerDeps())(request, id);
}
