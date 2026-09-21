import { buildInterviewHandlerDeps, requireSessionUser } from '../../../src/http/deps.ts';
import {
  createCreateInterviewSessionHandler,
  createListInterviewSessionsHandler,
} from '../../../src/http/handlers/interview-sessions.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createListInterviewSessionsHandler(await buildInterviewHandlerDeps(auth.user))(request);
}

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createCreateInterviewSessionHandler(await buildInterviewHandlerDeps(auth.user))(request);
}
