import { buildProjectResultsHandlerDeps } from '../../../../../../src/http/deps.ts';
import { createRemoveProjectResultArtifactHandler } from '../../../../../../src/http/handlers/project-results.ts';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  _ctx: { params: Promise<{ id: string; artifactId: string }> },
): Promise<Response> {
  const { id, artifactId } = await _ctx.params;
  return createRemoveProjectResultArtifactHandler(buildProjectResultsHandlerDeps())(request, id, artifactId);
}
