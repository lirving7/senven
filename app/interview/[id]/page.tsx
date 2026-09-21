'use client';

/**
 * Interview V2-A —— 面试对话详情页（§三）。
 *
 * 只消费既有 API：
 *   GET   /api/interview-sessions/:id                详情（session + turns）
 *   POST  /api/interview-sessions/:id/turns          下一轮（question 由 AI 生成）
 *   PATCH /api/interview-sessions/:id/turns/:turnId  提交回答（→ AI 点评）
 *   POST  /api/interview-sessions/:id/end            结束面试（幂等）
 *
 * 429（LLM_QUOTA_EXCEEDED）显示 quota 语义 + Retry-After，不自动重试（§十）；
 * ownership 全部由后端 401/404 保证，前端不判 userId（§九）。
 */

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { api, errorText } from '../../_lib/api';
import { useAuth } from '../../_lib/auth';
import { EmptyState, ErrorState, LoadingState } from '../../_components/StatePanel';
import { startTask } from '../../_lib/task-session';
import {
  INTERVIEW_ANSWER_MAX,
  INTERVIEW_MAX_TURNS,
  canAskNextQuestion,
  classifyInterviewQuotaError,
  findPendingTurn,
  interviewTaskKey,
  interviewTurnState,
  INTERVIEW_TURN_STATE_LABEL,
  isInterviewEnded,
  isValidInterviewAnswer,
  type InterviewDetail,
} from '../../_lib/interview';

type DetailPayload = { data: InterviewDetail };

/** 写操作结果：429 → 携带 quota 语义（§十），其余为普通错误 */
type OpOutcome = { kind: 'result'; data: true } | { kind: 'error'; message: string; quota: string | null };

async function runOp(run: () => Promise<void>): Promise<OpOutcome> {
  try {
    await run();
    return { kind: 'result' as const, data: true };
  } catch (e) {
    const q = classifyInterviewQuotaError(e);
    return { kind: 'error' as const, message: errorText(e), quota: q?.message ?? null };
  }
}

export default function InterviewSessionPage() {
  const params = useParams<{ id: string }>();
  const sessionId = typeof params?.id === 'string' ? params.id : '';
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [detail, setDetail] = useState<InterviewDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailRequestId, setDetailRequestId] = useState<string | undefined>(undefined);

  const [answer, setAnswer] = useState('');
  const [answerErr, setAnswerErr] = useState<string | null>(null);
  const [quota, setQuota] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [ending, setEnding] = useState(false);

  const userId = user?.id ?? 'anon';

  const load = useCallback(async () => {
    setDetailErr(null);
    try {
      const res = await api<DetailPayload>(`/api/interview-sessions/${sessionId}`);
      setDetail(res.data);
    } catch (e) {
      const err = e as { requestId?: string };
      setDetailRequestId(err.requestId);
      setDetailErr(errorText(e));
    }
  }, [sessionId]);

  useEffect(() => {
    if (!user || sessionId === '') return;
    void load();
  }, [user, sessionId, load]);

  const ended = detail !== null && isInterviewEnded(detail);
  const pending = detail !== null ? findPendingTurn(detail.turns) : null;
  const askable = detail !== null && canAskNextQuestion(detail);

  /** 提交回答 → AI 点评（同 key 去重，防重复点击/StrictMode 重复请求） */
  async function submitAnswer() {
    if (submitting || pending === null) return;
    if (!isValidInterviewAnswer(answer)) {
      setAnswerErr(`回答长度须为 1–${INTERVIEW_ANSWER_MAX} 字`);
      return;
    }
    setSubmitting(true);
    setAnswerErr(null);
    setQuota(null);
    const outcome = (await startTask<true>(
      interviewTaskKey('answer', userId, `${sessionId}:${pending.id}`),
      () => runOp(async () => {
        await api(`/api/interview-sessions/${sessionId}/turns/${pending.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ answer }),
        });
      }),
    )) as OpOutcome;
    setSubmitting(false);
    if (outcome.kind === 'error') {
      if (outcome.quota !== null) setQuota(outcome.quota);
      else setAnswerErr(outcome.message);
      return;
    }
    setAnswer('');
    await load();
  }

  /** 下一轮（AI 出题；quota 走 INTERVIEW 10/24h） */
  async function askNext() {
    if (asking || detail === null) return;
    setAsking(true);
    setQuota(null);
    setAnswerErr(null);
    const outcome = (await startTask<true>(
      interviewTaskKey('next', userId, sessionId),
      () => runOp(async () => {
        await api(`/api/interview-sessions/${sessionId}/turns`, { method: 'POST', body: JSON.stringify({}) });
      }),
    )) as OpOutcome;
    setAsking(false);
    if (outcome.kind === 'error') {
      if (outcome.quota !== null) setQuota(outcome.quota);
      else setAnswerErr(outcome.message);
      return;
    }
    await load();
  }

  /** 结束面试（幂等；确认后不可继续提问） */
  async function endSession() {
    if (ending || detail === null || ended) return;
    if (!window.confirm('确定结束这场面试吗？结束后不能再回答或提问。')) return;
    setEnding(true);
    setQuota(null);
    setAnswerErr(null);
    const outcome = (await startTask<true>(
      interviewTaskKey('end', userId, sessionId),
      () => runOp(async () => {
        await api(`/api/interview-sessions/${sessionId}/end`, { method: 'POST', body: JSON.stringify({}) });
      }),
    )) as OpOutcome;
    setEnding(false);
    if (outcome.kind === 'error') {
      if (outcome.quota !== null) setQuota(outcome.quota);
      else setAnswerErr(outcome.message);
      return;
    }
    await load();
  }

  if (authLoading || (user !== null && detail === null && detailErr === null)) {
    return (
      <main className="content-wrap">
        <h1>模拟面试</h1>
        <LoadingState />
      </main>
    );
  }

  if (!user) {
    return (
      <main className="content-wrap">
        <h1>模拟面试</h1>
        <ErrorState message="请先登录后使用模拟面试" />
      </main>
    );
  }

  if (detailErr) {
    return (
      <main className="content-wrap">
        <h1>模拟面试</h1>
        <ErrorState message={detailErr} requestId={detailRequestId} onRetry={() => void load()} />
        <p><Link href="/interview">← 返回面试列表</Link></p>
      </main>
    );
  }

  if (detail === null) return null;

  return (
    <main className="content-wrap">
      <p className="muted"><Link href="/interview">← 返回面试列表</Link></p>
      <h1>{detail.topic}</h1>
      <p className="muted">
        {ended ? '已结束' : '进行中'} · 第 {detail.turns.length}/{INTERVIEW_MAX_TURNS} 轮
        {detail.jdId !== null ? ' · 已关联 JD' : ''}
      </p>

      {/* 历史轮次回看 */}
      <section style={{ display: 'grid', gap: 12, marginTop: 16 }}>
        {detail.turns.map((t) => {
          const state = interviewTurnState(t);
          return (
            <div key={t.id} className="card">
              <div className="row-between">
                <strong>第 {t.turnOrder} 轮 · 问题</strong>
                <span className="chip">{INTERVIEW_TURN_STATE_LABEL[state]}</span>
              </div>
              <p style={{ marginTop: 6 }}>{t.question}</p>
              {t.answer !== null && (
                <>
                  <div className="muted" style={{ marginTop: 8 }}>我的回答</div>
                  <p style={{ whiteSpace: 'pre-wrap' }}>{t.answer}</p>
                </>
              )}
              {t.feedback !== null && (
                <div style={{ marginTop: 10 }}>
                  <div className="muted">AI 点评（练习参考，不构成任何能力认定）</div>
                  <p>{t.feedback.summary}{typeof t.feedback.score === 'number' ? `（评分 ${t.feedback.score}/100）` : ''}</p>
                  {Array.isArray(t.feedback.strengths) && t.feedback.strengths.length > 0 && (
                    <p>做得好：{t.feedback.strengths.join('；')}</p>
                  )}
                  {Array.isArray(t.feedback.improvements) && t.feedback.improvements.length > 0 && (
                    <p>可改进：{t.feedback.improvements.join('；')}</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {detail.turns.length === 0 && !ended && (
          <EmptyState title="还没有第一道题。点击下方「生成第一题」开始。" />
        )}
      </section>

      {/* 429 quota 语义（§十：单独展示，含 Retry-After；不自动重试） */}
      {quota && <div role="status" className="banner banner-warn" style={{ marginTop: 12 }}>{quota}</div>}
      {answerErr && <div role="alert" className="banner banner-error" style={{ marginTop: 12 }}>{answerErr}</div>}

      {/* 操作区 */}
      {!ended && (
        <section className="card" style={{ marginTop: 16 }}>
          {pending !== null ? (
            <>
              <h2>回答第 {pending.turnOrder} 轮</h2>
              <textarea
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={INTERVIEW_ANSWER_MAX}
                rows={6}
                placeholder="输入你的回答（提交后不可修改）"
              />
              <div className="row-between" style={{ marginTop: 8 }}>
                <span className="muted small">{answer.length}/{INTERVIEW_ANSWER_MAX}</span>
                <button className="btn btn-primary" disabled={submitting} onClick={() => void submitAnswer()}>
                  {submitting ? '提交中…' : '提交回答'}
                </button>
              </div>
            </>
          ) : askable ? (
            <div className="row-between">
              <span className="muted">本轮已完成点评，可以继续下一题。</span>
              <button className="btn btn-primary" disabled={asking} onClick={() => void askNext()}>
                {asking ? '出题中…' : detail.turns.length === 0 ? '生成第一题' : '下一题'}
              </button>
            </div>
          ) : (
            <p className="muted">
              已达 {INTERVIEW_MAX_TURNS} 轮上限。点击「结束面试」收尾，或回顾上方问答记录。
            </p>
          )}
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-danger" disabled={ending} onClick={() => void endSession()}>
              {ending ? '结束中…' : '结束面试'}
            </button>
          </div>
        </section>
      )}

      {ended && (
        <section className="card" style={{ marginTop: 16 }}>
          <p className="muted">面试已结束。以上为完整问答与点评记录（仅供练习复盘参考）。</p>
          <button className="btn btn-secondary" onClick={() => router.push('/interview')}>返回列表</button>
        </section>
      )}
    </main>
  );
}
