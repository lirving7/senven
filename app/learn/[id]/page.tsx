'use client';

/**
 * T3-A2-6 Phase 3 —— /learn/[id] 学习任务详情。
 *
 * 边界（冻结约束）：
 * - 只调用 `GET /api/learning-tasks/:id` / `PATCH` / `POST .../archive`；
 * - 状态只允许 PLANNED / IN_PROGRESS / PAUSED；不得出现 DONE/COMPLETED/VERIFIED/ARCHIVED 枚举；
 * - 禁止回退到 PLANNED（由服务端 422 拦截，前端只展示错误）；
 * - archive 后不得出现 restore；
 * - 若 sourceStepId 对应 ActionStep 已因 regenerate 不存在：仅作为历史快照展示，
 *   不得假设 ActionStep 仍存在，不得向悬空 step 自动提交 ProjectResult。
 */

import { use, useEffect, useState } from 'react';
import { api, errorText } from '../../_lib/api';
import { useAuth } from '../../_lib/auth';
import { ErrorState, LoadingState } from '../../_components/StatePanel';

type LearningTaskDetail = {
  id: string;
  actionPlanId: string;
  sourceStepId: string;
  sourceStepTitle: string;
  sourceStepTargetRequirement: string | null;
  content: string | null;
  status: 'PLANNED' | 'IN_PROGRESS' | 'PAUSED';
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const STATUS_LABEL: Record<string, string> = { PLANNED: '待开始', IN_PROGRESS: '进行中', PAUSED: '已暂停' };
const ALLOWED_STATUSES = ['PLANNED', 'IN_PROGRESS', 'PAUSED'] as const;

export default function LearnDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { user, loading } = useAuth();

  const [detail, setDetail] = useState<LearningTaskDetail | null>(null);
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  function load() {
    setNotice(null);
    api<{ data: LearningTaskDetail }>(`/api/learning-tasks/${id}`)
      .then((r) => {
        setDetail(r.data);
        setContent(r.data.content ?? '');
        setStatus(r.data.status);
      })
      .catch((e) => setNotice({ kind: 'err', text: errorText(e) }));
  }

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, id]);

  async function save() {
    if (!detail) return;
    setBusy(true); setNotice(null);
    try {
      const body: { status?: string; content?: string } = {};
      if (status !== detail.status) body.status = status;
      if (content !== (detail.content ?? '')) body.content = content;
      if (Object.keys(body).length === 0) {
        setNotice({ kind: 'ok', text: '没有需要保存的改动。' });
        return;
      }
      await api(`/api/learning-tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setNotice({ kind: 'ok', text: '已保存。' });
      await load();
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  async function archive() {
    if (!detail) return;
    setBusy(true); setNotice(null);
    try {
      await api(`/api/learning-tasks/${id}/archive`, { method: 'POST', body: JSON.stringify({}) });
      setNotice({ kind: 'ok', text: '已归档。该学习任务将不再出现在列表中。' });
      await load();
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;
  if (!detail) {
    return (
      <div className="content-wrap">
        {notice?.kind === 'err' ? <ErrorState message={notice.text} onRetry={load} /> : <LoadingState rows={3} />}
      </div>
    );
  }

  const archived = detail.archivedAt !== null;

  return (
    <div className="content-wrap">
      <h1>{detail.sourceStepTitle}</h1>
      <p className="muted">
        来源步骤目标要求：{detail.sourceStepTargetRequirement ?? '（无）'}
      </p>

      {notice && (
        <div className={notice.kind === 'ok' ? 'banner banner-info' : 'banner banner-error'} role="status">
          {notice.text}
        </div>
      )}

      <section className="card">
        <h2>学习记录</h2>
        <div className="row" style={{ gap: 16 }}>
          <span className={status === 'PLANNED' ? 'chip chip-unconfirmed' : status === 'IN_PROGRESS' ? 'chip chip-inferred' : 'chip chip-missing'}>
            {STATUS_LABEL[status] ?? status}
          </span>
          {archived && <span className="chip">已归档</span>}
        </div>

        <div className="field">
          <label>学习状态</label>
          <select
            className="select"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            disabled={busy || archived}
          >
            {ALLOWED_STATUSES.map((s) => (
              <option key={s} value={s}>{STATUS_LABEL[s]}（{s}）</option>
            ))}
          </select>
          {!archived && <p className="muted small">状态一旦从「待开始」推进，将不能回退到「待开始」。</p>}
        </div>

        <div className="field">
          <label>学习内容</label>
          <textarea
            className="input"
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={busy || archived}
            placeholder="记录你的学习过程、心得、产出…"
          />
        </div>

        {archived ? (
          <div className="banner banner-warn">该学习任务已归档，不可再修改状态或内容。</div>
        ) : (
          <div className="row">
            <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>保存</button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => void archive()}>归档</button>
          </div>
        )}
      </section>

      <p className="muted small">
        创建于 {new Date(detail.createdAt).toLocaleString()} · 更新于 {new Date(detail.updatedAt).toLocaleString()}
        {archived ? ` · 归档于 ${new Date(detail.archivedAt as string).toLocaleString()}` : ''}
      </p>
      <p className="muted small">
        学习过程本身不构成能力证据。若要把该学习转化为能力，请通过对应的项目成果提交可核验凭据。
      </p>
    </div>
  );
}
