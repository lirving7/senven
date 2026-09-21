'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../../_lib/api';
import { useAuth } from '../../_lib/auth';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../../_components/StatePanel';
import { PageHeader } from '../../_components/PageHeader';
import { WorkflowTrail } from '../../_components/WorkflowTrail';
import { StepEntry } from '../../_components/StepEntry';
import { StepResultEntry } from '../../_components/StepResultEntry';
import { StepLearningEntry } from '../../_components/StepLearningEntry';
import { IconChevronRight } from '../../_components/icons';
import { startTask, isTaskRunning, getTaskStartedAt, type TaskOutcome } from '../../_lib/task-session';
import { STEP_TYPE_BRACKET } from '../../../src/domain/action-plan/step-type.ts';

/**
 * V2 · T2 Step 3B —— 岗位行动计划前端。
 *
 * 只消费后端已有能力：ActionPlan / ActionStep / MatchRun。
 * 事实铁律（对应验收 A5）：have / gaps 一律原样展示后端返回值，
 * 前端**不做任何能力判断**（不允许 if (jd.requiresX) ... 之类的本地推断）。
 */

type HaveItem = { id?: string; key?: string; label?: string; level?: string | null };
type GapItem = { requirement?: string; category?: string; criticality?: string };
type StepStatus = 'TODO' | 'IN_PROGRESS' | 'DONE';
type StepItem = {
  id: string;
  order: number;
  title: string;
  desc: string;
  status: StepStatus;
  targetRequirement: string | null;
};
type ActionPlan = {
  id: string;
  matchRunId: string;
  jdId: string | null;
  goal: string;
  have: HaveItem[];
  gaps: GapItem[];
  actions: StepItem[];
  createdAt: string;
};

/** Project V2 Phase 0：AI 执行指导（建议层，零落库；AI 建议 ≠ 用户已完成） */
type StepGuide = {
  objective: string;
  problem: string;
  scope: string[];
  techStack: string[];
  steps: Array<{ title: string; detail: string }>;
  deliverables: string[];
};

const STEP_STATUS: Record<string, { label: string; cls: string }> = {
  TODO: { label: '待开始', cls: 'chip-unconfirmed' },
  IN_PROGRESS: { label: '进行中', cls: 'chip-inferred' },
  DONE: { label: '已完成', cls: 'chip-confirmed' },
};

const QUOTA_TEXT = '当前岗位行动计划生成次数已达到限制，请稍后再试。';

export default function ActionPlanPage() {
  const params = useParams();
  const planId = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  const { user, loading } = useAuth();

  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [fetching, setFetching] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [regenElapsed, setRegenElapsed] = useState(0);
  const [regenErr, setRegenErr] = useState<string | null>(null);
  const [stepBusy, setStepBusy] = useState<Set<string>>(new Set());

  // Project V2 Phase 0：AI 执行指导（仅用户显式点击触发；零写入，纯建议）
  const [guideStepId, setGuideStepId] = useState<string | null>(null);
  const [guide, setGuide] = useState<StepGuide | null>(null);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideElapsed, setGuideElapsed] = useState(0);
  const [guideErr, setGuideErr] = useState<string | null>(null);

  // O-4/G-3：重新生成等待计时
  useEffect(() => {
    if (!regenBusy) return;
    const startedAt = getTaskStartedAt(`plan-regen:${user?.id ?? ''}:${planId}`);
    const t = setInterval(() => {
      setRegenElapsed(startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
    }, 500);
    return () => clearInterval(t);
  }, [regenBusy, user, planId]);

  // G-4：重挂载恢复 —— 重生成在途则继续等待同一请求
  useEffect(() => {
    const key = `plan-regen:${user?.id ?? ''}:${planId}`;
    if (!user || !isTaskRunning(key)) return;
    setRegenBusy(true);
    void startTask<ActionPlan>(key, () => Promise.reject(new Error('unreachable')))
      .then((outcome) => applyRegenOutcome(outcome))
      .catch(() => setRegenBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, planId]);

  const load = useCallback(async () => {
    if (!planId) return;
    setFetching(true);
    setErr(null);
    try {
      const res = await api<{ data: ActionPlan }>(`/api/action-plans/${planId}`);
      setPlan(res.data);
    } catch (e) {
      const ex = e as ApiRequestError;
      setErr(ex.status === 404 ? '未找到该行动计划' : errorText(e));
    } finally {
      setFetching(false);
    }
  }, [planId]);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  function applyRegenOutcome(outcome: TaskOutcome<ActionPlan>) {
    setRegenBusy(false);
    if (outcome.kind === 'result') {
      setPlan(outcome.data);
      setErr(null);
      setRegenErr(null);
    } else {
      setRegenErr(outcome.message);
    }
  }

  async function regenerate() {
    if (!planId) return;
    const key = `plan-regen:${user?.id ?? ''}:${planId}`;
    if (isTaskRunning(key)) return;
    setRegenBusy(true);
    setRegenElapsed(0);
    setRegenErr(null);
    const outcome = await startTask<ActionPlan>(key, async () => {
      try {
        const res = await api<{ data: ActionPlan }>(`/api/action-plans/${planId}/regenerate`, { method: 'POST' });
        return { kind: 'result' as const, data: res.data };
      } catch (e) {
        const ex = e as ApiRequestError;
        return {
          kind: 'error' as const,
          message: ex.code === 'LLM_QUOTA_EXCEEDED' || ex.status === 429 ? QUOTA_TEXT : errorText(e),
        };
      }
    });
    applyRegenOutcome(outcome);
  }

  // G-3：AI 执行指导等待计时（在途时每 500ms 刷新）
  useEffect(() => {
    if (!guideBusy) return;
    const t = setInterval(() => setGuideElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [guideBusy]);

  /** Project V2 Phase 0：请求某一步骤的 AI 执行指导（服务端零写入，只返回建议） */
  async function loadGuide(step: StepItem) {
    if (!user || !planId) return;
    const key = `guide:${user.id}:${planId}:${step.id}`;
    if (isTaskRunning(key) || guideBusy) return;
    setGuideStepId(step.id);
    setGuideBusy(true);
    setGuideElapsed(0);
    setGuideErr(null);
    setGuide(null);
    const outcome = await startTask<StepGuide>(key, async () => {
      try {
        const res = await api<{ data: { guide: StepGuide; suggestionOnly: boolean } }>(
          `/api/action-plans/${planId}/steps/${step.id}/guide`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        return { kind: 'result' as const, data: res.data.guide };
      } catch (e) {
        const ex = e as ApiRequestError;
        return {
          kind: 'error' as const,
          message: ex.code === 'LLM_QUOTA_EXCEEDED' || ex.status === 429 ? QUOTA_TEXT : `AI 执行指导生成失败：${errorText(e)}`,
        };
      }
    });
    // guideBusy 互斥保证同一时刻只有一次指导请求在途，结果/错误直接落地当前步骤
    if (outcome.kind === 'result') setGuide(outcome.data);
    else setGuideErr(outcome.message);
    setGuideBusy(false);
  }

  /** 单步继续：只发 PATCH，状态以服务端返回为准（约束 #4，不做本地乐观置 DONE） */
  async function completeStep(stepId: string) {
    if (!planId) return;
    setStepBusy((s) => new Set(s).add(stepId));
    setErr(null);
    try {
      const res = await api<{ data: StepItem }>(`/api/action-plans/${planId}/steps/${stepId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'DONE' }),
      });
      setPlan((p) => (p ? { ...p, actions: p.actions.map((a) => (a.id === res.data.id ? res.data : a)) } : p));
    } catch (e) {
      const ex = e as ApiRequestError;
      setErr(ex.code === 'LLM_QUOTA_EXCEEDED' || ex.status === 429 ? QUOTA_TEXT : errorText(ex));
    } finally {
      setStepBusy((s) => {
        const n = new Set(s);
        n.delete(stepId);
        return n;
      });
    }
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;
  if (!planId) return <div className="content-wrap"><ErrorState message="缺少计划标识" /></div>;
  if (fetching && !plan) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (err && !plan) return <div className="content-wrap"><ErrorState message={err} onRetry={load} /></div>;

  const steps = plan?.actions ?? [];
  const remaining = steps.filter((s) => s.status !== 'DONE').length;

  return (
    <div className="content-wrap">
      <PageHeader
        title="岗位行动计划"
        description="基于一次「简历 × 岗位对照」生成的可执行步骤。完成情况以你的实际进度为准。"
        eyebrow={<WorkflowTrail current="plan" />}
        actions={
          <Link className="btn btn-secondary wf-back" href={plan?.jdId ? `/match?jdId=${plan.jdId}` : '/match'}>
            <IconChevronRight className="wf-back-icon" size={16} />
            返回对照
          </Link>
        }
      />

      {plan && (
        <div className="card wf-card">
          <div className="wf-step-head">
            <div className="wf-step-body">
              <div className="wf-stat-label">目标岗位</div>
              <h2 className="wf-block-title wf-title-flush">{plan.goal}</h2>
            </div>
            <div className="wf-step-side">
              <div className="wf-summary-actions">
                <span className="muted small">剩余 {remaining} / {steps.length} 步</span>
                <button className="btn btn-secondary" onClick={regenerate} disabled={regenBusy}>
                  {regenBusy ? '重新生成中…' : '刷新（重新生成）'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {err && plan && <div className="banner banner-error mb-16" role="alert">{err}</div>}
      {regenBusy && <ProcessingState steps={['正在重新生成行动计划…']} elapsed={regenElapsed} />}
      {regenErr && !regenBusy && (
        <div className="mb-16">
          <div className="banner banner-error" role="alert">{regenErr}</div>
          <button className="btn btn-secondary mt-8" onClick={() => void regenerate()}>
            重试重新生成
          </button>
        </div>
      )}

      {plan && !regenBusy && (
        <>
          {/* P1-3：闭环下一步 —— 计划在手后引导去投递 */}
          <div className="wf-next">
            <span className="wf-next-text">计划确认了方向？把对应岗位加入投递追踪，让进展可被管理。</span>
            <span className="wf-next-actions">
              {/* V1 修订 P1：回看本计划来源的岗位对照（零 LLM 只读回放） */}
              {plan.matchRunId && (
                <Link className="btn btn-ghost" href={`/match?runId=${plan.matchRunId}`}>查看本次岗位对照</Link>
              )}
              <Link className="btn btn-primary" href="/applications">去投递</Link>
            </span>
          </div>

          <div className="card wf-card">
            <h2 className="wf-block-title">已有能力（已确认事实）</h2>
            {plan.have.length === 0 ? (
              <p className="wf-empty-line">暂无已确认能力。可在简历事实确认后重新生成。</p>
            ) : (
              <div className="wf-tags">
                {plan.have.map((h, i) => (
                  <span key={h.id ?? i} className="chip chip-confirmed">
                    {h.label ?? h.key ?? '能力'}{h.level ? ` · ${h.level}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="card wf-card">
            <h2 className="wf-block-title">能力缺口</h2>
            {plan.gaps.length === 0 ? (
              <p className="wf-empty-line">没有能力缺口。</p>
            ) : (
              <div className="wf-table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>岗位要求</th>
                      <th className="wf-th-tight">类别</th>
                      <th className="wf-th-tight">重要度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.gaps.map((g, i) => (
                      <tr key={`${g.requirement ?? 'gap'}-${i}`}>
                        <td>{g.requirement}</td>
                        <td className="muted small">{g.category ?? '—'}</td>
                        <td className="muted small">{g.criticality ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card wf-card">
            <h2 className="wf-block-title">建议行动</h2>
            {/* P0-2：步骤类型图例 —— 前缀来自 STEP_TYPE_BRACKET 单一来源，不重新定义类型 */}
            <div className="wf-block-hint wf-tags">
              <span>{STEP_TYPE_BRACKET.LEARN} = 学习步骤：可创建学习任务，在「学习提升」中跟进</span>
              <span>{STEP_TYPE_BRACKET.PRACTICE} = 实践步骤：按描述自行执行，完成后标记完成</span>
              <span>{STEP_TYPE_BRACKET.PROJECT} = 项目步骤：提交项目成果，在「制作项目」中声明能力</span>
            </div>
            {steps.length === 0 ? (
              <EmptyState
                title="暂无建议行动"
                action={<button className="btn btn-primary" onClick={regenerate} disabled={regenBusy}>重新生成</button>}
              />
            ) : (
              <ol className="wf-steps">
                {steps.map((s) => {
                  const st = STEP_STATUS[s.status] ?? STEP_STATUS.TODO;
                  const busy = stepBusy.has(s.id);
                  return (
                    <li key={s.id} className={`wf-step${s.status === 'DONE' ? ' is-done' : ''}`}>
                      <div className="wf-step-head">
                        <div className="wf-step-body">
                          <div className="wf-step-title">
                            <span className={`chip ${st.cls}`}>{st.label}</span>
                            <strong>{s.title}</strong>
                          </div>
                          <p className="wf-step-desc">{s.desc}</p>
                          {s.targetRequirement && (
                            <p className="wf-step-target">对应要求：{s.targetRequirement}</p>
                          )}
                          {/* C4：学习 / 项目执行入口（纯展示，不落库、不改数据） */}
                          <StepEntry title={s.title} targetRequirement={s.targetRequirement} />
                          {/*
                            T3-A2-6 Phase 4：把 [学习] 步骤登记为学习任务。
                            仅在用户显式点击后调用 POST /api/learning-tasks；
                            仅 [学习] 步骤显示（Step Type 单一来源 parseStepKind）。
                          */}
                          <StepLearningEntry
                            planId={planId}
                            sourceStepId={s.id}
                            stepTitle={s.title}
                            targetRequirement={s.targetRequirement}
                          />
                          {/*
                            T3-A2-4 Phase 0：把该步骤的产出提交为「项目成果」。
                            仅在用户显式点击后调用既有 API（create → artifact → submit）；
                            组件内无 useEffect，故 status=DONE **不会**自动创建成果。
                            入口仅对 [学习] / [项目] 步骤显示（A2-4 授权范围）。
                          */}
                          <StepResultEntry planId={planId} sourceStepId={s.id} stepTitle={s.title} />

                          {/*
                            Project V2 Phase 0：AI 执行指导入口。
                            仅用户显式点击后调用 POST /api/action-plans/:planId/steps/:stepId/guide；
                            服务端零写入、只返回建议；前端不写任何数据、不改变步骤状态。
                          */}
                          <div className="mt-16">
                            <button
                              className="btn btn-secondary small"
                              disabled={guideBusy || stepBusy.has(s.id)}
                              onClick={() => void loadGuide(s)}
                            >
                              {guideBusy && guideStepId === s.id ? '生成指导中…' : 'AI 执行指导'}
                            </button>
                            {guideStepId === s.id && guideBusy && (
                              <div className="mt-16">
                                <ProcessingState steps={['正在读取步骤与岗位要求…', 'AI 组织执行方法…', '整理指导建议…']} elapsed={guideElapsed} />
                              </div>
                            )}
                            {guideStepId === s.id && guideErr && !guideBusy && (
                              <div className="mt-16">
                                <div className="banner banner-error" role="alert">{guideErr}</div>
                                <button className="btn btn-secondary small mt-8" disabled={guideBusy} onClick={() => void loadGuide(s)}>
                                  重试
                                </button>
                              </div>
                            )}
                            {guideStepId === s.id && guide && !guideBusy && (
                              <div className="wf-guide">
                                <div className="banner banner-info" role="note">
                                  以下为 AI 建议的执行方法，<strong>不代表你已完成任何内容</strong>。完成后可在下方提交成果。
                                </div>
                                <div className="wf-guide-section">
                                  <h3 className="wf-guide-title">为什么做这一步</h3>
                                  <p className="wf-guide-step">{guide.objective}</p>
                                </div>
                                <div className="wf-guide-section">
                                  <h3 className="wf-guide-title">解决什么问题</h3>
                                  <p className="wf-guide-step">{guide.problem}</p>
                                </div>
                                <div className="wf-guide-section">
                                  <h3 className="wf-guide-title">要实现的内容</h3>
                                  <ul className="wf-guide-list">
                                    {guide.scope.map((x, i) => <li key={i}>{x}</li>)}
                                  </ul>
                                </div>
                                <div className="wf-guide-section">
                                  <h3 className="wf-guide-title">建议工具 / 技术</h3>
                                  <div className="wf-tags">
                                    {guide.techStack.map((x, i) => <span key={i} className="chip">{x}</span>)}
                                  </div>
                                </div>
                                <div className="wf-guide-section">
                                  <h3 className="wf-guide-title">分步怎么做</h3>
                                  <ol className="wf-guide-list">
                                    {guide.steps.map((x, i) => (
                                      <li key={i} className="wf-guide-step">
                                        <strong>{x.title}</strong>
                                        <span className="muted">{x.detail}</span>
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                                <div className="wf-guide-section">
                                  <h3 className="wf-guide-title">建议提交的成果</h3>
                                  <ul className="wf-guide-list">
                                    {guide.deliverables.map((x, i) => <li key={i}>{x}</li>)}
                                  </ul>
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                        {s.status !== 'DONE' && (
                          <div className="wf-step-side">
                            <button className="btn btn-primary" onClick={() => completeStep(s.id)} disabled={busy}>
                              {busy ? '提交中…' : '标记完成'}
                            </button>
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}
