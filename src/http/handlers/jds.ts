import { createHash } from 'node:crypto';
import { z } from 'zod';

import { parseJd } from '../../domain/jd/parse-jd.ts';
import { toJobDescriptionCreateInput, toJobDescriptionCreateInputFromPreview } from '../../domain/jd/persistence.ts';
import { normalizeJdText } from '../../domain/jd/preprocess.ts';
import { signPreview, verifyPreview } from '../../domain/jd/preview-token.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { Counter, JdRepository } from '../../ports/index.ts';
import { hourlyQuotaFromEnv } from '../../db/rate-limit.ts';
import type { LLMProvider } from '../../llm/provider.ts';

export const LLM_QUOTA_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

/**
 * 输入层只做「类型与滥用上限」校验；
 * 「JD 至少 50 字符」等业务规则由领域层 assertJdLength 承担（单一事实来源），
 * API 层不复制领域规则。
 */
const createJdSchema = z.object({
  rawText: z.string().trim().min(1, 'rawText 不能为空').max(100_000, 'rawText 过长，请拆分后提交'),
  title: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  previewToken: z.string().optional(),
});

const previewJdSchema = z.object({
  rawText: z.string().trim().min(1, 'rawText 不能为空').max(100_000, 'rawText 过长，请拆分后提交'),
});

const updateJdTitleSchema = z.object({
  title: z.string().max(200),
});

export type JdsHandlerDeps = {
  auth: AuthService;
  provider: LLMProvider;
  jdRepo: JdRepository;
  llmCounter: Counter;
  llmQuotaPerHour?: number;
};

function hashContent(rawText: string): string {
  return createHash('sha256').update(normalizeJdText(rawText)).digest('hex');
}

export function createCreateJdHandler(deps: JdsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = createJdSchema.parse(await readJson(request));
      const rawText = body.rawText;
      const contentHash = hashContent(rawText);

      // 重复 JD：命中直接复用，不再调用 LLM（省成本，也不消耗配额）
      const existing = await deps.jdRepo.findByContentHash(user.id, contentHash);
      if (existing) {
        return jsonResponse(200, {
          data: {
            jdId: existing.id,
            requirementCount: existing.requirementCount,
            duplicated: true,
            degraded: false,
            multiPosting: false,
            warnings: ['检测到重复 JD，已复用既有解析结果。'],
          },
        });
      }

      // 命名窗口流程：preview 阶段已完成解析，create 直接用 preview token 中的结果
      if (body.previewToken) {
        const payload = verifyPreview(body.previewToken);
        if (payload.rawTextHash !== contentHash) {
          throw appError(ERROR_CODE.VALIDATION_FAILED, 'JD 内容在解析后发生变化，请重新解析');
        }

        const userTitle = body.title === undefined ? undefined : body.title.trim() || null;
        const userCompany = body.company === undefined ? undefined : body.company.trim() || null;
        const input = toJobDescriptionCreateInputFromPreview(payload, {
          userId: user.id,
          rawText,
          contentHash,
          title: userTitle,
          company: userCompany,
        });
        const saved = await deps.jdRepo.createWithRequirements(input);

        return jsonResponse(201, {
          data: {
            jdId: saved.id,
            requirementCount: saved.requirementCount,
            duplicated: false,
            language: payload.language,
            degraded: payload.degraded,
            multiPosting: payload.multiPosting,
            warnings: payload.warnings,
          },
        });
      }

      // 无 preview token：保留原解析+保存流程（兼容旧调用）
      const quota = await deps.llmCounter.consume(
        `llm:${user.id}`,
        deps.llmQuotaPerHour ?? hourlyQuotaFromEnv() ?? LLM_QUOTA_PER_HOUR,
        HOUR_MS,
      );
      if (!quota.allowed) {
        throw appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '调用次数已达上限，请稍后再试', {
          retryAfterSeconds: quota.retryAfterSeconds,
        });
      }

      const result = await parseJd(rawText, { provider: deps.provider });

      const input = toJobDescriptionCreateInput(result, { userId: user.id, rawText, contentHash });
      const saved = await deps.jdRepo.createWithRequirements(input);

      return jsonResponse(201, {
        data: {
          jdId: saved.id,
          requirementCount: saved.requirementCount,
          duplicated: false,
          language: result.language,
          degraded: result.degraded,
          multiPosting: result.multiPosting,
          warnings: result.warnings,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createPreviewJdHandler(deps: JdsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = previewJdSchema.parse(await readJson(request));
      const rawText = body.rawText;
      const contentHash = hashContent(rawText);

      // 重复 JD：直接复用既有结果，不消耗 LLM 配额
      const existing = await deps.jdRepo.findByContentHash(user.id, contentHash);
      if (existing) {
        const full = await deps.jdRepo.findByIdForUserWithRequirements(existing.id, user.id);
        return jsonResponse(200, {
          data: {
            previewToken: null,
            jdId: existing.id,
            duplicated: true,
            title: existing.title,
            company: existing.company,
            requirementCount: existing.requirementCount,
            requirements: (full?.requirements ?? []).map((r) => ({
              id: r.id,
              text: r.text,
              category: r.category,
              criticality: r.criticality,
            })),
            warnings: ['检测到重复 JD，已复用既有解析结果。'],
          },
        });
      }

      const quota = await deps.llmCounter.consume(
        `llm:${user.id}`,
        deps.llmQuotaPerHour ?? hourlyQuotaFromEnv() ?? LLM_QUOTA_PER_HOUR,
        HOUR_MS,
      );
      if (!quota.allowed) {
        throw appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '调用次数已达上限，请稍后再试', {
          retryAfterSeconds: quota.retryAfterSeconds,
        });
      }

      const result = await parseJd(rawText, { provider: deps.provider });

      const previewToken = signPreview({
        rawTextHash: contentHash,
        title: result.title,
        company: result.company,
        language: result.language,
        requirements: result.requirements,
        degraded: result.degraded,
        multiPosting: result.multiPosting,
        warnings: result.warnings,
      });

      return jsonResponse(200, {
        data: {
          previewToken,
          jdId: null,
          duplicated: false,
          title: result.title,
          company: result.company,
          requirementCount: result.requirements.length,
          requirements: result.requirements.map((r) => ({
            text: r.text,
            category: r.category,
            criticality: r.criticality,
            verbatim: r.verbatim,
          })),
          warnings: result.warnings,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

export function createGetJdHandler(deps: JdsHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      // 数据隔离：查询强制带 userId；他人数据等同于不存在（返回 404，避免枚举）
      const jd = await deps.jdRepo.findByIdForUser(id, user.id);
      if (!jd) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 JD');

      // 前端需要展示解析出的要求清单：单独取带要求的投影（匹配逻辑复用同款读取）
      const full = await deps.jdRepo.findByIdForUserWithRequirements(id, user.id);
      const requirements = (full?.requirements ?? []).map((r) => ({
        id: r.id,
        text: r.text,
        category: r.category,
        criticality: r.criticality,
      }));

      return jsonResponse(200, {
        data: {
          id: jd.id,
          title: jd.title,
          company: jd.company,
          requirementCount: jd.requirementCount,
          requirements,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/jds/:id —— 仅更新 title；空串保存为 null。不触发解析/Match/ActionPlan 等任何其他业务。 */
export function createUpdateJdTitleHandler(deps: { auth: AuthService; jdRepo: JdRepository }) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = updateJdTitleSchema.parse(await readJson(request));
      const normalizedTitle = body.title.trim();
      const nextTitle = normalizedTitle.length > 0 ? normalizedTitle : null;

      // 数据隔离：findByIdForUser 已带 userId；跨用户 / 不存在 → null → 404
      const updated = await deps.jdRepo.updateTitle(id, user.id, nextTitle);
      if (!updated) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 JD');

      return jsonResponse(200, {
        data: {
          id: updated.id,
          title: updated.title,
          company: updated.company,
          requirementCount: updated.requirementCount,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/jds —— 前端列表/下拉：仅本人数据，倒序。不依赖 LLM provider */
export function createListJdsHandler(deps: { auth: AuthService; jdRepo: JdRepository }) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const items = await deps.jdRepo.listForUser(user.id);
      return jsonResponse(200, {
        data: {
          items: items.map((jd) => ({
            id: jd.id,
            title: jd.title,
            company: jd.company,
            requirementCount: jd.requirementCount,
            createdAt: jd.createdAt.toISOString(),
          })),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
