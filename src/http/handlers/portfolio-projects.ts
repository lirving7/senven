import { z } from 'zod';

import { appError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { Clock, PortfolioProjectRepository } from '../../ports/index.ts';
import type {
  PortfolioMemberRecord,
  PortfolioProjectRecord,
} from '../../ports/index.ts';
import {
  isValidDescription,
  isValidTitle,
  normalizeDescription,
  normalizeTitle,
} from '../../domain/portfolio/portfolio.ts';

export type PortfolioProjectsHandlerDeps = {
  auth: AuthService;
  portfolioProjects: PortfolioProjectRepository;
  clock: Clock;
};

async function requireUser(deps: PortfolioProjectsHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/** POST /api/portfolio-projects：仅 title + description?（displayOrder/featured 走 schema 默认值） */
const CreateBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title 不能为空').max(120, 'title 不能超过 120 字'),
    description: z.string().max(2000, 'description 不能超过 2000 字').optional().nullable(),
  })
  .strict();

/**
 * PATCH 白名单严格：title? / description? / displayOrder? / featured?。
 * 空对象 {} → 400；未知字段 → 400（strict）。
 */
const UpdateBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title 不能为空').max(120, 'title 不能超过 120 字').optional(),
    description: z.string().max(2000, 'description 不能超过 2000 字').optional().nullable(),
    displayOrder: z.number().int().optional(),
    featured: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) => b.title !== undefined || b.description !== undefined || b.displayOrder !== undefined || b.featured !== undefined,
    { message: '至少需要提供一个可更新字段' },
  );

/** POST /:id/archive：严格空 body（{} 允许，未知字段 400） */
const ArchiveBodySchema = z.object({}).strict();

/** POST /:id/results：加入 ProjectResult */
const AddResultBodySchema = z
  .object({
    projectResultId: z.string().trim().min(1, 'projectResultId 不能为空'),
    displayOrder: z.number().int().optional(),
  })
  .strict();

function toProjectResponse(project: PortfolioProjectRecord) {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    displayOrder: project.displayOrder,
    featured: project.featured,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function toMemberResponse(member: PortfolioMemberRecord) {
  return {
    id: member.id,
    projectResultId: member.projectResultId,
    displayOrder: member.displayOrder,
    createdAt: member.createdAt.toISOString(),
  };
}

function toDetailResponse(detail: {
  project: PortfolioProjectRecord;
  results: PortfolioMemberRecord[];
  revokedResults: PortfolioMemberRecord[];
  activeResultCount: number;
}) {
  return {
    ...toProjectResponse(detail.project),
    results: detail.results.map(toMemberResponse),
    revokedResults: detail.revokedResults.map(toMemberResponse),
    activeResultCount: detail.activeResultCount,
  };
}

/** POST /api/portfolio-projects —— 创建作品集（201） */
export function createCreatePortfolioProjectHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = CreateBodySchema.parse(await readJson(request));
      const title = normalizeTitle(body.title);
      if (!isValidTitle(title)) throw appError(ERROR_CODE.VALIDATION_FAILED, 'title 长度须在 1–120 字之间');
      const description = normalizeDescription(body.description ?? null);
      if (!isValidDescription(description)) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, 'description 不能超过 2000 字');
      }

      const outcome = await deps.portfolioProjects.create({ userId: user.id, title, description });
      if (outcome.kind === 'CREATED') {
        return jsonResponse(201, { data: toProjectResponse(outcome.project) });
      }
      throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/portfolio-projects —— 仅本人 active（archivedAt IS NULL） */
export function createListPortfolioProjectsHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const items = await deps.portfolioProjects.listForUser(user.id);
      return jsonResponse(200, { data: { items: items.map(toProjectResponse) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/portfolio-projects/:id —— 详情（含 members）；归档可读；跨用户 404 */
export function createGetPortfolioProjectHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const detail = await deps.portfolioProjects.findForUser(id, user.id);
      if (!detail) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      return jsonResponse(200, { data: toDetailResponse(detail) });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/portfolio-projects/:id —— 更新 title/description/displayOrder/featured */
export function createUpdatePortfolioProjectHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = UpdateBodySchema.parse(await readJson(request));

      if (body.title !== undefined) {
        const t = normalizeTitle(body.title);
        if (!isValidTitle(t)) throw appError(ERROR_CODE.VALIDATION_FAILED, 'title 长度须在 1–120 字之间');
      }

      const outcome = await deps.portfolioProjects.update(id, user.id, {
        title: body.title !== undefined ? normalizeTitle(body.title) : undefined,
        description: body.description !== undefined ? normalizeDescription(body.description) : undefined,
        displayOrder: body.displayOrder,
        featured: body.featured,
      });

      switch (outcome.kind) {
        case 'UPDATED':
          return jsonResponse(200, { data: toProjectResponse(outcome.project) });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
        case 'ARCHIVED':
          throw appError(ERROR_CODE.PORTFOLIO_ARCHIVED, '已归档的作品集不可修改');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/portfolio-projects/:id/archive —— 归档（终态；幂等）；严格空 body */
export function createArchivePortfolioProjectHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      ArchiveBodySchema.parse(await readJson(request));
      const outcome = await deps.portfolioProjects.archive(id, user.id, deps.clock.now());
      switch (outcome.kind) {
        case 'ARCHIVED':
          return jsonResponse(200, { data: toProjectResponse(outcome.project) });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/portfolio-projects/:id/results —— 加入 ProjectResult（201 首次 / 200 重复） */
export function createAddPortfolioProjectResultHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = AddResultBodySchema.parse(await readJson(request));

      const outcome = await deps.portfolioProjects.addResult(id, user.id, {
        portfolioProjectId: id,
        projectResultId: body.projectResultId,
        displayOrder: body.displayOrder ?? 0,
      });

      switch (outcome.kind) {
        case 'ADDED':
          return jsonResponse(201, { data: toMemberResponse(outcome.member) });
        case 'DUPLICATE':
          return jsonResponse(200, { data: toMemberResponse(outcome.member) });
        case 'ARCHIVED':
          throw appError(ERROR_CODE.PORTFOLIO_ARCHIVED, '已归档的作品集不可添加成果');
        case 'NOT_FOUND':
        case 'PROJECT_RESULT_NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
        case 'NOT_ELIGIBLE':
          throw appError(ERROR_CODE.PORTFOLIO_RESULT_NOT_ELIGIBLE, '该成果当前不可加入作品集（仅已提交且未撤销的成果可加入）');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** DELETE /api/portfolio-projects/:id/results/:resultId —— 移除关系 */
export function createRemovePortfolioProjectResultHandler(deps: PortfolioProjectsHandlerDeps) {
  return async function DELETE(request: Request, id: string, resultId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const outcome = await deps.portfolioProjects.removeResult(id, user.id, resultId);
      switch (outcome.kind) {
        case 'REMOVED':
          return jsonResponse(200, { data: { removed: true } });
        case 'ARCHIVED':
          throw appError(ERROR_CODE.PORTFOLIO_ARCHIVED, '已归档的作品集不可移除成果');
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
