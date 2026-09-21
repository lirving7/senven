'use client';

/**
 * T5-B-3C —— Agent 工作台（/agent，纯前端消费层，零后端改动）。
 *
 * 只消费既有 3 个 Agent API（授权书 §六）：
 *   POST /api/agent/runs            创建并执行一次分析（同步长请求：idle → loading → done/error）
 *   GET  /api/agent/runs/:id        恢复最近一次 Run（runId 仅存 localStorage，授权书 §十）
 *   POST /api/agent/runs/:id/cancel 取消（仅 CREATED/PLANNING 可取消；终态以 DB 为准）
 *
 * 语义边界：
 *   - 三态模型：SYSTEM_FACT 不在本页生产；AI 建议一律 chip-advice；外部知识只显示数量；
 *   - 重新生成 = 再次 POST（新 Run、消耗新配额），不修改旧 Run / Proposal；
 *   - 不轮询、不流式；不展示 userId / providerRequestId / RAG 正文 / 任何凭据；
 *   - 无确认 / 一键修改类动作；步骤只是 AI 建议。
 */

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { api, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { PageHeader } from '../_components/PageHeader';
import {
  cancelable,
  clearLastRunId,
  errorTextFor,
  readLastRunId,
  saveLastRunId,
  type AgentProposalView,
  type AgentRunView,
} from '../_lib/agent';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../_components/StatePanel';
import { ProposalView, RunStatusChip } from '../_components/agent/ProposalView';
import { ActActionPanel } from '../_components/agent/ActActionPanel';

type Phase = 'idle' | 'loading' | 'done' | 'error';

function AgentWorkspace() {
  const params = useSearchParams();
  const { user, loading } = useAuth();

  const [resumes, setResumes] = useState<Array<{ id: string; createdAt: string }>>([]);
  const [jds, setJds] = useState<Array<{ id: string; title: string | null; company: string | null }>>([]);
  const [resumeId, setResumeId] = useState(params.get('resumeId') ?? '');
  const [jdId, setJdId] = useState(params.get('jdId') ?? '');
  const [matchRunId, setMatchRunId] = useState(params.get('matchRunId') ?? '');
  const [ragQuery, setRagQuery] = useState('');
  const [request, setRequest] = useState('');

  const [phase, setPhase] = useState<Phase>('idle');
  const [run, setRun] = useState<AgentRunView | null>(null);
  const [proposal, setProposal] = useState<AgentProposalView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const restoredRef = useRef(false);

  /* 上下文列表（与 /match 页同一读取方式，均为本人数据） */
  useEffect(() => {
    if (!user) return;
    api<{ data: { items: Array<{ id: string; createdAt: string }> } }>('/api/resumes')
      .then((r) => setResumes(r.data.items))
      .catch(() => setResumes([]));
    api<{ data: { items: Array<{ id: string; title: string | null; company: string | null }> } }>('/api/jds')
      .then((r) => setJds(r.data.items))
      .catch(() => setJds([]));
  }, [user]);

  const start = useCallback(async () => {
    setPhase('loading');
    setErr(null);
    setElapsed(0);
    const targets: Record<string, string> = {};
    if (resumeId) targets.resumeId = resumeId;
    if (jdId) targets.jdId = jdId;
    if (matchRunId) targets.matchRunId = matchRunId;
    if (ragQuery.trim()) targets.ragQuery = ragQuery.trim();
    const body = JSON.stringify({
      ...(Object.keys(targets).length > 0 ? { targets } : {}),
      ...(request.trim() ? { request: request.trim() } : {}),
    });
    try {
      const res = await api<{ data: { run: AgentRunView; proposal: AgentProposalView | null } }>('/api/agent/runs', {
        method: 'POST',
        body,
      });
      saveLastRunId(window.localStorage, res.data.run.id);
      setRun(res.data.run);
      setProposal(res.data.proposal);
      setPhase('done');
    } catch (e) {
      setErr(errorText(e));
      setPhase('error');
    }
  }, [resumeId, jdId, matchRunId, ragQuery, request]);

  /* 恢复最近一次 Run（仅 runId；404 说明已不可见，清理本地记录） */
  useEffect(() => {
    if (!user || restoredRef.current) return;
    restoredRef.current = true;
    const lastId = readLastRunId(window.localStorage);
    if (!lastId) return;
    api<{ data: { run: AgentRunView; proposal: AgentProposalView | null } }>(`/api/agent/runs/${lastId}`)
      .then((r) => {
        setRun(r.data.run);
        setProposal(r.data.proposal);
        setPhase('done');
      })
      .catch((e) => {
        if (e instanceof ApiRequestError && e.status === 404) clearLastRunId(window.localStorage);
      });
  }, [user]);

  /* loading 计时（ProcessingState 展示用） */
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  async function cancelRun() {
    if (!run || !cancelable(run.status)) return;
    setCancelBusy(true);
    try {
      await api<{ data: { run: AgentRunView } }>(`/api/agent/runs/${run.id}/cancel`, { method: 'POST' });
    } catch {
      /* 409（已被并发完结等）→ 以 GET 终态为准，不向用户暴露竞态细节 */
    }
    try {
      const res = await api<{ data: { run: AgentRunView; proposal: AgentProposalView | null } }>(
        `/api/agent/runs/${run.id}`,
      );
      setRun(res.data.run);
      setProposal(res.data.proposal);
    } catch {
      /* 读取失败保持现状态即可 */
    }
    setCancelBusy(false);
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  const canCancel = run !== null && cancelable(run.status);

  return (
    <div className="content-wrap">
      <PageHeader
        title="AI 求职助手"
        description="基于你的简历、岗位与对照结果生成 AI 行动建议。建议仅供参考，不属于系统事实，系统不会替你改动任何数据。"
        actions={run ? <RunStatusChip status={run.status} /> : undefined}
      />

      {/* ── 分析表单 ─────────────────────────────────────────────── */}
      {phase !== 'loading' && (
        <div className="card mb-16">
          <h2 className="mb-16" style={{ fontSize: 15 }}>分析上下文</h2>
          <div className="field">
            <label htmlFor="agent-resume">我的简历</label>
            <select id="agent-resume" className="select" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              <option value="">（不使用简历）</option>
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  简历 · {new Date(r.createdAt).toLocaleDateString()}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="agent-jd">岗位</label>
            <select id="agent-jd" className="select" value={jdId} onChange={(e) => setJdId(e.target.value)}>
              <option value="">（不使用岗位）</option>
              {jds.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title || '未命名岗位'}
                  {j.company ? ` · ${j.company}` : ''}
                </option>
              ))}
            </select>
          </div>
          {matchRunId && (
            <div className="field">
              <label htmlFor="agent-match">能力对照结果</label>
              <input
                id="agent-match"
                className="input"
                value={matchRunId}
                onChange={(e) => setMatchRunId(e.target.value)}
                placeholder="留空则不附带对照结果"
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="agent-rag">补充提问方向（可选，用于检索公共知识参考）</label>
            <input
              id="agent-rag"
              className="input"
              value={ragQuery}
              onChange={(e) => setRagQuery(e.target.value)}
              maxLength={200}
              placeholder="例如：模拟面试、能力画像"
            />
          </div>
          <div className="field">
            <label htmlFor="agent-request">你想让 AI 重点考虑什么？（可选）</label>
            <textarea
              id="agent-request"
              className="textarea"
              style={{ minHeight: 90 }}
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              maxLength={500}
              placeholder="例如：最近两个月时间有限，希望优先做性价比最高的事"
            />
          </div>
          <p className="muted small">建议至少选择一个简历或岗位作为分析上下文，建议质量会更好。</p>
          <button className="btn btn-primary" onClick={() => void start()}>
            开始 AI 分析
          </button>
        </div>
      )}

      {/* ── 分析中（同步长请求）──────────────────────────────────── */}
      {phase === 'loading' && (
        <ProcessingState
          steps={['正在读取你的求职资料…', '正在整理上下文…', '正在生成 AI 建议…']}
          elapsed={elapsed}
        />
      )}

      {/* ── 失败 ────────────────────────────────────────────────── */}
      {phase === 'error' && err && (
        <ErrorState message={err} onRetry={() => void start()} />
      )}

      {/* ── 结果 ────────────────────────────────────────────────── */}
      {phase === 'done' && run && (
        <>
          {run.status === 'FAILED' && (
            <div className="banner banner-error mb-16" role="alert">
              {errorTextFor(run.errorCode)}
            </div>
          )}
          {run.status === 'CANCELLED' && (
            <div className="banner banner-info mb-16">本次分析已取消，未产生建议。可重新发起一次分析。</div>
          )}
          {run.status === 'EXPIRED' && (
            <div className="banner banner-info mb-16">该次分析已过期，请重新发起分析。</div>
          )}
          {run.status === 'PROPOSED' && proposal === null && (
            <div className="advice-note mb-16" role="status">
              未找到有效的 AI 建议。你可以重新发起一次分析。
            </div>
          )}
          {run.status === 'PROPOSED' && proposal && (
            <>
              <ProposalView proposal={proposal} />
              {/* T6-4-C：Act 操作面板（Confirm / Execute / Result） */}
              <ActActionPanel proposal={proposal} />
            </>
          )}

          <div className="row mt-16">
            <button className="btn btn-primary" onClick={() => void start()}>
              重新分析（将开始一次新的分析）
            </button>
            {canCancel && (
              <button className="btn btn-danger" onClick={() => void cancelRun()} disabled={cancelBusy}>
                {cancelBusy ? '取消中…' : '取消本次分析'}
              </button>
            )}
            {run.status === 'PROPOSED' && (
              <span className="muted small">当前状态不可取消。</span>
            )}
          </div>
          <div className="muted small mt-8">
            开始时间：{new Date(run.createdAt).toLocaleString()}
            {run.endedAt ? ` · 结束时间：${new Date(run.endedAt).toLocaleString()}` : ''}
          </div>
        </>
      )}

      {/* ── 空态引导 ────────────────────────────────────────────── */}
      {phase === 'idle' && resumes.length === 0 && jds.length === 0 && (
        <EmptyState
          title="先上传一份简历或解析一个岗位，AI 分析会更有依据"
          action={
            <Link className="btn btn-secondary" href="/resumes">
              去上传简历
            </Link>
          }
        />
      )}
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense fallback={<div className="content-wrap"><LoadingState rows={3} /></div>}>
      <AgentWorkspace />
    </Suspense>
  );
}
