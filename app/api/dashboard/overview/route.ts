import { buildDashboardHandlerDeps } from '../../../../src/http/deps.ts';
import { createGetDashboardOverviewHandler } from '../../../../src/http/handlers/dashboard.ts';

export const runtime = 'nodejs';

/** T6-3-C：Dashboard 唯一核心聚合接口（GET /api/dashboard/overview；纯 FACT，零 LLM） */
export async function GET(request: Request): Promise<Response> {
  return createGetDashboardOverviewHandler(buildDashboardHandlerDeps())(request);
}
