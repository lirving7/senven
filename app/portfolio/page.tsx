'use client';

/**
 * Portfolio V2-A/B（ADR-018）：作品集「项目 → 成果 → 凭据」可追溯展示 + 完整策展操作。
 *
 * 边界（冻结约束）：
 * - **API 唯一执行点**：只调用既有 API（portfolio-projects 7 端点 + project-results/capabilities 只读），
 *   零新 endpoint、零 contract change；归属完全由后端 ownership 语义（跨用户 404）保证。
 * - **用户主动策展**：创建/编辑/归档/添加/移除均由用户显式点击触发，无自动写入；
 *   全部写操作**零 LLM**，且不产生 Capability / CapabilityEvidence / CONFIRMED（Portfolio 非事实权威）。
 * - **加入资格 = 真实规则（ADR-014 P-1）**：仅 SUBMITTED 成果可加入；DRAFT/REVOKED 禁选并说明。
 * - **成员排序冻结（P-2）**：PortfolioProjectResult.displayOrder 仅 ADD 时设置，加入后不可改——
 *   UI 不提供成员重排；作品集排序用 PATCH displayOrder（列表按其 ASC 排序）。
 * - **REVOKED（继承 V2-A）**：已加入的已撤销成果保留历史、明示「来源成果已撤销」、不计有效统计；
 *   禁止自动删除关系；移除成员关系只解除引用，绝不删除成果/凭据/能力。
 * - 防重复提交：复用 task-session（startTask 同 key 去重）+ busy 锁，不建第二套任务系统。
 */

import { useEffect, useState } from 'react';
import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState } from '../_components/StatePanel';
import { PageHeader } from '../_components/PageHeader';
import { startTask, type TaskOutcome } from '../_lib/task-session';
import {
  PORTFOLIO_ARCHIVE_CONFIRM,
  PORTFOLIO_JOIN_GROUP_LABELS,
  PORTFOLIO_REMOVE_CONFIRM,
  PORTFOLIO_RESULT_STATUS_LABEL,
  PORTFOLIO_REVOKED_NOTICE,
  PORTFOLIO_SOURCE_LABELS,
  countEffectiveResults,
  filterConfirmedCapabilities,
  portfolioTaskKey,
  resultJoinEligibility,
  toPortfolioResultView,
  validatePortfolioForm,
  type PortfolioCapabilityRef,
  type PortfolioDetailPayload,
  type PortfolioProjectResultPayload,
  type PortfolioProjectSummary,
  type PortfolioResultView,
} from '../_lib/portfolio-view';

type CapabilityItem = PortfolioCapabilityRef & { source: string; createdAt: string };

/** GET /api/project-results 列表项（添加成果选择器数据源） */
type ResultListItem = {
  id: string;
  title: string;
  status: 'DRAFT' | 'SUBMITTED' | 'REVOKED';
  sourceStepTitle: string;
  artifactCount: number;
  submittedAt: string | null;
  revokedAt: string | null;
};

const RESULT_CHIP: Record<string, string> = {
  DRAFT: 'chip chip-unconfirmed',
  SUBMITTED: 'chip chip-confirmed',
  REVOKED: 'chip chip-missing',
};

export default function PortfolioPage() {
  const { user, loading } = useAuth();

  // ── 列表 ──
  const [items, setItems] = useState<PortfolioProjectSummary[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);

  // ── 详情 ──
  const [detail, setDetail] = useState<PortfolioDetailPayload | null>(null);
  const [views, setViews] = useState<PortfolioResultView[]>([]);
  const [confirmedCaps, setConfirmedCaps] = useState<PortfolioCapabilityRef[]>([]);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  // ── 编辑表单 ──
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editOrder, setEditOrder] = useState(0);
  const [editFeatured, setEditFeatured] = useState(false);

  // ── 添加成果 ──
  const [showPicker, setShowPicker] = useState(false);
  const [allResults, setAllResults] = useState<ResultListItem[]>([]);
  const [pickerErr, setPickerErr] = useState<string | null>(null);
  const [pickerBusy, setPickerBusy] = useState(false);

  const uid = user?.id ?? '';

  useEffect(() => {
    if (loading || !user) return;
    void refreshList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, loading]);

  async function refreshList() {
    setListBusy(true);
    setListErr(null);
    try {
      const r = await api<{ data: { items: PortfolioProjectSummary[] } }>('/api/portfolio-projects');
      setItems(r.data.items);
    } catch (e) {
      setListErr(errorText(e));
    } finally {
      setListBusy(false);
    }
  }

  async function refreshDetail(id: string) {
    setDetailBusy(true);
    setDetailErr(null);
    try {
      const [detailRes, capsRes] = await Promise.all([
        api<{ data: PortfolioDetailPayload }>(`/api/portfolio-projects/${id}`),
        api<{ data: { items: CapabilityItem[] } }>('/api/capabilities'),
      ]);
      const d = detailRes.data;
      const members = [...d.results, ...d.revokedResults];
      const results = await Promise.all(
        members.map((m) =>
          api<{ data: PortfolioProjectResultPayload }>(`/api/project-results/${m.projectResultId}`)
            .then((r) => toPortfolioResultView(m, r.data))
            .catch(() => null),
        ),
      );
      setDetail(d);
      setViews(results.filter((v): v is PortfolioResultView => v !== null));
      setConfirmedCaps(filterConfirmedCapabilities(capsRes.data.items));
    } catch (e) {
      setDetailErr(errorText(e));
    } finally {
      setDetailBusy(false);
    }
  }

  // ── 写操作（全部用户显式触发；task-session 同 key 去重 + busy 锁防重） ──

  async function createPortfolio(title: string, description: string) {
    const check = validatePortfolioForm({ title, description });
    if (!check.ok) {
      setFormErr(check.error);
      return;
    }
    setFormErr(null);
    if (createBusy) return;
    setCreateBusy(true);
    const outcome = await startTask(portfolioTaskKey('create', uid, 'new'), async (): Promise<TaskOutcome<null>> => {
      try {
        await api('/api/portfolio-projects', {
          method: 'POST',
          body: JSON.stringify({ title: check.title, description: check.description }),
        });
        return { kind: 'result', data: null };
      } catch (e) {
        return { kind: 'error', message: `创建失败：${errorText(e)}` };
      }
    });
    setCreateBusy(false);
    if (outcome.kind === 'result') {
      setShowCreate(false);
      setActionMsg('作品集已创建。');
      await refreshList();
    } else {
      setFormErr(outcome.message);
    }
  }

  async function saveEdit() {
    if (!detail) return;
    const check = validatePortfolioForm({ title: editTitle, description: editDesc });
    if (!check.ok) {
      setActionMsg(check.error);
      return;
    }
    if (actionBusy) return;
    setActionBusy(true);
    setActionMsg(null);
    const outcome = await startTask(portfolioTaskKey('patch', uid, detail.id), async (): Promise<TaskOutcome<null>> => {
      try {
        await api(`/api/portfolio-projects/${detail.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            title: check.title,
            description: check.description,
            displayOrder: Number.isFinite(editOrder) ? editOrder : undefined,
            featured: editFeatured,
          }),
        });
        return { kind: 'result', data: null };
      } catch (e) {
        return { kind: 'error', message: `保存失败：${errorText(e)}` };
      }
    });
    setActionBusy(false);
    if (outcome.kind === 'result') {
      setEditing(false);
      setActionMsg('已保存。');
      await refreshDetail(detail.id);
    } else {
      setActionMsg(outcome.message);
    }
  }

  async function archivePortfolio() {
    if (!detail || actionBusy) return;
    if (!window.confirm(PORTFOLIO_ARCHIVE_CONFIRM)) return;
    setActionBusy(true);
    setActionMsg(null);
    const outcome = await startTask(portfolioTaskKey('archive', uid, detail.id), async (): Promise<TaskOutcome<null>> => {
      try {
        await api(`/api/portfolio-projects/${detail.id}/archive`, { method: 'POST', body: JSON.stringify({}) });
        return { kind: 'result', data: null };
      } catch (e) {
        return { kind: 'error', message: `归档失败：${errorText(e)}` };
      }
    });
    setActionBusy(false);
    if (outcome.kind === 'result') {
      setActionMsg('已归档。');
      await refreshDetail(detail.id);
    } else {
      setActionMsg(outcome.message);
    }
  }

  async function openPicker() {
    if (!detail || detail.archivedAt) return;
    setShowPicker(true);
    setPickerErr(null);
    if (allResults.length > 0) return;
    setPickerBusy(true);
    try {
      const r = await api<{ data: { items: ResultListItem[] } }>('/api/project-results');
      setAllResults(r.data.items);
    } catch (e) {
      setPickerErr(errorText(e));
    } finally {
      setPickerBusy(false);
    }
  }

  async function addResult(projectResultId: string) {
    if (!detail || actionBusy) return;
    setActionBusy(true);
    setActionMsg(null);
    const outcome = await startTask(portfolioTaskKey('add', uid, `${detail.id}:${projectResultId}`), async (): Promise<TaskOutcome<null>> => {
      try {
        await api(`/api/portfolio-projects/${detail.id}/results`, {
          method: 'POST',
          body: JSON.stringify({ projectResultId }),
        });
        return { kind: 'result', data: null };
      } catch (e) {
        return { kind: 'error', message: `添加失败：${errorText(e)}` };
      }
    });
    setActionBusy(false);
    if (outcome.kind === 'result') {
      setShowPicker(false);
      setActionMsg('已加入作品集。');
      await refreshDetail(detail.id);
    } else {
      setActionMsg(outcome.message);
    }
  }

  async function removeResult(projectResultId: string) {
    if (!detail || actionBusy) return;
    if (!window.confirm(PORTFOLIO_REMOVE_CONFIRM)) return;
    setActionBusy(true);
    setActionMsg(null);
    const outcome = await startTask(portfolioTaskKey('remove', uid, `${detail.id}:${projectResultId}`), async (): Promise<TaskOutcome<null>> => {
      try {
        await api(`/api/portfolio-projects/${detail.id}/results/${projectResultId}`, { method: 'DELETE' });
        return { kind: 'result', data: null };
      } catch (e) {
        return { kind: 'error', message: `移除失败：${errorText(e)}` };
      }
    });
    setActionBusy(false);
    if (outcome.kind === 'result') {
      setActionMsg('已移除（仅解除引用，成果与凭据不受影响）。');
      await refreshDetail(detail.id);
    } else {
      setActionMsg(outcome.message);
    }
  }

  if (loading) return <LoadingState />;
  if (!user) return <ErrorState message="请先登录后管理作品集" />;

  // ── 详情视图 ──────────────────────────────────────────────────────────
  if (detail) {
    const archived = detail.archivedAt != null;
    const effective = countEffectiveResults(views);
    const activeViews = views.filter((v) => !v.revoked);
    const revokedViews = views.filter((v) => v.revoked);
    return (
      <div>
        <button
          className="btn-ghost small"
          disabled={actionBusy}
          onClick={() => {
            setDetail(null);
            setEditing(false);
            setShowPicker(false);
            void refreshList();
          }}
        >
          ← 返回作品集列表
        </button>

        <div className="card" style={{ marginTop: 12 }}>
          <h2 className="row">
            {detail.title}
            {detail.featured && <span className="chip chip-confirmed">精选</span>}
            {archived && <span className="chip">已归档</span>}
          </h2>
          {detail.description && <p>{detail.description}</p>}
          <p className="muted">
            排序 {detail.displayOrder} · 有效成果 {effective} 项
            {views.length !== effective && `（另有 ${views.length - effective} 项来源成果已撤销）`}
          </p>
          {confirmedCaps.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <p className="muted">{PORTFOLIO_SOURCE_LABELS.capability}</p>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {confirmedCaps.map((c) => (
                  <span key={c.id} className="chip chip-confirmed" title={`key: ${c.key}`}>
                    {c.label}
                    {c.level ? ` · ${c.level}` : ''}
                  </span>
                ))}
              </div>
            </div>
          )}
          {!archived && (
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button
                className="btn small"
                disabled={actionBusy}
                onClick={() => {
                  setEditing(true);
                  setEditTitle(detail.title);
                  setEditDesc(detail.description ?? '');
                  setEditOrder(detail.displayOrder);
                  setEditFeatured(detail.featured);
                  setActionMsg(null);
                }}
              >
                编辑
              </button>
              <button className="btn small" disabled={actionBusy || showPicker} onClick={() => void openPicker()}>
                添加项目成果
              </button>
              <button className="btn-ghost small" disabled={actionBusy} onClick={() => void archivePortfolio()}>
                归档
              </button>
            </div>
          )}
          {archived && <p className="muted">已归档：不可编辑、添加或移除成果（仍可查看）。</p>}
          {actionMsg && (
            <p className={actionMsg.startsWith('已') ? 'muted' : 'banner banner-error'} role={actionMsg.startsWith('已') ? 'status' : 'alert'}>
              {actionMsg}
            </p>
          )}
        </div>

        {editing && !archived && (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>编辑作品集</h3>
            <div className="field">
              <label>标题（1–120 字）</label>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} maxLength={120} />
            </div>
            <div className="field">
              <label>描述（0–2000 字，可空）</label>
              <textarea value={editDesc} onChange={(e) => setEditDesc(e.target.value)} maxLength={2000} rows={3} />
            </div>
            <div className="field">
              <label>排序值（列表按此升序）</label>
              <input type="number" value={editOrder} onChange={(e) => setEditOrder(Number(e.target.value))} />
            </div>
            <div className="field row">
              <label style={{ margin: 0 }}>
                <input type="checkbox" checked={editFeatured} onChange={(e) => setEditFeatured(e.target.checked)} /> 精选
              </label>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-primary small" disabled={actionBusy} onClick={() => void saveEdit()}>
                保存
              </button>
              <button className="btn-ghost small" disabled={actionBusy} onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        {showPicker && !archived && (
          <div className="card" style={{ marginTop: 12 }}>
            <h3>添加项目成果</h3>
            <p className="muted">只能加入「已提交」的成果；草稿须先提交，已撤销的成果不可加入。</p>
            {pickerBusy && <LoadingState rows={2} />}
            {pickerErr && <ErrorState message={pickerErr} />}
            {!pickerBusy && !pickerErr && allResults.length === 0 && (
              <EmptyState title="还没有任何项目成果。请先在「制作项目」页创建并提交成果。" />
            )}
            {(['SUBMITTED', 'DRAFT', 'REVOKED'] as const).map((group) => {
              const groupItems = allResults.filter((r) => r.status === group);
              if (groupItems.length === 0) return null;
              const label =
                group === 'SUBMITTED'
                  ? PORTFOLIO_JOIN_GROUP_LABELS.eligible
                  : group === 'DRAFT'
                    ? PORTFOLIO_JOIN_GROUP_LABELS.draft
                    : PORTFOLIO_JOIN_GROUP_LABELS.revoked;
              return (
                <div key={group} style={{ marginTop: 8 }}>
                  <p className="muted">{label}</p>
                  {groupItems.map((r) => {
                    const eligible = resultJoinEligibility(r.status) === 'ELIGIBLE';
                    return (
                      <div key={r.id} className="row-between" style={{ padding: '4px 0' }}>
                        <span className="row">
                          <strong>{r.title}</strong>
                          <span className={RESULT_CHIP[r.status] ?? 'chip'}>
                            {PORTFOLIO_RESULT_STATUS_LABEL[r.status] ?? r.status}
                          </span>
                          <span className="muted">凭据 {r.artifactCount}</span>
                        </span>
                        <button
                          className="btn btn-primary small"
                          disabled={!eligible || actionBusy}
                          onClick={() => void addResult(r.id)}
                        >
                          {eligible ? '加入' : '不可加入'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            <button className="btn-ghost small" style={{ marginTop: 8 }} onClick={() => setShowPicker(false)}>
              收起
            </button>
          </div>
        )}

        <h3 style={{ marginTop: 20 }}>成果</h3>
        {detailBusy && <LoadingState />}
        {detailErr && <ErrorState message={detailErr} />}
        {!detailBusy && !detailErr && activeViews.length === 0 && revokedViews.length === 0 && (
          <EmptyState title="该作品集还没有成果，点击「添加项目成果」加入。" />
        )}
        {activeViews.map((v) => (
          <ResultCard
            key={v.memberId}
            view={v}
            canRemove={!archived}
            busy={actionBusy}
            onRemove={() => void removeResult(v.resultId)}
          />
        ))}

        {revokedViews.length > 0 && (
          <>
            <h3 style={{ marginTop: 20 }}>已撤销的来源成果（保留历史，不计入有效成果）</h3>
            {revokedViews.map((v) => (
              <ResultCard
                key={v.memberId}
                view={v}
                canRemove={!archived}
                busy={actionBusy}
                onRemove={() => void removeResult(v.resultId)}
              />
            ))}
          </>
        )}
      </div>
    );
  }

  // ── 列表视图 ──────────────────────────────────────────────────────────
  return (
    <div className="content-wrap">
      <PageHeader
        title="作品集"
        description="管理可用于求职的项目作品，内容可追溯到你的真实项目成果与提交凭据。"
      />
      <div className="row" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-4)' }}>
        <button className="btn btn-primary small" disabled={createBusy} onClick={() => setShowCreate((s) => !s)}>
          {showCreate ? '收起创建表单' : items.length === 0 ? '创建你的第一个作品集' : '新建作品集'}
        </button>
      </div>

      {showCreate && (
        <CreateForm busy={createBusy} error={formErr} onSubmit={(t, d) => void createPortfolio(t, d)} />
      )}

      {listErr && <ErrorState message={listErr} />}
      {listBusy && <LoadingState />}
      {!listBusy && !listErr && items.length === 0 && !showCreate && (
        <EmptyState title="还没有作品集。" />
      )}
      <div style={{ display: 'grid', gap: 12 }}>
        {items.map((p) => (
          <div key={p.id} className="card row-between">
            <div className="row">
              <strong>{p.title}</strong>
              {p.featured && <span className="chip chip-confirmed">精选</span>}
              <span className="muted">排序 {p.displayOrder}</span>
            </div>
            <button
              className="btn small"
              disabled={detailBusy || createBusy}
              onClick={() => {
                setAllResults([]);
                setShowPicker(false);
                setEditing(false);
                setActionMsg(null);
                void refreshDetail(p.id);
              }}
            >
              查看详情
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 创建表单（POST body 仅 title + description：displayOrder/featured 走服务端默认值） */
function CreateForm({
  busy,
  error,
  onSubmit,
}: {
  busy: boolean;
  error: string | null;
  onSubmit: (title: string, description: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  return (
    <div className="card">
      <h3>创建作品集</h3>
      <div className="field">
        <label>标题（1–120 字）</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="例如：跨境电商运营作品集" />
      </div>
      <div className="field">
        <label>描述（0–2000 字，可空）</label>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} rows={3} />
      </div>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-primary small" disabled={busy || title.trim() === ''} onClick={() => onSubmit(title, desc)}>
        {busy ? '创建中…' : '创建'}
      </button>
    </div>
  );
}

/** 单个成果卡片：来源矩阵 + 凭据 + 移除（REVOKED 顶部警示） */
function ResultCard({
  view,
  canRemove,
  busy,
  onRemove,
}: {
  view: PortfolioResultView;
  canRemove: boolean;
  busy: boolean;
  onRemove: () => void;
}) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      {view.revoked && (
        <p className="banner banner-error" role="alert">
          {PORTFOLIO_REVOKED_NOTICE}
        </p>
      )}
      <div className="row-between">
        <h4 className="row">
          {PORTFOLIO_SOURCE_LABELS.result}
          <strong>{view.title}</strong>
          <span className={RESULT_CHIP[view.status] ?? 'chip'}>
            {PORTFOLIO_RESULT_STATUS_LABEL[view.status] ?? view.status}
          </span>
        </h4>
        {canRemove && (
          <button className="btn-ghost small" disabled={busy} onClick={onRemove}>
            移除成果
          </button>
        )}
      </div>
      <p>{view.summary}</p>
      <p className="muted">
        项目步骤：{view.sourceStepTitle}
        {view.sourceStepTargetRequirement ? `（${view.sourceStepTargetRequirement}）` : ''}
      </p>
      <p className="muted">提交时间：{view.submittedAt ? new Date(view.submittedAt).toLocaleString() : '—'}</p>
      {view.artifacts.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <p className="muted">{PORTFOLIO_SOURCE_LABELS.artifact}</p>
          {view.artifacts.map((a) => (
            <div key={a.id} className="row" style={{ padding: '4px 0', flexWrap: 'wrap' }}>
              <span className="chip">{a.kindLabel}</span>
              {a.url && (
                <a href={a.url} target="_blank" rel="noreferrer">
                  打开链接
                </a>
              )}
              {a.excerpt && <span className="muted">{a.excerpt}</span>}
            </div>
          ))}
        </div>
      )}
      {/* 指标真实性（ADR-018 §7）：无真实指标数据时直接不展示，无占位符 */}
    </div>
  );
}
