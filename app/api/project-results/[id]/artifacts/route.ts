import { buildProjectResultsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createAddProjectResultArtifactHandler } from '../../../../../src/http/handlers/project-results.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createAddProjectResultArtifactHandler(buildProjectResultsHandlerDeps())(request, id);
}
