import { buildProjectAiAnalysisHandlerDeps, requireSessionUser } from '../../../../../src/http/deps.ts';
import { createAnalyzeProjectResultHandler } from '../../../../../src/http/handlers/project-ai-analysis.ts';

export const runtime = 'nodejs';

/**
 * T3-A2-2：POST /api/project-results/:id/analyze
 * 用户显式触发的项目成果 AI 分析（feature=PROJECT_MENTOR，配额 10/日）。
 *
 * 安全边界：**零数据库写入**。仅返回候选建议；
 * 用户采纳后仍必须走 A2-1：POST /api/project-results/:id/evidence。
 * 使用独立 deps：含 provider，但不含任何 Capability / Skill 写权限。
 */
export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await requireSessionUser(request);
  if ('response' in auth) return auth.response;
  const { id } = await _ctx.params;
  return createAnalyzeProjectResultHandler(await buildProjectAiAnalysisHandlerDeps(auth.user))(request, id);
}
