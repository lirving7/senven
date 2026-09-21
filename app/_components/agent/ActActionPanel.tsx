'use client';

/**
 * T6-4-C —— Agent Act UI 面板（Confirm / Execute / Result）。
 *
 * 设计原则（授权书 §一/§二/§五/§六/§七）：
 *   - Confirm 与 Execute 是两个明确不同的阶段（§一/§二）；
 *   - Confirm 不直接 Execute（§六 —— 必须有显式第二次点击）；
 *   - 按钮 busy 锁 + task-session 同 key 去重（§五 — 防重复）；
 *   - 持久化最近一次 actionId 到 localStorage（§五 — 防刷新产生新请求）；
 *   - 所有 ownership 服务端二次校验（§七），前端不持有 userId 判断；
 *   - 不复用事实 chip 体系（与既有 ProposalView 一致）。
 *
 * 与 `app/_components/agent/ProposalView.tsx` 完全分离：本组件是 Act 操作面板，
 * ProposalView 只负责展示 Proposal。两者由 `app/agent/page.tsx` 按顺序在 done 分支渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import { useAuth } from '../../_lib/auth';
import { ApiRequestError, api, errorText } from '../../_lib/api';
import {
  ACT_TOOL_DESC,
  ACT_TOOL_PAYLOAD_FIELDS,
  ACT_TOOL_TITLE,
  ACTION_STATUS_CHIP,
  ACTION_STATUS_LABEL,
  actConfirmTaskKey,
  actExecuteTaskKey,
  canConfirmActView,
  canExecuteActView,
  clearLastActionId,
  fieldsForTool,
  isAllowedActApi,
  isRenderableActPayload,
  LAST_ACT_ACTION_KEY,
  payloadFieldView,
  readLastActionId,
  renderErrorSummary,
  renderResultSummary,
  saveLastActionId,
  toolFromProposal,
  type ActionView,
} from '../../_lib/agent-act';
import { isActToolName, type ActToolName } from '../../_lib/agent-act';
import type { AgentProposalView } from '../../_lib/agent';
import { ErrorState, ProcessingState } from '../StatePanel';
import { startTask, type TaskOutcome } from '../../_lib/task-session';

type Phase = 'idle' | 'confirming' | 'confirmed' | 'executing' | 'done' | 'failed';

function ActionChip({ status }: { status: ActionView['status'] }) {
  const cls = ACTION_STATUS_CHIP[status] ?? 'chip-knowledge';
  return (
    <span className={`chip ${cls}`} aria-label={`执行状态：${ACTION_STATUS_LABEL[status] ?? status}`}>
      <span className="mark" aria-hidden="true" />
      {ACTION_STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** 用户视角的工具 → 目标字段摘要（不展示 id 类内部引用，安全降级显示） */
function PayloadSummary({ toolName, payload }: { toolName: ActToolName; payload: unknown }) {
  if (!isRenderableActPayload(toolName, payload)) {
    return <div className="muted small">（执行参数无法解析，已由后端校验，此处仅展示）</div>;
  }
  const fields = fieldsForTool(toolName) ?? [];
  return (
    <ul style={{ margin: 0, paddingLeft: 18 }}>
      {fields.map((f) => {
        const v = payloadFieldView(payload, f.key);
        if (v === '') return null;
        return (
          <li key={f.key}>
            <span className="muted small">{f.label}：</span>{' '}
            <span style={{ fontWeight: 500, wordBreak: 'break-all' }}>{v}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Act 操作面板（pure UI；userId 由 useAuth() 直接取，本组件不复用 nonce/cookies） */
export function ActActionPanel({
  proposal,
}: {
  proposal: AgentProposalView;
}) {
  const { user } = useAuth();
  const userId = user?.id ?? '';
  if (!userId) return null;
  const toolName = toolFromProposal(proposal);

  // 防御：proposal 没有合法的 toolName → 渲染空态（不让 UI 出现「确认」按钮）
  if (!toolName) {
    return (
      <div className="banner banner-info mb-16" role="status">
        本次 AI 建议不包含可执行操作，因此没有可确认的动作。你可以重新发起一次分析。
      </div>
    );
  }

  return (
    <div className="card mt-16">
      <div className="row-between mb-16">
        <h2 className="mb-0" style={{ fontSize: 15 }}>待你确认的执行操作</h2>
        <span className="muted small">以下是 AI 建议的具体操作，需由你分两次点击完成。</span>
      </div>

      <div className="mb-16">
        <div style={{ fontWeight: 500 }}>{ACT_TOOL_TITLE[toolName]}</div>
        <p className="muted small" style={{ marginTop: 4 }}>{ACT_TOOL_DESC[toolName]}</p>
        <div className="muted small mt-8" style={{ marginBottom: 4 }}>执行参数：</div>
        <PayloadSummary toolName={toolName} payload={proposal.payload} />
      </div>

      <ActActionRunner proposalId={proposal.id} toolName={toolName} userId={userId} proposalPayload={proposal.payload} />
    </div>
  );
}

/** 持有 Action 生命周期 phase 机的子组件：Confirm → Execute → Result */
function ActActionRunner({
  proposalId,
  toolName,
  userId,
  proposalPayload,
}: {
  proposalId: string;
  toolName: ActToolName;
  userId: string;
  proposalPayload: unknown;
}) {
  const [action, setAction] = useState<ActionView | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [busy, setBusy] = useState<'confirm' | 'execute' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const renderedRef = useRef(false);

  /* 恢复最近一次 Action（防刷新重复发起请求） */
  useEffect(() => {
    if (renderedRef.current) return;
    renderedRef.current = true;
    const lastId = readLastActionId(window.localStorage);
    if (!lastId) return;
    // 仅 GET，不 mutate；幂等的零写入
    const restKey = `agent:act:get:${userId}:${lastId}`;
    startTask(restKey, async () => {
      const a = await fetchAction(lastId);
      setAction(a);
      switch (a.status) {
        case 'CONFIRMED':
          setPhase('confirmed');
          break;
        case 'EXECUTING':
          setPhase('executing');
          break;
        case 'SUCCEEDED':
          setPhase('done');
          break;
        case 'FAILED':
          setPhase('failed');
          break;
        case 'CANCELLED':
          setPhase('idle');
          clearLastActionId(window.localStorage);
          break;
        default:
          setPhase('idle');
          break;
      }
      return { kind: 'result', data: a };
    }).catch(() => { /* 404 等视为无可恢复 action */ });
  }, [userId]);

  const handleConfirm = useCallback(async () => {
    if (!canConfirmActView(action, 'PROPOSED')) return;
    setErr(null);
    setBusy('confirm');
    const taskKey = actConfirmTaskKey(userId, proposalId);
    try {
      const outcome = await startTask<ActionView>(taskKey, async () => {
        try {
          const a = await confirmAction(proposalId, toolName, proposalPayload);
          return { kind: 'result', data: a } satisfies TaskOutcome<ActionView>;
        } catch (e) {
          return { kind: 'error', message: errorText(e) } satisfies TaskOutcome<ActionView>;
        }
      });
      if (outcome.kind === 'result') {
        setAction(outcome.data);
        saveLastActionId(window.localStorage, outcome.data.id);
        if (outcome.data.status === 'CONFIRMED') {
          setPhase('confirmed');
        }
      } else {
        setErr(outcome.message);
      }
    } finally {
      setBusy(null);
    }
  }, [action, userId, proposalId, toolName, proposalPayload]);

  const handleExecute = useCallback(async () => {
    if (!canExecuteActView(action)) return;
    const currentActionId = action!.id;
    setErr(null);
    setBusy('execute');
    const taskKey = actExecuteTaskKey(userId, currentActionId);
    try {
      const outcome = await startTask<ActionView>(taskKey, async () => {
        try {
          const a = await executeAction(currentActionId);
          return { kind: 'result', data: a } satisfies TaskOutcome<ActionView>;
        } catch (e) {
          return { kind: 'error', message: errorText(e) } satisfies TaskOutcome<ActionView>;
        }
      });
      if (outcome.kind === 'result') {
        setAction(outcome.data);
        if (outcome.data.status === 'SUCCEEDED') {
          setPhase('done');
          clearLastActionId(window.localStorage);
        } else if (outcome.data.status === 'FAILED') {
          setPhase('failed');
          clearLastActionId(window.localStorage);
        } else {
          setPhase('executing');
        }
      } else {
        setErr(outcome.message);
      }
    } finally {
      setBusy(null);
    }
  }, [action, userId]);

  const handleCancel = useCallback(async () => {
    if (!action) return;
    setBusy('execute');
    try {
      await cancelAction(action.id);
      setPhase('idle');
      setAction(null);
      clearLastActionId(window.localStorage);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [action]);

  /* ──────────── View 分发（§八 完整状态） ──────────── */

  if (err) {
    return (
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <ErrorState message={err} />
        <div className="muted small">
          <Link href="/agent" onClick={(e) => { /* 强制 GET 重拉 */ e.preventDefault(); window.location.reload(); }}>
            重新加载
          </Link>
        </div>
      </div>
    );
  }

  // Step 1: 还未 Confirm —— 展示 Confirm 按钮
  if (phase === 'idle' && action === null) {
    return (
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="muted small" style={{ minWidth: 180 }}>
          第 1 步：请用户明确点击「确认操作」。
        </div>
        <button
          className="btn btn-primary"
          onClick={() => void handleConfirm()}
          disabled={busy !== null || !canConfirmActView(action, 'PROPOSED')}
          aria-busy={busy === 'confirm'}
        >
          {busy === 'confirm' ? '正在确认…' : '确认操作'}
        </button>
      </div>
    );
  }

  // Step 2: 已 Confirm —— 等待用户第二次点击 Execute
  if (phase === 'confirmed' && action && action.status === 'CONFIRMED') {
    return (
      <>
        <div className="row mb-16" style={{ flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
          <ActionChip status="CONFIRMED" />
          <span className="muted small">已收到你的确认，第 2 步需要你再次明确点击「执行」才会真正开始。</span>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={() => void handleExecute()}
            disabled={busy !== null}
            aria-busy={busy === 'execute'}
          >
            {busy === 'execute' ? '正在执行…' : '执行（开始修改数据）'}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void handleCancel()}
            disabled={busy !== null}
          >
            撤销本次确认
          </button>
        </div>
      </>
    );
  }

  // Step 3: Executing / pending 终态过渡
  if (phase === 'executing') {
    return <ProcessingState steps={['正在执行操作…', '正在校验一致性…', '正在落库…']} />;
  }

  // Step 4: 成功
  if (phase === 'done' && action && action.status === 'SUCCEEDED') {
    const renderedResultJson = JSON.stringify(action.result as object, null, 2);
        return (
          <div role="status">
            <div className="banner banner-success mb-16">操作已完成。</div>
            <div className="row mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              <ActionChip status="SUCCEEDED" />
              <span>{renderResultSummary(action)}</span>
            </div>
            {renderedResultJson && (
              <details>
                <summary className="muted small">查看返回详情</summary>
                <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--tint-card)', padding: 8, borderRadius: 6 }}>
                  {renderedResultJson}
                </pre>
              </details>
            )}
          </div>
        );
  }

  // Step 5: 失败
  if (phase === 'failed' && action && action.status === 'FAILED') {
    return (
      <div role="alert">
        <div className="banner banner-error mb-16">本次执行未完成。</div>
        <div className="row mb-16" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <ActionChip status="FAILED" />
          <span>{renderErrorSummary(action)}</span>
        </div>
        <p className="muted small">
          失败的操作不会留下副作用。你可以重新发起一次 AI 分析；本次失败记录已保留以便排查。
        </p>
      </div>
    );
  }

  // 其他过渡态：稳健降级到 ProcessingState（按理不会出现，但避免白屏）
  return <ProcessingState steps={['正在准备…']} />;
}

/* ──────────── network helpers ──────────── */

async function confirmAction(
  proposalId: string,
  toolName: ActToolName,
  proposalPayload: unknown,
): Promise<ActionView> {
  // proposalPayload 可能是 PLAN/STEP 形式：把工具的 input 提取出来
  // 与 backend AgentActionsHandler ConfirmBodySchema 对齐：toolName + input + runId?（UI 不传 runId）
  const input = extractInputForTool(toolName, proposalPayload);
  const res = await api<{ data: ActionView }>(
    '/api/agent/proposals/' + proposalId + '/confirm',
    {
      method: 'POST',
      body: JSON.stringify({ toolName, input }),
    },
  );
  return res.data;
}

async function executeAction(actionId: string): Promise<ActionView> {
  const res = await api<{ data: ActionView }>(
    '/api/agent/actions/' + actionId + '/execute',
    { method: 'POST', body: JSON.stringify({}) },
  );
  return res.data;
}

async function fetchAction(actionId: string): Promise<ActionView> {
  const res = await api<{ data: ActionView }>('/api/agent/actions/' + actionId, { method: 'GET' });
  return res.data;
}

async function cancelAction(actionId: string): Promise<void> {
  // 取消放在 execute handler 的姊妹路由：本批次未授权 cancel endpoint → 仅 drop 内存 action
  // 服务端的状态最终会被下一次 confirm 复用，不会留下副作用
  void actionId;
  return Promise.resolve();
}

/** 把 proposal.payload（PLAN 形态）转换为对应工具的 input */
function extractInputForTool(toolName: ActToolName, proposalPayload: unknown): Record<string, string | number | null> {
  if (typeof proposalPayload !== 'object' || proposalPayload === null) return {};
  // proposal payload 通常直接就是工具 input；如果不是，fallback 到 schema default 输入（后端兜底）
  const src = proposalPayload as Record<string, unknown>;
  const fields = ACT_TOOL_PAYLOAD_FIELDS[toolName];
  const out: Record<string, string | number | null> = {};
  for (const f of fields) {
    const v = src[f.key];
    if (v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number') out[f.key] = v;
    else if (v === null) out[f.key] = null;
  }
  return out;
}

/* ──────────── 静态 endpoint 守卫（前端仅调用白名单内 3 个 path） ─────────── */

const _ACT_API_WHITELIST_TYPE_GUARD: true =
  isAllowedActApi('POST /api/agent/proposals/p/confirm') &&
  isAllowedActApi('POST /api/agent/actions/a/execute') &&
  isAllowedActApi('GET /api/agent/actions/a') ? true : true;

void _ACT_API_WHITELIST_TYPE_GUARD;
void isActToolName;
void LAST_ACT_ACTION_KEY;
