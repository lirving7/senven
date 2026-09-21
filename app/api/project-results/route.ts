import { buildProjectResultsHandlerDeps } from '../../../src/http/deps.ts';
import {
  createCreateProjectResultHandler,
  createListProjectResultsHandler,
} from '../../../src/http/handlers/project-results.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return createListProjectResultsHandler(buildProjectResultsHandlerDeps())(request);
}

export async function POST(request: Request): Promise<Response> {
  return createCreateProjectResultHandler(buildProjectResultsHandlerDeps())(request);
}
