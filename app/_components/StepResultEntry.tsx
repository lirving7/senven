'use client';

/**
 * T3-A2-4 · Phase 0 —— 「从 ActionStep 提交成果」入口组件。
 *
 * 严格边界（已在授权范围内冻结）：
 * - **只调用既有 API**：`POST /api/project-results`、`POST /api/project-results/:id/artifacts`、
 *   `POST /api/project-results/:id/submit`。不新增 API、不绕过 handler/repository。
 * - **只在用户显式点击后执行**：组件内**没有任何 useEffect**，
 *   因此页面加载、步骤状态变化（含 `status = DONE`）都不可能触发创建。
 * - **不自动生成 CapabilityEvidence、不写 CONFIRMED**：本组件不接触能力/证据链路；
 *   后续声明与确认仍只在「制作项目」页由用户显式执行。
 * - 步骤类型准入复用 `canSubmitResultForKind`（当前为 [学习] / [项目]）。
 */

import Link from 'next/link';
import { useState } from 'react';
import { api, errorText } from '../_lib/api';
import { parseStepKind } from '../_lib/step-entry';
import {
  ARTIFACT_KINDS,
  buildArtifactBody,
  buildCreateResultBody,
  buildResultTitlePrefill,
  canSubmitResultForKind,
  validateResultDraftInput,
} from '../_lib/step-result-entry';

type Notice = { kind: 'ok' | 'err'; text: string };

export function StepResultEntry({
  planId,
  sourceStepId,
  stepTitle,
  onCreated,
  onSubmitted,
}: {
  planId: string;
  sourceStepId: string;
  stepTitle: string;
  onCreated?: (resultId: string) => void;
  onSubmitted?: (resultId: string) => void;
}) {
  const kind = parseStepKind(stepTitle);
  const allowed = canSubmitResultForKind(kind);

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(() => buildResultTitlePrefill(stepTitle));
  const [summary, setSummary] = useState('');
  const [artifactKind, setArtifactKind] = useState<string>('REPO');
  const [url, setUrl] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);

  if (!allowed) return null;

  /** 显式执行入口：`submitNow=false` → 仅存草稿；`true` → 存草稿并立即提交 */
  async function run(submitNow: boolean) {
    const check = validateResultDraftInput(title, summary);
    if (!check.ok) {
      setNotice({ kind: 'err', text: check.reason });
      return;
    }
    const artifact = buildArtifactBody({ kind: artifactKind, url, excerpt });
    if (submitNow && !artifact) {
      setNotice({ kind: 'err', text: '提交成果需要至少 1 条凭据（链接或摘要）；只填标题与说明请选择「保存草稿」。' });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const created = await api<{ data: { id: string; status: string } }>('/api/project-results', {
        method: 'POST',
        body: JSON.stringify(buildCreateResultBody({ planId, sourceStepId, title, summary })),
      });
      const resultId = created.data.id;
      setCreatedId(resultId);
      onCreated?.(resultId);

      if (artifact) {
        await api(`/api/project-results/${resultId}/artifacts`, {
          method: 'POST',
          body: JSON.stringify(artifact),
        });
      }

      if (!submitNow) {
        setFinalStatus(created.data.status);
        setNotice({
          kind: 'ok',
          text: artifact
            ? `已保存草稿并添加 1 条凭据（${created.data.status}）。可在「制作项目」页提交，或继续补充凭据。`
            : `已保存草稿（${created.data.status}）。提交前需要至少 1 条凭据（链接或摘要）。`,
        });
        return;
      }

      const done = await api<{ data: { status: string } }>(`/api/project-results/${resultId}/submit`, {
        method: 'POST',
      });
      setFinalStatus(done.data.status);
      onSubmitted?.(resultId);
      setNotice({
        kind: 'ok',
        text: `成果已提交（${done.data.status}）。可在「制作项目」页为该成果声明候选能力（声明仍由你显式执行）。`,
      });
    } catch (e) {
      setNotice({ kind: 'err', text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const succeeded = finalStatus !== null;

  return (
    <div style={{ marginTop: 12, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
      {!open && (
        <div className="row-between" style={{ gap: 12 }}>
          <span className="small muted">该步骤完成后，可以把产出提交为成果，用于后续能力回流。</span>
          <button className="btn btn-secondary small" onClick={() => setOpen(true)}>
            提交成果
          </button>
        </div>
      )}

      {open && (
        <div>
          <div className="row-between">
            <strong className="small">提交该步骤的成果</strong>
            <button className="btn-ghost small" disabled={busy} onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          <p className="muted small">
            保存后可继续补充凭据；只有「已提交」的成果才能声明候选能力，且确认必须由你本人显式执行。
          </p>

          <div className="field">
            <label>成果标题</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy || succeeded} />
          </div>
          <div className="field">
            <label>成果说明（你做了什么）</label>
            <textarea
              className="textarea"
              rows={3}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              disabled={busy || succeeded}
              placeholder="例如：用 Docker 把服务容器化并部署到测试环境"
            />
          </div>
          <div className="field">
            <label>凭据类型</label>
            <select className="select" value={artifactKind} onChange={(e) => setArtifactKind(e.target.value)} disabled={busy || succeeded}>
              {ARTIFACT_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>凭据链接（可核验，建议填写）</label>
            <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} disabled={busy || succeeded} placeholder="https://github.com/you/repo" />
          </div>
          <div className="field">
            <label>凭据摘要（无链接时的文字说明）</label>
            <input className="input" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} disabled={busy || succeeded} placeholder="例如：已完成容器化并留下部署记录" />
          </div>

          <div className="row" style={{ gap: 12 }}>
            <button className="btn btn-secondary" disabled={busy || succeeded} onClick={() => void run(false)}>
              {busy ? '处理中…' : '保存草稿'}
            </button>
            <button className="btn btn-primary" disabled={busy || succeeded} onClick={() => void run(true)}>
              {busy ? '处理中…' : '保存并提交'}
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 8 }}>
            提示：不带链接的凭据可以保存，但无法作为能力确认依据（确认要求可验证来源）。
          </p>
        </div>
      )}

      {notice && (
        <div className={notice.kind === 'ok' ? 'banner banner-info' : 'banner banner-error'} style={{ marginTop: 8 }} role="status">
          {notice.text}
          {createdId && (
            <>
              {' '}
              <Link href={`/projects?resultId=${createdId}`}>前往「制作项目」（继续提交 / 声明候选能力）→</Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
