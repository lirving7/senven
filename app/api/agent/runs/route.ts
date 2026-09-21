import { buildAgentRunsHandlerDeps, requireSessionUser } from '../../../../src/http/deps.ts';
import { createCreateAgentRunHandler } from '../../../../src/http/handlers/agent-runs.ts';

export const runtime = 'nodejs';

/** T5-B-2C：`POST /api/agent/runs`（仅 POST；白名单由 agent-guards / agent-tool-guards 机械断言） */
export async function POST(request: Request): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  return createCreateAgentRunHandler(await buildAgentRunsHandlerDeps(auth.user))(request);
}
