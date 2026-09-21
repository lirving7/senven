import { buildResumeVersionsHandlerDeps } from '../../../../../../../src/http/deps.ts';
import { createDownloadVersionPdfHandler } from '../../../../../../../src/http/handlers/resume-versions.ts';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string; versionId: string }> },
): Promise<Response> {
  const { id, versionId } = await ctx.params;
  return createDownloadVersionPdfHandler(buildResumeVersionsHandlerDeps())(request, id, versionId);
}
