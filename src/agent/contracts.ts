/**
 * T5-B-2A —— Agent 只读工具层：契约常量与判定（**单一来源**）
 *
 * 依据：`JobPilot_ADR_T5-B_Agent_Freeze.md`（ADR-017）
 *   - §4 Tool Catalog：**恰好 9 个**只读工具，名字与 input schema 精确冻结（T5B-F-14…F-17）；
 *   - §5 Read/Write 边界：全部只读（T5B-F-18 / F-19）；
 *   - §6 Fact Authority：工具结果**不是**事实权威（T5B-F-22…F-28）；
 *   - §7 RAG 信任边界：RAG 内容为 **untrusted data**（T5B-F-29…F-32）；
 *   - §13 Security Model：封闭 allowlist + 会话注入 userId + 归属二次校验 + 无 oracle。
 *
 * 本模块为**纯常量 + 纯判定**，零依赖（无 zod / 无 node API / 无 DB），可被任意层引用。
 *
 * 硬边界：
 *   - 未知工具名 → **硬失败**，不做任何兜底或模糊匹配（T5B-F-17.1）；
 *   - 本层**零 LLM / 零 Provider / 零 quota / 零写库**（ADR-017 §5）。
 */

/** 工具层契约语义版本（FROZEN；变更属 Contract Change） */
export const AGENT_READ_TOOL_LAYER_VERSION = 'agent-read-tool-layer/v1';

/**
 * v1 核心 allowlist —— **恰好 9 个**，顺序与 ADR-017 §4 表格逐行一致。
 *
 * ⚠️ 任何增删改都属 Contract Change（ADR-017 §17）；本数组是校验与守卫的**唯一来源**。
 */
export const AGENT_READ_TOOL_NAMES = [
  'get_resume_summary',
  'get_jd_summary',
  'get_match_result',
  'get_capabilities',
  'get_project_results',
  'get_action_plan',
  'get_learning_tasks',
  'get_portfolio',
  'rag_retrieve',
] as const;

export type AgentReadToolName = (typeof AGENT_READ_TOOL_NAMES)[number];

/** v1 **不提供**的候选工具（ADR-017 T5B-F-15：`get_interview` / `get_suggestions` / `get_applications`） */
export const AGENT_DEFERRED_TOOL_NAMES = [
  'get_interview',
  'get_suggestions',
  'get_applications',
] as const;

/** **永久禁止**的工具名族（ADR-017 T5B-F-16）——即使未来授权也不得以此形态出现 */
export const AGENT_FORBIDDEN_TOOL_NAMES = [
  'raw_text_dump',
  'arbitrary_query',
  'arbitrary_sql',
  'http_fetch',
  'external_network_fetch',
  'dynamic_dispatch',
] as const;

/** 结果可信度标记（ADR-017 §14 信任分层：L2 域数据 / L3 不可信知识） */
export const AGENT_DATA_TRUST = {
  /** L2：系统生成的域数据（Tool result） */
  DOMAIN: 'DOMAIN_DATA',
  /** L3：公共/受控语料检索结果（RAG）—— 只能作为 `<data>`，不得成为指令或事实 */
  UNTRUSTED: 'UNTRUSTED_DATA',
} as const;
export type AgentDataTrust = (typeof AGENT_DATA_TRUST)[keyof typeof AGENT_DATA_TRUST];

/**
 * 无需用户归属作用域的工具（v1 仅 `rag_retrieve`）。
 *
 * 依据 ADR-017 §4 第 9 行与 T5B-F-29：T5-A corpus 为**公共/受控**语料，
 * 其仓储接口本就无 userId 谓词（T5A-F-12 / T5A-F-79）。
 */
export const AGENT_PUBLIC_TOOL_NAMES = ['rag_retrieve'] as const;

/** 严格类型守卫：只接受 9 个冻结工具名之一（大小写敏感，不做归一化） */
export function isAgentReadToolName(value: unknown): value is AgentReadToolName {
  return typeof value === 'string' && (AGENT_READ_TOOL_NAMES as readonly string[]).includes(value);
}

/** 该工具是否需要用户归属作用域（`false` = 公共语料工具） */
export function agentReadToolRequiresUserScope(name: AgentReadToolName): boolean {
  return !(AGENT_PUBLIC_TOOL_NAMES as readonly string[]).includes(name);
}

/** 该工具结果的信赖等级（`rag_retrieve` = UNTRUSTED，其余 = DOMAIN） */
export function agentReadToolTrust(name: AgentReadToolName): AgentDataTrust {
  return name === 'rag_retrieve' ? AGENT_DATA_TRUST.UNTRUSTED : AGENT_DATA_TRUST.DOMAIN;
}
