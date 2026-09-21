import { buildResumeReadHandlerDeps, buildResumesHandlerDeps, requireSessionUser } from '../../../src/http/deps.ts';
import { createCreateResumeHandler } from '../../../src/http/handlers/resumes.ts';
import { createListResumesHandler } from '../../../src/http/handlers/resume-read.ts';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createCreateResumeHandler(await buildResumesHandlerDeps(auth.user))(request);
}

export async function GET(request: Request): Promise<Response> {
  return createListResumesHandler(buildResumeReadHandlerDeps())(request);
}
