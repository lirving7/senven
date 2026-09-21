import { buildCareerGoalsHandlerDeps } from '../../../../../src/http/deps.ts';
import { createSetCurrentCareerGoalHandler } from '../../../../../src/http/handlers/career-goals.ts';

export const runtime = 'nodejs';

/** T6-1：`POST /api/career-goals/:id/current`（仅 POST；单事务切换；幂等；409 可重试） */
export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createSetCurrentCareerGoalHandler(buildCareerGoalsHandlerDeps())(request, id);
}
