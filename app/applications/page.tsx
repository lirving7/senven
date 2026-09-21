'use client';

/**
 * T6-2 · Application Tracker —— 求职申请追踪页（最小闭环，不做 Dashboard 2.0）：
 * 列表 → 筛选（stage / careerGoal / company）→ 详情（关联摘要）→ 创建 → 编辑（stage/notes）。
 * stage 词表：APPLIED / SCREENING / INTERVIEWING / OFFER / REJECTED / WITHDRAWN（DRAFT/CLOSED 已删除）。
 */

import { useCallback, useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { PageHeader } from '../_components/PageHeader';
import { WorkflowTrail } from '../_components/WorkflowTrail';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';

type App = {
  id: string;
  company: string;
  position: string | null;
  jdId: string | null;
  careerGoalId: string | null;
  resumeVersionId: string | null;
  appliedAt: string;
  stage: string;
  stageLabel: string;
  notes: string | null;
  updatedAt: string;
};

type Detail = App & {
  jdSummary: { title: string | null; company: string | null } | null;
  careerGoalSummary: { name: string; position: string; status: string } | null;
  resumeVersionSummary: { versionNo: number; jdId: string | null; createdAt: string } | null;
};

type Counts = {
  total: number;
  applied: number;
  screening: number;
  interviewing: number;
  offer: number;
  rejected: number;
  withdrawn: number;
};

const STAGES = ['APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN'];
const STAGE_LABEL: Record<string, string> = {
  APPLIED: '已投递',
  SCREENING: '简历筛选中',
  INTERVIEWING: '面试中',
  OFFER: 'Offer',
  REJECTED: '未通过',
  WITHDRAWN: '已撤回',
};

type GoalItem = { id: string; name: string; status: string };
type JdOption = { id: string; title: string | null; company: string | null };

/** 四态判别联合：error / loading / empty / ready 严格互斥，error 不得降级成 empty。 */
type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; counts: Counts; items: App[]; hasMore: boolean }
  | { phase: 'error'; message: string };

/** 日期守卫：非法 / 缺失时间不得渲染成 "Invalid Date"。 */
function formatDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN');
}
function formatDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN');
}

export default function ApplicationsPage() {
  return (
    <Suspense fallback={<div className="content-wrap"><LoadingState rows={3} /></div>}>
      <ApplicationsInner />
    </Suspense>
  );
}

function ApplicationsInner() {
  const { user, loading } = useAuth();
  const [state, setState] = useState<ListState>({ phase: 'loading' });
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [company, setCompany] = useState('');
  const [position, setPosition] = useState('');
  const [jdId, setJdId] = useState('');
  const [careerGoalId, setCareerGoalId] = useState('');
  const [optionErr, setOptionErr] = useState<string | null>(null);
  const [jds, setJds] = useState<JdOption[]>([]);
  const [goals, setGoals] = useState<GoalItem[]>([]);
  const [saving, setSaving] = useState(false);

  // 筛选
  const [fStage, setFStage] = useState('');
  const [fGoal, setFGoal] = useState('');
  const [fCompany, setFCompany] = useState('');
  // 详情
  const [detail, setDetail] = useState<Detail | null>(null);

  const query = useCallback(
    (offset: number) => {
      const p = new URLSearchParams({ limit: '20', offset: String(offset) });
      if (fStage) p.set('stage', fStage);
      if (fGoal) p.set('careerGoalId', fGoal);
      if (fCompany.trim()) p.set('company', fCompany.trim());
      return p.toString();
    },
    [fStage, fGoal, fCompany],
  );

  const load = useCallback(
    (offset = 0) => {
      if (offset === 0) setState({ phase: 'loading' });
      api<{ data: { counts: Counts; items: App[]; pagination: { hasMore: boolean } } }>(
        `/api/applications?${query(offset)}`,
      )
        .then((r) => {
          setState((prev) => {
            const merged =
              offset === 0 || prev.phase !== 'ready' ? r.data.items : [...prev.items, ...r.data.items];
            return { phase: 'ready', counts: r.data.counts, items: merged, hasMore: r.data.pagination.hasMore };
          });
        })
        .catch((e) => setState({ phase: 'error', message: errorText(e) }));
    },
    [query],
  );

  const loadOptions = useCallback(() => {
    if (!user) return;
    setOptionErr(null);
    api<{ data: { items: JdOption[] } }>('/api/jds')
      .then((r) => setJds(r.data.items))
      .catch((e) => { setJds([]); setOptionErr(errorText(e)); });
    api<{ data: { items: GoalItem[] } }>('/api/career-goals')
      .then((r) => setGoals(r.data.items.filter((g) => g.status === 'ACTIVE')))
      .catch((e) => { setGoals([]); setOptionErr(errorText(e)); });
  }, [user]);

  useEffect(() => {
    if (user) {
      load(0);
      loadOptions();
    }
  }, [user, load, loadOptions]);

  // T6-3-D P1-1：深链定位 —— /applications?a=<id> 直接打开对应详情（复用既有 GET /api/applications/:id，零新 API）；
  // 目标在当前页时列表行同时高亮；跨页时详情面板仍可展示（既有数据能力）。
  const params = useSearchParams();
  const aParam = params.get('a');
  const [highlightId, setHighlightId] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !aParam) return;
    setHighlightId(aParam);
    void openDetail(aParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, aParam]);

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  async function add() {
    if (!company.trim()) return;
    setSaving(true);
    setActionErr(null);
    try {
      await api('/api/applications', {
        method: 'POST',
        body: JSON.stringify({
          company: company.trim(),
          ...(position.trim() ? { position: position.trim() } : {}),
          ...(jdId ? { jdId } : {}),
          ...(careerGoalId ? { careerGoalId } : {}),
        }),
      });
      setCompany('');
      setPosition('');
      setJdId('');
      setCareerGoalId('');
      setShowAdd(false);
      load(0);
    } catch (e) {
      setActionErr(errorText(e));
    } finally {
      setSaving(false);
    }
  }

  async function changeStage(item: App, stage: string) {
    const prev = item.stage;
    // 乐观更新：仅改这一行，并在失败时回滚
    setState((s) =>
      s.phase === 'ready'
        ? {
            ...s,
            items: s.items.map((x) => (x.id === item.id ? { ...x, stage, stageLabel: STAGE_LABEL[stage] } : x)),
          }
        : s,
    );
    try {
      await api(`/api/applications/${item.id}`, { method: 'PATCH', body: JSON.stringify({ stage }) });
      // 计数需要重新拉取（阶段分布已变化）
      load(0);
    } catch (e) {
      setActionErr('保存失败，已恢复原状态：' + errorText(e));
      setState((s) =>
        s.phase === 'ready'
          ? {
              ...s,
              items: s.items.map((x) => (x.id === item.id ? { ...x, stage: prev, stageLabel: STAGE_LABEL[prev] } : x)),
            }
          : s,
      );
    }
  }

  async function openDetail(id: string) {
    setActionErr(null);
    try {
      const r = await api<{ data: { application: Detail } }>(`/api/applications/${id}`);
      setDetail(r.data.application);
    } catch (e) {
      setActionErr(errorText(e));
    }
  }

  const counts = state.phase === 'ready' ? state.counts : null;
  const items = state.phase === 'ready' ? state.items : [];
  const hasMore = state.phase === 'ready' ? state.hasMore : false;

  const cards = [
    { label: '累计投递', value: counts?.total ?? 0, key: true },
    { label: '筛选中', value: counts?.screening ?? 0 },
    { label: '面试中', value: counts?.interviewing ?? 0 },
    { label: 'Offer', value: counts?.offer ?? 0 },
    { label: '未通过', value: counts?.rejected ?? 0 },
    { label: '已撤回', value: counts?.withdrawn ?? 0 },
  ];

  return (
    <div className="content-wrap">
      <PageHeader
        title="我的求职"
        description="跟踪每一次投递的状态流转，避免长时间无进展的申请被遗漏。"
        actions={
          <button className="btn btn-primary" type="button" aria-expanded={showAdd} onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? '收起' : '添加投递'}
          </button>
        }
      />
      <WorkflowTrail current="applications" />

      {showAdd && (
        <div className="card wf-card">
          <div className="wf-fields">
            <div className="field">
              <label htmlFor="app-company">公司名称</label>
              <input id="app-company" className="input" value={company} onChange={(e) => setCompany(e.target.value)} placeholder="例如：云枢智能" />
            </div>
            <div className="field">
              <label htmlFor="app-position">职位名称（可选，关联 JD 时自动预填）</label>
              <input id="app-position" className="input" value={position} maxLength={120} onChange={(e) => setPosition(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="app-jd">关联岗位（可选）</label>
              <select id="app-jd" className="select" value={jdId} onChange={(e) => setJdId(e.target.value)}>
                <option value="">不关联</option>
                {jds.map((j) => <option key={j.id} value={j.id}>{j.title || '未命名岗位'}{j.company ? ` · ${j.company}` : ''}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="app-goal">关联求职目标（可选；仅显示进行中的目标）</label>
              <select id="app-goal" className="select" value={careerGoalId} onChange={(e) => setCareerGoalId(e.target.value)}>
                <option value="">不关联</option>
                {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>
          {optionErr && (
            <div className="banner banner-error mb-16" role="alert">
              岗位或求职目标列表加载失败：{optionErr}
            </div>
          )}
          <button className="btn btn-primary" onClick={add} disabled={saving || !company.trim()}>
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      )}

      {actionErr && <div className="banner banner-error mb-16" role="alert">{actionErr}</div>}

      <div className="wf-stats">
        {cards.map((c) => (
          <div key={c.label} className={`wf-stat${c.key ? ' is-key' : ''}`}>
            <div className="wf-stat-label">{c.label}</div>
            <div className="wf-stat-num">{c.value}</div>
          </div>
        ))}
      </div>

      {/* 筛选 */}
      <div className="card wf-card">
        <div className="wf-filter">
          <label className="sr-only" htmlFor="f-stage">按状态筛选</label>
          <select id="f-stage" className="select" value={fStage} onChange={(e) => setFStage(e.target.value)}>
            <option value="">全部状态</option>
            {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
          </select>
          <label className="sr-only" htmlFor="f-goal">按求职目标筛选</label>
          <select id="f-goal" className="select" value={fGoal} onChange={(e) => setFGoal(e.target.value)}>
            <option value="">全部求职目标</option>
            {goals.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <label className="sr-only" htmlFor="f-company">按公司搜索</label>
          <input
            id="f-company"
            className="input"
            value={fCompany}
            onChange={(e) => setFCompany(e.target.value)}
            placeholder="按公司搜索"
          />
          <button className="btn btn-secondary" onClick={() => load(0)}>筛选</button>
          {(fStage || fGoal || fCompany) && (
            <button className="btn btn-ghost" onClick={() => { setFStage(''); setFGoal(''); setFCompany(''); }}>
              清除
            </button>
          )}
        </div>
      </div>

      {state.phase === 'loading' && <LoadingState rows={3} />}
      {state.phase === 'error' && <ErrorState message={state.message} onRetry={() => load(0)} />}
      {state.phase === 'ready' && items.length === 0 && (
        <EmptyState
          title="还没有投递记录"
          description={
            fStage || fGoal || fCompany
              ? '当前筛选条件下没有匹配的投递记录。'
              : '记录每一次投递，进展才不会被遗漏。'
          }
          action={
            fStage || fGoal || fCompany ? (
              <button className="btn btn-secondary" onClick={() => { setFStage(''); setFGoal(''); setFCompany(''); }}>清除筛选</button>
            ) : (
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>添加投递</button>
            )
          }
        />
      )}

      {state.phase === 'ready' && items.length > 0 && (
        <div className="card wf-card">
          <div className="wf-table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>公司 / 职位</th>
                  <th className="wf-th-tight">状态</th>
                  <th className="wf-th-tight">申请时间</th>
                  <th className="wf-th-tight">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className={`applications-row${item.id === highlightId ? ' wf-row-highlight' : ''}`}>
                    <td>
                      <div className="wf-req-text">{item.company}</div>
                      {item.position && <div className="muted small">{item.position}</div>}
                    </td>
                    <td>
                      <label className="sr-only" htmlFor={`stage-${item.id}`}>修改 {item.company} 的投递状态</label>
                      <select
                        id={`stage-${item.id}`}
                        className="select wf-stage-select"
                        value={item.stage}
                        onChange={(e) => changeStage(item, e.target.value)}
                      >
                        {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
                      </select>
                    </td>
                    <td className="muted small">{formatDate(item.appliedAt)}</td>
                    <td>
                      <button className="btn btn-ghost small" onClick={() => void openDetail(item.id)}>详情</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="mt-16 row wf-center">
              <button className="btn btn-secondary" onClick={() => load(items.length)}>加载更多</button>
            </div>
          )}
        </div>
      )}

      {/* 详情面板 */}
      {detail && (
        <div className="card wf-card mt-16">
          <div className="wf-step-head mb-16">
            <div className="wf-step-body">
              <h2 className="wf-block-title wf-title-flush">{detail.company}</h2>
              {detail.position && <div className="muted small">{detail.position}</div>}
            </div>
            <div className="wf-step-side">
              <button className="btn btn-ghost small" onClick={() => setDetail(null)}>收起</button>
            </div>
          </div>
          <ul className="wf-rows">
            <li className="wf-row">
              <span className="wf-row-main">阶段</span>
              <span className="wf-row-side">{detail.stageLabel}</span>
            </li>
            <li className="wf-row">
              <span className="wf-row-main">申请时间</span>
              <span className="wf-row-side">{formatDateTime(detail.appliedAt)}</span>
            </li>
            {detail.notes && (
              <li className="wf-row">
                <span className="wf-row-main">备注</span>
                <span className="wf-row-side is-wrap">{detail.notes}</span>
              </li>
            )}
            <li className="wf-row">
              <span className="wf-row-main">关联</span>
              <span className="wf-row-side is-wrap">
                {detail.jdSummary
                  ? `岗位「${detail.jdSummary.title || '未命名岗位'}${detail.jdSummary.company ? ` · ${detail.jdSummary.company}` : ''}」`
                  : '无 JD（手动记录）'}
                {detail.careerGoalSummary ? ` · 目标「${detail.careerGoalSummary.name}」` : ''}
                {detail.resumeVersionSummary ? ` · 简历版本 v${detail.resumeVersionSummary.versionNo}` : ''}
              </span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}
