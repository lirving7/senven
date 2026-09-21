/**
 * T6-4-B —— Act Tool Contract（**单一来源**）。
 *
 * 授权依据：T6-4-B 授权书 §五/§六/§八。
 *
 * 与 T5-B 只读工具层（`contracts.ts`，ADR-017 冻结 9 只读工具）的关系：
 *   - 本文件是**独立的 Act Tool Catalog**，不修改、不扩展 AGENT_READ_TOOL_NAMES；
 *   - Act 工具全部 `requiresConfirmation = true`（§八：第一版不允许 false）；
 *   - 全部走既有业务写入口（§七 Fact Authority：不出现 Agent 直写 DB）；
 *   - 全部具备幂等（§四：idempotencyKey = toolName + canonical payload 的 sha256）；
 *   - caller 仅限**服务端 Act 执行器**（经用户 Confirm 的 AgentAction），模型不得自由命名工具。
 */

import { z } from 'zod';

import { ACT_TOOL_NAMES, type ActToolName } from '../domain/agent/act.ts';

/** Act Tool Contract 版本 */
export const ACT_TOOL_CONTRACT_VERSION = 'agent-act-tool-contract/v1';

/** 白名单（从领域层 re-export；DB CHECK 与本表同一集合） */
export const ACT_TOOL_WHITELIST = ACT_TOOL_NAMES;

/** 每个工具的输入 schema（.strict()：多余字段一律 400，含 userId 注入键） */
export const ACT_TOOL_INPUT_SCHEMAS = {
  create_career_goal: z
    .object({
      name: z.string().trim().min(1).max(80),
      position: z.string().trim().min(1).max(80),
      location: z.string().max(80).optional(),
      employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT']),
      jdIds: z.array(z.string().trim().min(1)).max(20).optional(),
    })
    .strict(),
  attach_jd_to_goal: z
    .object({
      goalId: z.string().trim().min(1),
      jdId: z.string().trim().min(1),
    })
    .strict(),
  create_application: z
    .object({
      company: z.string().trim().min(1).max(120),
      position: z.string().trim().max(120).optional(),
      jdId: z.string().trim().min(1).optional(),
      careerGoalId: z.string().trim().min(1).optional(),
      resumeVersionId: z.string().trim().min(1).optional(),
    })
    .strict(),
  update_application_stage: z
    .object({
      applicationId: z.string().trim().min(1),
      stage: z.enum(['APPLIED', 'SCREENING', 'INTERVIEWING', 'OFFER', 'REJECTED', 'WITHDRAWN']),
    })
    .strict(),
  create_learning_task: z
    .object({
      actionPlanId: z.string().trim().min(1),
      sourceStepId: z.string().trim().min(1),
      content: z.string().optional().nullable(),
    })
    .strict(),
} as const satisfies Record<ActToolName, z.ZodTypeAny>;

export type { ActToolName };

export type ActToolInput<T extends ActToolName> = z.infer<(typeof ACT_TOOL_INPUT_SCHEMAS)[T]>;

/** 每个工具的 Contract 元数据（§六 全字段） */
export type ActToolContract = {
  name: ActToolName;
  description: string;
  /** §八：第一版全部 true，禁止自动执行 */
  requiresConfirmation: true;
  /** permission boundary：只允许操作当前 session userId 名下资源 */
  permissionBoundary: 'SESSION_USER_ONLY';
  /** ownership requirement：目标资源必须属于当前用户（跨用户一律 404 无 oracle） */
  ownershipRequired: true;
  /** idempotency requirement：幂等键 + SUCCEEDED 结果复用 */
  idempotent: true;
  /** failure semantics：EXECUTING → FAILED，errorCode 落库；不自动 retry */
  failureSemantics: 'EXECUTING_TO_FAILED_NO_AUTO_RETRY';
  /** allowed caller：仅服务端 Act 执行器（模型不得自由命名/直调） */
  allowedCaller: 'SERVER_ACT_EXECUTOR_ONLY';
  /** 是否创建/修改持久化业务事实 */
  createsDurableFact: boolean;
};

export const ACT_TOOL_CONTRACTS: Record<ActToolName, ActToolContract> = {
  create_career_goal: {
    name: 'create_career_goal',
    description: '创建一个 CareerGoal（用户确认后；走既有 CareerGoal 写入口，遵守 current 唯一约束；不改变用户意图）',
    requiresConfirmation: true,
    permissionBoundary: 'SESSION_USER_ONLY',
    ownershipRequired: true,
    idempotent: true,
    failureSemantics: 'EXECUTING_TO_FAILED_NO_AUTO_RETRY',
    allowedCaller: 'SERVER_ACT_EXECUTOR_ONLY',
    createsDurableFact: true,
  },
  attach_jd_to_goal: {
    name: 'attach_jd_to_goal',
    description: '将一个属于当前用户的 JD 关联到其 CareerGoal（走既有 replace-set 更新入口，逐项 ownership 校验）',
    requiresConfirmation: true,
    permissionBoundary: 'SESSION_USER_ONLY',
    ownershipRequired: true,
    idempotent: true,
    failureSemantics: 'EXECUTING_TO_FAILED_NO_AUTO_RETRY',
    allowedCaller: 'SERVER_ACT_EXECUTOR_ONLY',
    createsDurableFact: true,
  },
  create_application: {
    name: 'create_application',
    description: '创建一条 Application 投递记录（用户确认后；走既有 Application 写入口并执行关联一致性校验；不自动投递外部平台、不发送任何外部消息）',
    requiresConfirmation: true,
    permissionBoundary: 'SESSION_USER_ONLY',
    ownershipRequired: true,
    idempotent: true,
    failureSemantics: 'EXECUTING_TO_FAILED_NO_AUTO_RETRY',
    allowedCaller: 'SERVER_ACT_EXECUTOR_ONLY',
    createsDurableFact: true,
  },
  update_application_stage: {
    name: 'update_application_stage',
    description: '更新本人 Application 的 stage（stage 必须属于现有允许集合；走既有合法更新路径）',
    requiresConfirmation: true,
    permissionBoundary: 'SESSION_USER_ONLY',
    ownershipRequired: true,
    idempotent: true,
    failureSemantics: 'EXECUTING_TO_FAILED_NO_AUTO_RETRY',
    allowedCaller: 'SERVER_ACT_EXECUTOR_ONLY',
    createsDurableFact: true,
  },
  create_learning_task: {
    name: 'create_learning_task',
    description: '根据本人已有 ActionPlan 的步骤创建 Learning Task（走既有 Learning Task 写入口；不确认能力事实）',
    requiresConfirmation: true,
    permissionBoundary: 'SESSION_USER_ONLY',
    ownershipRequired: true,
    idempotent: true,
    failureSemantics: 'EXECUTING_TO_FAILED_NO_AUTO_RETRY',
    allowedCaller: 'SERVER_ACT_EXECUTOR_ONLY',
    createsDurableFact: true,
  },
};

/** Act 白名单判定（大小写敏感，不做归一化；未知工具硬拒绝） */
export function isActWhitelistedTool(value: unknown): value is ActToolName {
  return typeof value === 'string' && (ACT_TOOL_NAMES as readonly string[]).includes(value);
}
