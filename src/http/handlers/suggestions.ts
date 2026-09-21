import { z } from 'zod';

import { generateSuggestions } from '../../domain/suggestion/generate.ts';
import type { ConfirmedFactRef } from '../../domain/suggestion/generate.ts';
import { toSuggestionCreateInputs } from '../../domain/suggestion/persistence.ts';
import { SUGGESTION_KIND } from '../../domain/suggestion/types.ts';
import { EVIDENCE_SOURCE, FACT_STATUS } from '../../domain/types.ts';
import type { EvidenceSource } from '../../domain/types.ts';
import { appError, ERROR_CODE } from '../../errors.ts';
import { readCookie, SESSION_COOKIE } from '../cookies.ts';
import { errorResponse, jsonResponse, newRequestId, readJson } from '../request.ts';
import type { AuthService } from '../../auth/service.ts';
import type {
  MatchRepository,
  ResumeEntriesRepository,
  ResumeFactsRepository,
  SuggestionRepository,
} from '../../ports/index.ts';
import type { Counter } from '../../ports/index.ts';
import { hourlyQuotaFromEnv } from '../../db/rate-limit.ts';
import type { RephrasePort } from '../../domain/suggestion/rephrase.ts';

const TRUSTED_SOURCES: readonly EvidenceSource[] = [
  EVIDENCE_SOURCE.RESUME_TEXT,
  EVIDENCE_SOURCE.USER_STATEMENT,
];
const HOUR_MS = 60 * 60 * 1000;
export const SUGGESTION_LLM_QUOTA_PER_HOUR = 20;

const createBodySchema = z
  .object({
    resumeId: z.string().trim().min(1, 'resumeId 不能为空'),
    matchRunId: z.string().trim().min(1, 'matchRunId 不能为空'),
  })
  .strict();

const patchBodySchema = z.object({ action: z.enum(['ACCEPT', 'SKIP']) }).strict();

export type SuggestionsHandlerDeps = {
  auth: AuthService;
  matchRepo: MatchRepository;
  resumeEntries: ResumeEntriesRepository;
  resumeFacts: ResumeFactsRepository;
  suggestions: SuggestionRepository;
  /** 不注入则不产出 REPHRASE */
  rephrase?: RephrasePort;
  llmCounter?: Counter;
  llmQuotaPerHour?: number;
};

/** POST /api/suggestions —— 基于一次 MatchRun 生成修改建议 */
export function createGenerateSuggestionsHandler(deps: SuggestionsHandlerDeps) {
  return async function POST(request: Request): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = createBodySchema.parse(await readJson(request));

      const run = await deps.matchRepo.findRunWithItemsForUser(body.matchRunId, user.id);
      if (run === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该匹配记录');
      if (run.resumeId !== body.resumeId) {
        throw appError(ERROR_CODE.VALIDATION_FAILED, 'resumeId 与该匹配记录不一致');
      }

      const entries = await deps.resumeEntries.findEntriesForResume(body.resumeId, user.id);
      if (entries === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历');

      const facts = await deps.resumeFacts.findFactsForResume(body.resumeId, user.id);
      const confirmedFacts: ConfirmedFactRef[] = (facts ?? [])
        .filter((f) => f.status === FACT_STATUS.CONFIRMED)
        .map((f) => ({
          key: f.key,
          label: f.label,
          excerpt: f.evidence
            .filter((r) => TRUSTED_SOURCES.includes(r.source) && (r.excerpt ?? '').trim().length > 0)
            .map((r) => r.excerpt as string)
            .join(' / '),
        }))
        .filter((f) => f.excerpt.length > 0);

      let rephrase = deps.rephrase;
      if (rephrase && deps.llmCounter) {
        const inner = rephrase;
        rephrase = async (req) => {
          const quota = await deps.llmCounter!.consume(
            `llm:${user.id}`,
            deps.llmQuotaPerHour ?? hourlyQuotaFromEnv() ?? SUGGESTION_LLM_QUOTA_PER_HOUR,
            HOUR_MS,
          );
          if (!quota.allowed) {
            throw appError(ERROR_CODE.LLM_QUOTA_EXCEEDED, '调用次数已达上限，请稍后再试', {
              retryAfterSeconds: quota.retryAfterSeconds,
            });
          }
          return inner(req);
        };
      }

      const outcome = await generateSuggestions(
        { matchRunId: run.id, items: run.items, resumeEntries: entries, confirmedFacts },
        { rephrase },
      );

      if (!outcome.ok) {
        return jsonResponse(200, { data: { state: outcome.state, message: outcome.message, suggestions: [] } });
      }

      const saved = await deps.suggestions.createMany(
        toSuggestionCreateInputs(outcome.drafts, { resumeId: body.resumeId }),
      );

      return jsonResponse(201, {
        data: {
          suggestions: outcome.drafts.map((d, i) => ({
            id: saved[i]?.id ?? null,
            kind: d.kind,
            requirement: d.requirement,
            targetField: d.targetField,
            before: d.before,
            after: d.after,
            reason: d.reason,
            evidenceRefs: d.evidenceRefs,
            needsUserConfirmation: d.needsUserConfirmation,
          })),
          // 因可能引入新事实而被丢弃的建议，如实告知用户
          rejected: outcome.rejected,
        },
      });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}

/** PATCH /api/suggestions/:id —— 采用 / 跳过 */
export function createResolveSuggestionHandler(deps: SuggestionsHandlerDeps) {
  return async function PATCH(request: Request, id: string): Promise<Response> {
    const requestId = newRequestId();
    try {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      const user = await deps.auth.getCurrentUser(token);
      if (!user) throw appError(ERROR_CODE.UNAUTHENTICATED, '请先登录');

      const body = patchBodySchema.parse(await readJson(request));

      const rec = await deps.suggestions.findForUser(id, user.id);
      if (rec === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该建议');
      if (rec.status !== 'PENDING') {
        throw appError(ERROR_CODE.SUGGESTION_ALREADY_RESOLVED, '该建议已经处理过了');
      }

      if (body.action === 'SKIP') {
        await deps.suggestions.updateStatus(id, 'SKIPPED');
        return jsonResponse(200, { data: { id, status: 'SKIPPED', applied: false } });
      }

      // ACCEPT：只有 REPHRASE 是文本改写，其余两类不能被写进简历
      if (rec.kind !== SUGGESTION_KIND.REPHRASE) {
        throw appError(
          ERROR_CODE.SUGGESTION_NOT_APPLICABLE,
          '这类建议是补充指引，不能直接写入简历。请先补充真实经历。',
        );
      }
      if (rec.after === null) {
        throw appError(ERROR_CODE.SUGGESTION_NOT_APPLICABLE, '该建议没有可写入的内容');
      }

      const applied = await deps.suggestions.applyTextChange(rec.resumeId, user.id, rec.targetField, rec.after);
      if (!applied) {
        throw appError(ERROR_CODE.SUGGESTION_NOT_APPLICABLE, '该建议的目标字段暂不支持自动写入');
      }

      await deps.suggestions.updateStatus(id, 'ACCEPTED');
      return jsonResponse(200, { data: { id, status: 'ACCEPTED', applied: true } });
    } catch (err) {
      return errorResponse(err, requestId);
    }
  };
}
