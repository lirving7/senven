/**
 * T6-1 —— CareerGoal API handlers（**恰好 5 个 endpoint**）
 *
 *   POST /api/career-goals            创建求职目标（用户自著资源，非 AI 推荐 → Confirm 产物）
 *   GET  /api/career-goals            列表（?status= / ?current=true）
 *   GET  /api/career-goals/:id        详情（跨用户一律 404，无 oracle）
 *   PATCH /api/career-goals/:id       更新（replace-set jdIds；**拒绝 isCurrent**）
 *   POST /api/career-goals/:id/current 设为当前目标（单事务；幂等；409 可重试）
 *
 * 硬边界（授权书 §八–§十三）：
 *   - userId 只来自 session；body `.strict()`，出现 userId 即 400；
 *   - PATCH body 出现 isCurrent → 400（isCurrent 只能经 /current 切换）；
 *   - jdIds 逐项 ownership 校验；跨用户 JD 与不存在同形（422，不透露哪个）；
 *   - 不新增第六个 endpoint；不触碰 Fact Authority / Agent。
 */

import { z } from 'zod';

import {
  CAREER_GOAL_EMPLOYMENT_TYPE,
  CAREER_GOAL_STATUS,
} from '../../domain/career-goal/career-goal.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { CareerGoalRecord, CareerGoalRepository } from '../../ports/index.ts';

export type CareerGoalsHandlerDeps = {
  auth: AuthService;
  careerGoals: CareerGoalRepository;
};

async function requireUser(deps: CareerGoalsHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

const jdIdSchema = z.string().min(1).max(64);

const CreateBodySchema = z
  .object({
    name: z.string().min(1).max(80),
    position: z.string().min(1).max(80),
    location: z.string().max(80).optional(),
    employmentType: z.nativeEnum(CAREER_GOAL_EMPLOYMENT_TYPE),
    status: z.nativeEnum(CAREER_GOAL_STATUS).optional(),
    jdIds: z.array(jdIdSchema).max(20).optional(),
  })
  .strict();

const PatchBodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    position: z.string().min(1).max(80).optional(),
    location: z.string().max(80).nullable().optional(),
    employmentType: z.nativeEnum(CAREER_GOAL_EMPLOYMENT_TYPE).optional(),
    status: z.nativeEnum(CAREER_GOAL_STATUS).optional(),
    jdIds: z.array(jdIdSchema).max(20).optional(),
  })
  .strict();

/** 409 本地映射（复用 2C 先例：类型化结果直映射，不动 errors.ts / error-mapping.ts 冻结指纹） */
const CURRENT_CONFLICT = {
  GOAL_NOT_ACTIVE: { code: 'CAREER_GOAL_NOT_CURRENTABLE', message: '仅进行中的目标可以设为当前' },
  CURRENT_SWITCH_RACE: { code: 'CAREER_GOAL_CURRENT_CONFLICT', message: '当前目标切换冲突，请重试' },
} as const;

const JD_NOT_OWNED = { code: 'CAREER_GOAL_JD_NOT_OWNED', message: '存在不可关联的岗位' } as const;

function goalView(goal: CareerGoalRecord) {
  return {
    id: goal.id,
    name: goal.name,
    position: goal.position,
    location: goal.location,
    employmentType: goal.employmentType,
    status: goal.status,
    isCurrent: goal.isCurrent,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    jdIds: goal.jdIds,
  };
}

/** POST /api/career-goals —— 创建；201 返回（含 jdIds 关联结果） */
export function createCreateCareerGoalHandler(deps: CareerGoalsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = CreateBodySchema.parse(await readJson(request));
      const outcome = await deps.careerGoals.create(user.id, {
        name: body.name,
        position: body.position,
        ...(body.location === undefined ? {} : { location: body.location }),
        employmentType: body.employmentType,
        status: body.status ?? CAREER_GOAL_STATUS.ACTIVE,
        ...(body.jdIds === undefined ? {} : { jdIds: body.jdIds }),
      });
      if (outcome.kind === 'JD_NOT_FOUND') {
        return jsonResponse(422, { error: { ...JD_NOT_OWNED, requestId } });
      }
      return jsonResponse(201, { data: { goal: goalView(outcome.goal) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/career-goals?status=&current= —— 仅本人列表 */
export function createListCareerGoalsHandler(deps: CareerGoalsHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const url = new URL(request.url);
      const status = url.searchParams.get('status');
      const current = url.searchParams.get('current');
      if (status !== null && !(status in CAREER_GOAL_STATUS)) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, 'status 取值不合法');
      }
      if (current !== null && current !== 'true' && current !== 'false') {
        throw appError(ERROR_CODE.VALIDATION_FAILED, 'current 取值不合法');
      }
      const items = await deps.careerGoals.listForUser(user.id, {
        ...(status ? { status } : {}),
        ...(current === 'true' ? { current: true } : {}),
      });
      return jsonResponse(200, { data: { items: items.map(goalView) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createGetCareerGoalHandler(deps: CareerGoalsHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const goal = await deps.careerGoals.findForUser(id, user.id);
      if (goal === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      return jsonResponse(200, { data: { goal: goalView(goal) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/career-goals/:id —— 更新（replace-set；拒绝 isCurrent 由 strict schema 承担） */
export function createPatchCareerGoalHandler(deps: CareerGoalsHandlerDeps) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = PatchBodySchema.parse(await readJson(request));
      const outcome = await deps.careerGoals.update(user.id, id, body);
      if (outcome.kind === 'NOT_FOUND') throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      if (outcome.kind === 'JD_NOT_FOUND') {
        return jsonResponse(422, { error: { ...JD_NOT_OWNED, requestId } });
      }
      return jsonResponse(200, { data: { goal: goalView(outcome.goal) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/career-goals/:id/current —— 设为当前（幂等；409 可重试） */
export function createSetCurrentCareerGoalHandler(deps: CareerGoalsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const outcome = await deps.careerGoals.setCurrent(user.id, id);
      if (outcome.kind === 'NOT_FOUND') throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      if (outcome.kind === 'CONFLICT') {
        const c = CURRENT_CONFLICT[outcome.reason];
        return jsonResponse(409, { error: { code: c.code, message: c.message, requestId } });
      }
      return jsonResponse(200, { data: { goal: goalView(outcome.goal) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
