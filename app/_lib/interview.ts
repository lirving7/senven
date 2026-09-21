'use client';

/**
 * Interview V2-A —— 前端纯逻辑层（零 src/ import、零 node: import、零 fetch）。
 *
 * 为什么复刻常量而不 import src/：Next 15 webpack 不解析 node: scheme，
 * 前端组件链路 import src/ 会触发 UnhandledSchemeError（T6-4-C/D 实证）。
 * 端到端锁定由后端测试（tests/interview-api.test.ts）承担。
 */

// ─── 常量（与 src/domain/interview/interview.ts 复刻，改动需同步） ──────

export const INTERVIEW_MAX_TURNS = 8;
export const INTERVIEW_TOPIC_MAX = 200;
export const INTERVIEW_ANSWER_MAX = 4000;

// ─── 类型（与 API response 形状一致） ─────────────────────────────────

export type InterviewSessionItem = {
  id: string;
  jdId: string | null;
  topic: string;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InterviewFeedbackView = {
  schemaVersion: string;
  summary: string;
  score?: number;
  strengths: string[];
  improvements: string[];
};

export type InterviewTurnView = {
  id: string;
  turnOrder: number;
  question: string;
  answer: string | null;
  feedback: InterviewFeedbackView | null;
  createdAt: string;
  updatedAt: string;
};

export type InterviewDetail = InterviewSessionItem & { turns: InterviewTurnView[] };

export type InterviewJdOption = {
  id: string;
  title: string | null;
  company: string | null;
  requirementCount: number;
  createdAt: string;
};

// ─── 派生 ──────────────────────────────────────────────────────────

/** session 是否已结束（以服务端 endedAt 为准，前端不做归属判断） */
export function isInterviewEnded(s: Pick<InterviewSessionItem, 'endedAt'>): boolean {
  return s.endedAt !== null && s.endedAt !== undefined;
}

/** 最后一轮（服务端按 turnOrder ASC 返回） */
export function lastInterviewTurn(turns: InterviewTurnView[]): InterviewTurnView | null {
  const list = Array.isArray(turns) ? turns : [];
  return list.length > 0 ? list[list.length - 1]! : null;
}

/** 待回答的 Turn：最后一轮存在且 answer 为 null */
export function findPendingTurn(turns: InterviewTurnView[]): InterviewTurnView | null {
  const last = lastInterviewTurn(turns);
  return last !== null && last.answer === null ? last : null;
}

/** 是否还可以创建下一轮（未结束 + 无 pending + 未达 8 轮）——仅用于 UI 提示，权威判定在服务端 */
export function canAskNextQuestion(detail: InterviewDetail): boolean {
  if (isInterviewEnded(detail)) return false;
  if (findPendingTurn(detail.turns) !== null) return false;
  const count = Array.isArray(detail.turns) ? detail.turns.length : 0;
  return count < INTERVIEW_MAX_TURNS;
}

/** Turn 展示状态 */
export function interviewTurnState(t: Pick<InterviewTurnView, 'answer' | 'feedback'>): 'UNANSWERED' | 'EVALUATION_PENDING' | 'COMPLETED' {
  if (t.answer === null) return 'UNANSWERED';
  if (t.feedback === null) return 'EVALUATION_PENDING';
  return 'COMPLETED';
}

export const INTERVIEW_TURN_STATE_LABEL: Record<ReturnType<typeof interviewTurnState>, string> = {
  UNANSWERED: '待回答',
  EVALUATION_PENDING: '评估中',
  COMPLETED: '已点评',
};

// ─── 输入校验（与服务端边界一致；answer 不 trim） ────────────────────

export function isValidInterviewTopic(topic: string): boolean {
  const t = topic.trim();
  return t.length >= 1 && t.length <= INTERVIEW_TOPIC_MAX;
}

export function isValidInterviewAnswer(answer: string): boolean {
  return answer.length >= 1 && answer.length <= INTERVIEW_ANSWER_MAX;
}

// ─── task-session key（G-4：必须含 userId） ─────────────────────────

export function interviewTaskKey(kind: string, userId: string, ctx: string): string {
  return `iv-${kind}:${userId}:${ctx}`;
}

// ─── 429 quota 语义（§十：不显示成普通系统错误） ──────────────────────

export type QuotaBlocked = { kind: 'quota'; message: string; retryAfterSeconds: number | null };

/**
 * 把捕获的错误归类：429 LLM_QUOTA_EXCEEDED → quota 语义（含 Retry-After）；
 * 其它 → null（由调用方按普通错误处理）。不自动 retry。
 */
export function classifyInterviewQuotaError(err: unknown): QuotaBlocked | null {
  if (
    err !== null &&
    typeof err === 'object' &&
    'status' in err &&
    (err as { status?: unknown }).status === 429 &&
    'code' in err &&
    (err as { code?: unknown }).code === 'LLM_QUOTA_EXCEEDED'
  ) {
    const retryRaw = (err as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    const retryAfterSeconds = typeof retryRaw === 'number' && Number.isFinite(retryRaw) ? retryRaw : null;
    return {
      kind: 'quota',
      message: retryAfterSeconds !== null
        ? `面试练习次数已达上限（每 24 小时 10 次），请约 ${retryAfterSeconds >= 60 ? Math.ceil(retryAfterSeconds / 60) + ' 分钟' : retryAfterSeconds + ' 秒'}后再试`
        : '面试练习次数已达上限（每 24 小时 10 次），请明天再试',
      retryAfterSeconds,
    };
  }
  return null;
}

// ─── JD 下拉展示 ────────────────────────────────────────────────────

export function interviewJdOptionLabel(jd: InterviewJdOption): string {
  const title = jd.title && jd.title.trim() !== '' ? jd.title.trim() : '未命名岗位';
  return jd.company && jd.company.trim() !== '' ? `${title} · ${jd.company.trim()}` : title;
}
