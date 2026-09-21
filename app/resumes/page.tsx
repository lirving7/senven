'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiForm, ApiRequestError, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../_components/StatePanel';
import { FactChip } from '../_components/FactChip';
import { PageHeader } from '../_components/PageHeader';
import { IconArrowRight, IconIdCard, IconUpload } from '../_components/icons';
import {
  startTask,
  isTaskRunning,
  getTaskStartedAt,
  type TaskOutcome,
} from '../_lib/task-session';

type ResumeParseOutcome = TaskOutcome<{ resumeId?: string; message?: string }>;

/**
 * 列表项：字段一律按可能缺失处理。
 * API 契约见 src/http/handlers/resume-read.ts:26-36 —— 但前端不得假定
 * 「字段一定存在 / 类型一定正确」，否则会出现 null / undefined / [object Object] 直出。
 */
type ResumeItem = {
  id?: string;
  sourceType?: string;
  createdAt?: string;
  itemCount?: number;
  statusSummary?: { confirmed?: number; inferred?: number; unconfirmed?: number };
};

/** 安全取非负整数：任何非有限数（含 null / undefined / NaN / 字符串）都返回 null。 */
function safeCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** 取非空字符串：trim 后为空即视为缺失。 */
function safeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * sourceType → 中文口径。
 * 与 app/page.tsx 的 sourceTypeLabel 保持同一映射（TEXT=粘贴文本，其余原样），
 * 不新增业务语义、不猜测未知类型的中文名。
 */
function sourceTypeLabel(v: unknown): string {
  const s = safeText(v);
  if (s === null) return '来源未标注';
  return s === 'TEXT' ? '粘贴文本' : s;
}

/**
 * 创建时间格式化。非法日期返回 null 由调用方决定是否展示，
 * 绝不渲染 "Invalid Date"。
 */
function formatCreatedAt(v: unknown): string | null {
  const s = safeText(v);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('zh-CN');
}

/**
 * 列表加载状态 ── 四态互斥，取代原来的 `.catch(() => setItems([]))`
 * （后者把 401/500/网络错误一律降级成「空列表」，让加载失败伪装成「没有简历」）。
 *
 *   loading  → 请求在途
 *   ready    → 请求成功（items 为空 = 真实空列表）
 *   error    → 请求失败（保留 message / requestId 供重试与排障）
 */
type ListState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: ResumeItem[] }
  | { phase: 'error'; message: string; requestId?: string };

export default function ResumesPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [text, setText] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<'idle' | 'submitting' | 'processing'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    if (!user) return;
    setList({ phase: 'loading' });
    api<{ data?: { items?: ResumeItem[] } }>('/api/resumes')
      .then((r) => {
        // 结构硬化：data / items 任一缺失都视为空列表，而非抛出或渲染 undefined
        const items = Array.isArray(r?.data?.items) ? r.data.items : [];
        setList({ phase: 'ready', items });
      })
      .catch((e: unknown) => {
        const reqId = e instanceof ApiRequestError ? e.requestId : undefined;
        setList({ phase: 'error', message: errorText(e), requestId: reqId });
      });
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (busy !== 'processing') return;
    const startedAt = getTaskStartedAt(`resume-parse:${user?.id ?? ''}`);
    const t = setInterval(() => {
      setElapsed(startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
    }, 500);
    return () => clearInterval(t);
  }, [busy, user]);

  // G-4：重挂载恢复 —— 上传解析在途则继续等待同一请求；已完成（含成功待跳转/失败）恢复结果
  useEffect(() => {
    const key = `resume-parse:${user?.id ?? ''}`;
    if (!user || !isTaskRunning(key)) return;
    setBusy('processing');
    setElapsed(Math.floor((Date.now() - (getTaskStartedAt(key) ?? Date.now())) / 1000));
    void startTask<{ resumeId?: string; message?: string }>(key, () => Promise.reject(new Error('unreachable')))
      .then((outcome) => applyOutcome(outcome))
      .catch(() => setBusy('idle'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  function applyOutcome(outcome: ResumeParseOutcome) {
    setBusy('idle');
    if (outcome.kind === 'result' && outcome.data.resumeId) {
      router.push(`/resumes/${outcome.data.resumeId}`);
    } else if (outcome.kind === 'result') {
      setErr(outcome.data.message ?? '没能识别出结构化信息');
    } else {
      setErr(outcome.message);
    }
  }

  async function runParse(task: () => Promise<ResumeParseOutcome>) {
    const key = `resume-parse:${user?.id ?? ''}`;
    if (isTaskRunning(key)) return;
    setBusy('processing');
    setElapsed(0);
    setErr(null);
    const outcome = await startTask(key, task);
    applyOutcome(outcome);
  }

  async function submitText() {
    if (!text.trim()) return;
    await runParse(async () => {
      try {
        const res = await api<{ data: { resumeId?: string; state?: string; message?: string } }>('/api/resumes', {
          method: 'POST',
          body: JSON.stringify({ rawText: text }),
        });
        if (res.data.resumeId) return { kind: 'result', data: { resumeId: res.data.resumeId } };
        return { kind: 'result', data: { message: res.data.message ?? '没能识别出结构化信息' } };
      } catch (e) {
        const ex = e as ApiRequestError;
        return { kind: 'error', message: ex.code === 'VALIDATION_FAILED' ? '仅支持 PDF / Word，单文件 ≤5MB' : errorText(ex) };
      }
    });
  }

  async function submitFile() {
    if (!file) return;
    await runParse(async () => {
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await apiForm<{ data: { resumeId?: string; state?: string; message?: string } }>('/api/resumes', form);
        if (res.data.resumeId) return { kind: 'result', data: { resumeId: res.data.resumeId } };
        return { kind: 'result', data: { message: res.data.message ?? '没能读取到文字' } };
      } catch (e) {
        const ex = e as ApiRequestError;
        return { kind: 'error', message: ex.code === 'VALIDATION_FAILED' ? '仅支持 PDF / Word，单文件 ≤5MB' : errorText(ex) };
      }
    });
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  const canSubmit = text.trim().length > 0 || file !== null;
  const items = list.phase === 'ready' ? list.items : null;

  return (
    <div className="content-wrap">
      <PageHeader
        title="我的简历"
        description="粘贴文本或上传 PDF / Word 解析简历。解析得到的经历需你逐条确认为事实后，才会参与后续的岗位对照。"
        actions={
          <Link className="btn btn-secondary" href="/agent">
            AI 求职助手
            <IconArrowRight />
          </Link>
        }
      />

      {/* ─── 上传 / 添加简历（主入口）────────────────────────────────────
          业务行为与改造前完全一致：同一按钮按 textarea 是否有内容决定
          提交文本还是提交文件；不新增第二套上传规则。 */}
      <section className="rs-entry" aria-labelledby="rs-entry-title">
        {busy === 'processing' ? (
          <ProcessingState steps={['正在读取内容…', '解析事实与证据…', '生成待确认条目…']} elapsed={elapsed} />
        ) : (
          <>
            <div className="rs-entry-head">
              <h2 className="rs-entry-title" id="rs-entry-title">添加简历</h2>
              <p className="rs-entry-note">
                支持粘贴文本或上传 PDF / Word，单文件 ≤5MB。解析结果需你逐条确认后才作为事实。
              </p>
            </div>

            <div className="field">
              <label htmlFor="resume-text">粘贴简历文本</label>
              <textarea
                id="resume-text"
                className="textarea"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="粘贴你的简历全文，例如：姓名、技能、项目经历、教育经历…"
              />
            </div>

            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.doc,.docx"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />

            <div className="rs-entry-actions">
              <button
                type="button"
                className="btn btn-secondary rs-file-btn"
                onClick={() => fileRef.current?.click()}
              >
                <IconUpload />
                {file ? '已选文件' : '上传文件（PDF / Word）'}
              </button>
              <button
                type="button"
                className="btn btn-primary rs-submit"
                disabled={!canSubmit}
                onClick={text.trim() ? submitText : submitFile}
              >
                解析简历
              </button>
            </div>

            {/* 已选文件名单独一行：避免长文件名把按钮撑开，也让「选了哪个文件」可见 */}
            {file && (
              <p className="rs-file-name" title={file.name}>
                已选文件：{file.name}
              </p>
            )}

            {err && <div className="banner banner-error mt-16" role="alert">{err}</div>}
          </>
        )}
      </section>

      {/* ─── 简历列表（事实工作区主体）─────────────────────────────────── */}
      <section aria-labelledby="rs-list-title">
        <div className="rs-list-head">
          <h2 className="rs-list-title" id="rs-list-title">已解析的简历</h2>
          {items && items.length > 0 && (
            <span className="rs-list-count">{items.length} 份</span>
          )}
        </div>

        {list.phase === 'loading' && <LoadingState rows={2} />}

        {list.phase === 'error' && (
          <ErrorState
            message={list.message}
            requestId={list.requestId}
            onRetry={load}
          />
        )}

        {list.phase === 'ready' && items && items.length === 0 && (
          <div className="card">
            <EmptyState
              title="还没有简历"
              description="用上方粘贴框或文件上传添加第一份。解析完成后需要你逐条确认，才会成为可用于岗位对照的事实。"
            />
          </div>
        )}

        {list.phase === 'ready' && items && items.length > 0 && (
          <ul className="rs-list">
            {items.map((r, i) => (
              <ResumeRow key={safeText(r?.id) ?? `resume-${i}`} item={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * 单份简历行。
 *
 * 信息层级：名称/标识（一行）→ 来源 + 创建时间（caption）→ 事实计数（chips）→ 操作。
 * 结构上刻意与「大卡片网格」区分：这是一条条可扫读的行。
 *
 * 结构约束（无障碍 / 合法 HTML）：
 *   两个可交互目标（整行进入详情、独立进入 PDF）必须是**兄弟节点**，
 *   不能把一个 <a> 嵌在另一个 <a> 里 —— 嵌套锚点是非法 HTML，
 *   会让键盘焦点顺序与屏幕阅读器语义错乱。
 *   因此行容器 <li> 内并排两个链接：.rs-row（主体）与 .rs-row-pdf（次级）。
 *
 * 事实安全：
 *   · 只展示 API 实际返回的计数，不推导「完成度 / 质量 / 是否有效」；
 *   · 0 条时如实写「0 条已解析事实」，不写「解析失败 / 丢失」（后端未提供该事实）；
 *   · 不做 `confirmed > 0 => 完成` 之类推断。
 */
function ResumeRow({ item }: { item: ResumeItem }) {
  const id = safeText(item?.id);
  const itemCount = safeCount(item?.itemCount);
  const summary = item?.statusSummary ?? {};
  const confirmed = safeCount(summary.confirmed) ?? 0;
  const unconfirmed = safeCount(summary.unconfirmed) ?? 0;
  const inferred = safeCount(summary.inferred) ?? 0;
  const createdAt = formatCreatedAt(item?.createdAt);
  const pending = unconfirmed + inferred;

  const summaryLine = [
    sourceTypeLabel(item?.sourceType),
    createdAt ? `创建于 ${createdAt}` : null,
  ].filter((s): s is string => s !== null).join(' · ');

  const title =
    itemCount === null
      ? '简历'
      : itemCount === 0
        ? '简历 · 0 条已解析事实'
        : `简历 · ${itemCount} 条已解析事实`;

  const inner = (
    <>
      <span className="rs-row-icon" aria-hidden="true">
        <IconIdCard />
      </span>

      <div className="rs-row-body">
        <div className="rs-row-title">{title}</div>
        <div className="rs-row-meta">{summaryLine}</div>
        <div className="rs-row-chips">
          <FactChip status="CONFIRMED">
            已确认<span className="rs-chip-num"> {confirmed}</span>
          </FactChip>
          <FactChip status="UNCONFIRMED">
            待确认<span className="rs-chip-num"> {unconfirmed}</span>
          </FactChip>
          {inferred > 0 && (
            <FactChip status="INFERRED">
              推断<span className="rs-chip-num"> {inferred}</span>
            </FactChip>
          )}
        </div>
      </div>
    </>
  );

  // 契约异常（缺 id）：不可导航，降级为静态行，绝不渲染 undefined 到 href
  if (!id) {
    return (
      <li className="rs-row rs-row-static">
        {inner}
        <div className="rs-row-actions">
          <span className="rs-row-go rs-row-go-muted">无法打开</span>
        </div>
      </li>
    );
  }

  return (
    <li className="rs-item">
      {/* 主体链接：覆盖除「版本 / PDF」按钮以外的整行区域 */}
      <Link className="rs-row" href={`/resumes/${id}`}>
        {inner}
        <span className="rs-row-actions">
          <span className="rs-row-go">
            {pending > 0 ? '继续确认' : '查看'}
            <IconArrowRight />
          </span>
        </span>
      </Link>

      {/* 次级链接：与主体链接是兄弟节点，不嵌套 */}
      <Link className="btn btn-secondary rs-row-pdf" href={`/resumes/${id}/pdf`}>
        版本 / PDF
      </Link>
    </li>
  );
}
