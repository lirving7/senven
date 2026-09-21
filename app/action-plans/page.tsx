'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';
import { PageHeader } from '../_components/PageHeader';
import { WorkflowTrail } from '../_components/WorkflowTrail';

type PlanSummary = {
  id: string;
  goal: string;
  /** Match 页依赖该字段回查是否已生成计划，故此处显式声明（后端已返回）。 */
  matchRunId?: string | null;
  actions: Array<{ id: string; title: string; status: string }>;
  createdAt: string;
};

/** 四态判别联合：error / loading / empty / ready 严格互斥，error 不得降级成 empty。 */
type PlansState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: PlanSummary[] }
  | { phase: 'error'; message: string };

/** 日期守卫：非法 / 缺失时间不得渲染成 "Invalid Date"。 */
function formatCreatedAt(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN');
}

export default function ActionPlansPage() {
  const { user, loading } = useAuth();
  const [state, setState] = useState<PlansState>({ phase: 'loading' });

  const load = useCallback(() => {
    if (!user) return;
    setState({ phase: 'loading' });
    api<{ data: { items: PlanSummary[] } }>('/api/action-plans')
      .then((r) => setState({ phase: 'ready', items: r.data.items }))
      .catch((e) => setState({ phase: 'error', message: errorText(e) }));
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  const doneOf = (p: PlanSummary) => p.actions.filter((a) => a.status === 'DONE').length;
  const items = state.phase === 'ready' ? state.items : [];

  return (
    <div className="content-wrap">
      <PageHeader
        title="岗位行动计划"
        description="每份计划来自一次「简历 × 岗位对照」：基于你的既有能力与岗位差距，生成可执行的学习 / 实践 / 项目步骤。"
      />
      <WorkflowTrail current="plan" />

      {state.phase === 'loading' && <LoadingState rows={4} />}
      {state.phase === 'error' && <ErrorState message={state.message} onRetry={load} />}

      {state.phase === 'ready' && items.length === 0 && (
        <EmptyState
          title="还没有行动计划"
          description="先做一次「简历 × 岗位对照」，对照完成后即可一键生成计划。"
          action={<Link className="btn btn-primary" href="/match">去岗位对照</Link>}
        />
      )}

      {state.phase === 'ready' && items.length > 0 && (
        <div>
          {items.map((p) => (
            <Link key={p.id} href={`/action-plans/${p.id}`} className="entry-card wf-card">
              <div className="wf-step-head">
                <div className="wf-step-body">
                  <div className="entry-title">{p.goal}</div>
                  <div className="entry-desc">
                    {p.actions.length} 个步骤 · 已完成 {doneOf(p)}
                  </div>
                </div>
                <div className="wf-step-side">
                  <span className="muted small">{formatCreatedAt(p.createdAt)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
