/**
 * T5-B-2A —— Agent 只读工具层（公开入口）
 *
 * 交付内容：9 个冻结只读工具（`AGENT_READ_TOOL_NAMES`）的
 * 契约常量 + strict input schema + 只读适配器 + 静态分派装配。
 *
 * 明确**不在**本阶段（ADR-017 §15 / 授权书 §十七）：
 *   - Agent Runtime / Agent API / AGENT quota / Provider 变更；
 *   - 任何 Tool Calling / Agent Loop / 确认与执行端点 / 外部工具；
 *   - 任何写操作与事实层（Fact Authority）写入。
 */

export {
  AGENT_DATA_TRUST,
  AGENT_DEFERRED_TOOL_NAMES,
  AGENT_FORBIDDEN_TOOL_NAMES,
  AGENT_PUBLIC_TOOL_NAMES,
  AGENT_READ_TOOL_LAYER_VERSION,
  AGENT_READ_TOOL_NAMES,
  agentReadToolRequiresUserScope,
  agentReadToolTrust,
  isAgentReadToolName,
} from './contracts.ts';
export type { AgentDataTrust, AgentReadToolName } from './contracts.ts';

export type { AgentReadToolContext, AgentReadToolDeps } from './tool-deps.ts';
export type { AgentReadToolFailureReason, AgentReadToolOutcome, AgentReadToolPayload } from './tool-outcome.ts';

export { AGENT_READ_TOOL_INPUT_SCHEMAS } from './tool-schemas.ts';

export { createAgentReadToolLayer } from './tool-layer.ts';
export type { AgentReadToolInvokeContext, AgentReadToolLayer } from './tool-layer.ts';

export {
  adaptActionPlan,
  adaptCapabilities,
  adaptJdSummary,
  adaptLearningTasks,
  adaptMatchResult,
  adaptPortfolio,
  adaptProjectResults,
  adaptRagRetrieve,
  adaptResumeSummary,
} from './tool-adapters.ts';
export type {
  ActionPlanSummaryOutput,
  ActionStepSummaryOutput,
  AgentStepType,
  CapabilitySummaryOutput,
  GetActionPlanOutput,
  GetCapabilitiesOutput,
  GetJdSummaryOutput,
  GetLearningTasksOutput,
  GetMatchResultOutput,
  GetPortfolioOutput,
  GetProjectResultsOutput,
  GetResumeSummaryOutput,
  JdRequirementOutput,
  LearningTaskSummaryOutput,
  MatchItemSummaryOutput,
  PortfolioMemberOutput,
  PortfolioProjectSummaryOutput,
  ProjectResultSummaryOutput,
  RagRetrieveItemOutput,
  RagRetrieveOutput,
  ResumeSummaryItemOutput,
} from './tool-adapters.ts';
