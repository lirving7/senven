/**
 * T5-B-2A —— Agent 只读工具层：9 个 strict input schema（**与工具名一一对应**）
 *
 * 依据 ADR-017 §4（input 列逐字冻结）与 T5B-F-17.2：
 *   全部 `.strict()` —— **未知字段一律拒绝**；因此调用方（或未来的模型）**无法**注入
 *   `userId` 或任何未声明字段（T5B-F-17.3）。
 *
 * ⚠️ 本文件只做**输入结构校验**；归属校验发生在适配器调用既有 `...ForUser(id, userId)` 时。
 */

import { z } from 'zod';

import {
  RETRIEVAL_MAX_LIMIT,
  RETRIEVAL_MIN_LIMIT,
  RETRIEVAL_QUERY_MAX_CHARS,
} from '../domain/rag/retrieval.ts';
import type { AgentReadToolName } from './contracts.ts';

/** 资源 id 的机械边界（长度上限防止超长输入；归属由仓储二次校验） */
const resourceId = z.string().min(1).max(64);

/** 状态过滤值的机械边界（取值语义由既有业务决定，本层不新增枚举） */
const statusFilter = z.string().min(1).max(32);

export const GetResumeSummaryInput = z.object({ resumeId: resourceId.optional() }).strict();
export const GetJdSummaryInput = z.object({ jdId: resourceId }).strict();
export const GetMatchResultInput = z.object({ matchRunId: resourceId.optional() }).strict();
export const GetCapabilitiesInput = z.object({ status: statusFilter.optional() }).strict();
export const GetProjectResultsInput = z.object({ planId: resourceId.optional() }).strict();
export const GetActionPlanInput = z.object({ planId: resourceId.optional() }).strict();
export const GetLearningTasksInput = z.object({ status: statusFilter.optional() }).strict();
export const GetPortfolioInput = z.object({ portfolioProjectId: resourceId.optional() }).strict();

/**
 * `rag_retrieve` 边界**逐字复用 T5-A 检索契约常量**（T5A-F-46 / T5B-F-29）：
 * `query` trim 后 1–200；`limit` 1..20，缺省 5。
 */
export const RagRetrieveInput = z
  .object({
    query: z.string().max(RETRIEVAL_QUERY_MAX_CHARS * 4),
    limit: z.number().int().min(RETRIEVAL_MIN_LIMIT).max(RETRIEVAL_MAX_LIMIT).optional(),
  })
  .strict();

export type GetResumeSummaryInputT = z.infer<typeof GetResumeSummaryInput>;
export type GetJdSummaryInputT = z.infer<typeof GetJdSummaryInput>;
export type GetMatchResultInputT = z.infer<typeof GetMatchResultInput>;
export type GetCapabilitiesInputT = z.infer<typeof GetCapabilitiesInput>;
export type GetProjectResultsInputT = z.infer<typeof GetProjectResultsInput>;
export type GetActionPlanInputT = z.infer<typeof GetActionPlanInput>;
export type GetLearningTasksInputT = z.infer<typeof GetLearningTasksInput>;
export type GetPortfolioInputT = z.infer<typeof GetPortfolioInput>;
export type RagRetrieveInputT = z.infer<typeof RagRetrieveInput>;

/**
 * 工具名 → input schema 的**唯一目录**（机械守卫据此断言「9 名 = 9 schema」）。
 *
 * ⚠️ 本表用于**校验与守卫**；执行分派**不得**按名字索引本表（禁止动态分派，T5B-F-16）——
 * 见 `tool-layer.ts` 的静态 `switch`。
 */
export const AGENT_READ_TOOL_INPUT_SCHEMAS: Record<AgentReadToolName, z.ZodTypeAny> = {
  get_resume_summary: GetResumeSummaryInput,
  get_jd_summary: GetJdSummaryInput,
  get_match_result: GetMatchResultInput,
  get_capabilities: GetCapabilitiesInput,
  get_project_results: GetProjectResultsInput,
  get_action_plan: GetActionPlanInput,
  get_learning_tasks: GetLearningTasksInput,
  get_portfolio: GetPortfolioInput,
  rag_retrieve: RagRetrieveInput,
};
