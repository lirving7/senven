import { buildActionPlansHandlerDeps, requireSessionUser } from '../../../src/http/deps.ts';
import {
  createCreateActionPlanHandler,
  createListActionPlansHandler,
} from '../../../src/http/handlers/action-plans.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createListActionPlansHandler(await buildActionPlansHandlerDeps(auth.user))(request);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createCreateActionPlanHandler(await buildActionPlansHandlerDeps(auth.user))(request);
}
