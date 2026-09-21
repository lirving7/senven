'use client';

/**
 * T5-B-3B —— Agent Proposal 展示组件（纯 UI，只读消费，零数据写入）。
 *
 * 三态模型（授权书 §二，冻结）：
 *   - AI_ADVICE          → `AdviceChip`（chip-advice；菱形标记，与事实圆形 chip 三重区分）
 *   - EXTERNAL_KNOWLEDGE → `KnowledgeRefChip`（仅计数，UNTRUSTED，不解析/不缓存 RAG 正文）
 *   - SYSTEM_FACT        → 既有 `FactChip`（本文件不使用，保持完全分离）
 *
 * 只渲染冻结 payload 白名单字段：kind / summary / steps(order,title,action,rationale) /
 * nextAction / basedOnRefs；不出现 matchScore、gap、确认、一键修改等任何扩展或动作语义。
 */

import Link from 'next/link';

import {
  groupBasedOnRefs,
  isRenderablePlanPayload,
  RUN_STATUS_CHIP,
  RUN_STATUS_LABEL,
  type AgentProposalView,
  type AgentRunStatus,
} from '../../_lib/agent';

/** AI_ADVICE 标记（chip-advice 专属；菱形 mark + 文字 + 专属色系） */
export function AdviceChip({ children }: { children?: React.ReactNode }) {
  return (
    <span className="chip chip-advice" aria-label="AI 建议（非系统事实）">
      <span className="mark" aria-hidden="true" />
      {children ?? 'AI 建议'}
    </span>
  );
}

/**
 * EXTERNAL_KNOWLEDGE 标记：只显示「外部知识参考 · N 条」。
 * UNTRUSTED 公共/受控语料 —— 不跳转、不解析标题与正文、不缓存（授权书 §二/§五）。
 */
export function KnowledgeRefChip({ count }: { count: number }) {
  return (
    <span
      className="chip chip-knowledge"
      title="外部知识参考：来自公共或受控语料（UNTRUSTED），仅显示数量，不展示正文"
    >
      <span className="mark" aria-hidden="true" />
      外部知识参考 · {count} 条
    </span>
  );
}

/** AgentRun 状态 chip：仅 PROPOSED 用 chip-advice；终态/进行态均为中性展示 */
export function RunStatusChip({ status }: { status: string }) {
  const cls = RUN_STATUS_CHIP[status as AgentRunStatus] ?? 'chip-knowledge';
  const label = RUN_STATUS_LABEL[status as AgentRunStatus] ?? status;
  return (
    <span className={`chip ${cls}`} aria-label={`分析状态：${label}`}>
      <span className="mark" aria-hidden="true" />
      {label}
    </span>
  );
}

/** basedOnRefs → 「类型 + 引用 + 跳转」；KNOWLEDGE_CHUNK 聚合为计数 chip，永不产生链接 */
export function RefLinks({ basedOnRefs }: { basedOnRefs: unknown }) {
  const { linked, knowledgeCount } = groupBasedOnRefs(basedOnRefs);
  if (linked.length === 0 && knowledgeCount === 0) return null;
  return (
    <div className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {linked.map((r) => (
        <Link
          key={`${r.label}-${r.id}`}
          href={r.href ?? '#'}
          className="chip chip-unconfirmed"
          style={{ textDecoration: 'none' }}
          aria-label={`查看依据：${r.label}`}
        >
          {r.label} →
        </Link>
      ))}
      {knowledgeCount > 0 && <KnowledgeRefChip count={knowledgeCount} />}
    </div>
  );
}

/**
 * Proposal 展示：只消费冻结 payload 字段。
 * payload 结构非法时渲染防御性文案（绝不把非法数据当作建议展示）。
 */
export function ProposalView({ proposal }: { proposal: AgentProposalView }) {
  if (!isRenderablePlanPayload(proposal.payload)) {
    return (
      <div className="advice-note" role="status">
        本次 AI 建议未能通过系统格式校验，内容已隐藏。你可以重新发起一次分析。
      </div>
    );
  }
  const plan = proposal.payload;
  return (
    <div className="card">
      <div className="row-between mb-16">
        <AdviceChip />
        <span className="muted small">revision {proposal.revision} · 仅供参考</span>
      </div>

      <p style={{ fontWeight: 500, marginTop: 0 }}>{plan.summary}</p>

      <h3 style={{ fontSize: 14, marginBottom: 8 }}>AI 建议步骤</h3>
      <ol className="advice-steps">
        {plan.steps.map((s) => (
          <li key={s.order}>
            <div style={{ fontWeight: 500 }}>
              第 {s.order} 步 · {s.title}
            </div>
            <div className="mt-8">{s.action}</div>
            <div className="muted small mt-8">理由：{s.rationale}</div>
          </li>
        ))}
      </ol>

      <div className="mt-16">
        <div style={{ fontWeight: 500, marginBottom: 4 }}>建议的下一步</div>
        <div>{plan.nextAction}</div>
      </div>

      <div className="mt-16">
        <div className="muted small mb-8">依据（仅类型与引用，不含正文）</div>
        <RefLinks basedOnRefs={proposal.basedOnRefs} />
      </div>

      <div className="advice-note mt-16" role="note">
        以上内容为 AI 生成的建议，仅供参考，不属于系统事实；系统不会替你改动任何数据。
        步骤只是建议，是否照做由你决定。
      </div>
    </div>
  );
}
