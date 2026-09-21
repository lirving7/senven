import { buildLearningTasksHandlerDeps } from '../../../src/http/deps.ts';
import {
  createCreateLearningTaskHandler,
  createListLearningTasksHandler,
} from '../../../src/http/handlers/learning-tasks.ts';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return createListLearningTasksHandler(buildLearningTasksHandlerDeps())(request);
}

export async function POST(request: Request): Promise<Response> {
  return createCreateLearningTaskHandler(buildLearningTasksHandlerDeps())(request);
}
