import { z } from 'zod';

import { buildPdfModel } from '../../domain/pdf/build.ts';
import { snapshotOf } from '../../domain/pdf/persistence.ts';
import type { VersionSnapshot } from '../../domain/pdf/persistence.ts';
import { renderPdf } from '../../domain/pdf/render.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { JdRepository, ResumeFactsRepository, ResumeVersionRepository } from '../../ports/index.ts';

const basicsSchema = z
  .object({
    name: z.string().trim().min(1, '姓名不能为空').max(50),
    phone: z.string().trim().max(40).optional(),
    email: z.string().trim().max(80).optional(),
    city: z.string().trim().max(40).optional(),
  })
  .strict();

const createBodySchema = z
  .object({
    basics: basicsSchema,
    jdId: z.string().trim().min(1).optional(),
  })
  .strict();

export type ResumeVersionsHandlerDeps = {
  auth: AuthService;
  resumeFacts: ResumeFactsRepository;
  resumeVersions: ResumeVersionRepository;
  jdRepo: JdRepository;
};

/**
 * POST /api/resumes/:id/versions
 * Resume / Confirmed Facts → 逐字段 verifyClaim → 快照 → 新 ResumeVersion
 */
export function createCreateVersionHandler(deps: ResumeVersionsHandlerDeps) {
  return async function POST(request: Request, resumeId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = createBodySchema.parse(await readJson(request));

      const facts = await deps.resumeFacts.findFactsForResume(resumeId, user.id);
      if (facts === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历');

      let jdId: string | null = null;
      if (body.jdId) {
        const jd = await deps.jdRepo.findByIdForUser(body.jdId, user.id);
        if (jd === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 JD');
        jdId = jd.id;
      }

      // 先做一次资格预检，避免写入一份只有姓名、毫无内容的 PDF
      const pre = buildPdfModel({ resumeId, versionNo: 0, basics: body.basics, facts });
      if (pre.model.meta.confirmedCount === 0) {
        throw appError(ERROR_CODE.PDF_CONTENT_INVALID, '没有任何已确认的事实可以写入 PDF，请先完成简历确认');
      }

      const version = await deps.resumeVersions.createVersion({
        resumeId,
        userId: user.id,
        jdId,
        buildSnapshot: (versionNo) =>
          snapshotOf(buildPdfModel({ resumeId, versionNo, basics: body.basics, facts }).model),
      });
      if (version === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历');

      const snapshot = version.snapshot as VersionSnapshot;

      return jsonResponse(201, {
        data: {
          versionId: version.id,
          versionNo: version.versionNo,
          pdfUrl: version.pdfUrl,
          templateVersion: snapshot.templateVersion,
          confirmedCount: snapshot.model.meta.confirmedCount,
          // 被挡在 PDF 之外的条目如实返回，不静默丢弃
          excluded: snapshot.model.excluded,
          createdAt: version.createdAt.toISOString(),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * GET /api/resumes/:id/versions —— 版本历史列表（轻量，不含快照正文）
 */
export function createListVersionsHandler(deps: ResumeVersionsHandlerDeps) {
  return async function GET(request: Request, resumeId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      // 归属校验：非本人简历 404（不返回 403，避免枚举）
      const owner = await deps.resumeFacts.findFactsForResume(resumeId, user.id);
      if (owner === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历');

      const versions = await deps.resumeVersions.listForResume(resumeId, user.id);
      return jsonResponse(200, {
        data: {
          items: versions.map((v) => ({
            versionId: v.id,
            versionNo: v.versionNo,
            pdfUrl: v.pdfUrl,
            createdAt: v.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * GET /api/resumes/:id/versions/:versionId/pdf
 * 从不可变快照重新渲染 —— 不复用任何上游结论（ADR-010）
 */
export function createDownloadVersionPdfHandler(deps: ResumeVersionsHandlerDeps) {
  return async function GET(request: Request, resumeId: string, versionId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const version = await deps.resumeVersions.findForUser(versionId, user.id);
      if (version === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该版本');
      if (version.resumeId !== resumeId) throw appError(ERROR_CODE.NOT_FOUND, '未找到该版本');

      const snapshot = version.snapshot as VersionSnapshot;
      if (!snapshot || !snapshot.model) {
        throw appError(ERROR_CODE.PDF_RENDER_FAILED, '该版本的快照不可读，无法渲染');
      }

      const pdf = await renderPdf(snapshot.model);

      return new Response(new Uint8Array(pdf), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': `attachment; filename="resume-v${version.versionNo}.pdf"`,
          'cache-control': 'private, no-store',
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
