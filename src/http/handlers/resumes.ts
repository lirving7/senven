import { z } from 'zod';

import { extractText } from '../../domain/resume/extract.ts';
import { parseResume } from '../../domain/resume/parse-resume.ts';
import type { ResumeDraftParser } from '../../domain/resume/parse-resume.ts';
import { RESUME_STATE } from '../../domain/resume/types.ts';
import { EVIDENCE_SOURCE } from '../../domain/types.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { ResumeRepository } from '../../ports/index.ts';

const textBodySchema = z.object({ rawText: z.string().trim().min(1, 'rawText 不能为空').max(200_000) }).strict();

export type ResumesHandlerDeps = {
  auth: AuthService;
  resumes: ResumeRepository;
  parse: ResumeDraftParser;
};

/**
 * POST /api/resumes
 * session → intake → extract → parse → locate → 单事务落库
 * 原始文件**不落盘**，只保留抽取后的文本。
 */
export function createCreateResumeHandler(deps: ResumesHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const contentType = request.headers.get('content-type') ?? '';
      let bytes: Uint8Array | null = null;
      let declaredName: string | undefined;

      if (contentType.includes('multipart/form-data')) {
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File)) throw appError(ERROR_CODE.VALIDATION_FAILED, '缺少上传文件字段 file');
        bytes = new Uint8Array(await file.arrayBuffer());
        declaredName = file.name;
      } else {
        const body = textBodySchema.parse(await readJson(request));
        bytes = new TextEncoder().encode(body.rawText);
      }

      // extractText 内部先跑 intake 的全部安全规则（魔数 / 大小 / 图片拒绝）
      const extracted = await extractText({ bytes, declaredName });

      const outcome = await parseResume(
        { extracted, evidenceSource: EVIDENCE_SOURCE.RESUME_TEXT },
        { parse: deps.parse },
      );

      if (!outcome.ok) {
        return jsonResponse(200, {
          data: { state: outcome.state, message: outcome.message, items: [] },
        });
      }

      const saved = await deps.resumes.createWithItems({
        userId: user.id,
        rawText: outcome.parsed.rawText,
        sourceType: outcome.parsed.sourceType,
        items: outcome.parsed.items.map((i) => ({
          section: i.section,
          title: i.title,
          detail: i.detail,
          status: i.status,
          source: outcome.parsed.evidenceSource,
          locator: i.locator,
          excerpt: i.excerpt,
        })),
      });

      return jsonResponse(201, {
        data: {
          resumeId: saved.id,
          sourceType: outcome.parsed.sourceType,
          itemCount: saved.itemCount,
          evidenceCount: saved.evidenceCount,
          statusSummary: { unconfirmed: saved.unconfirmedCount, inferred: saved.inferredCount, confirmed: 0 },
          items: outcome.parsed.items,
          rejected: outcome.parsed.rejected,
          warnings: outcome.parsed.warnings,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
