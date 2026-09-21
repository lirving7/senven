import { z } from 'zod';

import { MATCHER_VERSION, runMatch } from '../../domain/match/matcher.ts';
import type { SemanticMatcher } from '../../domain/match/matcher.ts';
import { toMatchRunCreateInput } from '../../domain/match/persistence.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type { Counter, JdRepository, MatchRepository, ResumeFactsRepository } from '../../ports/index.ts';
import { hourlyQuotaFromEnv } from '../../db/rate-limit.ts';

export const LLM_QUOTA_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

/**
 * strict()：出现多余字段（尤其 userId）直接 400。
 * T4 §19 要求 userId 只能来自会话，不允许出现在请求体里。
 */
const createMatchSchema = z
  .object({
    resumeId: z.string().trim().min(1, 'resumeId 不能为空'),
    jdId: z.string().trim().min(1, 'jdId 不能为空'),
  })
  .strict();

export type MatchesHandlerDeps = {
  auth: AuthService;
  resumeFacts: ResumeFactsRepository;
  jdRepo: JdRepository;
  matchRepo: MatchRepository;
  /** 不注入则只做确定性匹配 */
  semantic?: SemanticMatcher;
  llmCounter?: Counter;
  llmQuotaPerHour?: number;
};

/** 只在语义匹配真的被调用时才消耗配额，避免纯确定性匹配白白扣额度 */
function withQuota(
  semantic: SemanticMatcher,
  userId: string,
  counter: Counter | undefined,
  limit: number,
): SemanticMatcher {
  return async (req) => {
    if (counter) {
      const quota = await counter.consume(`llm:${userId}`, limit, HOUR_MS);
      if (!quota.allowed) {
        throw appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '调用次数已达上限，请稍后再试', {
          retryAfterSeconds: quota.retryAfterSeconds,
        });
      }
    }
    return semantic(req);
  };
}

export function createCreateMatchHandler(deps: MatchesHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = createMatchSchema.parse(await readJson(request));

      // 归属校验：非本人资源一律 null，统一映射为 404（不返回 403，避免枚举）
      const facts = await deps.resumeFacts.findFactsForResume(body.resumeId, user.id);
      if (facts === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历');

      const jd = await deps.jdRepo.findByIdForUserWithRequirements(body.jdId, user.id);
      if (jd === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 JD');
      if (jd.requirements.length === 0) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, '该 JD 还没有解析出的要求，请先解析岗位');
      }

      const semantic = deps.semantic
        ? withQuota(
            deps.semantic,
            user.id,
            deps.llmCounter,
            deps.llmQuotaPerHour ?? hourlyQuotaFromEnv() ?? LLM_QUOTA_PER_HOUR,
          )
        : undefined;

      const outcome = await runMatch(
        {
          requirements: jd.requirements.map((r) => ({
            id: r.id,
            text: r.text,
            category: r.category,
            criticality: r.criticality,
          })),
          facts,
        },
        { semantic },
      );

      // §11：简历没有确认过的事实时，这是正常业务状态，不是服务器异常
      if (!outcome.ok) {
        return jsonResponse(200, { data: { state: outcome.state, message: outcome.message } });
      }

      const saved = await deps.matchRepo.createRunWithItems(
        toMatchRunCreateInput(outcome, {
          userId: user.id,
          resumeId: body.resumeId,
          jdId: body.jdId,
          matcherVersion: MATCHER_VERSION,
        }),
      );

      return jsonResponse(201, {
        data: {
          runId: saved.id,
          matcherVersion: MATCHER_VERSION,
          summary: outcome.summary,
          items: outcome.items,
          createdAt: saved.createdAt.toISOString(),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/**
 * V1 修订 P1：GET /api/matches/:id —— 已持久化 Match 结果的只读回看。
 * userId 只来自会话；跨用户/不存在 → 404（无 oracle）；零 LLM、零写入、零 quota。
 */
export function createGetMatchHandler(deps: MatchesHandlerDeps) {
  return async function GET(_request: Request, runId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const cookie = _request.headers.get('cookie');
      const token = readCookie(cookie, SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const run = await deps.matchRepo.findRunWithItemsForUser(runId, user.id);
      if (run === null) throw appError(ERROR_CODE.NOT_FOUND, '岗位对照不存在');

      return jsonResponse(200, {
        data: {
          runId: run.id,
          matcherVersion: MATCHER_VERSION,
          summary: run.summary,
          items: run.items,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
