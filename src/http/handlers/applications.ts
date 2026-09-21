/**
 * T6-2 —— Application Tracker handlers（恰 4 个 endpoint：POST / GET list / GET /:id / PATCH /:id）。
 *
 * 硬边界（授权书 §五–§十）：
 *   - userId 只来自 session；body `.strict()`，出现 userId 一律 400；
 *   - careerGoalId / resumeVersionId / jdId 非空时逐项 ownership 校验，跨用户与不存在同形（404 无 oracle）；
 *   - ResumeVersion/JD 一致性：两者均非空且 ResumeVersion.jdId 非空 → 必须与 Application.jdId 一致（否则 400）；
 *   - CareerGoal/JD 一致性：两者均非空 → CareerGoalJobDescription 必须存在绑定（否则 400；应用层校验，无 DB composite FK）；
 *   - appliedAt 缺省 = 当前时间（历史回填归 Migration #16，与运行时无关）；
 *   - position 缺省：POST 且 jdId 存在时从 JD.title 预填；
 *   - 不新增 stage endpoint / DELETE / 严格状态机；stage 任意合法值可经 PATCH 修正。
 */

import { z } from 'zod';

import {
  APPLICATION_STAGE,
  APPLICATION_STAGES,
  DEFAULT_STAGE,
  toView,
  toDetailView,
} from '../../domain/application/types.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type {
  ApplicationRepository,
  CareerGoalRepository,
  JdRepository,
  ResumeVersionRepository,
} from '../../ports/index.ts';

const stageSchema = z.enum(['APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN']);

/** strict()：出现多余字段（尤其 userId）直接 400 */
const createSchema = z
  .object({
    company: z.string().trim().min(1, '公司名称不能为空').max(80, '公司名称过长'),
    jdId: z.string().trim().min(1).max(64).optional(),
    careerGoalId: z.string().trim().min(1).max(64).optional(),
    resumeVersionId: z.string().trim().min(1).max(64).optional(),
    position: z.string().trim().max(120, '职位名称过长').optional(),
    appliedAt: z.string().datetime({ offset: true }).optional(),
    stage: stageSchema.optional(),
    notes: z.string().trim().max(500, '备注过长').optional(),
  })
  .strict();

const patchSchema = z
  .object({
    company: z.string().trim().min(1, '公司名称不能为空').max(80, '公司名称过长').optional(),
    position: z.string().trim().max(120, '职位名称过长').nullable().optional(),
    jdId: z.string().trim().min(1).max(64).nullable().optional(),
    careerGoalId: z.string().trim().min(1).max(64).nullable().optional(),
    resumeVersionId: z.string().trim().min(1).max(64).nullable().optional(),
    appliedAt: z.string().datetime({ offset: true }).optional(),
    stage: stageSchema.optional(),
    notes: z.string().trim().max(500, '备注过长').nullable().optional(),
  })
  .strict();

export type ApplicationsHandlerDeps = {
  auth: AuthService;
  applications: ApplicationRepository;
  jdRepo: JdRepository;
  careerGoals: CareerGoalRepository;
  resumeVersions: ResumeVersionRepository;
};

async function requireUser(deps: ApplicationsHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/** BUG-002（延续）：≥50 条启用分页 */
export const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function parsePageParam(
  raw: string | null,
  name: string,
  opts: { min: number; max: number; fallback: number },
): number {
  const text = raw === null ? '' : raw.trim();
  if (text === '') return opts.fallback;
  if (!/^\d+$/.test(text)) {
    throw appError(ERROR_CODE.VALIDATION_FAILED, `${name} 必须是非负整数`);
  }
  const n = Number(text);
  if (n < opts.min || n > opts.max) {
    throw appError(ERROR_CODE.VALIDATION_FAILED, `${name} 须在 ${opts.min} 到 ${opts.max} 之间`);
  }
  return n;
}

/** 400 语义包（与既有错误信封同形；不新增 errors.ts 条目） */
const CONSISTENCY_ERRORS = {
  RV_JD_MISMATCH: { code: 'APPLICATION_RESUME_VERSION_MISMATCH', message: '简历版本与岗位不匹配' },
  GOAL_JD_UNBOUND: { code: 'APPLICATION_GOAL_JD_UNBOUND', message: '该岗位未绑定到当前求职目标' },
} as const;

/** 关联字段 ownership 校验（POST 与 PATCH 共用；跨用户与不存在同形 404） */
async function resolveLinks(
  deps: ApplicationsHandlerDeps,
  userId: string,
  refs: { jdId?: string | null; careerGoalId?: string | null; resumeVersionId?: string | null },
): Promise<{ jdTitle: string | null }> {
  let jdTitle: string | null = null;
  if (refs.jdId) {
    const jd = await deps.jdRepo.findByIdForUser(refs.jdId, userId);
    if (jd === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 JD');
    jdTitle = jd.title;
  }
  if (refs.careerGoalId) {
    const goal = await deps.careerGoals.findForUser(refs.careerGoalId, userId);
    if (goal === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该求职目标');
  }
  if (refs.resumeVersionId) {
    const rv = await deps.resumeVersions.findForUser(refs.resumeVersionId, userId);
    if (rv === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历版本');
  }
  return { jdTitle };
}

/**
 * 关联一致性校验（在 ownership 通过后调用；作用域 = 合并后的最终状态）：
 *   - ResumeVersion.jdId 非空 且 Application.jdId 非空 → 必须相同（§五.5）；
 *   - careerGoalId 与 jdId 均非空 → (goal, jd) 必须存在绑定（§五.6）。
 */
async function assertConsistency(
  deps: ApplicationsHandlerDeps,
  refs: { jdId: string | null; careerGoalId: string | null; resumeVersionId: string | null },
  resumeVersionJdId: string | null,
): Promise<void> {
  if (
    refs.resumeVersionId !== null &&
    resumeVersionJdId !== null &&
    refs.jdId !== null &&
    resumeVersionJdId !== refs.jdId
  ) {
    throw appError(ERROR_CODE.VALIDATION_FAILED, CONSISTENCY_ERRORS.RV_JD_MISMATCH.message);
  }
  if (refs.careerGoalId !== null && refs.jdId !== null) {
    const linked = await deps.careerGoals.hasJobDescriptionLink(refs.careerGoalId, refs.jdId);
    if (!linked) {
      throw appError(ERROR_CODE.VALIDATION_FAILED, CONSISTENCY_ERRORS.GOAL_JD_UNBOUND.message);
    }
  }
}

/** GET /api/applications —— counts + 当前页列表（counts 随筛选、不受分页影响） */
export function createListApplicationsHandler(deps: ApplicationsHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const url = new URL(request.url);
      const limit = parsePageParam(url.searchParams.get('limit'), 'limit', {
        min: 1,
        max: MAX_PAGE_SIZE,
        fallback: DEFAULT_PAGE_SIZE,
      });
      const offset = parsePageParam(url.searchParams.get('offset'), 'offset', {
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
        fallback: 0,
      });
      const stage = url.searchParams.get('stage');
      if (stage !== null && stage !== '' && !APPLICATION_STAGES.includes(stage as never)) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, 'stage 取值不合法');
      }
      const filter = {
        ...(url.searchParams.get('careerGoalId') ? { careerGoalId: url.searchParams.get('careerGoalId')! } : {}),
        ...(stage ? { stage } : {}),
        ...(url.searchParams.get('jdId') ? { jdId: url.searchParams.get('jdId')! } : {}),
        ...(url.searchParams.get('company') ? { company: url.searchParams.get('company')! } : {}),
      };

      const counts = await deps.applications.countStagesForUser(user.id, filter);
      const records = await deps.applications.listForUser(user.id, { limit, offset, ...filter });

      return jsonResponse(200, {
        data: {
          counts,
          items: records.map(toView),
          pagination: {
            total: counts.total,
            limit,
            offset,
            hasMore: offset + records.length < counts.total,
          },
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/applications —— position 缺省从 JD.title 预填；appliedAt 缺省 = 当前时间 */
export function createCreateApplicationHandler(deps: ApplicationsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = createSchema.parse(await readJson(request));

      const { jdTitle } = await resolveLinks(deps, user.id, {
        jdId: body.jdId,
        careerGoalId: body.careerGoalId,
        resumeVersionId: body.resumeVersionId,
      });
      const resumeVersionJdId = body.resumeVersionId
        ? (await deps.resumeVersions.findForUser(body.resumeVersionId, user.id))?.jdId ?? null
        : null;
      await assertConsistency(
        deps,
        { jdId: body.jdId ?? null, careerGoalId: body.careerGoalId ?? null, resumeVersionId: body.resumeVersionId ?? null },
        resumeVersionJdId,
      );

      const record = await deps.applications.create({
        userId: user.id,
        company: body.company,
        jdId: body.jdId ?? null,
        careerGoalId: body.careerGoalId ?? null,
        resumeVersionId: body.resumeVersionId ?? null,
        position: body.position ?? jdTitle,
        appliedAt: body.appliedAt ? new Date(body.appliedAt) : new Date(),
        stage: body.stage ?? DEFAULT_STAGE,
        notes: body.notes ?? null,
      });

      return jsonResponse(201, { data: toView(record) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/applications/:id —— 详情（含关联资源摘要；跨用户 404 无 oracle） */
export function createGetApplicationDetailHandler(deps: ApplicationsHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const record = await deps.applications.findForUser(id, user.id);
      if (record === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该投递记录');

      const jd = record.jdId ? await deps.jdRepo.findByIdForUser(record.jdId, user.id) : null;
      const goal = record.careerGoalId ? await deps.careerGoals.findForUser(record.careerGoalId, user.id) : null;
      const rv = record.resumeVersionId ? await deps.resumeVersions.findForUser(record.resumeVersionId, user.id) : null;

      return jsonResponse(200, {
        data: {
          application: toDetailView(record, {
            jdSummary: jd ? { title: jd.title, company: jd.company } : null,
            careerGoalSummary: goal
              ? { name: goal.name, position: goal.position, status: goal.status }
              : null,
            resumeVersionSummary: rv
              ? { versionNo: rv.versionNo, jdId: rv.jdId, createdAt: rv.createdAt.toISOString() }
              : null,
          }),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/applications/:id —— 修改后重新执行全部 ownership / 一致性校验（§八） */
export function createUpdateApplicationHandler(deps: ApplicationsHandlerDeps) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = patchSchema.parse(await readJson(request));

      const existing = await deps.applications.findForUser(id, user.id);
      if (existing === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该投递记录');
      if (Object.keys(body).length === 0) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, '至少提供一个要修改的字段');
      }

      // 关联字段 = 合并后的最终状态（PATCH 未提供则沿用现值）
      const jdId = body.jdId !== undefined ? body.jdId : existing.jdId;
      const careerGoalId = body.careerGoalId !== undefined ? body.careerGoalId : existing.careerGoalId;
      const resumeVersionId =
        body.resumeVersionId !== undefined ? body.resumeVersionId : existing.resumeVersionId;

      await resolveLinks(deps, user.id, {
        jdId: body.jdId !== undefined ? body.jdId : null,
        careerGoalId: body.careerGoalId !== undefined ? body.careerGoalId : null,
        resumeVersionId: body.resumeVersionId !== undefined ? body.resumeVersionId : null,
      });
      const resumeVersionJdId = resumeVersionId
        ? (await deps.resumeVersions.findForUser(resumeVersionId, user.id))?.jdId ?? null
        : null;
      await assertConsistency(deps, { jdId, careerGoalId, resumeVersionId }, resumeVersionJdId);

      const updated = await deps.applications.update(id, user.id, {
        ...(body.stage === undefined ? {} : { stage: body.stage }),
        ...(body.company === undefined ? {} : { company: body.company }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
        ...(body.position === undefined ? {} : { position: body.position }),
        ...(body.jdId === undefined ? {} : { jdId: body.jdId }),
        ...(body.careerGoalId === undefined ? {} : { careerGoalId: body.careerGoalId }),
        ...(body.resumeVersionId === undefined ? {} : { resumeVersionId: body.resumeVersionId }),
        ...(body.appliedAt === undefined ? {} : { appliedAt: new Date(body.appliedAt) }),
      });
      if (updated === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该投递记录');

      return jsonResponse(200, { data: toView(updated) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

// 保持既有导出面（page/守卫可能引用）
export { APPLICATION_STAGE, APPLICATION_STAGES };
