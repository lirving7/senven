import { buildCareerGoalsHandlerDeps } from '../../../../src/http/deps.ts';
import { createGetCareerGoalHandler, createPatchCareerGoalHandler } from '../../../../src/http/handlers/career-goals.ts';

export const runtime = 'nodejs';

/** T6-1：`GET /api/career-goals/:id`（仅 GET；跨用户一律 404，无 oracle） */
export async function GET(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createGetCareerGoalHandler(buildCareerGoalsHandlerDeps())(request, id);
}

/** T6-1：`PATCH /api/career-goals/:id`（仅 PATCH；replace-set jdIds；拒绝 isCurrent） */
export async function PATCH(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createPatchCareerGoalHandler(buildCareerGoalsHandlerDeps())(request, id);
}
