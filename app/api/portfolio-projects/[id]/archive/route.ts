import { buildPortfolioProjectsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createArchivePortfolioProjectHandler } from '../../../../../src/http/handlers/portfolio-projects.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createArchivePortfolioProjectHandler(buildPortfolioProjectsHandlerDeps())(request, id);
}
