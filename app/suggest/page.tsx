'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { PageHeader } from '../_components/PageHeader';
import { WorkflowTrail } from '../_components/WorkflowTrail';
import {
  startTask,
  isTaskRunning,
  getTaskStartedAt,
  getTaskOutcome,
  clearTask,
  type TaskOutcome,
} from '../_lib/task-session';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../_components/StatePanel';
import { EvidenceRef, type EvidenceItem } from '../_components/EvidenceRef';
import { IconChevronRight } from '../_components/icons';

type Suggestion = {
  id: string | null;
  kind: 'REPHRASE' | 'CONFIRM_FACT' | 'GUIDANCE';
  requirement: string | null;
  targetField: string;
  before: string | null;
  after: string | null;
  reason: string;
  evidenceRefs: EvidenceItem[];
};

const KIND_LABEL: Record<Suggestion['kind'], string> = {
  REPHRASE: '改写表达',
  CONFIRM_FACT: '先确认事实',
  GUIDANCE: '补充指引',
};

function SuggestPage() {
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const resumeId = params.get('resumeId') ?? '';
  const matchRunId = params.get('matchRunId') ?? '';

  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [rejected, setRejected] = useState<Array<{ title: string; reason: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  // G-4：任务 key 含 userId（换账号不串数据）；同 key 在途去重、已完成结果恢复（消除重挂载重复 LLM）
  const taskKey = user ? `suggest:${user.id}:${resumeId}:${matchRunId}` : '';

  function applyOutcome(outcome: TaskOutcome<{ suggestions: Suggestion[]; rejected: Array<{ title: string; reason: string }> }>) {
    setBusy(false);
    if (outcome.kind === 'result') {
      setItems(outcome.data.suggestions);
      setRejected(outcome.data.rejected);
      setErr(null);
    } else {
      setErr(outcome.message);
    }
  }

  // G-4：重挂载恢复 —— 在途则继续等待同一请求（不重复 POST）
  useEffect(() => {
    if (!user || !taskKey || !isTaskRunning(taskKey)) return;
    setBusy(true);
    setElapsed(Math.floor((Date.now() - (getTaskStartedAt(taskKey) ?? Date.now())) / 1000));
    void startTask<{ suggestions: Suggestion[]; rejected: Array<{ title: string; reason: string }> }>(
      taskKey,
      () => Promise.reject(new Error('unreachable')),
    ).then(applyOutcome).catch(() => setBusy(false));
  }, [user, taskKey]);

  useEffect(() => {
    if (busy) {
      const startedAt = getTaskStartedAt(taskKey);
      const t = setInterval(() => {
        setElapsed(startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
      }, 500);
      return () => clearInterval(t);
    }
  }, [busy, taskKey]);

  useEffect(() => {
    if (!user || !taskKey || isTaskRunning(taskKey)) return;
    const done = getTaskOutcome<{ suggestions: Suggestion[]; rejected: Array<{ title: string; reason: string }> }>(taskKey);
    if (done) applyOutcome(done);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, taskKey]);

  async function generate() {
    setBusy(true);
    setElapsed(0);
    setErr(null);
    const outcome = await startTask(taskKey, async (): Promise<TaskOutcome<{ suggestions: Suggestion[]; rejected: Array<{ title: string; reason: string }> }>> => {
      try {
        const res = await api<{ data: { suggestions: Suggestion[]; rejected: Array<{ title: string; reason: string }> } | { state: string; message: string } }>('/api/suggestions', {
          method: 'POST',
          body: JSON.stringify({ resumeId, matchRunId }),
        });
        if ('state' in res.data) {
          return { kind: 'error', message: res.data.message };
        }
        return { kind: 'result', data: { suggestions: res.data.suggestions, rejected: res.data.rejected } };
      } catch (e) {
        return { kind: 'error', message: errorText(e) };
      }
    });
    applyOutcome(outcome);
  }

  /** 强制重新生成（清掉已保留的结果） */
  function regenerate() {
    clearTask(taskKey);
    void generate();
  }

  async function act(item: Suggestion, action: 'ACCEPT' | 'SKIP') {
    if (!item.id) return;
    try {
      await api(`/api/suggestions/${item.id}`, { method: 'PATCH', body: JSON.stringify({ action }) });
      setResolved((s) => new Set(s).add(item.id as string));
    } catch (e) {
      const ex = e as ApiRequestError;
      setErr(ex.code === 'SUGGESTION_NOT_APPLICABLE' ? '这类建议是补充指引，不能直接写入简历，请先补充真实经历。' : errorText(ex));
    }
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;
  if (!resumeId || !matchRunId) return <div className="content-wrap"><ErrorState message="缺少匹配上下文，请先从岗位对照进入" /></div>;

  const hasItems = items !== null && items.length > 0;
  // 首次进入：尚无结果、未在生成中、也无错误 —— 这是「等待触发」的初始态。
  // 与 /match 页的「开始对照」按钮同一约定：显式给出触发入口，而不是空等。
  const showGenerateEntry = !busy && !err && items === null;
  // 四态严格互斥：error 绝不渲染成 empty；empty 仅在「已生成但 0 条」时出现。
  const showEmpty = !busy && !err && items !== null && items.length === 0;

  return (
    <div className="content-wrap">
      <PageHeader
        title="修改建议"
        description="只改表达、不改事实。被事实验证层拦截的建议不会展示任何编造内容。"
        actions={
          <Link className="btn btn-secondary wf-back" href={`/match?resumeId=${resumeId}&jdId=`}>
            <IconChevronRight className="wf-back-icon" size={16} />
            返回对照
          </Link>
        }
      />
      <WorkflowTrail current="suggest" />

      {showGenerateEntry && (
        <div className="wf-form-row">
          <button className="btn btn-primary" onClick={() => void generate()} disabled={busy}>
            生成修改建议
          </button>
        </div>
      )}

      {err && (
        <div className="mb-16">
          <div className="banner banner-error" role="alert">{err}</div>
          <button className="btn btn-secondary mt-8" onClick={() => void generate()} disabled={busy}>
            重试生成
          </button>
        </div>
      )}
      {busy && <ProcessingState steps={['正在生成保守修改…']} elapsed={elapsed} />}

      {hasItems && !busy && (
        <div className="wf-next">
          <span className="wf-next-text">共 {items?.length} 条建议。逐条「采用」或「跳过」，处理完即可导出 PDF。</span>
          <span className="wf-next-actions">
            <button className="btn btn-ghost" onClick={regenerate}>重新生成建议</button>
            <Link className="btn btn-primary" href={`/resumes/${resumeId}/pdf`}>去导出 PDF</Link>
          </span>
        </div>
      )}

      {rejected.length > 0 && (
        <div className="card wf-card">
          <h2 className="wf-block-title">已拦截（可能引入未确认事实）</h2>
          <ul className="wf-rows">
            {rejected.map((r, i) => (
              <li key={i} className="wf-row">
                <span className="wf-row-main">{r.title}</span>
                <span className="wf-row-side is-wrap">{r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showEmpty && (
        <EmptyState
          title="当前简历表达已较清晰，没有需要修改的地方"
          description="这不代表简历已完美，只说明本次没有需要改写的表达。"
          action={<Link className="btn btn-primary" href={`/resumes/${resumeId}/pdf`}>去导出 PDF</Link>}
        />
      )}

      {items?.map((item, i) => {
        const done = item.id !== null && resolved.has(item.id);
        return (
          <div key={item.id ?? i} className={`card wf-card wf-item${done ? ' is-resolved' : ''}`}>
            <div className="wf-item-head">
              <span className="wf-item-kind">{KIND_LABEL[item.kind]}{item.requirement ? ` · ${item.requirement}` : ''}</span>
              {done && <span className="wf-item-state">已处理</span>}
            </div>

            {item.kind === 'REPHRASE' && item.before && item.after ? (
              <div className="wf-diff">
                <div className="wf-diff-cell is-before">
                  <span className="wf-diff-label">原文</span>
                  <span className="wf-diff-text">{item.before}</span>
                </div>
                <div className="wf-diff-cell is-after">
                  <span className="wf-diff-label">改后</span>
                  <span className="wf-diff-text">{item.after}</span>
                </div>
              </div>
            ) : (
              <p className="wf-diff-reason">{item.reason}</p>
            )}

            <EvidenceRef items={item.evidenceRefs} />

            {!done && (
              <div className="row mt-16">
                {item.kind === 'REPHRASE' && (
                  <button className="btn btn-primary" onClick={() => act(item, 'ACCEPT')}>采用</button>
                )}
                <button className="btn btn-secondary" onClick={() => act(item, 'SKIP')}>跳过</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SuggestPageWrapper() {
  return (
    <Suspense fallback={<div className="content-wrap"><LoadingState rows={3} /></div>}>
      <SuggestPage />
    </Suspense>
  );
}
