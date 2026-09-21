'use client';

/**
 * T3-A2-1 最小 UI：项目成果 → 候选能力 → 确认 闭环。
 * T3-A2-4 Phase 0：补齐浏览器端「创建成果 → 添加凭据 → 提交成果」入口。
 *
 * 边界（冻结约束）：
 * - API 是**唯一**执行点：本页只调用既有/新增 API，**不直接写 CONFIRMED**。
 * - **不在前端判断 provenance**：可确认性完全由服务端闸门决定，前端只展示服务端返回的原因。
 * - 不新增 PATCH/PUT；不新增第二个 confirm API（确认继续用 POST /api/capabilities/:id/confirm）。
 * - revoke 状态如实显示；已撤销的成果仍可查看历史凭据，但不作为可确认来源。
 * - 样式全部复用既有设计系统类（card / banner / field / chip / btn），不引入新样式。
 * - A2-4：创建成果只复用 `POST /api/project-results`；选择步骤复用**既有** `GET /api/action-plans`
 *   （不新增任何 API）；写操作一律由用户显式点击触发（无自动创建）。
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { api, errorText } from '../_lib/api';
import { useAuth } from '../_lib/auth';
import { EmptyState, ErrorState, LoadingState, ProcessingState } from '../_components/StatePanel';
import { PageHeader } from '../_components/PageHeader';
import { StepResultEntry } from '../_components/StepResultEntry';
import { ARTIFACT_KINDS, buildArtifactBody, canSubmitResultForTitle } from '../_lib/step-result-entry';
import { startTask, isTaskRunning, getTaskStartedAt, getTaskOutcome, type TaskOutcome } from '../_lib/task-session';

type AnalysisEvidence = { artifactId: string; point: string };
type AnalysisInsights = {
  strengths: string[];
  weaknesses: string[];
  evidence: AnalysisEvidence[];
  nextSteps: string[];
};
/**
 * Phase 1：分析响应 = candidates（兼容保留）+ 四个新增建议段。
 * 旧 task-session 缓存可能缺少新字段 → 读取时一律 `?? []` 防御。
 */
type CandidatesPayload = {
  candidates: Array<{ artifactId: string; key: string; label: string; rationale?: string }>;
  strengths?: string[];
  weaknesses?: string[];
  evidence?: AnalysisEvidence[];
  nextSteps?: string[];
};

type Artifact = { id: string; kind: string; url: string | null; excerpt: string | null; createdAt: string };
type ResultItem = {
  id: string; title: string; summary: string; status: 'DRAFT' | 'SUBMITTED' | 'REVOKED';
  sourceStepTitle: string; artifactCount: number; submittedAt: string | null; revokedAt: string | null;
};
type ResultDetail = ResultItem & { artifacts: Artifact[] };
type Capability = { id: string; key: string; label: string; level: string | null; status: string; source: string; createdAt: string };
type CapabilityDetail = Capability & {
  evidence: Array<{ id: string; type: string; source: string; url: string | null; excerpt: string | null }>;
};

/** A2-4：可提交成果的行动步骤（来自既有 GET /api/action-plans） */
type PlanStepOption = {
  key: string;
  planId: string;
  stepId: string;
  stepTitle: string;
  stepStatus: string;
  goal: string;
};

const RESULT_LABEL: Record<string, string> = { DRAFT: '草稿', SUBMITTED: '已提交', REVOKED: '已撤销' };
const RESULT_CHIP: Record<string, string> = {
  DRAFT: 'chip chip-unconfirmed',
  SUBMITTED: 'chip chip-confirmed',
  REVOKED: 'chip chip-missing',
};

export default function ProjectsPage() {
  const { user, loading } = useAuth();

  const [items, setItems] = useState<ResultItem[]>([]);
  const [detail, setDetail] = useState<ResultDetail | null>(null);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [capDetail, setCapDetail] = useState<CapabilityDetail | null>(null);

  const [artifactId, setArtifactId] = useState('');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  /** T3-A2-2：AI 候选建议（仅存在于内存，绝不落库） */
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeElapsed, setAnalyzeElapsed] = useState(0);
  const [analyzeErr, setAnalyzeErr] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Array<{ artifactId: string; key: string; label: string; rationale?: string }>>([]);
  /** Phase 1：优势 / 不足 / 证据 / 下一步（纯建议，仅内存；旧缓存缺字段时按空数组兜底） */
  const [insights, setInsights] = useState<AnalysisInsights | null>(null);
  /** G-4：AI 分析进行中的结果上下文 id（跨页保持用） */
  const analyzeTaskRef = useRef<{ userId: string; resultId: string } | null>(null);
  /** A2-4：新建成果 —— 先选步骤（既有 action-plans 列表），再复用 StepResultEntry */
  const [stepOptions, setStepOptions] = useState<PlanStepOption[]>([]);
  const [pickedKey, setPickedKey] = useState('');
  /** A2-4：草稿成果的凭据/提交入口（仅 DRAFT 可见；服务端仍会再校验状态） */
  const [aKind, setAKind] = useState('REPO');
  const [aUrl, setAUrl] = useState('');
  const [aExcerpt, setAExcerpt] = useState('');

  function loadResults() {
    api<{ data: { items: ResultItem[] } }>('/api/project-results')
      .then((r) => setItems(r.data.items))
      .catch((e) => setNotice({ kind: 'err', text: errorText(e) }));
  }
  function loadCapabilities() {
    api<{ data: { items: Capability[] } }>('/api/capabilities')
      .then((r) => setCaps(r.data.items))
      .catch((e) => setNotice({ kind: 'err', text: errorText(e) }));
  }

  /**
   * A2-4：从**既有** `GET /api/action-plans` 取出可提交成果的步骤。
   * 只复用读接口，不新增 API；仅 [学习] / [项目] 步骤进入列表（与步骤页入口一致）。
   */
  function loadStepOptions() {
    api<{ data: { items: Array<{ id: string; goal: string; actions: Array<{ id: string; title: string; status: string }> }> } }>('/api/action-plans')
      .then((r) => {
        const opts: PlanStepOption[] = [];
        for (const p of r.data.items ?? []) {
          for (const a of p.actions ?? []) {
            if (!canSubmitResultForTitle(a.title)) continue;
            opts.push({ key: `${p.id}:${a.id}`, planId: p.id, stepId: a.id, stepTitle: a.title, stepStatus: a.status, goal: p.goal });
          }
        }
        setStepOptions(opts);
      })
      .catch((e) => setNotice({ kind: 'err', text: errorText(e) }));
  }

  useEffect(() => {
    if (!user) return;
    loadResults();
    loadCapabilities();
    loadStepOptions();
    // 支持从步骤页「提交成果」后直达（?resultId=...）。
    // 读 location.search 而非 useSearchParams，避免静态预渲染需要 Suspense 边界。
    const rid = new URLSearchParams(window.location.search).get('resultId');
    if (rid) void openResult(rid);
  }, [user]);

  async function openResult(id: string) {
    setNotice(null);
    try {
      const r = await api<{ data: ResultDetail }>(`/api/project-results/${id}`);
      setDetail(r.data);
      const firstUrlArtifact = r.data.artifacts.find((a) => (a.url ?? '').trim().length > 0);
      setArtifactId(firstUrlArtifact?.id ?? '');
      setKey('');
      setLabel('');
      // G-4：恢复该成果的 AI 分析任务状态（在途 → 继续等待同一请求；已完成 → 恢复候选/错误）
      if (user) {
        const taskKey = `analyze:${user.id}:${id}`;
        if (isTaskRunning(taskKey)) {
          setAnalyzing(true);
          analyzeTaskRef.current = { userId: user.id, resultId: id };
          void startTask<CandidatesPayload>(taskKey, () => Promise.reject(new Error('unreachable')))
            .then((outcome) => applyAnalyzeOutcome(outcome, id))
            .catch(() => setAnalyzing(false));
        } else {
          const done = getTaskOutcome<CandidatesPayload>(taskKey);
          if (done) {
            analyzeTaskRef.current = { userId: user.id, resultId: id };
            applyAnalyzeOutcome(done, id);
          }
        }
      }
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    }
  }

  async function openCapability(id: string) {
    try {
      const r = await api<{ data: CapabilityDetail }>(`/api/capabilities/${id}`);
      setCapDetail(r.data);
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    }
  }

  /** 声明候选能力：调用 declare API，一切判定由服务端完成 */
  async function declare() {
    if (!detail || !artifactId || !key.trim() || !label.trim()) return;
    setBusy(true); setNotice(null);
    try {
      const r = await api<{ data: { capability: { id: string; status: string; source: string }; evidence: { created: boolean } } }>(
        `/api/project-results/${detail.id}/evidence`,
        { method: 'POST', body: JSON.stringify({ artifactId, key: key.trim(), label: label.trim() }) },
      );
      setNotice({
        kind: 'ok',
        text: r.data.evidence.created
          ? `已声明候选能力：${r.data.capability.status}（来源 ${r.data.capability.source}）。确认需由你在下方显式执行。`
          : '该凭据已声明过，未重复创建证据（幂等）。',
      });
      loadCapabilities();
      await openResult(detail.id);
      await openCapability(r.data.capability.id);
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  // G-3：AI 分析等待计时（经 task-session 的 startedAt 推导，跨页恢复时连续）
  useEffect(() => {
    if (!analyzing) return;
    const startedAt = analyzeTaskRef.current
      ? getTaskStartedAt(`analyze:${analyzeTaskRef.current.userId}:${analyzeTaskRef.current.resultId}`)
      : null;
    const t = setInterval(() => {
      setAnalyzeElapsed(startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0);
    }, 500);
    return () => clearInterval(t);
  }, [analyzing]);

  function applyAnalyzeOutcome(outcome: TaskOutcome<CandidatesPayload>, resultId: string) {
    if (resultId !== analyzeTaskRef.current?.resultId) return;
    setCandidates(outcome.kind === 'result' ? outcome.data.candidates : []);
    setInsights(
      outcome.kind === 'result'
        ? {
            strengths: outcome.data.strengths ?? [],
            weaknesses: outcome.data.weaknesses ?? [],
            evidence: outcome.data.evidence ?? [],
            nextSteps: outcome.data.nextSteps ?? [],
          }
        : null,
    );
    if (outcome.kind === 'result') {
      setNotice({
        kind: 'ok',
        text: outcome.data.candidates.length === 0
          ? 'AI 未给出候选建议（该成果可能不足以支撑明确能力）。'
          : `AI 给出 ${outcome.data.candidates.length} 条候选建议。注意：这些只是建议，尚未创建任何能力。`,
      });
    } else {
      setAnalyzeErr(outcome.message);
      setNotice({ kind: 'err', text: outcome.message });
    }
    setAnalyzing(false);
  }

  async function analyze() {
    if (!detail || !user) return;
    const taskKey = `analyze:${user.id}:${detail.id}`;
    setAnalyzing(true); setAnalyzeElapsed(0); setAnalyzeErr(null); setNotice(null); setCandidates([]); setInsights(null);
    analyzeTaskRef.current = { userId: user.id, resultId: detail.id };
    const outcome = await startTask<CandidatesPayload>(taskKey, async () => {
      try {
        const r = await api<{ data: CandidatesPayload & { suggestionOnly: boolean } }>(
          `/api/project-results/${detail.id}/analyze`,
          { method: 'POST', body: JSON.stringify({}) },
        );
        return { kind: 'result' as const, data: r.data };
      } catch (e) {
        return { kind: 'error' as const, message: `AI 分析失败：${errorText(e)}` };
      }
    });
    applyAnalyzeOutcome(outcome, detail.id);
  }

  /** 采纳候选：调用 A2-1 既有写路径（本页不直接写 Capability） */
  async function adopt(c: { artifactId: string; key: string; label: string }) {
    if (!detail) return;
    setBusy(true); setNotice(null);
    try {
      const r = await api<{ data: { capability: { id: string; status: string; source: string }; evidence: { created: boolean } } }>(
        `/api/project-results/${detail.id}/evidence`,
        { method: 'POST', body: JSON.stringify({ artifactId: c.artifactId, key: c.key, label: c.label }) },
      );
      setNotice({
        kind: 'ok',
        text: r.data.evidence.created
          ? `已采纳：候选能力 ${r.data.capability.status}（来源 ${r.data.capability.source}）。确认仍需你在下方显式执行。`
          : '该候选此前已采纳过（幂等，未重复创建证据）。',
      });
      setCandidates((prev) => prev.filter((x) => !(x.artifactId === c.artifactId && x.key === c.key)));
      loadCapabilities();
      await openResult(detail.id);
      await openCapability(r.data.capability.id);
    } catch (e) {
      setNotice({ kind: 'err', text: `采纳失败：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  /**
   * A2-4：为「草稿」成果添加凭据（复用既有 `POST /api/project-results/:id/artifacts`）。
   * 非 DRAFT 时服务端会以 `RESULT_NOT_EDITABLE`(422) 拒绝；本页也只在 DRAFT 时渲染该入口。
   */
  async function addArtifact() {
    if (!detail) return;
    const body = buildArtifactBody({ kind: aKind, url: aUrl, excerpt: aExcerpt });
    if (!body) {
      setNotice({ kind: 'err', text: '请至少填写凭据链接或凭据摘要其中一项' });
      return;
    }
    setBusy(true); setNotice(null);
    try {
      await api(`/api/project-results/${detail.id}/artifacts`, { method: 'POST', body: JSON.stringify(body) });
      setNotice({ kind: 'ok', text: '已添加凭据。提交成果后即可声明候选能力。' });
      setAUrl(''); setAExcerpt('');
      await openResult(detail.id);
      loadResults();
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  /** A2-4：提交草稿成果（复用既有 `POST /api/project-results/:id/submit`） */
  async function submitResult() {
    if (!detail) return;
    setBusy(true); setNotice(null);
    try {
      await api(`/api/project-results/${detail.id}/submit`, { method: 'POST' });
      setNotice({ kind: 'ok', text: '成果已提交。现在可以为它声明候选能力。' });
      await openResult(detail.id);
      loadResults();
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  /** 确认：仍走既有唯一入口；前端不做任何 provenance 判断 */
  async function confirmCapability(id: string) {    setBusy(true); setNotice(null);
    try {
      await api(`/api/capabilities/${id}/confirm`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      setNotice({ kind: 'ok', text: '确认成功：该能力已标记为 CONFIRMED。' });
      loadCapabilities();
      await openCapability(id);
    } catch (e) {
      setNotice({ kind: 'err', text: `确认失败：${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <div className="content-wrap"><LoadingState rows={3} /></div>;
  if (!user) return <div className="content-wrap"><ErrorState message="请先登录" /></div>;

  const urlArtifacts = (detail?.artifacts ?? []).filter((a) => (a.url ?? '').trim().length > 0);
  const pickedStep = stepOptions.find((o) => o.key === pickedKey) ?? null;

  return (
    <div className="content-wrap">
      <PageHeader
        title="制作项目"
        description="把「已提交」的项目成果声明为候选能力。声明只产生 未确认（UNCONFIRMED）候选；确认必须由你本人显式执行，且由服务端校验来源是否有效。"
      />

      {notice && (
        <div className={notice.kind === 'ok' ? 'banner banner-info' : 'banner banner-error'} role="status">
          {notice.text}
        </div>
      )}

      <section className="card">
        <h2>新建成果</h2>
        <p className="muted">
          成果必须来自一个具体的行动步骤（保持可追溯）。选择步骤 → 填写产出与凭据 → 保存并提交。
          提交后即可在下方声明候选能力。
        </p>
        {stepOptions.length === 0 ? (
          <EmptyState
            title="暂无可用步骤。请先到「岗位行动计划」生成计划（只有 [学习] / [项目] 步骤可以提交成果）。"
            action={<Link className="btn btn-primary" href="/match">去岗位对照，生成行动计划 →</Link>}
          />
        ) : (
          <>
            <div className="field">
              <label>选择行动步骤</label>
              <select className="select" value={pickedKey} onChange={(e) => setPickedKey(e.target.value)}>
                <option value="">请选择 [学习] / [项目] 步骤</option>
                {stepOptions.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.goal} · {o.stepTitle}（{o.stepStatus}）
                  </option>
                ))}
              </select>
            </div>
            {pickedStep && (
              <StepResultEntry
                planId={pickedStep.planId}
                sourceStepId={pickedStep.stepId}
                stepTitle={pickedStep.stepTitle}
                onCreated={() => loadResults()}
                onSubmitted={() => loadResults()}
              />
            )}
          </>
        )}
      </section>

      <section className="card">
        <div className="row-between" style={{ alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>我的成果</h2>
          {/* P1-3：闭环下一步 —— 有成果后引导去投递 */}
          {items.length > 0 && <Link className="btn btn-secondary" href="/applications">去投递 →</Link>}
        </div>
        {items.length === 0 ? (
          <EmptyState
            title="还没有项目成果。可用上方「新建成果」选择行动步骤创建，或到「岗位行动计划」的步骤里点击「提交成果」。"
            action={<Link className="btn btn-secondary" href="/match">去岗位对照 →</Link>}
          />
        ) : items.map((i) => (
          <div key={i.id} className="row-between" style={{ padding: '6px 0' }}>
            <button className="btn-ghost" onClick={() => void openResult(i.id)}>{i.title}</button>
            <span className="row">
              <span className={RESULT_CHIP[i.status] ?? 'chip'}>{RESULT_LABEL[i.status] ?? i.status}</span>
              <span className="muted">凭据 {i.artifactCount}</span>
            </span>
          </div>
        ))}
      </section>

      {detail && (
        <section className="card">
          <h2>成果详情：{detail.title}</h2>
          <p className="muted">
            来源步骤：{detail.sourceStepTitle} · 状态：{RESULT_LABEL[detail.status] ?? detail.status}
          </p>

          <h3>凭据</h3>
          {detail.artifacts.length === 0 ? (
            <EmptyState title="该成果还没有凭据" />
          ) : detail.artifacts.map((a) => (
            <div key={a.id} className="row-between" style={{ padding: '6px 0' }}>
              <span className="row">
                <span className="chip">{a.kind}</span>
                {a.url
                  ? <a href={a.url} target="_blank" rel="noopener noreferrer">{a.url}</a>
                  : <span className="muted">（无链接）</span>}
              </span>
              {a.excerpt && <span className="muted">{a.excerpt}</span>}
            </div>
          ))}

          {/* A2-4：草稿状态的成果，可在此添加凭据并提交（服务端仍会校验状态与凭据闸门） */}
          {detail.status === 'DRAFT' && (
            <>
              <h3>添加凭据</h3>
              <div className="field">
                <label>凭据类型</label>
                <select className="select" value={aKind} onChange={(e) => setAKind(e.target.value)} disabled={busy}>
                  {ARTIFACT_KINDS.map((k) => (
                    <option key={k} value={k}>{k}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>凭据链接（可核验，建议填写）</label>
                <input className="input" value={aUrl} onChange={(e) => setAUrl(e.target.value)} disabled={busy} placeholder="https://github.com/you/repo" />
              </div>
              <div className="field">
                <label>凭据摘要（无链接时的文字说明）</label>
                <input className="input" value={aExcerpt} onChange={(e) => setAExcerpt(e.target.value)} disabled={busy} placeholder="例如：已完成容器化并留下部署记录" />
              </div>
              <button className="btn btn-secondary" disabled={busy || (!aUrl.trim() && !aExcerpt.trim())} onClick={() => void addArtifact()}>
                添加凭据
              </button>

              <h3>提交成果</h3>
              <p className="muted">
                提交需要至少 1 条凭据；不带链接的凭据可以提交，但无法作为能力确认依据（确认要求可验证来源）。
              </p>
              <button className="btn btn-primary" disabled={busy || detail.artifacts.length === 0} onClick={() => void submitResult()}>
                提交成果
              </button>
            </>
          )}

          <h3>声明候选能力</h3>
          {detail.status !== 'SUBMITTED' && (            <div className="banner banner-warn">
              只有「已提交」的成果可以声明能力。草稿请先提交；已撤销的成果不能作为确认依据。
            </div>
          )}
          {detail.status === 'SUBMITTED' && urlArtifacts.length === 0 && (
            <div className="banner banner-warn">
              该成果没有带链接的凭据。确认要求可验证来源，请先在成果中添加带链接的凭据。
            </div>
          )}

          <div className="field">
            <label>选择凭据</label>
            <select className="select" value={artifactId} onChange={(e) => setArtifactId(e.target.value)} disabled={detail.status !== 'SUBMITTED'}>
              <option value="">请选择带链接的凭据</option>
              {urlArtifacts.map((a) => (
                <option key={a.id} value={a.id}>{a.kind} · {a.url}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>能力标识 key</label>
            <input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder="例如 docker" />
          </div>
          <div className="field">
            <label>能力名称</label>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如 Docker 容器化" />
          </div>
          <button
            className="btn btn-primary"
            disabled={busy || detail.status !== 'SUBMITTED' || !artifactId || !key.trim() || !label.trim()}
            onClick={() => void declare()}
          >
            声明候选能力
          </button>

          <h3>AI 分析（建议，不会写入数据）</h3>
          <div className="banner banner-info">
            点击后才会调用模型（仅此一次，不会自动触发）。AI 只提出候选建议；你**采纳**后才会创建
            「未确认」候选能力，最终仍需你显式**确认**。
          </div>
          <button
            className="btn btn-secondary"
            disabled={analyzing || busy || detail.status !== 'SUBMITTED'}
            onClick={() => void analyze()}
          >
            {analyzing ? '分析中…' : 'AI 分析该成果'}
          </button>

          {analyzing && (
            <div className="mt-16">
              <ProcessingState steps={['正在读取成果内容…', 'AI 提取候选能力…', '整理候选建议…']} elapsed={analyzeElapsed} />
            </div>
          )}
          {analyzeErr && !analyzing && (
            <div className="mt-16">
              <div className="banner banner-error">{analyzeErr}</div>
              <button className="btn btn-secondary mt-8" onClick={() => void analyze()} disabled={busy || detail.status !== 'SUBMITTED'}>
                重试 AI 分析
              </button>
            </div>
          )}

          {candidates.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p className="muted">以下为 AI 建议（未确认、未落库），选择其中合适的进行采纳：</p>
              {candidates.map((c) => (
                <div key={`${c.artifactId}-${c.key}`} className="row-between" style={{ padding: '6px 0' }}>
                  <span className="row">
                    <span className="chip">{c.key}</span>
                    <strong>{c.label}</strong>
                    {c.rationale && <span className="muted">{c.rationale}</span>}
                  </span>
                  <button className="btn btn-primary small" disabled={busy} onClick={() => void adopt(c)}>
                    采纳
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Phase 1：优势 / 不足 / 证据 / 下一步 —— 全部为 AI 建议，零写入；evidence 只引用用户提交的凭据 */}
          {insights && !analyzing && (
            <div style={{ marginTop: 12 }}>
              <h3>项目分析</h3>
              <p className="muted small">以下分析仅基于你提交的成果与凭据内容，属于 AI 建议，不代表能力确认。</p>
              <h4 style={{ margin: '8px 0 4px' }}>优势</h4>
              {insights.strengths.length === 0 ? (
                <div className="muted small">（无）</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {insights.strengths.map((s, i) => <li key={i} className="small">{s}</li>)}
                </ul>
              )}
              <h4 style={{ margin: '8px 0 4px' }}>不足</h4>
              {insights.weaknesses.length === 0 ? (
                <div className="muted small">无法从当前提交内容判断，或暂未发现明显不足。</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {insights.weaknesses.map((s, i) => <li key={i} className="small">{s}</li>)}
                </ul>
              )}
              <h4 style={{ margin: '8px 0 4px' }}>证据（来自你提交的凭据）</h4>
              {insights.evidence.length === 0 ? (
                <div className="muted small">（无）</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {insights.evidence.map((e, i) => {
                    const art = detail.artifacts.find((a) => a.id === e.artifactId);
                    return (
                      <li key={i} className="small" style={{ marginBottom: 4 }}>
                        {e.point}
                        {art && (
                          <span className="muted small"> —— {art.kind}{art.url ? ` · ${art.url}` : ''}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <h4 style={{ margin: '8px 0 4px' }}>下一步</h4>
              {insights.nextSteps.length === 0 ? (
                <div className="muted small">（无）</div>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {insights.nextSteps.map((s, i) => <li key={i} className="small">{s}</li>)}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2>我的能力</h2>
        {caps.length === 0 ? (
          <EmptyState title="还没有能力记录" />
        ) : caps.map((c) => (
          <div key={c.id} className="row-between" style={{ padding: '6px 0' }}>
            <button className="btn-ghost" onClick={() => void openCapability(c.id)}>{c.label}</button>
            <span className="row">
              <span className={c.status === 'CONFIRMED' ? 'chip chip-confirmed' : 'chip chip-unconfirmed'}>
                {c.status === 'CONFIRMED' ? '已确认' : '未确认'}
              </span>
              <span className="muted">来源 {c.source}</span>
              {c.status !== 'CONFIRMED' && (
                <button className="btn btn-secondary small" disabled={busy} onClick={() => void confirmCapability(c.id)}>
                  确认
                </button>
              )}
            </span>
          </div>
        ))}
      </section>

      {capDetail && (
        <section className="card">
          <h2>能力详情：{capDetail.label}</h2>
          <p className="muted">
            状态：{capDetail.status} · 来源：{capDetail.source} · level：{capDetail.level ?? '—'}
          </p>
          <h3>证据来源</h3>
          {capDetail.evidence.length === 0 ? (
            <EmptyState title="该能力没有证据，无法确认" />
          ) : capDetail.evidence.map((e) => (
            <div key={e.id} className="row-between" style={{ padding: '6px 0' }}>
              <span className="row">
                <span className={e.type === 'PROJECT_RESULT_EVIDENCE' ? 'chip chip-confirmed' : 'chip chip-inferred'}>
                  {e.type === 'PROJECT_RESULT_EVIDENCE' ? '项目成果证据' : '简历事实证据'}
                </span>
                <span className="muted small">{e.type}</span>
              </span>
              <span className="muted">
                {e.url ?? e.excerpt ?? '（无可用链接）'}
              </span>
            </div>
          ))}
        </section>
      )}

      <p className="muted">
        本页仅调用服务端 API。确认由服务端闸门判定：项目成果来源需「凭据有链接」且「成果未撤销」；
        简历来源仍沿用原有判据。
      </p>
    </div>
  );
}
