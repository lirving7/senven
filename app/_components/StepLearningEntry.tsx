'use client';

/**
 * T3-A2-6 Phase 4 —— 「从 ActionStep 创建学习任务」入口组件。
 *
 * 严格边界（冻结约束）：
 * - **只调用既有 API**：`POST /api/learning-tasks`（唯一写入口）；不新增 API。
 * - **只在用户显式点击后执行**：组件内**没有任何 useEffect**，加载/状态变化不触发创建。
 * - **不重新定义 Step Type**：复用 `parseStepKind`（单一来源，派生自 `step-type.ts`）；
 *   仅 `[学习]` 步骤显示本入口。
 * - 创建参数全部来自当前 ActionPlan / ActionStep 上下文（不来自自由输入）。
 * - 遵守后端契约：首次 201 / active 重复 200 / archived 重复 409。
 */

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiRequestError, errorText } from '../_lib/api';
import { parseStepKind } from '../_lib/step-entry';

type Notice = { kind: 'ok' | 'err'; text: string };

export function StepLearningEntry({
  planId,
  sourceStepId,
  stepTitle,
  targetRequirement,
}: {
  planId: string;
  sourceStepId: string;
  stepTitle: string;
  targetRequirement: string | null;
}) {
  const kind = parseStepKind(stepTitle);
  // 仅 [学习] 步骤显示本入口（与 StepResultEntry 的 [学习]/[项目] 分开）
  const allowed = kind === 'LEARN';

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  if (!allowed) return null;

  async function create() {
    setBusy(true);
    setNotice(null);
    try {
      const created = await api<{ data: { id: string; status: string } }>('/api/learning-tasks', {
        method: 'POST',
        body: JSON.stringify({
          actionPlanId: planId,
          sourceStepId,
          // content 留空：由用户到 /learn/[id] 再填写学习内容
        }),
      });
      setCreatedId(created.data.id);
      setNotice({ kind: 'ok', text: `已创建学习任务（${created.data.status}）。` });
    } catch (e) {
      const ex = e as ApiRequestError;
      if (ex.code === 'LEARNING_TASK_ARCHIVED_EXISTS') {
        setNotice({ kind: 'err', text: '该步骤此前已创建过学习任务并归档，不能重复创建。' });
      } else {
        setNotice({ kind: 'err', text: errorText(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: '2px solid var(--border)' }}>
      {!open && (
        <div className="row-between" style={{ gap: 12 }}>
          <span className="small muted">把该学习步骤登记为学习任务，持续记录学习进度。</span>
          <button className="btn btn-secondary small" onClick={() => setOpen(true)}>
            创建学习任务
          </button>
        </div>
      )}

      {open && (
        <div>
          <div className="row-between">
            <strong className="small">创建学习任务</strong>
            <button className="btn-ghost small" disabled={busy} onClick={() => setOpen(false)}>
              收起
            </button>
          </div>
          <p className="muted small">
            将基于当前步骤创建一条学习任务（对应要求：{targetRequirement ?? '（无）'}）。
            创建后可在「学习提升」页记录内容、推进状态。
          </p>
          <div className="row" style={{ gap: 12 }}>
            <button className="btn btn-primary" disabled={busy || createdId !== null} onClick={() => void create()}>
              {busy ? '创建中…' : '创建学习任务'}
            </button>
          </div>
        </div>
      )}

      {notice && (
        <div className={notice.kind === 'ok' ? 'banner banner-info' : 'banner banner-error'} style={{ marginTop: 8 }} role="status">
          {notice.text}
          {createdId && (
            <>
              {' '}
              <Link href={`/learn/${createdId}`}>前往学习任务 →</Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}
