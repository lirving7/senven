import { buildPortfolioProjectsHandlerDeps } from '../../../../src/http/deps.ts';
import {
  createGetPortfolioProjectHandler,
  createUpdatePortfolioProjectHandler,
} from '../../../../src/http/handlers/portfolio-projects.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createGetPortfolioProjectHandler(buildPortfolioProjectsHandlerDeps())(request, id);
}

export async function PATCH(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createUpdatePortfolioProjectHandler(buildPortfolioProjectsHandlerDeps())(request, id);
}
