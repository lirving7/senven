'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, errorText } from '../../../_lib/api';
import { useAuth } from '../../../_lib/auth';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../../../_components/StatePanel';
import { PageHeader } from '../../../_components/PageHeader';
import { FactChip, factLabel } from '../../../_components/FactChip';
import { IconAlert, IconChevronRight, IconIdCard, IconLayers } from '../../../_components/icons';

/**
 * 简历 PDF 导出工作区（UI Phase 2-B-3）。
 *
 * 事实安全：本页**只呈现** API 实际返回的数据，不推断质量 / 完成度 / 匹配度。
 *
 * 导出范围由后端 `src/domain/pdf/build.ts` 的三道闸门决定（本页不定义、不重算）：
 *   ① status === CONFIRMED
 *   ② 可信来源（RESUME_TEXT / USER_STATEMENT）+ locator + excerpt 均非空
 *   ③ verifyClaim() === VERDICT.ALLOW
 * 被挡在 PDF 之外的条目由 API 以 `excluded[]` 如实返回（含 status 与 reason），
 * 本页逐条展示 **事实内容 + 排除原因**，不把 `reason` 替换成自造文案。
 */

type Version = {
  versionId: string;
  versionNo: number;
  pdfUrl: string | null;
  createdAt: string;
};

/** POST 响应里的被排除条目（与后端 PdfExcludedItem 同形）。 */
type ExcludedItem = {
  category: string | null;
  text: string;
  status: string | null;
  reason: string;
};

/** 生成完成后暂存的结果摘要（仅来自本次 POST 响应，不持久化、不跨导航保留）。 */
type ExcludedSummary = { count: number; items: ExcludedItem[] };

type VersionState =
  | { phase: 'loading' }
  | { phase: 'ready'; items: Version[] }
  | { phase: 'error'; message: string; requestId?: string };

// ── null / empty 守卫（与 /resumes、/resumes/[id] 同口径）──────────────

function safeText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function safeCount(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

function formatCreatedAt(v: unknown): string | null {
  const s = safeText(v);
  if (s === null) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('zh-CN');
}

/** 归一化 excluded[]：只保留结构完整的对象，字段缺失时降级而非渲染 null。 */
function normalizeExcluded(v: unknown): ExcludedItem[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((x) => ({
      category: safeText(x.category),
      text: safeText(x.text) ?? '未标注内容',
      status: safeText(x.status),
      reason: safeText(x.reason) ?? '未提供原因',
    }));
}

/** 归一化版本列表：缺 id 的行直接丢弃（不可导航的数据不渲染）。 */
function normalizeVersions(v: unknown): Version[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object')
    .map((x) => ({
      versionId: safeText(x.versionId) ?? '',
      versionNo: safeCount(x.versionNo) ?? 0,
      pdfUrl: safeText(x.pdfUrl),
      createdAt: safeText(x.createdAt) ?? '',
    }))
    .filter((x) => x.versionId.length > 0);
}

export default function ResumePdfPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [city, setCity] = useState('');

  const [versions, setVersions] = useState<VersionState>({ phase: 'loading' });
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [genErr, setGenErr] = useState<{ message: string; requestId?: string } | null>(null);
  const [excluded, setExcluded] = useState<ExcludedSummary | null>(null);
  const [lastResult, setLastResult] = useState<{ versionNo: number; confirmedCount: number } | null>(null);

  const loadVersions = useCallback(() => {
    if (!user) return;
    setVersions({ phase: 'loading' });
    api<{ data?: { items?: unknown } }>(`/api/resumes/${id}/versions`)
      .then((r) => setVersions({ phase: 'ready', items: normalizeVersions(r?.data?.items) }))
      .catch((e: unknown) => {
        const reqId = e instanceof ApiRequestError ? e.requestId : undefined;
        setVersions({ phase: 'error', message: errorText(e), requestId: reqId });
      });
  }, [user, id]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  // 生成等待计时（唯一用途：如实显示已等待时长）
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  async function generate() {
    if (!safeText(name)) {
      setGenErr({ message: '请先填写姓名' });
      return;
    }
    setBusy(true);
    setElapsed(0);
    setGenErr(null);
    setExcluded(null);
    setLastResult(null);
    try {
      const res = await api<{
        data?: {
          versionNo?: unknown;
          confirmedCount?: unknown;
          excluded?: unknown;
        };
      }>(`/api/resumes/${id}/versions`, {
        method: 'POST',
        body: JSON.stringify({
          basics: {
            name: name.trim(),
            phone: phone.trim(),
            email: email.trim(),
            city: city.trim(),
          },
        }),
      });

      const items = normalizeExcluded(res?.data?.excluded);
      setExcluded(items.length > 0 ? { count: items.length, items } : null);
      setLastResult({
        versionNo: safeCount(res?.data?.versionNo) ?? 0,
        confirmedCount: safeCount(res?.data?.confirmedCount) ?? 0,
      });
      // 成功后重新拉真实列表 —— 列表是权威来源，不在客户端伪造新行
      loadVersions();
    } catch (e) {
      const reqId = e instanceof ApiRequestError ? e.requestId : undefined;
      setGenErr({ message: errorText(e), requestId: reqId });
    } finally {
      setBusy(false);
    }
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

  const versionItems = versions.phase === 'ready' ? versions.items : [];
  const latest = versionItems.length > 0 ? versionItems[0] : null;

  return (
    <div className="content-wrap">
      <PageHeader
        eyebrow={
          <>
            <span>我的简历</span>
            <span aria-hidden="true">·</span>
            <span>导出</span>
          </>
        }
        title="简历 PDF"
        description="填写基本信息作为 PDF 顶部内容。只有通过事实核验的条目会进入 PDF；被排除的条目会如实列出原因。"
        actions={
          <Link className="btn btn-ghost pdf-back" href={`/resumes/${id}`}>
            <IconChevronRight className="pdf-back-icon" />
            返回简历
          </Link>
        }
      />

      {/* ── 基本信息（用于 PDF 顶部） ─────────────────────────────── */}
      <section className="card pdf-card" aria-labelledby="pdf-basics-title">
        <h2 className="pdf-card-title" id="pdf-basics-title">
          基本信息
        </h2>
        <p className="pdf-card-hint">这些字段直接写入 PDF 顶部，不参与事实核验。</p>

        <div className="pdf-form">
          <div className="field">
            <label htmlFor="pdf-name">
              姓名<span aria-hidden="true"> *</span>
            </label>
            <input
              id="pdf-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="林一舟"
              required
              autoComplete="name"
            />
          </div>
          <div className="field">
            <label htmlFor="pdf-phone">电话</label>
            <input
              id="pdf-phone"
              className="input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="138-0000-0000"
              autoComplete="tel"
            />
          </div>
          <div className="field">
            <label htmlFor="pdf-email">邮箱</label>
            <input
              id="pdf-email"
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </div>
          <div className="field">
            <label htmlFor="pdf-city">城市</label>
            <input
              id="pdf-city"
              className="input"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder="上海"
              autoComplete="address-level2"
            />
          </div>
        </div>

        <div className="pdf-actions">
          <button className="btn btn-primary" type="button" onClick={generate} disabled={busy} aria-busy={busy}>
            {busy ? '正在生成…' : '生成 PDF'}
          </button>
          {latest?.pdfUrl && (
            <a className="btn btn-secondary" href={latest.pdfUrl}>
              下载最新（第 {latest.versionNo} 版）
            </a>
          )}
        </div>

        <p className="pdf-scope">
          <IconLayers />
          <span>
            导出范围由事实核验决定：<strong>已确认</strong>且具备可核验原文位置的事实才进入 PDF；推断、待确认、缺失三类一律排除。
          </span>
        </p>
      </section>

      {/* ── 生成中 ────────────────────────────────────────────────── */}
      {busy && (
        <ProcessingState
          title="正在生成 PDF"
          steps={['校验事实是否满足导出条件…', '渲染单栏 A4 版面…', '写入版本快照…']}
          elapsed={elapsed}
        />
      )}

      {/* ── 生成失败：真实错误，不伪装成功 ──────────────────────── */}
      {genErr && !busy && (
        <div className="banner banner-error pdf-banner" role="alert">
          <IconAlert />
          <div className="pdf-banner-body">
            <div className="pdf-banner-title">生成失败</div>
            <div className="pdf-banner-text">{genErr.message}</div>
            {genErr.requestId && <div className="caption">请求号：{genErr.requestId}</div>}
            <button
              className="btn btn-secondary btn-sm pdf-banner-action"
              type="button"
              onClick={generate}
              disabled={!safeText(name)}
            >
              重试生成
            </button>
          </div>
        </div>
      )}

      {/* ── 生成成功摘要：仅真实计数 ────────────────────────────── */}
      {lastResult && !busy && !genErr && (
        <div className="banner banner-info pdf-banner" role="status">
          <IconIdCard />
          <div className="pdf-banner-body">
            <div className="pdf-banner-title">已生成第 {lastResult.versionNo} 版</div>
            <div className="pdf-banner-text">写入 PDF 的事实：{lastResult.confirmedCount} 条。</div>
          </div>
        </div>
      )}

      {/* ── 被排除条目：展示事实内容 + 后端返回的真实原因 ───────── */}
      {excluded && excluded.count > 0 && (
        <section className="card pdf-card" aria-labelledby="pdf-excluded-title">
          <h2 className="pdf-card-title" id="pdf-excluded-title">
            未进入本次 PDF 的条目
            <span className="pdf-count">{excluded.count}</span>
          </h2>
          <p className="pdf-card-hint">
            以下事实未被写入本次导出的 PDF。每条的原因来自导出时的实际校验结果。
          </p>
          <ul className="pdf-excluded-list">
            {excluded.items.map((x, i) => (
              <li key={`${x.text}-${i}`} className="pdf-excluded-item">
                <div className="pdf-excluded-head">
                  <span className="pdf-excluded-text">{x.text}</span>
                  {x.status && (
                    <FactChip status={x.status} aria-label={`导出时状态：${factLabel(x.status)}`} />
                  )}
                </div>
                <div className="pdf-excluded-reason">
                  <span className="pdf-excluded-reason-label">原因</span>
                  <span>{x.reason}</span>
                </div>
              </li>
            ))}
          </ul>
          <p className="pdf-card-hint pdf-excluded-next">
            若需让这些内容进入 PDF，请返回简历页逐条核对并确认；若原因指向原文位置缺失，则该条目当前无法作为导出依据。
          </p>
        </section>
      )}

      {/* ── 版本历史：四态互斥，绝不把 error 渲染成 empty ──────── */}
      <section className="card pdf-card" aria-labelledby="pdf-history-title">
        <h2 className="pdf-card-title" id="pdf-history-title">
          版本历史
        </h2>

        {versions.phase === 'loading' ? (
          <LoadingState rows={2} />
        ) : versions.phase === 'error' ? (
          <ErrorState message={versions.message} requestId={versions.requestId} onRetry={loadVersions} />
        ) : versionItems.length === 0 ? (
          <EmptyState
            title="还没有生成过 PDF"
            description="填写上方基本信息并生成后，这里会出现每个版本的记录与下载入口。"
          />
        ) : (
          <>
            <div className="pdf-table-wrap">
              <table className="table">
                <caption className="sr-only">简历 PDF 版本历史</caption>
                <thead>
                  <tr>
                    <th scope="col">版本</th>
                    <th scope="col">生成时间</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {versionItems.map((v) => (
                    <tr key={v.versionId}>
                      <td className="pdf-version-no">第 {v.versionNo} 版</td>
                      <td className="muted small">
                        {formatCreatedAt(v.createdAt) ?? '时间未记录'}
                      </td>
                      <td>
                        {v.pdfUrl ? (
                          <a className="btn btn-secondary pdf-download" href={v.pdfUrl}>
                            下载 PDF
                          </a>
                        ) : (
                          <span className="muted small">暂不可下载</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pdf-card-hint pdf-history-note">
              每次生成都会创建一个新版本，历史版本不会被覆盖。
            </p>
          </>
        )}
      </section>
    </div>
  );
}
