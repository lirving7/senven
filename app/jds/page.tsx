'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../_components/StatePanel';
import { PageHeader } from '../_components/PageHeader';
import { WorkflowTrail } from '../_components/WorkflowTrail';
import { IconArrowRight, IconLoader } from '../_components/icons';
import {
  startTask,
  isTaskRunning,
  getTaskStartedAt,
  getTaskOutcome,
  type TaskOutcome,
} from '../_lib/task-session';

type Requirement = { id: string; text: string; category: string; criticality: 'MUST' | 'SHOULD' | 'BONUS' };
type PreviewRequirement = { text: string; category: string; criticality: 'MUST' | 'SHOULD' | 'BONUS'; verbatim: boolean };
type JdResult = { jdId: string; title: string | null; company: string | null; requirements: Requirement[]; warnings: string[]; duplicated: boolean };
type JdPreview = { token: string; title: string | null; company: string | null; requirements: PreviewRequirement[]; warnings: string[] };
type JdHistoryItem = { id: string; title: string | null; company: string | null; requirementCount: number; createdAt: string };
type JdPreviewOutcome =
  | { kind: 'preview'; previewToken: string; title: string | null; company: string | null; requirements: PreviewRequirement[]; warnings: string[] }
  | { kind: 'existing'; jdId: string; title: string | null; company: string | null; requirements: Requirement[]; warnings: string[]; duplicated: boolean };

/** 历史记录的四态：不用 null 兼任「加载中」与「空」，error 不得降级成 empty。 */
type HistoryState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: JdHistoryItem[] }
  | { phase: 'error'; message: string };

const CRITICALITY: Array<{ key: Requirement['criticality']; label: string }> = [
  { key: 'MUST', label: '必须具备' },
  { key: 'SHOULD', label: '建议具备' },
  { key: 'BONUS', label: '有则加分' },
];

const CATEGORY: Record<string, string> = {
  HARD: '硬性', TECH: '技术', DUTY: '职责', PLUS: '加分', EDUCATION: '教育', MAJOR: '专业', OTHER: '其他',
};

const MIN_LEN = 50;
const TITLE_MAX_LEN = 200;

/** 日期守卫：非法 / 缺失时间不得渲染成 "Invalid Date"。 */
function formatCreatedAt(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN');
}

function JdPage() {
  const params = useSearchParams();
  const { user, loading } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'idle' | 'processing' | 'saving-title'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<JdResult | null>(null);
  const [preview, setPreview] = useState<JdPreview | null>(null);
  const [history, setHistory] = useState<HistoryState>({ phase: 'loading' });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [titleErr, setTitleErr] = useState<string | null>(null);
  const [titleSaved, setTitleSaved] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const jdIdParam = params.get('jdId');

  // G-4：任务 key 含 userId；同 key 在途去重、已完成结果恢复
  const taskKey = user ? `jd-parse:${user.id}` : '';

  // G-6：历史分析记录（复用既有 GET /api/jds，纯前端入口）
  // 失败必须保留错误态，**不得** catch 成空列表（否则 API 故障会被读成「没有历史」）。
  function loadHistory() {
    if (!user) return;
    setHistory({ phase: 'loading' });
    api<{ data: { items: JdHistoryItem[] } }>('/api/jds')
      .then((r) => setHistory({ phase: 'ready', items: r.data.items }))
      .catch((e) => setHistory({ phase: 'error', message: errorText(e) }));
  }

  useEffect(() => {
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  useEffect(() => {
    if (busy === 'processing') {
      const startedAt = getTaskStartedAt(taskKey);
      const t = setInterval(() => {
        setElapsed(startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
      }, 500);
      return () => clearInterval(t);
    }
  }, [busy, taskKey]);

  useEffect(() => {
    if (!jdIdParam || !user) return;
    api<{ data: { id: string; title: string | null; company: string | null; requirements: Requirement[] } }>(`/api/jds/${jdIdParam}`)
      .then((r) => setResult({ jdId: r.data.id, title: r.data.title, company: r.data.company, requirements: r.data.requirements, warnings: [], duplicated: false }))
      .catch(() => setErr('无法读取该 JD'));
  }, [jdIdParam, user]);

  // G-4：重挂载恢复 —— 在途则继续等待同一请求；已完成则恢复结果
  useEffect(() => {
    if (!user || !taskKey || !isTaskRunning(taskKey)) return;
    setBusy('processing');
    setElapsed(Math.floor((Date.now() - (getTaskStartedAt(taskKey) ?? Date.now())) / 1000));
    void startTask<JdPreviewOutcome>(taskKey, () => Promise.reject(new Error('unreachable')))
      .then((outcome) => {
        applyOutcome(outcome);
        loadHistory();
      })
      .catch(() => setBusy('idle'));
  }, [user, taskKey]);

  useEffect(() => {
    if (!user || !taskKey || isTaskRunning(taskKey)) return;
    const done = getTaskOutcome<JdPreviewOutcome>(taskKey);
    if (done) {
      applyOutcome(done);
      loadHistory();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, taskKey]);

  useEffect(() => {
    if (editing) {
      const id = requestAnimationFrame(() => titleInputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [editing]);

  function applyOutcome(outcome: TaskOutcome<JdPreviewOutcome>) {
    setBusy('idle');
    if (outcome.kind === 'result') {
      setErr(null);
      if (outcome.data.kind === 'preview') {
        // 解析成功：直接创建 JD，不再弹出命名窗口
        setPreview({
          token: outcome.data.previewToken,
          title: outcome.data.title,
          company: outcome.data.company,
          requirements: outcome.data.requirements,
          warnings: outcome.data.warnings,
        });
        void createJobDescription(outcome.data.previewToken, null);
      } else {
        setResult({
          jdId: outcome.data.jdId,
          title: outcome.data.title,
          company: outcome.data.company,
          requirements: outcome.data.requirements,
          warnings: outcome.data.warnings,
          duplicated: outcome.data.duplicated,
        });
      }
    } else {
      setErr(outcome.message);
    }
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  async function parse() {
    if (isTaskRunning(taskKey)) return;
    setBusy('processing');
    setElapsed(0);
    setErr(null);
    setPreview(null);
    setResult(null);

    const outcome = await startTask(taskKey, async (): Promise<TaskOutcome<JdPreviewOutcome>> => {
      try {
        const res = await api<{
          data: {
            previewToken: string | null;
            jdId: string | null;
            duplicated: boolean;
            title: string | null;
            company: string | null;
            requirementCount: number;
            requirements: Array<PreviewRequirement | Requirement>;
            warnings: string[];
          };
        }>('/api/jds/preview', {
          method: 'POST',
          body: JSON.stringify({ rawText: text }),
        });

        if (res.data.duplicated && res.data.jdId) {
          const detail = await api<{ data: { id: string; title: string | null; company: string | null; requirements: Requirement[] } }>(`/api/jds/${res.data.jdId}`);
          return {
            kind: 'result',
            data: {
              kind: 'existing',
              jdId: detail.data.id,
              title: detail.data.title,
              company: detail.data.company,
              requirements: detail.data.requirements,
              warnings: res.data.warnings,
              duplicated: true,
            },
          };
        }

        const token = res.data.previewToken;
        if (!token) {
          return { kind: 'error', message: '解析结果异常，请重试' };
        }

        return {
          kind: 'result',
          data: {
            kind: 'preview',
            previewToken: token,
            title: res.data.title,
            company: res.data.company,
            requirements: res.data.requirements as PreviewRequirement[],
            warnings: res.data.warnings,
          },
        };
      } catch (e) {
        return { kind: 'error', message: errorText(e) };
      }
    });
    applyOutcome(outcome);
    loadHistory();
  }

  async function createJobDescription(token: string, title: string | null) {
    try {
      const res = await api<{ data: { jdId: string; duplicated: boolean; warnings: string[] } }>('/api/jds', {
        method: 'POST',
        // title 为 null 时必须归一为 undefined：JSON.stringify 会省略 undefined 字段，
        // 而服务端 createJdSchema 的 title 是 .optional()（只接受 string | undefined），
        // 直接发送 {"title":null} 会被 Zod 判为 "Expected string, received null"（HTTP 400）。
        body: JSON.stringify({ rawText: text, title: title ?? undefined, previewToken: token }),
      });
      const detail = await api<{ data: { id: string; title: string | null; company: string | null; requirements: Requirement[] } }>(`/api/jds/${res.data.jdId}`);
      setResult({
        jdId: detail.data.id,
        title: detail.data.title,
        company: detail.data.company,
        requirements: detail.data.requirements,
        warnings: res.data.warnings,
        duplicated: res.data.duplicated,
      });
      setPreview(null);
      setErr(null);
      loadHistory();
    } catch (e) {
      setErr(errorText(e));
      setBusy('idle');
    }
  }

  function startEdit() {
    if (!result) return;
    setDraft(result.title ?? '');
    setEditing(true);
    setTitleErr(null);
    setTitleSaved(false);
  }

  function cancelEdit() {
    setEditing(false);
    setTitleErr(null);
    setDraft('');
  }

  async function saveTitle() {
    if (!result || busy === 'saving-title') return;
    if (draft.length > TITLE_MAX_LEN) {
      setTitleErr(`岗位名称最多 ${TITLE_MAX_LEN} 字符`);
      return;
    }
    setBusy('saving-title');
    setTitleErr(null);
    try {
      const res = await api<{ data: { id: string; title: string | null; company: string | null; requirementCount: number } }>(`/api/jds/${result.jdId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: draft }),
      });
      setResult({
        ...result,
        title: res.data.title,
        company: res.data.company,
      });
      setEditing(false);
      setTitleSaved(true);
      setTimeout(() => setTitleSaved(false), 2000);
      loadHistory();
    } catch (e) {
      setTitleErr(errorText(e));
    } finally {
      setBusy('idle');
    }
  }

  function onTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      void saveTitle();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }

  const short = text.trim().length < MIN_LEN;
  const displayTitle = result?.title || '未命名岗位';
  const historyItems = history.phase === 'ready' ? history.items : [];

  return (
    <div className="content-wrap">
      <PageHeader
        title="分析岗位"
        description="粘贴招聘信息，解析出分级要求清单。解析结果会保存为可复用的岗位记录。"
      />
      <WorkflowTrail current="jd" />

      <div className="card wf-card">
        <div className="field">
          <label htmlFor="jd-text">粘贴招聘信息</label>
          <textarea id="jd-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴岗位职责、任职要求…" aria-describedby="jd-text-count" />
          <span className="field-hint" id="jd-text-count">{text.trim().length} 字{short ? `（还需 ${MIN_LEN - text.trim().length} 字）` : ''}</span>
        </div>
        <button className="btn btn-primary" disabled={short || busy === 'processing'} onClick={parse}>
          {busy === 'processing' ? '解析中…' : '解析岗位'}
        </button>
        {err && (
          <div className="mt-16">
            <div className="banner banner-error" role="alert">{err}</div>
            <button className="btn btn-secondary mt-8" onClick={() => void parse()} disabled={short || busy === 'processing' || !text.trim()}>
              重试解析
            </button>
          </div>
        )}
      </div>

      {busy === 'processing' && <ProcessingState steps={['正在理解岗位要求…', '分桶…', '判定重要程度…']} elapsed={elapsed} />}

      {result && (
        <div className="card wf-card">
          <div className="wf-step-head mb-16">
            <div className="wf-step-body">
              {editing ? (
                <div className="field wf-title-flush">
                  <label htmlFor="jd-title-input">岗位名称</label>
                  <input
                    id="jd-title-input"
                    ref={titleInputRef}
                    className="input"
                    type="text"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onTitleKeyDown}
                    maxLength={TITLE_MAX_LEN}
                    placeholder="例如：AI视频制作实习生"
                    disabled={busy === 'saving-title'}
                  />
                  <span className="muted small">{draft.length}/{TITLE_MAX_LEN}</span>
                  {titleErr && <div className="banner banner-error mt-8" role="alert">{titleErr}</div>}
                  <div className="row mt-8">
                    <button className="btn btn-ghost" onClick={cancelEdit} disabled={busy === 'saving-title'} type="button">
                      取消
                    </button>
                    <button className="btn btn-primary" onClick={() => void saveTitle()} disabled={busy === 'saving-title'} type="button">
                      {busy === 'saving-title' ? '保存中…' : '保存'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <h2 className="wf-block-title">
                    {displayTitle}{result.company ? ` · ${result.company}` : ''}
                    <button className="btn btn-ghost small" onClick={startEdit} type="button">
                      编辑
                    </button>
                  </h2>
                  {titleSaved && <div className="banner banner-success" role="status">已保存</div>}
                  <div className="muted small">共 {result.requirements.length} 条要求</div>
                </>
              )}
            </div>
          </div>

          <div className="wf-next">
            <span className="wf-next-text">解析完成。把这份岗位和你的简历逐条对照，得到能力差距。</span>
            <span className="wf-next-actions">
              {/* P2-4：岗位 → 求职目标入口（仅跳转既有 /goals，不自动设置 isCurrent） */}
              <Link className="btn btn-ghost" href={`/goals?jdId=${result.jdId}`}>加入求职目标</Link>
              <Link className="btn btn-ghost" href={`/agent?jdId=${result.jdId}`}>AI 求职助手</Link>
              <Link className="btn btn-primary" href={`/match?jdId=${result.jdId}`}>
                与我的简历对照
                <IconArrowRight className="wf-go-icon" size={16} />
              </Link>
            </span>
          </div>

          {result.duplicated && <div className="banner banner-info">这段 JD 你已解析过，已复用既有结果。</div>}
          {result.warnings.map((w, i) => <div key={i} className="banner banner-warn">{w}</div>)}

          {CRITICALITY.map((c) => {
            const group = result.requirements.filter((r) => r.criticality === c.key);
            if (group.length === 0) return null;
            return (
              <div key={c.key} className="wf-block">
                <h3 className="wf-block-title">{c.label} · {group.length}</h3>
                <ul className="wf-rows">
                  {group.map((r) => (
                    <li key={r.id} className="wf-row">
                      <span className="wf-req-text">{r.text}</span>
                      <span className="wf-req-cat">{CATEGORY[r.category] ?? r.category}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {/* ─── G-6：历史分析记录（复用既有 GET /api/jds，点击经 ?jdId= 恢复详情） ─── */}
      <div className="card wf-card">
        <h2 className="wf-block-title">
          历史分析记录
          {history.phase === 'ready' && <span className="muted small">· {historyItems.length}</span>}
        </h2>
        {history.phase === 'loading' && <LoadingState rows={2} />}
        {history.phase === 'error' && <ErrorState message={history.message} onRetry={loadHistory} />}
        {history.phase === 'ready' && historyItems.length === 0 && (
          <EmptyState
            title="还没有分析过任何岗位"
            description="在上方粘贴一段招聘信息，解析结果会自动保存，之后可在这里复用。"
          />
        )}
        {history.phase === 'ready' && historyItems.length > 0 && (
          <ul className="wf-rows">
            {historyItems.map((h) => (
              <li key={h.id}>
                <Link className="wf-row is-link" href={`/jds?jdId=${h.id}`}>
                  <span className="wf-row-main">
                    {h.title || '未命名岗位'}{h.company ? ` · ${h.company}` : ''}
                  </span>
                  <span className="wf-row-side">
                    {h.requirementCount} 条要求 · {formatCreatedAt(h.createdAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function JdPageWrapper() {
  return (
    <Suspense fallback={<div className="content-wrap"><ProcessingState steps={[]} /></div>}>
      <JdPage />
    </Suspense>
  );
}
