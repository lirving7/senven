import { buildLearningTasksHandlerDeps } from '../../../../src/http/deps.ts';
import {
  createGetLearningTaskHandler,
  createUpdateLearningTaskHandler,
} from '../../../../src/http/handlers/learning-tasks.ts';

export const runtime = 'nodejs';

export async function GET(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createGetLearningTaskHandler(buildLearningTasksHandlerDeps())(request, id);
}

export async function PATCH(request: Request, _ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await _ctx.params;
  return createUpdateLearningTaskHandler(buildLearningTasksHandlerDeps())(request, id);
}
