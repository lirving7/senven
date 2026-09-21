/**
 * T5-B-2A —— Agent 只读工具层：依赖与上下文边界（**只读装配契约**）
 *
 * 依据 ADR-017：
 *   - T5B-F-17.3：`userId` **只能来自认证 session**；**不接受**调用方/模型提供 userId；
 *   - T5B-F-17.4/5：resource id 必须**二次归属校验**，跨用户 / 不存在 → 统一**无 oracle** 语义；
 *   - T5B-F-61②：Agent 实现文件的依赖类型**只含只读能力**，不含任何写仓储 / provider / quota。
 *
 * 说明（依赖形状）：
 *   - 本层**不**引用 Prisma、不持有 DB client、不写 raw SQL；所有数据访问都经 **既有只读 Port**
 *     （`src/ports/index.ts` 中已存在的接口方法），用 `Pick<>` 精确声明所需方法子集 —— 从而
 *     既「复用现有只读 Repository」又不引入任何新的查询逻辑（授权书 §五）。
 *   - ⚠️ 本类型**不是**新的 Port 定义；`src/ports/index.ts` 未被修改。
 */

import type {
  ActionPlanRepository,
  CapabilityRepository,
  JdRepository,
  LearningTaskRepository,
  MatchRepository,
  PortfolioProjectRepository,
  ProjectResultRepository,
  RagRetrievalRepository,
  ResumeRepository,
} from '../ports/index.ts';

/**
 * 工具调用上下文。
 *
 * ⚠️ `userId` 由**服务端**在调用时注入（未来由已认证的 `AgentRun.userId` 派生），
 * **绝不**由工具输入 schema 承载 —— 9 个 input schema 全部 `.strict()`，
 * 携带 `userId` 的输入会因「未知字段」被拒（见 `tool-schemas.ts`）。
 */
export type AgentReadToolContext = {
  userId: string;
};

/**
 * 工具层依赖（**全部只读**，方法子集经 `Pick` 从既有 Port 精确取用）。
 *
 * 不包含：任何 `create*` / `update*` / `archive*` / `confirm*` / `addArtifact` / `submit` / `revoke`
 * 等写方法；不包含 provider / llmUsage / quota；不包含 Prisma / DB client。
 */
export type AgentReadToolDeps = {
  /** `get_resume_summary`：仅「我的简历」列表 + 解析确认详情（`ResumeDetail` 结构上不含 rawText） */
  resumes: Pick<ResumeRepository, 'listForUser' | 'findDetailForUser'>;

  /** `get_jd_summary`：仅按 id + 归属读取 JD 及其要求条目 */
  jds: Pick<JdRepository, 'findByIdForUserWithRequirements'>;

  /**
   * `get_match_result`：仅按 id + 归属读取一次 run 的全部 MatchItem。
   *
   * ⚠️ **BLOCK-1（需 ChatGPT 裁决，本阶段未自行解决）**：
   * ADR-017 §4 将该工具的 input 冻结为 `{ matchRunId? }`（**可选**），
   * 但既有 `MatchRepository` **没有任何「列出该用户全部 MatchRun」的只读方法**
   * （仅有 `createRunWithItems` / `findRunForUser` / `findRunWithItemsForUser`），
   * 因此「省略 matchRunId 时解析最近一次 run」**无法**在不修改
   * `src/db/repositories.ts` 的前提下实现 —— 而修改后者超出本阶段授权（§十四要求先 STOP）。
   *
   * 处置：本阶段把该只读解析能力显式声明为**依赖契约的一部分**（由未来装配点提供），
   * 使 schema 与 ADR-017 §4 逐字一致，同时把缺口暴露在装配层而不是被静默吞掉。
   */
  matches: Pick<MatchRepository, 'findRunWithItemsForUser'> & {
    /** 只读：解析该用户最近一次 MatchRun 的 id；无数据 → null */
    findLatestRunIdForUser(userId: string): Promise<string | null>;
  };

  /** `get_capabilities`：列表 + 单条详情（详情含证据，用于「证据计数」） */
  capabilities: Pick<CapabilityRepository, 'listForUser' | 'findForUser'>;

  /** `get_project_results`：仅「我的成果」列表（条目自带 `artifactCount`） */
  projectResults: Pick<ProjectResultRepository, 'listForUser'>;

  /** `get_action_plan`：仅列表 + 单条（含 steps） */
  actionPlans: Pick<ActionPlanRepository, 'listForUser' | 'findForUser'>;

  /**
   * `get_learning_tasks`：仅「我的学习任务」列表。
   *
   * 注（OBSERVATION）：`listForUser` 按既有语义**隐藏已归档**（T3-A2-6 D-6），
   * 故 ADR-017 §4 所列的「归档标记」在当前只读能力下恒为 `false`。
   * 如需列出已归档任务，需要新的只读方法 —— 同属 BLOCK-1 类缺口，本阶段不自行扩展。
   */
  learningTasks: Pick<LearningTaskRepository, 'listForUser'>;

  /** `get_portfolio`：仅列表 + 详情（详情含成员与其 ProjectResult 事实状态） */
  portfolioProjects: Pick<PortfolioProjectRepository, 'listForUser' | 'findForUser'>;

  /** `rag_retrieve`：T5-A 检索仓储（接口层**无写方法**，T5A-F-54） */
  rag: Pick<RagRetrievalRepository, 'retrieve'>;
};
