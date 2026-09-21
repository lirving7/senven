import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { ResumeRepository } from '../../ports/index.ts';

export type ResumeReadHandlerDeps = {
  auth: AuthService;
  resumes: ResumeRepository;
};

async function requireUser(deps: ResumeReadHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

/** GET /api/resumes —— 「我的简历」列表，仅本人数据 */
export function createListResumesHandler(deps: ResumeReadHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const items = await deps.resumes.listForUser(user.id);
      return jsonResponse(200, {
        data: {
          items: items.map((r) => ({
            id: r.id,
            sourceType: r.sourceType,
            createdAt: r.createdAt.toISOString(),
            itemCount: r.itemCount,
            statusSummary: r.statusSummary,
          })),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/resumes/:id —— 解析确认详情（条目带 id + 证据），非本人 404 */
export function createGetResumeHandler(deps: ResumeReadHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const detail = await deps.resumes.findDetailForUser(id, user.id);
      if (detail === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历');

      return jsonResponse(200, {
        data: {
          id: detail.id,
          sourceType: detail.sourceType,
          createdAt: detail.createdAt.toISOString(),
          items: detail.items.map((i) => ({
            id: i.id,
            section: i.section,
            title: i.title,
            detail: i.detail,
            status: i.status,
            evidence: i.evidence.map((e) => ({
              source: e.source,
              locator: e.locator,
              excerpt: e.excerpt ?? null,
            })),
          })),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
