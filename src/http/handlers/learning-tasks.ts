import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { ActionPlanRepository, Clock, LearningTaskRepository, LearningTaskRecord } from '../../ports/index.ts';
import { learningTaskSnapshotFromStep, isLearningTaskStatus } from '../../domain/learning-task/learning-task.ts';

export type LearningTasksHandlerDeps = {
  auth: AuthService;
  actionPlans: ActionPlanRepository;
  learningTasks: LearningTaskRepository;
  clock: Clock;
};

async function requireUser(deps: LearningTasksHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

const CreateBodySchema = z
  .object({
    actionPlanId: z.string().trim().min(1, 'actionPlanId 不能为空'),
    sourceStepId: z.string().trim().min(1, 'sourceStepId 不能为空'),
    content: z.string().optional().nullable(),
  })
  .strict();

const UpdateBodySchema = z
  .object({
    status: z.string().trim().min(1).optional(),
    content: z.string().optional().nullable(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.content !== undefined, {
    message: '至少需要提供 status 或 content 之一',
  });

/** POST /api/learning-tasks/:id/archive 的严格空 body：仅允许 `{}`，任何未知字段 400 */
const ArchiveBodySchema = z.object({}).strict();

function toTaskResponse(task: LearningTaskRecord) {
  return {
    id: task.id,
    actionPlanId: task.actionPlanId,
    sourceStepId: task.sourceStepId,
    sourceStepTitle: task.sourceStepTitle,
    sourceStepTargetRequirement: task.sourceStepTargetRequirement,
    content: task.content,
    status: task.status,
    archivedAt: task.archivedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

/** POST /api/learning-tasks —— 创建学习任务（201 首次 / 200 活跃重复 / 409 归档重复） */
export function createCreateLearningTaskHandler(deps: LearningTasksHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = CreateBodySchema.parse(await readJson(request));

      const plan = await deps.actionPlans.findForUser(body.actionPlanId, user.id);
      if (!plan) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');

      const step = plan.steps.find((s) => s.id === body.sourceStepId);
      if (!step) throw appError(ERROR_CODE.VALIDATION_FAILED, 'sourceStepId 不属于该行动计划');

      const snapshot = learningTaskSnapshotFromStep(step);
      const outcome = await deps.learningTasks.create({
        userId: user.id,
        actionPlanId: body.actionPlanId,
        sourceStepId: body.sourceStepId,
        sourceStepTitle: snapshot.sourceStepTitle,
        sourceStepTargetRequirement: snapshot.sourceStepTargetRequirement,
        content: body.content ?? null,
      });

      switch (outcome.kind) {
        case 'CREATED':
          return jsonResponse(201, { data: toTaskResponse(outcome.task) });
        case 'ACTIVE_DUPLICATE':
          return jsonResponse(200, { data: toTaskResponse(outcome.task) });
        case 'ARCHIVED_DUPLICATE':
          throw appError(ERROR_CODE.LEARNING_TASK_ARCHIVED_EXISTS, '该学习任务已归档，不能重复创建');
        case 'ACTION_PLAN_NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/learning-tasks —— 仅本人，默认隐藏已归档 */
export function createListLearningTasksHandler(deps: LearningTasksHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const items = await deps.learningTasks.listForUser(user.id);
      return jsonResponse(200, { data: { items: items.map(toTaskResponse) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * GET /api/learning-tasks/:id —— 单条读取（T3-A2-6 Phase 3 正式授权）。
 * - 归档任务**允许读取**（历史详情可读）；
 * - 响应**不含 userId**；
 * - 不存在 / 跨用户 → 404（不产生 existence oracle）。
 */
export function createGetLearningTaskHandler(deps: LearningTasksHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const task = await deps.learningTasks.findForUser(id, user.id);
      if (!task) throw appError(ERROR_CODE.NOT_FOUND, '未找到该学习任务');
      return jsonResponse(200, { data: toTaskResponse(task) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/learning-tasks/:id —— 更新 status / content */
export function createUpdateLearningTaskHandler(deps: LearningTasksHandlerDeps) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = UpdateBodySchema.parse(await readJson(request));

      if (body.status !== undefined && !isLearningTaskStatus(body.status)) {
        throw appError(ERROR_CODE.LEARNING_TASK_NOT_TRANSITIONABLE, '非法状态：只能是 PLANNED / IN_PROGRESS / PAUSED');
      }

      const outcome = await deps.learningTasks.update(id, user.id, {
        status: body.status,
        content: body.content,
      });

      switch (outcome.kind) {
        case 'UPDATED':
          return jsonResponse(200, { data: toTaskResponse(outcome.task) });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到该学习任务');
        case 'INVALID_STATUS':
          throw appError(ERROR_CODE.LEARNING_TASK_NOT_TRANSITIONABLE, '非法状态：只能是 PLANNED / IN_PROGRESS / PAUSED');
        case 'FORBIDDEN_TRANSITION':
          throw appError(ERROR_CODE.LEARNING_TASK_NOT_TRANSITIONABLE, '不允许回退到 PLANNED 状态');
        case 'ARCHIVED':
          throw appError(ERROR_CODE.LEARNING_TASK_NOT_TRANSITIONABLE, '已归档的学习任务不可修改');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/learning-tasks/:id/archive —— 归档（终态；幂等）；严格空 body */
export function createArchiveLearningTaskHandler(deps: LearningTasksHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      // 严格空 body：`{}` 允许，任何未知字段 → 400（strict 空 schema）
      ArchiveBodySchema.parse(await readJson(request));
      const outcome = await deps.learningTasks.archive(id, user.id, deps.clock.now());

      switch (outcome.kind) {
        case 'ARCHIVED':
          return jsonResponse(200, { data: toTaskResponse(outcome.task) });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到该学习任务');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
