import { buildPortfolioProjectsHandlerDeps } from '../../../../../../src/http/deps.ts';
import { createRemovePortfolioProjectResultHandler } from '../../../../../../src/http/handlers/portfolio-projects.ts';

export const runtime = 'nodejs';

export async function DELETE(
  request: Request,
  _ctx: { params: Promise<{ id: string; resultId: string }> },
): Promise<Response> {
  const { id, resultId } = await _ctx.params;
  return createRemovePortfolioProjectResultHandler(buildPortfolioProjectsHandlerDeps())(request, id, resultId);
}
