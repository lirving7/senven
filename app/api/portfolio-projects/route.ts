import { buildPortfolioProjectsHandlerDeps } from '../../../src/http/deps.ts';
import {
  createCreatePortfolioProjectHandler,
  createListPortfolioProjectsHandler,
} from '../../../src/http/handlers/portfolio-projects.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return createListPortfolioProjectsHandler(buildPortfolioProjectsHandlerDeps())(request);
}

export async function POST(request: Request): Promise<Response> {
  return createCreatePortfolioProjectHandler(buildPortfolioProjectsHandlerDeps())(request);
}
