import { buildLearningTasksHandlerDeps } from '../../../../../src/http/deps.ts';
import { createArchiveLearningTaskHandler } from '../../../../../src/http/handlers/learning-tasks.ts';

export const runtime = 'nodejs';

export async function POST(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createArchiveLearningTaskHandler(buildLearningTasksHandlerDeps())(request, id);
}
