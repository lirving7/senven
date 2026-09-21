/**
 * T5-B-3B —— Agent Proposal 消费层（纯类型 + 纯映射，零副作用，可在 node --test 中直接导入）。
 *
 * 三态模型（授权书 §二，冻结）：
 *   SYSTEM_FACT        —— 来自既有业务系统（本文件不生产，仅由既有页面/FactChip 呈现）
 *   AI_ADVICE          —— 来自 AgentProposal，UI 一律使用 `chip-advice`（不得复用事实 chip）
 *   EXTERNAL_KNOWLEDGE —— 来自 KNOWLEDGE_CHUNK，仅显示数量/引用关系，UNTRUSTED，
 *                          禁止解析、复制、缓存 RAG 正文（KNOWLEDGE_CHUNK 不跳转）。
 *
 * 边界：
 *   - 只消费已冻结的 Proposal payload（kind/summary/steps/nextAction/basedOnRefs），不新增字段；
 *   - 本文件不做任何 fetch / DOM / localStorage 直连 —— 存储经 StorageLike 注入，便于测试；
 *   - 不引用 React / 'use client'，保持纯函数。
 */

/** AgentRun 冻结状态（T5-B-1 状态机；UI 侧只读映射，不新增状态） */
export type AgentRunStatus = 'CREATED' | 'PLANNING' | 'PROPOSED' | 'CANCELLED' | 'FAILED' | 'EXPIRED';

/** Runtime 已冻结的 errorCode（T5-B-2B；本表只做展示映射，不新增错误体系） */
export type AgentErrorCode =
  | 'LLM_QUOTA_EXCEEDED'
  | 'LLM_PROVIDER_ERROR'
  | 'LLM_TIMEOUT'
  | 'LLM_INVALID_PLAN'
  | 'AGENT_TOOL_ERROR'
  | 'AGENT_STATE_CONFLICT'
  | 'AGENT_CANCELLED';

/** `GET/POST /api/agent/runs` 响应中的 Run 视图（= 2C toRunView 冻结字段；UI 不渲染 userId / providerRequestId） */
export type AgentRunView = {
  id: string;
  userId: string;
  goalKind: string;
  status: AgentRunStatus;
  modelVersion: string | null;
  semanticVersions: unknown;
  promptTemplateVersion: string;
  quotaUsage: unknown;
  providerRequestId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

/** Proposal 视图（= 2C toProposalView 冻结字段；payload/basedOnRefs 原样） */
export type AgentProposalView = {
  id: string;
  runId: string;
  revision: number;
  kind: string;
  payload: unknown;
  basedOnRefs: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
};

/** 冻结的 PLAN payload（授权书 §三；任何其它字段一律不渲染） */
export type PlanPayload = {
  kind: 'PLAN';
  summary: string;
  steps: Array<{ order: number; title: string; action: string; rationale: string }>;
  nextAction: string;
};

export type BasedOnRef = {
  entityType: string;
  entityId: string;
  version?: string;
  fingerprint?: string;
};

/* ────────────────────────── Run 状态映射 ────────────────────────── */

export const RUN_STATUS_LABEL: Record<AgentRunStatus, string> = {
  CREATED: '准备中',
  PLANNING: '分析中',
  PROPOSED: '建议已生成',
  CANCELLED: '已取消',
  FAILED: '分析未完成',
  EXPIRED: '已过期',
};

/**
 * Run 状态 → chip 类名。
 * 仅 `PROPOSED`（AI_ADVICE 产物）使用 `chip-advice`；其余为运行状态中性展示，
 * 一律不复用 `chip-confirmed` / `chip-inferred`（事实语义，授权书 §二）。
 */
export const RUN_STATUS_CHIP: Record<AgentRunStatus, string> = {
  CREATED: 'chip-unconfirmed',
  PLANNING: 'chip-unconfirmed',
  PROPOSED: 'chip-advice',
  CANCELLED: 'chip-knowledge',
  FAILED: 'chip-missing',
  EXPIRED: 'chip-knowledge',
};

/** 取消仅允许 CREATED / PLANNING（授权书 §八；PROPOSED/FAILED/EXPIRED 不可取消） */
export function cancelable(status: string): boolean {
  return status === 'CREATED' || status === 'PLANNING';
}

/* ────────────────────────── 错误文案映射 ────────────────────────── */

/** errorCode → 用户可理解文案（技术错误码不得作为主要 UI 文案，授权书 §七） */
export const ERROR_TEXT: Record<string, string> = {
  LLM_QUOTA_EXCEEDED: '今日 AI 分析次数已用完（每 24 小时 10 次），明天再来看看吧。',
  LLM_PROVIDER_ERROR: 'AI 服务暂时无法完成分析，请稍后重试。',
  LLM_TIMEOUT: '本次分析超时了，请稍后重试。',
  LLM_INVALID_PLAN: '本次 AI 建议未通过系统格式校验，请重新发起分析。',
  AGENT_TOOL_ERROR: '读取你的求职资料时出现问题，请稍后重试。',
  AGENT_STATE_CONFLICT: '当前状态不允许该操作。',
  AGENT_CANCELLED: '本次分析已取消。',
};

export function errorTextFor(code: string | null | undefined): string {
  if (!code) return '本次分析未完成，请稍后重试。';
  return ERROR_TEXT[code] ?? '本次分析未完成，请稍后重试。';
}

/* ────────────────────────── PLAN payload 防御性校验 ────────────────────────── */

/**
 * 渲染前对原始 payload 做结构校验（UI 安全边界：非法结构绝不渲染为建议）。
 * 只接受授权书 §三 冻结形状；多余字段不影响（渲染层只读取白名单字段）。
 */
export function isRenderablePlanPayload(payload: unknown): payload is PlanPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  if (p.kind !== 'PLAN') return false;
  if (typeof p.summary !== 'string' || p.summary.length < 1 || p.summary.length > 800) return false;
  if (typeof p.nextAction !== 'string' || p.nextAction.length < 1 || p.nextAction.length > 200) return false;
  if (!Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > 8) return false;
  let expectedOrder = 1;
  for (const s of p.steps) {
    if (typeof s !== 'object' || s === null) return false;
    const st = s as Record<string, unknown>;
    if (st.order !== expectedOrder) return false;
    expectedOrder += 1;
    for (const k of ['title', 'action', 'rationale'] as const) {
      if (typeof st[k] !== 'string' || (st[k] as string).length < 1) return false;
    }
    if ((st.title as string).length > 80) return false;
    if ((st.action as string).length > 300) return false;
    if ((st.rationale as string).length > 300) return false;
  }
  return true;
}

/* ────────────────────────── basedOnRefs 固定映射（授权书 §五，冻结） ────────────────────────── */

export type RefTarget = { label: string; href: string | null };

/**
 * 9 类 entityType → 展示标签 + 跳转目标。
 * - JD：v1 无 `/jds/[id]` 详情页（3A-R1）→ 跳列表页；
 * - MATCH_RUN：runId 不进 URL（3A-R2）→ 跳 `/match`；
 * - KNOWLEDGE_CHUNK：不跳转、不解析标题/正文（§二 EXTERNAL_KNOWLEDGE）；
 * - 未知类型：防御性回落为纯文本，不跳转。
 */
export const BASED_ON_REF_TARGET: Record<string, (id: string) => RefTarget> = {
  RESUME: (id) => ({ label: '我的简历', href: `/resumes/${id}` }),
  JD: () => ({ label: '岗位要求', href: '/jds' }),
  MATCH_RUN: () => ({ label: '能力对照', href: '/match' }),
  CAPABILITY: () => ({ label: '能力画像', href: '/projects' }),
  PROJECT_RESULT: () => ({ label: '项目成果', href: '/projects' }),
  ACTION_PLAN: (id) => ({ label: '行动计划', href: `/action-plans/${id}` }),
  LEARNING_TASK: () => ({ label: '学习任务', href: '/learn' }),
  PORTFOLIO: () => ({ label: '作品集项目', href: '/projects' }),
  KNOWLEDGE_CHUNK: () => ({ label: '外部知识参考', href: null }),
};

export function refTarget(ref: BasedOnRef): RefTarget {
  const fn = BASED_ON_REF_TARGET[ref.entityType];
  if (!fn) return { label: ref.entityType, href: null };
  return fn(ref.entityId);
}

/** 把 refs 分组为「可跳转引用」+「外部知识条数」；KNOWLEDGE_CHUNK 永不产生链接 */
export function groupBasedOnRefs(refs: unknown): { linked: Array<RefTarget & { id: string }>; knowledgeCount: number } {
  if (!Array.isArray(refs)) return { linked: [], knowledgeCount: 0 };
  const linked: Array<RefTarget & { id: string }> = [];
  let knowledgeCount = 0;
  for (const raw of refs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.entityType !== 'string' || typeof r.entityId !== 'string') continue;
    if (r.entityType === 'KNOWLEDGE_CHUNK') {
      knowledgeCount += 1;
      continue;
    }
    const t = refTarget(r as unknown as BasedOnRef);
    if (t.href) linked.push({ ...t, id: r.entityId });
  }
  return { linked, knowledgeCount };
}

/* ────────────────────────── 最近一次 Run 的本地记忆（授权书 §十） ────────────────────────── */

export const LAST_RUN_STORAGE_KEY = 'jp_agent_last_run';

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** 只保存最近一次 runId（非整个 Run 对象；读侧经 GET /api/agent/runs/:id 恢复） */
export function readLastRunId(store: StorageLike): string | null {
  try {
    const raw = store.getItem(LAST_RUN_STORAGE_KEY);
    if (typeof raw !== 'string') return null;
    const id = raw.trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export function saveLastRunId(store: StorageLike, runId: string): void {
  try {
    store.setItem(LAST_RUN_STORAGE_KEY, runId);
  } catch {
    /* 本地存储不可用时静默（仅影响「恢复最近一次」体验） */
  }
}

export function clearLastRunId(store: StorageLike): void {
  try {
    store.removeItem(LAST_RUN_STORAGE_KEY);
  } catch {
    /* 同上 */
  }
}
