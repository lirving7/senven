/**
 * T4-5：Interview（模拟面试）handler。
 *
 * 独立 Deps：**故意不含** Capability / CapabilityEvidence / Skill / ProjectResult /
 * Resume / Evidence 写仓储 —— 从依赖类型层面即不可能写入事实层（ADR-015 §9）。
 *
 * PATCH Turn 三阶段（ADR-015 C-2）：
 *   Stage 1（repository.saveAnswer，锁 Session 行）→ 写 answer / 三态判定
 *   Stage 2（handler 无锁）→ quota gate → provider → strict validation（retry=0）
 *   Stage 3（repository.commitFeedback，锁 Session 行）→ 原子写 feedback
 */
import { z } from 'zod';

import { appError, AppError, ERROR_CODE } from '../../errors.ts';
import type { AuthService } from '../../auth/service.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import { generateJsonWithUsage } from '../../llm/usage-gate.ts';
import type { LLMProvider } from '../../llm/provider.ts';
import { LLMError } from '../../llm/provider.ts';
import { LLM_FEATURE } from '../../ports/index.ts';
import type {
  Clock,
  InterviewRepository,
  InterviewSessionRecord,
  InterviewTurnRecord,
  JdRepository,
  LlmFeature,
  LlmUsageRepository,
} from '../../ports/index.ts';
import {
  buildFeedbackPrompt,
  buildFeedbackSystemPrompt,
  buildQuestionPrompt,
  buildQuestionSystemPrompt,
  isValidAnswer,
  isValidTopic,
  MAX_INTERVIEW_TURNS,
  validateFeedbackOutput,
  validateQuestionOutput,
} from '../../domain/interview/interview.ts';
import { AiAnalysisInvalidResponseError } from '../../domain/ai/analyze-project.ts';

/**
 * V-2：把 provider 的 LLMError 翻译成 Interview 域错误（ADR-015 C-3 §5）。
 * 避免 LLMError 落到全局 error-mapping 的 FORMAT→JD_SHAPE_INVALID（JD 域错误码外溢）。
 * - FORMAT（provider 无法解析/生成 JSON）→ 502 UPSTREAM_ERROR
 * - TIMEOUT → 504 UPSTREAM_TIMEOUT
 * - RATE_LIMIT → 429 RATE_LIMITED
 * - AUTH → 500 INTERNAL_ERROR
 * - UPSTREAM → 502 UPSTREAM_ERROR
 */
function translateProviderError(err: unknown): never {
  if (err instanceof LLMError) {
    switch (err.code) {
      case 'FORMAT':
        throw appError(ERROR_CODE.UPSTREAM_ERROR, '面试服务暂时不可用');
      case 'TIMEOUT':
        throw appError(ERROR_CODE.UPSTREAM_TIMEOUT, '面试服务超时，请重试');
      case 'RATE_LIMIT':
        throw appError(ERROR_CODE.RATE_LIMITED, '请求过于频繁，请稍后再试');
      case 'AUTH':
        throw appError(ERROR_CODE.INTERNAL_ERROR, '服务配置异常，请联系管理员');
      case 'UPSTREAM':
      default:
        throw appError(ERROR_CODE.UPSTREAM_ERROR, '面试服务暂时不可用');
    }
  }
  throw err;
}

export type InterviewHandlerDeps = {
  auth: AuthService;
  interviews: InterviewRepository;
  /**
   * Interview V2-A（D-1）：只读、user-scoped 的 JD 原文读取（JD grounding）。
   * 刻意用 `Pick<JdRepository, 'findRawTextForUser'>` —— 结构上不可能经由本 deps
   * 写任何 JD / Resume / 事实层数据（ADR-015 §9 不变）。
   */
  jdTexts: Pick<JdRepository, 'findRawTextForUser'>;
  provider: LLMProvider;
  usage: LlmUsageRepository;
  clock: Clock;
};

async function requireUser(deps: InterviewHandlerDeps, request: Request) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  const user = await deps.auth.getCurrentUser(token);
  if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');
  return user;
}

const CreateSessionBodySchema = z
  .object({
    topic: z.string().min(1, 'topic 不能为空').max(200, 'topic 不能超过 200 字'),
    jdId: z.string().trim().min(1).optional().nullable(),
  })
  .strict();

const EmptyBodySchema = z.object({}).strict();

/** PATCH turn：strict body，仅允许 answer */
const PatchTurnBodySchema = z
  .object({
    answer: z.string().min(1, 'answer 不能为空').max(4000, 'answer 不能超过 4000 字'),
  })
  .strict();

/** V-3：question 结构化输出 schema（JSON Schema draft） */
const QUESTION_SCHEMA = {
  type: 'object',
  properties: { question: { type: 'string' } },
  required: ['question'],
  additionalProperties: false,
} as const;

/** V-3：feedback 结构化输出 schema（interview-feedback/v1，严格） */
const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', const: 'interview-feedback/v1' },
    summary: { type: 'string' },
    score: { type: 'integer', minimum: 0, maximum: 100 },
    strengths: { type: 'array', maxItems: 10, items: { type: 'string' } },
    improvements: { type: 'array', maxItems: 10, items: { type: 'string' } },
  },
  required: ['schemaVersion', 'summary', 'strengths', 'improvements'],
  additionalProperties: false,
} as const;

function toSessionResponse(s: InterviewSessionRecord) {
  return {
    id: s.id,
    jdId: s.jdId,
    topic: s.topic,
    endedAt: s.endedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

function toTurnResponse(t: InterviewTurnRecord) {
  return {
    id: t.id,
    turnOrder: t.turnOrder,
    question: t.question,
    answer: t.answer,
    feedback: t.feedback,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

/**
 * Interview V2-A（D-1 / F-1）：解析 session.jdId → **当前用户自己的** JD 真实原文。
 * - session 无 jdId → null（prompt 无 JD，与既有 API 语义一致）
 * - jdId 不存在 / 不属于当前用户（跨用户）→ null —— 跨用户 JD 绝不进入 prompt
 * - F-1 修复：此前 handler 直接把 jdId（cuid）当 jdText 传入 prompt，此处彻底纠正
 */
async function resolveJdText(deps: InterviewHandlerDeps, jdId: string | null, userId: string): Promise<string | null> {
  if (!jdId) return null;
  return deps.jdTexts.findRawTextForUser(jdId, userId);
}

/** POST /api/interview-sessions —— 创建 session */
export function createCreateInterviewSessionHandler(deps: InterviewHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = CreateSessionBodySchema.parse(await readJson(request));
      const topic = body.topic.trim();
      if (!isValidTopic(topic)) throw appError(ERROR_CODE.VALIDATION_FAILED, 'topic 长度须为 1–200 字');

      const outcome = await deps.interviews.createSession({
        userId: user.id,
        jdId: body.jdId ?? null,
        topic,
      });
      if (outcome.kind === 'CREATED') {
        return jsonResponse(201, { data: toSessionResponse(outcome.session) });
      }
      throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/interview-sessions —— 全量 active + ended，createdAt DESC id DESC */
export function createListInterviewSessionsHandler(deps: InterviewHandlerDeps) {
  return async function GET(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const items = await deps.interviews.listForUser(user.id);
      return jsonResponse(200, { data: { items: items.map(toSessionResponse) } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** GET /api/interview-sessions/:id —— 详情（session + turns，turnOrder ASC） */
export function createGetInterviewSessionHandler(deps: InterviewHandlerDeps) {
  return async function GET(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const detail = await deps.interviews.findForUser(id, user.id);
      if (!detail) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      return jsonResponse(200, {
        data: {
          ...toSessionResponse(detail.session),
          turns: detail.turns.map(toTurnResponse),
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/interview-sessions/:id/end —— 结束（幂等） */
export function createEndInterviewSessionHandler(deps: InterviewHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      EmptyBodySchema.parse(await readJson(request));
      const outcome = await deps.interviews.end(id, user.id, deps.clock.now());
      switch (outcome.kind) {
        case 'ENDED':
          return jsonResponse(200, { data: toSessionResponse(outcome.session) });
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** POST /api/interview-sessions/:id/turns —— 创建下一轮（question 由 provider 生成，失败不建行） */
export function createCreateInterviewTurnHandler(deps: InterviewHandlerDeps) {
  return async function POST(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      EmptyBodySchema.parse(await readJson(request));

      // 先取 session（用于组装 prompt）；非本人/不存在 → 404
      const detail = await deps.interviews.findForUser(id, user.id);
      if (!detail) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');

      // 前置资格检查（provider 调用之前的短事务）：锁 Session 行 → reread endedAt → 检查 pending。
      // 存在未回答 Turn / 已结束时立即短路 409，provider 调用 0 次、quota 不消耗。
      // 注意：这只是快速短路；provider 成功后的 createTurn 仍会锁内再次检查，处理并发。
      const eligibility = await deps.interviews.checkTurnEligibility(id, user.id);
      switch (eligibility.kind) {
        case 'SESSION_ENDED':
          throw appError(ERROR_CODE.INTERVIEW_SESSION_ENDED, '面试已结束，不能继续提问');
        case 'TURN_PENDING':
          throw appError(ERROR_CODE.INTERVIEW_TURN_PENDING, '上一题尚未回答，请先作答');
        case 'TURN_LIMIT_REACHED':
          // Interview V2-A（D-2）：第 9 轮在此短路 —— provider 0 次 / quota 0 / 不建 Turn
          throw appError(ERROR_CODE.INTERVIEW_TURN_CONFLICT, `一场面试最多 ${MAX_INTERVIEW_TURNS} 轮，已达轮次上限`);
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
        case 'OK':
          break;
      }

      // F-1：解析当前用户自己的 JD 原文（跨用户 / 不存在 → null）
      const jdText = await resolveJdText(deps, detail.session.jdId, user.id);

      // Stage：provider 生成 question（quota gate + strict validation，retry=0）。
      // provider failure / malformed → 抛错，不创建 Turn 行。
      let questionRaw: unknown;
      try {
        questionRaw = await generateJsonWithUsage<unknown>(
          { usage: deps.usage, clock: deps.clock },
          {
            userId: user.id,
            feature: LLM_FEATURE.INTERVIEW as LlmFeature,
            provider: deps.provider,
            request: {
              system: buildQuestionSystemPrompt(),
              prompt: buildQuestionPrompt(detail.session.topic, jdText, detail.turns.map((t) => ({ question: t.question, answer: t.answer, feedback: t.feedback }))),
              schema: QUESTION_SCHEMA as unknown as Record<string, unknown>,
              // ARCH-1：Interview 显式 opt-in schema-in-prompt（既有 6 特性默认不触发）
              schemaInPrompt: true,
            },
          },
        );
      } catch (err) {
        translateProviderError(err);
      }
      const qv = validateQuestionOutput(questionRaw);
      if (!qv.ok) {
        // V-5：reason 只进服务端诊断日志（由 errorResponse 的 details 记录），不进入客户端响应
        throw appError(ERROR_CODE.AI_ANALYSIS_INVALID_RESPONSE, '面试问题生成结果结构异常，请重试', { reason: qv.reason });
      }

      // 锁 Session 行创建 Turn（锁内**再次**检查 pending + 计算 turnOrder）。
      // 若 provider 调用期间另一请求已创建 unanswered Turn，此处会返回 TURN_PENDING（并发兜底）。
      const outcome = await deps.interviews.createTurn(id, user.id, qv.question);
      switch (outcome.kind) {
        case 'CREATED':
          return jsonResponse(201, { data: toTurnResponse(outcome.turn) });
        case 'SESSION_ENDED':
          throw appError(ERROR_CODE.INTERVIEW_SESSION_ENDED, '面试已结束，不能继续提问');
        case 'TURN_PENDING':
          throw appError(ERROR_CODE.INTERVIEW_TURN_PENDING, '上一题尚未回答，请先作答');
        case 'TURN_LIMIT_REACHED':
          // D-2：锁内并发兜底（provider 已调用，但不落第 9 行）
          throw appError(ERROR_CODE.INTERVIEW_TURN_CONFLICT, `一场面试最多 ${MAX_INTERVIEW_TURNS} 轮，已达轮次上限`);
        case 'TURN_CONFLICT':
          throw appError(ERROR_CODE.INTERVIEW_TURN_CONFLICT, '并发冲突，请重试');
        case 'NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/interview-sessions/:id/turns/:turnId —— 提交 answer（三阶段） */
export function createPatchInterviewTurnHandler(deps: InterviewHandlerDeps) {
  return async function PATCH(request: Request, id: string, turnId: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const user = await requireUser(deps, request);
      const body = PatchTurnBodySchema.parse(await readJson(request));
      if (!isValidAnswer(body.answer)) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, 'answer 长度须为 1–4000 字');
      }

      // Stage 1：锁 Session 行，写 answer / 三态判定
      const stage1 = await deps.interviews.saveAnswer(user.id, { sessionId: id, turnId, answer: body.answer });
      switch (stage1.kind) {
        case 'COMPLETED_SAME':
          // 已完成 + same answer → 200 existing，不调用 LLM
          return jsonResponse(200, { data: toTurnResponse(stage1.turn) });
        case 'SESSION_ENDED':
          throw appError(ERROR_CODE.INTERVIEW_SESSION_ENDED, '面试已结束，不能提交答案');
        case 'TURN_NOT_FOUND':
          throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
        case 'ANSWER_IMMUTABLE':
          throw appError(ERROR_CODE.INTERVIEW_ANSWER_IMMUTABLE, '该轮答案已提交，不可修改');
        case 'SAVED':
        case 'PENDING_RETRY':
          // 进入 Stage 2（评估）
          break;
      }

      // Stage 2：无 DB 锁，quota gate + provider + strict validation（retry=0）
      const sessionDetail = await deps.interviews.findForUser(id, user.id);
      if (!sessionDetail) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');
      const turn = sessionDetail.turns.find((t) => t.id === turnId);
      if (!turn) throw appError(ERROR_CODE.NOT_FOUND, '未找到对应资源');

      let feedback: unknown;
      try {
        // F-1：feedback prompt 同样使用当前用户自己的 JD 真实原文（跨用户 / 不存在 → null）
        const jdText = await resolveJdText(deps, sessionDetail.session.jdId, user.id);
        const feedbackRaw = await generateJsonWithUsage<unknown>(
          { usage: deps.usage, clock: deps.clock },
          {
            userId: user.id,
            feature: LLM_FEATURE.INTERVIEW as LlmFeature,
            provider: deps.provider,
            request: {
              system: buildFeedbackSystemPrompt(),
              prompt: buildFeedbackPrompt(sessionDetail.session.topic, turn.question, body.answer, jdText),
              schema: FEEDBACK_SCHEMA as unknown as Record<string, unknown>,
              // ARCH-1：Interview 显式 opt-in schema-in-prompt（既有 6 特性默认不触发）
              schemaInPrompt: true,
            },
          },
        );
        const fv = validateFeedbackOutput(feedbackRaw);
        if (!fv.ok) {
          // V-5：reason 只进服务端诊断日志，不进入客户端响应
          throw appError(ERROR_CODE.AI_ANALYSIS_INVALID_RESPONSE, '面试反馈结果结构异常，请重试', { reason: fv.reason });
        }
        feedback = fv.feedback;
      } catch (err) {
        // V-1：配额不足（429）时保留原 retryAfterSeconds，并 additive merge client 键。
        // answer 已保存（Stage 1），feedback 保持 NULL，可同 answer 重试。
        if (err instanceof AppError && err.code === ERROR_CODE.LLM_QUOTA_EXCEEDED) {
          const retryAfterSeconds = (err.details as { retryAfterSeconds?: number } | null)?.retryAfterSeconds;
          throw appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '调用次数已达上限，请稍后再试', {
            ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
            client: { answerSaved: true, feedback: null },
          });
        }
        // V-2：provider LLMError → Interview 域错误（避免 JD_SHAPE_INVALID 外溢）
        translateProviderError(err);
      }

      // Stage 3：锁 Session 行，原子写 feedback（校验 pending + answer 一致）
      const stage3 = await deps.interviews.commitFeedback(user.id, { sessionId: id, turnId, answer: body.answer, feedback });
      switch (stage3.kind) {
        case 'COMMITTED':
          return jsonResponse(200, { data: toTurnResponse(stage3.turn) });
        case 'SESSION_ENDED':
          throw appError(ERROR_CODE.INTERVIEW_SESSION_ENDED, '面试已结束，评估结果未保存');
        case 'NOT_PENDING':
        case 'ANSWER_MISMATCH':
        case 'TURN_NOT_FOUND':
          throw appError(ERROR_CODE.INTERVIEW_ANSWER_IMMUTABLE, '该轮答案已提交，不可修改');
      }
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
