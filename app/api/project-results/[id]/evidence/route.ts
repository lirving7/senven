import { buildProjectResultsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createDeclareProjectEvidenceHandler } from '../../../../../src/http/handlers/project-results.ts';

export const runtime = 'nodejs';

/**
 * T3-A2-1：POST /api/project-results/:id/evidence
 * 由「已提交成果 + 可验证凭据」声明一项候选能力（UNCONFIRMED）。
 * 零 LLM；确认仍走唯一入口 POST /api/capabilities/:id/confirm。
 */
export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createDeclareProjectEvidenceHandler(buildProjectResultsHandlerDeps())(request, id);
}
