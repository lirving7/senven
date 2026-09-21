'use client';

import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';
import { FactChip } from '../_components/FactChip';
import { PageHeader } from '../_components/PageHeader';
import { WorkflowTrail } from '../_components/WorkflowTrail';
import { EvidenceRef, type EvidenceItem } from '../_components/EvidenceRef';
import { IconArrowRight, IconChevronRight } from '../_components/icons';
import {
  startTask,
  isTaskRunning,
  getTaskStartedAt,
  getTaskOutcome,
  type TaskOutcome,
} from '../_lib/task-session';

type MatchItem = {
  requirementId: string | null;
  requirement: string;
  category: string;
  criticality: string;
  status: 'HAVE' | 'ENHANCE' | 'MISSING';
  reason: string;
  evidenceRefs: EvidenceItem[];
  suggestion: string | null;
};

type MatchResult = {
  runId: string;
  summary: { total: number; have: number; enhance: number; missing: number; mustTotal: number; mustHave: number };
  items: MatchItem[];
};

type ResumeOption = { id: string; sourceType: string; createdAt: string };
type JdOption = { id: string; title: string | null; company: string | null };

/* ─── O-4/G-4：阶段式进度 + task-session 状态保持 ───
 * 进行中的对照请求经统一的 task-session 保存（key 含 userId）：跳页返回恢复等待
 * 同一 promise（不清零、不重复启动、不取消）。阶段推进是「已等待时间」驱动的参考
 * 提示（后端无进度推送，不伪造精确百分比）。
 */
const STAGES = ['读取简历', '分析岗位要求', '执行匹配', '整理结果', '完成'];
/** 时间阈值（秒）：进入各阶段的参考点；最后一段之后停留在「执行匹配」直至响应返回 */
const STAGE_THRESHOLDS = [0, 2, 6, 14];

function stageIndexOf(elapsedSeconds: number): number {
  let idx = 0;
  for (let i = 0; i < STAGE_THRESHOLDS.length; i++) {
    if (elapsedSeconds >= STAGE_THRESHOLDS[i]) idx = i;
  }
  return idx;
}

function formatCreatedAt(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN');
}

function MatchPage() {
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const [resumes, setResumes] = useState<ResumeOption[]>([]);
  const [jds, setJds] = useState<JdOption[]>([]);
  const [resumeId, setResumeId] = useState(params.get('resumeId') ?? '');
  const [jdId, setJdId] = useState(params.get('jdId') ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [resultElapsed, setResultElapsed] = useState<number | null>(null);
  const [showHave, setShowHave] = useState(false);
  const [existingPlanId, setExistingPlanId] = useState<string | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [planErr, setPlanErr] = useState<string | null>(null);
  // 选项加载失败必须显式暴露：否则「简历/岗位为空」会被误读成「用户没有数据」。
  const [optionsErr, setOptionsErr] = useState<string | null>(null);
  const router = useRouter();

  function loadOptions() {
    if (!user) return;
    setOptionsErr(null);
    api<{ data: { items: ResumeOption[] } }>('/api/resumes')
      .then((r) => {
        setResumes(r.data.items);
        setResumeId((cur) => cur || r.data.items[0]?.id || '');
      })
      .catch((e) => { setResumes([]); setOptionsErr(errorText(e)); });
    api<{ data: { items: JdOption[] } }>('/api/jds')
      .then((r) => {
        setJds(r.data.items);
        setJdId((cur) => cur || r.data.items[0]?.id || '');
      })
      .catch((e) => { setJds([]); setOptionsErr(errorText(e)); });
  }

  useEffect(() => {
    loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // G-4：重新挂载时恢复状态 —— 进行中则继续等待同一请求（不重复启动/不取消）；已完成则恢复结果
  // V1 修订 P1：task-session 内存之外，还支持「已持久化 MatchRun 回看」——
  // 优先级：?runId= 深链 > localStorage 最近一次成功 runId → GET /api/matches/:id（零 LLM、零写入）。
  // 刷新页面因此读取已有结果，不会重新 POST 分析。
  useEffect(() => {
    if (!user) return;
    const restorePersisted = async (runId: string) => {
      try {
        const r = await api<{ data: MatchResult }>(`/api/matches/${runId}`);
        setResult(r.data);
        setErr(null);
      } catch (e) {
        const ex = e as ApiRequestError;
        if (ex.status === 404) {
          // runId 失效（跨用户/已清理）：清除本地指针，回到正常空态
          try { localStorage.removeItem(`jp_last_match_run_${user.id}`); } catch { /* ignore */ }
        } else {
          setErr(errorText(e));
        }
      }
    };
    const key = `match:${user.id}:${resumeId}:${jdId}`;
    if (isTaskRunning(key)) {
      setBusy(true);
      setResult(null);
      setErr(null);
      setElapsed(Math.floor((Date.now() - (getTaskStartedAt(key) ?? Date.now())) / 1000));
      void startTask<MatchResult>(key, () => Promise.reject(new Error('unreachable')))
        .then(applyOutcome)
        .catch(() => setBusy(false));
      return;
    }
    const done = getTaskOutcome<MatchResult>(key);
    if (done) { applyOutcome(done); return; }
    const urlRunId = params.get('runId');
    let stored: string | null = null;
    try { stored = localStorage.getItem(`jp_last_match_run_${user.id}`); } catch { /* ignore */ }
    const persistedRunId = urlRunId || stored;
    if (persistedRunId) {
      setBusy(false);
      void restorePersisted(persistedRunId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // O-4：等待计时（进行中每 0.5s 刷新「已等待」）
  useEffect(() => {
    if (!busy || !user) return;
    const start = getTaskStartedAt(`match:${user.id}:${resumeId}:${jdId}`) || Date.now();
    setElapsed(Math.floor((Date.now() - start) / 1000));
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 500);
    return () => clearInterval(timer);
  }, [busy, user, resumeId, jdId]);

  // 只读检查：本 MatchRun 是否已有行动计划（GET，不触发生成，满足约束 #1）
  useEffect(() => {
    if (!user || !result) { setExistingPlanId(null); return; }
    api<{ data: { items: Array<{ id: string; matchRunId: string }> } }>('/api/action-plans').then((r) => {
      const found = r.data.items.find((p) => p.matchRunId === result.runId);
      setExistingPlanId(found?.id ?? null);
    }).catch(() => setExistingPlanId(null));
  }, [user, result]);

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  function applyOutcome(outcome: TaskOutcome<MatchResult>) {
    setBusy(false);
    if (outcome.kind === 'result') {
      setResult(outcome.data);
      setErr(null);
      // V1 修订 P1：记录最近一次成功 runId，供刷新/返回时经 GET /api/matches/:id 回看
      if (user) {
        try { localStorage.setItem(`jp_last_match_run_${user.id}`, outcome.data.runId); } catch { /* ignore */ }
      }
    } else {
      setResult(null);
      setErr(outcome.message);
    }
  }

  async function run() {
    // 已有进行中的请求：不重复启动（按钮本身 disabled，这里兜底）
    if (!user) return;
    const key = `match:${user.id}:${resumeId}:${jdId}`;
    if (isTaskRunning(key)) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    setElapsed(0);
    const startedAt = Date.now();
    const outcome = await startTask<MatchResult>(key, async (): Promise<TaskOutcome<MatchResult>> => {
      try {
        const res = await api<{ data: MatchResult | { state: string; message: string } }>('/api/matches', {
          method: 'POST',
          body: JSON.stringify({ resumeId, jdId }),
        });
        if ('state' in res.data) {
          return { kind: 'error', message: res.data.message };
        }
        return { kind: 'result', data: res.data };
      } catch (e) {
        return { kind: 'error', message: errorText(e) };
      }
    });
    if (outcome.kind === 'result') setResultElapsed(Math.round((Date.now() - startedAt) / 1000));
    applyOutcome(outcome);
  }

  async function genPlan() {
    if (!result) return;
    setPlanBusy(true);
    setPlanErr(null);
    try {
      const res = await api<{ data: { id: string } }>('/api/action-plans', {
        method: 'POST',
        body: JSON.stringify({ matchRunId: result.runId }),
      });
      router.push(`/action-plans/${res.data.id}`);
    } catch (e) {
      const ex = e as ApiRequestError;
      if (ex.code === 'LLM_QUOTA_EXCEEDED' || ex.status === 429) {
        setPlanErr('当前岗位行动计划生成次数已达到限制，请稍后再试。');
      } else {
        setPlanErr(errorText(e));
      }
    } finally {
      setPlanBusy(false);
    }
  }

  const noData = resumes.length === 0 || jds.length === 0;
  const haveItems = result?.items.filter((i) => i.status === 'HAVE') ?? [];
  const activeItems = result?.items.filter((i) => i.status !== 'HAVE') ?? [];

  return (
    <div className="content-wrap">
      <PageHeader
        title="简历 × 岗位对照"
        description="把你的简历与目标岗位逐条比对，得到已覆盖 / 待增强 / 缺失的能力差距，并可一键生成行动计划。"
      />
      <WorkflowTrail current="match" />

      <div className="card wf-card">
        <div className="wf-form-row">
          <div className="field">
            <label htmlFor="match-resume">简历</label>
            <select id="match-resume" className="select" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              {resumes.map((r) => <option key={r.id} value={r.id}>简历（{r.sourceType}）· {formatCreatedAt(r.createdAt)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="match-jd">岗位</label>
            <select id="match-jd" className="select" value={jdId} onChange={(e) => setJdId(e.target.value)}>
              {jds.map((j) => <option key={j.id} value={j.id}>{j.title || '未命名岗位'}{j.company ? ` · ${j.company}` : ''}</option>)}
            </select>
          </div>
          <button className="btn btn-primary" onClick={run} disabled={busy || !resumeId || !jdId}>
            {busy ? '对照中…' : '开始对照'}
          </button>
        </div>

        {optionsErr && (
          <div className="mt-16">
            <div className="banner banner-error" role="alert">简历或岗位列表加载失败：{optionsErr}</div>
            <button className="btn btn-secondary mt-8" onClick={loadOptions}>重试加载</button>
          </div>
        )}
        {err && (
          <div className="mt-16">
            <div className="banner banner-error" role="alert">{err}</div>
            <button className="btn btn-secondary mt-8" onClick={run} disabled={busy || !resumeId || !jdId}>
              重试对照
            </button>
          </div>
        )}
      </div>

      {/* P1-1：首次使用路径引导（纯展示，不改任何业务逻辑） */}
      {!busy && !result && !noData && !optionsErr && (
        <p className="wf-block-hint">
          使用路径：选择简历与岗位开始对照 → 查看能力差距 → 生成岗位行动计划 → 按 [学习] / [项目] 步骤执行
        </p>
      )}

      {busy && (
        <div className="card wf-card" role="status" aria-live="polite">
          <div className="wf-step-head">
            <h2 className="wf-block-title wf-title-flush">对照进行中</h2>
            <span className="wf-step-side muted small">已等待 {elapsed}s</span>
          </div>
          <ol className="match-stages mt-16">
            {STAGES.map((label, i) => {
              const current = stageIndexOf(elapsed);
              const state = i < current ? 'done' : i === current ? 'active' : 'todo';
              return (
                <li key={label} className={`match-stage is-${state}`}>
                  <span className="match-stage-no">{i + 1}</span>
                  <span>{label}{i === current && i < STAGES.length - 1 ? '…' : ''}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {!busy && !result && noData && !optionsErr && (
        <EmptyState
          title="还没有可对照的简历或 JD"
          description="对照需要一份简历和一份岗位记录。两者都准备好后即可开始。"
          action={<div className="row"><Link className="btn btn-primary" href="/resumes">去上传简历</Link><Link className="btn btn-secondary" href="/jds">去解析 JD</Link></div>}
        />
      )}

      {result && (
        <>
          <div className="card wf-card">
            <div className="wf-summary">
              <div className="wf-summary-main">
                <div className="wf-stat-label">必须具备覆盖</div>
                <div className="wf-summary-num">
                  {result.summary.mustHave} / {result.summary.mustTotal}
                </div>
                {resultElapsed !== null && (
                  <div className="wf-stat-note">对照完成 · 用时 {resultElapsed}s</div>
                )}
              </div>
              <div className="wf-summary-chips">
                <FactChip status="HAVE">已覆盖 {result.summary.have}</FactChip>
                <FactChip status="ENHANCE">待增强 {result.summary.enhance}</FactChip>
                <FactChip status="MISSING">缺失 {result.summary.missing}</FactChip>
              </div>
              <div className="wf-summary-actions">
                <Link className="btn btn-secondary" href={`/suggest?resumeId=${resumeId}&matchRunId=${result.runId}`}>生成修改建议</Link>
                <Link className="btn btn-ghost" href={`/agent?resumeId=${resumeId}&jdId=${jdId}&matchRunId=${result.runId}`}>让 AI 求职助手分析</Link>
                {existingPlanId ? (
                  <Link className="btn btn-primary" href={`/action-plans/${existingPlanId}`}>
                    查看岗位行动计划
                    <IconArrowRight className="wf-go-icon" size={16} />
                  </Link>
                ) : (
                  <button className="btn btn-primary" onClick={genPlan} disabled={planBusy}>
                    {planBusy ? '生成中…' : '生成岗位行动计划'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {planErr && <div className="banner banner-error mb-16" role="alert">{planErr}</div>}

          <div className="card wf-card">
            <h2 className="wf-block-title">行动项（缺失与待增强）</h2>
            <div className="wf-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="wf-th-tight">状态</th>
                    <th>岗位要求</th>
                    <th>依据与建议</th>
                  </tr>
                </thead>
                <tbody>
                  {activeItems.map((item, i) => (
                    <tr key={item.requirementId ?? i}>
                      <td><FactChip status={item.status} /></td>
                      <td>{item.requirement}</td>
                      <td>
                        <div className="muted small">{item.reason}</div>
                        {item.suggestion && <div className="small mt-16">建议：{item.suggestion}</div>}
                        <EvidenceRef items={item.evidenceRefs} />
                      </td>
                    </tr>
                  ))}
                  {activeItems.length === 0 && (
                    <tr><td colSpan={3} className="muted">没有缺失或待增强项，全部已覆盖。</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {haveItems.length > 0 && (
              <div className="mt-16">
                <button
                  className="evidence-toggle wf-toggle"
                  onClick={() => setShowHave((v) => !v)}
                  aria-expanded={showHave}
                >
                  已覆盖 {haveItems.length} 项
                  <IconChevronRight className="wf-toggle-icon" size={14} />
                </button>
                {showHave && (
                  <ul className="wf-guide-list mt-8">
                    {haveItems.map((item, i) => (
                      <li key={item.requirementId ?? i}>{item.requirement}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="wf-next">
            <span className="wf-next-text">对照完成？把这个岗位加入你的投递追踪，让进展可被管理。</span>
            <span className="wf-next-actions">
              <Link className="btn btn-primary" href="/applications">
                去投递
                <IconArrowRight className="wf-go-icon" size={16} />
              </Link>
            </span>
          </div>
        </>
      )}
    </div>
  );
}

export default function MatchPageWrapper() {
  return (
    <Suspense fallback={<div className="content-wrap"><LoadingState rows={3} /></div>}>
      <MatchPage />
    </Suspense>
  );
}
