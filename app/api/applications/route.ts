import { buildApplicationsHandlerDeps } from '../../../src/http/deps.ts';
import {
  createCreateApplicationHandler,
  createListApplicationsHandler,
} from '../../../src/http/handlers/applications.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return createListApplicationsHandler(buildApplicationsHandlerDeps())(request);
}

export async function POST(request: Request): Promise<Response> {
  return createCreateApplicationHandler(buildApplicationsHandlerDeps())(request);
}
