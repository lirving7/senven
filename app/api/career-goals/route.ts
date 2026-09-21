import { buildCareerGoalsHandlerDeps } from '../../../src/http/deps.ts';
import { createCreateCareerGoalHandler, createListCareerGoalsHandler } from '../../../src/http/handlers/career-goals.ts';

export const runtime = 'nodejs';

/** T6-1：`POST /api/career-goals`（仅 POST；userId 只来自 session，body strict） */
export async function POST(request: Request): Promise<Response> {
  return createCreateCareerGoalHandler(buildCareerGoalsHandlerDeps())(request);
}

/** T6-1：`GET /api/career-goals`（仅 GET；支持 ?status= / ?current=true） */
export async function GET(request: Request): Promise<Response> {
  return createListCareerGoalsHandler(buildCareerGoalsHandlerDeps())(request);
}
