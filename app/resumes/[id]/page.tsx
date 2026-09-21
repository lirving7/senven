'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../../_lib/api';
import { useAuth } from '../../_lib/auth';
import { EmptyState, ErrorState, LoadingState } from '../../_components/StatePanel';
import { PageHeader } from '../../_components/PageHeader';
import { FactChip, factLabel } from '../../_components/FactChip';
import { EvidenceRef, type EvidenceItem } from '../../_components/EvidenceRef';
import { IconChevronRight, IconArrowRight, IconIdCard } from '../../_components/icons';

/**
 * Resume 事实确认工作区（UI Phase 2-B-2）。
 *
 * 事实安全：本页**只呈现** API 实际返回的事实与状态，不推断能力 / 质量 / 完成度。
 * 计数口径与 `/api/resumes/:id` 契约一致（items.length + 各 status 计数）。
 */

type Section = 'SKILL' | 'PROJECT' | 'EDUCATION' | 'EXPERIENCE';

type Item = {
  id: string;
  section: Section;
  title: string;
  detail: string | null;
  status: string;
  evidence: EvidenceItem[];
};

/** 详情接口返回的 resume 级字段（sourceType / createdAt）。缺失时降级，不渲染 null。 */
type ResumeMeta = { sourceType?: string; createdAt?: string };

const SECTIONS: Array<{ key: Section; label: string }> = [
  { key: 'SKILL', label: '技能' },
  { key: 'PROJECT', label: '项目经历' },
  { key: 'EXPERIENCE', label: '实习与工作' },
  { key: 'EDUCATION', label: '教育经历' },
];

// ── null / empty 守卫（与 /resumes 列表页同口径）──────────────────────

function safeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function safeCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function sourceTypeLabel(v: unknown): string {
  const s = safeText(v);
  if (s === null) return '来源未标注';
  return s === 'TEXT' ? '粘贴文本' : s;
}

function formatCreatedAt(v: unknown): string | null {
  const s = safeText(v);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('zh-CN');
}

/** 只接受已知四态；未知状态原样返回，交由 FactChip 既有降级处理。 */
function sectionLabel(k: unknown): string {
  const s = safeText(k);
  const hit = SECTIONS.find((x) => x.key === s);
  return hit ? hit.label : (s ?? '其他');
}

/** 该状态是否属于「可确认」集合 —— 与后端 confirmItem 的允许转移一致（UNCONFIRMED / INFERRED）。 */
function isConfirmable(status: string): boolean {
  return status === 'UNCONFIRMED' || status === 'INFERRED';
}

type DetailState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: Item[]; meta: ResumeMeta }
  | { phase: 'error'; message: string; requestId?: string };

export default function ResumeConfirmPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const [detail, setDetail] = useState<DetailState>({ phase: 'loading' });
  const [confirming, setConfirming] = useState<Set<string>>(new Set());
  const [actionErr, setActionErr] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!user) return;
    setDetail({ phase: 'loading' });
    setActionErr(null);
    api<{ data?: { sourceType?: string; createdAt?: string; items?: Item[] } }>(`/api/resumes/${id}`)
      .then((r) => {
        const raw = r?.data?.items;
        const items = Array.isArray(raw) ? raw.filter((x): x is Item => Boolean(x) && typeof x === 'object') : [];
        setDetail({ phase: 'ready', items, meta: { sourceType: r?.data?.sourceType, createdAt: r?.data?.createdAt } });
      })
      .catch((e: unknown) => {
        const reqId = e instanceof ApiRequestError ? e.requestId : undefined;
        setDetail({ phase: 'error', message: errorText(e), requestId: reqId });
      });
  }, [user, id]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmOne(item: Item) {
    if (confirming.has(item.id)) return;
    setActionErr(null);
    setConfirming((s) => new Set(s).add(item.id));
    try {
      await api(`/api/resumes/${id}/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ kind: item.section, confirm: true }),
      });
      // 只有服务端确认成功才更新本地状态 —— 失败绝不伪装成功
      setDetail((prev) =>
        prev.phase === 'ready'
          ? { ...prev, items: prev.items.map((x) => (x.id === item.id ? { ...x, status: 'CONFIRMED' } : x)) }
          : prev,
      );
    } catch (e) {
      const ex = e as ApiRequestError;
      setActionErr(ex.code === 'ITEM_NOT_CONFIRMABLE' ? '该条目没有可核验的依据，无法确认' : errorText(ex));
    } finally {
      setConfirming((s) => {
        const n = new Set(s);
        n.delete(item.id);
        return n;
      });
    }
  }

  async function confirmGroup(section: Section) {
    if (detail.phase !== 'ready') return;
    const targets = detail.items.filter((i) => i.section === section && isConfirmable(i.status));
    for (const t of targets) await confirmOne(t);
  }

  if (loading) {
    return (
      <div className="content-wrap">
        <LoadingState rows={4} />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="content-wrap">
        <ErrorState message="请先登录" />
      </div>
    );
  }

  const items = detail.phase === 'ready' ? detail.items : [];
  const confirmed = items.filter((i) => i.status === 'CONFIRMED').length;
  const unconfirmed = items.filter((i) => i.status === 'UNCONFIRMED').length;
  const inferred = items.filter((i) => i.status === 'INFERRED').length;
  const total = items.length;
  const pending = unconfirmed + inferred;
  const canContinue = confirmed > 0;

  return (
    <div className="content-wrap">
      <PageHeader
        eyebrow={
          <>
            <span>我的简历</span>
            <span aria-hidden="true">·</span>
            <span>解析确认</span>
          </>
        }
        title="解析确认"
        description="这些是 AI 从简历中抽取的事实。逐条核对无误后确认；只有「已确认」的事实才会进入岗位对照与 PDF 导出。"
        actions={
          <>
            <Link className="btn btn-secondary" href={`/agent?resumeId=${id}`}>
              AI 求职助手
              <IconArrowRight />
            </Link>
            <Link className="btn btn-ghost rd-back" href="/resumes">
              <IconChevronRight className="rd-back-icon" />
              我的简历
            </Link>
          </>
        }
      />

      {/* ── Resume 概览：仅真实字段 ───────────────────────────────── */}
      <section className="rd-overview" aria-label="简历概览">
        <div className="rd-overview-item">
          <span className="rd-overview-label">来源</span>
          <span className="rd-overview-value">
            {detail.phase === 'ready' ? sourceTypeLabel(detail.meta.sourceType) : '—'}
          </span>
        </div>
        <div className="rd-overview-item">
          <span className="rd-overview-label">已解析事实</span>
          <span className="rd-overview-value">
            {detail.phase === 'ready' ? `${safeCount(total) ?? 0} 条` : '—'}
          </span>
        </div>
        <div className="rd-overview-item">
          <span className="rd-overview-label">已确认</span>
          <span className="rd-overview-value">
            {detail.phase === 'ready' ? `${confirmed} 条` : '—'}
          </span>
        </div>
        <div className="rd-overview-item">
          <span className="rd-overview-label">待确认</span>
          <span className="rd-overview-value">
            {detail.phase === 'ready' ? `${pending} 条` : '—'}
          </span>
        </div>
        <div className="rd-overview-item">
          <span className="rd-overview-label">创建时间</span>
          <span className="rd-overview-value">
            {detail.phase === 'ready' ? (formatCreatedAt(detail.meta.createdAt) ?? '时间未记录') : '—'}
          </span>
        </div>
      </section>

      {actionErr && (
        <div className="banner banner-error" role="alert">
          {actionErr}
        </div>
      )}

      {/* ── 事实工作区：四态互斥 ─────────────────────────────────── */}
      {detail.phase === 'loading' ? (
        <LoadingState rows={4} />
      ) : detail.phase === 'error' ? (
        <ErrorState message={detail.message} requestId={detail.requestId} onRetry={load} />
      ) : total === 0 ? (
        <EmptyState
          title="当前简历暂无已解析事实"
          description="这份简历尚未产出可核对的事实条目。可以返回简历列表重新添加，或前往 AI 求职助手继续。"
          action={
            <>
              <Link className="btn btn-secondary" href="/resumes">
                返回我的简历
              </Link>
              <Link className="btn btn-ghost" href={`/agent?resumeId=${id}`}>
                AI 求职助手
              </Link>
            </>
          }
        />
      ) : (
        <section className="rd-sections" aria-label="事实清单">
          {SECTIONS.map((sec) => {
            const group = items.filter((i) => i.section === sec.key);
            if (group.length === 0) return null;
            const groupPending = group.filter((i) => isConfirmable(i.status)).length;
            return (
              <div key={sec.key} className="rd-section">
                <div className="rd-section-head">
                  <h2 className="rd-section-title">
                    {sectionLabel(sec.key)}
                    <span className="rd-section-count">{group.length}</span>
                  </h2>
                  {groupPending > 0 && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm rd-group-btn"
                      onClick={() => confirmGroup(sec.key)}
                      disabled={group.some((i) => confirming.has(i.id))}
                    >
                      这 {groupPending} 条都正确
                    </button>
                  )}
                </div>
                <ul className="rd-list">
                  {group.map((item) => {
                    const title = safeText(item.title);
                    const detailText = safeText(item.detail);
                    const busy = confirming.has(item.id);
                    return (
                      <li key={item.id} className="rd-item">
                        <div className="rd-item-main">
                          <div className="rd-item-fact">
                            <FactChip status={item.status} />
                            <span className="rd-item-title">{title ?? '未标注内容'}</span>
                            {detailText && <span className="rd-item-detail">{detailText}</span>}
                          </div>
                          <EvidenceRef items={item.evidence} />
                        </div>
                        {isConfirmable(item.status) ? (
                          <button
                            type="button"
                            className="btn btn-primary rd-item-action"
                            onClick={() => confirmOne(item)}
                            disabled={busy}
                            aria-busy={busy}
                          >
                            {busy ? '确认中…' : '确认'}
                          </button>
                        ) : (
                          <span className="rd-item-state">
                            <FactChip status={item.status} aria-label={`状态：${factLabel(item.status)}，无需操作`} />
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>
      )}

      {/* ── 继续下一步 ─────────────────────────────────────────── */}
      {detail.phase === 'ready' && total > 0 && (
        <section className="rd-continue" aria-label="下一步">
          <div className="rd-continue-note">
            {canContinue ? (
              <>
                <IconIdCard />
                <span>已确认 {confirmed} 条事实，可以继续岗位对照。</span>
              </>
            ) : (
              <span>至少确认一条事实后，才能继续岗位对照。</span>
            )}
          </div>
          {canContinue ? (
            <Link className="btn btn-primary" href="/jds">
              继续：分析岗位
              <IconArrowRight />
            </Link>
          ) : (
            <button type="button" className="btn btn-primary" disabled aria-describedby="rd-continue-why">
              继续：分析岗位
            </button>
          )}
          {!canContinue && (
            <p id="rd-continue-why" className="rd-continue-why">
              当前已确认 0 条事实，该入口暂不可用。请先在上方逐条确认事实。
            </p>
          )}
        </section>
      )}
    </div>
  );
}
