/**
 * T6-4-B —— Act 执行器（**唯一 allowed caller**）。
 *
 * 执行一个已 CONFIRMED 的 AgentAction：白名单判定 → 输入 schema 校验 →
 * 调用**既有业务写入口**（不出现直写 DB）→ SUCCEEDED(result) / FAILED(errorCode)。
 *
 * 硬边界（T6-4 §二/§七/§八）：
 *   - 不改 Fact Authority：不确认 Capability、不写 Resume 已确认事实、不改 CareerGoal 用户意图
 *     （create_career_goal 仅创建用户已确认要创建的目标）；
 *   - ownership：全部目标资源经 `findForUser(id, userId)` 校验，跨用户 → 404 无 oracle；
 *   - 幂等：执行前按 idempotencyKey 查既有 SUCCEEDED → 直接复用 result（§四）；
 *   - 失败：EXECUTING → FAILED + errorCode，不自动 retry（§三.6）。
 */

import { appError, ERROR_CODE } from '../errors.ts';
import type {
  AgentActionRecord,
  AgentActionRepository,
  ApplicationRepository,
  CareerGoalRepository,
  JdRepository,
  LearningTaskRepository,
  ResumeVersionRepository,
  ActionPlanRepository,
} from '../ports/index.ts';
import {
  isActWhitelistedTool,
  ACT_TOOL_INPUT_SCHEMAS,
  ACT_TOOL_CONTRACTS,
  type ActToolInput,
  type ActToolName,
} from './act-contracts.ts';
import { canExecute, isActTerminalStatus, type ActActionStatus } from '../domain/agent/act.ts';

export type ActExecutorDeps = {
  careerGoals: CareerGoalRepository;
  applications: ApplicationRepository;
  learningTasks: LearningTaskRepository;
  jds: JdRepository;
  resumeVersions: ResumeVersionRepository;
  actionPlans: ActionPlanRepository;
  agentActions: AgentActionRepository;
};

type Ok<T> = { kind: 'OK'; result: T };
type Err = { kind: 'ERR'; errorCode: string; message: string };
type ToolOutcome<T> = Ok<T> | Err;

/** 执行一个 AgentAction（仅接受 CONFIRMED；幂等复用 SUCCEEDED）。返回最终状态记录。 */
export async function executeActAction(
  action: AgentActionRecord,
  userId: string,
  deps: ActExecutorDeps,
): Promise<AgentActionRecord> {
  const status = action.status as ActActionStatus;

  // 幂等优先：同一 Action（同 key）已成功 → 直接复用（§四；含重复 execute / 并发重复提交）
  const dup = await deps.agentActions.findByIdempotencyKey(action.idempotencyKey);
  if (dup && dup.id !== action.id && dup.status === 'SUCCEEDED') return dup;
  if (action.status === 'SUCCEEDED') return action;

  // 状态机：只有 CONFIRMED 可以 EXECUTING（§三.2/§三.7）
  if (!canExecute(status)) {
    throw appError(
      ERROR_CODE.VALIDATION_FAILED,
      isActTerminalStatus(status)
        ? `该 Action 已处于终态 ${status}，不得执行`
        : '该 Action 尚未确认（须先 Confirm）',
    );
  }

  // 白名单 + schema（模型/调用方不得注入任意 tool 或多余字段）
  if (!isActWhitelistedTool(action.toolName)) {
    await markFailed(deps, action, 'ACT_TOOL_NOT_WHITELISTED', `工具 ${action.toolName} 不在 Act 白名单`);
    throw appError(ERROR_CODE.VALIDATION_FAILED, '工具不在 Act 白名单');
  }
  const toolName = action.toolName;
  const parsed = ACT_TOOL_INPUT_SCHEMAS[toolName].safeParse(action.payload);
  if (!parsed.success) {
    await markFailed(deps, action, 'ACT_INPUT_INVALID', 'Act 输入未通过 schema 校验');
    throw appError(ERROR_CODE.VALIDATION_FAILED, 'Act 输入未通过 schema 校验');
  }
  const input = parsed.data;

  // EXECUTING
  const executing = await deps.agentActions.updateStatus(action.id, userId, { status: 'EXECUTING' });
  if (executing === null) {
    // 并发下已被终态化（如另一请求先执行）——重读复用
    const fresh = await deps.agentActions.findForUser(action.id, userId);
    if (fresh && isActTerminalStatus(fresh.status as ActActionStatus)) return fresh;
    throw appError(ERROR_CODE.VALIDATION_FAILED, 'Action 状态冲突（可能已被并发执行），请重试');
  }

  try {
    let result: unknown;
    switch (toolName) {
      case 'create_career_goal':
        result = await runCreateCareerGoal(deps, userId, input as ActToolInput<'create_career_goal'>);
        break;
      case 'attach_jd_to_goal':
        result = await runAttachJdToGoal(deps, userId, input as ActToolInput<'attach_jd_to_goal'>);
        break;
      case 'create_application':
        result = await runCreateApplication(deps, userId, input as ActToolInput<'create_application'>);
        break;
      case 'update_application_stage':
        result = await runUpdateApplicationStage(deps, userId, input as ActToolInput<'update_application_stage'>);
        break;
      case 'create_learning_task':
        result = await runCreateLearningTask(deps, userId, input as ActToolInput<'create_learning_task'>);
        break;
      default: {
        const never: never = toolName;
        throw new Error(`unreachable tool ${String(never)}`);
      }
    }
    const done = await deps.agentActions.updateStatus(action.id, userId, { status: 'SUCCEEDED', result });
    return done ?? (await deps.agentActions.findForUser(action.id, userId))!;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const errorCode = typeof code === 'string' && code ? code : 'ACT_EXECUTION_FAILED';
    const message = err instanceof Error ? err.message : '未知执行失败';
    await markFailed(deps, action, errorCode, message);
    throw err;
  }
}

async function markFailed(
  deps: ActExecutorDeps,
  action: AgentActionRecord,
  errorCode: string,
  message: string,
): Promise<void> {
  await deps.agentActions.updateStatus(action.id, action.userId, {
    status: 'FAILED',
    errorCode,
    errorMessage: message,
  });
}

// ─── 各 Tool 实现（全部走既有业务写入口 / 既有 ownership 校验） ───

type ActResultView = { kind: string; id?: string; status?: string; [k: string]: unknown };

async function runCreateCareerGoal(
  deps: ActExecutorDeps,
  userId: string,
  input: { name: string; position: string; location?: string; employmentType: string; jdIds?: string[] },
): Promise<ActResultView> {
  const outcome = await deps.careerGoals.create(userId, {
    name: input.name,
    position: input.position,
    ...(input.location === undefined ? {} : { location: input.location }),
    employmentType: input.employmentType as 'FULL_TIME' | 'PART_TIME' | 'INTERNSHIP' | 'CONTRACT',
    status: 'ACTIVE',
    jdIds: input.jdIds,
  });
  if (outcome.kind === 'JD_NOT_FOUND') {
    throw appError(ERROR_CODE.VALIDATION_FAILED, 'jdIds 中存在不属于该用户的 JD');
  }
  return { kind: 'CREATED', id: outcome.goal.id, name: outcome.goal.name, isCurrent: outcome.goal.isCurrent };
}

async function runAttachJdToGoal(
  deps: ActExecutorDeps,
  userId: string,
  input: { goalId: string; jdId: string },
): Promise<ActResultView> {
  const goal = await deps.careerGoals.findForUser(input.goalId, userId);
  if (goal === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该求职目标');
  // replace-set 语义：现有 jdIds ∪ {jdId}（update 内逐项校验 JD ownership）
  const existing = goal.jdIds ?? [];
  if (existing.includes(input.jdId)) {
    return { kind: 'NOOP', id: goal.id, alreadyLinked: true };
  }
  const outcome = await deps.careerGoals.update(userId, goal.id, { jdIds: [...existing, input.jdId] });
  if (outcome.kind === 'JD_NOT_FOUND') {
    throw appError(ERROR_CODE.VALIDATION_FAILED, 'jdId 不属于该用户');
  }
  if (outcome.kind !== 'UPDATED') {
    throw appError(ERROR_CODE.NOT_FOUND, '未找到该求职目标');
  }
  return { kind: 'ATTACHED', id: goal.id, jdIds: outcome.goal.jdIds };
}

async function runCreateApplication(
  deps: ActExecutorDeps,
  userId: string,
  input: { company: string; position?: string; jdId?: string; careerGoalId?: string; resumeVersionId?: string },
): Promise<ActResultView> {
  // ownership（与 applications handler 的 resolveRefs 同语义）
  let jdTitle: string | null = null;
  let resumeVersionJdId: string | null = null;
  if (input.jdId) {
    const jd = await deps.jds.findByIdForUser(input.jdId, userId);
    if (jd === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该 JD');
    jdTitle = jd.title;
  }
  if (input.careerGoalId) {
    const goal = await deps.careerGoals.findForUser(input.careerGoalId, userId);
    if (goal === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该求职目标');
  }
  if (input.resumeVersionId) {
    const rv = await deps.resumeVersions.findForUser(input.resumeVersionId, userId);
    if (rv === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该简历版本');
    resumeVersionJdId = rv.jdId;
  }
  // 关联一致性（与 applications handler 的 assertConsistency 同语义）
  if (input.resumeVersionId && resumeVersionJdId !== null && input.jdId && resumeVersionJdId !== input.jdId) {
    throw appError(ERROR_CODE.VALIDATION_FAILED, '简历版本与岗位不一致');
  }
  if (input.careerGoalId && input.jdId) {
    const linked = await deps.careerGoals.hasJobDescriptionLink(input.careerGoalId, input.jdId);
    if (!linked) throw appError(ERROR_CODE.VALIDATION_FAILED, '该求职目标尚未关联此岗位');
  }
  const rec = await deps.applications.create({
    userId,
    company: input.company,
    position: input.position ?? jdTitle,
    jdId: input.jdId ?? null,
    careerGoalId: input.careerGoalId ?? null,
    resumeVersionId: input.resumeVersionId ?? null,
    appliedAt: new Date(),
    stage: 'APPLIED',
    notes: null,
  });
  return { kind: 'CREATED', id: rec.id, stage: rec.stage };
}

async function runUpdateApplicationStage(
  deps: ActExecutorDeps,
  userId: string,
  input: { applicationId: string; stage: string },
): Promise<ActResultView> {
  const updated = await deps.applications.update(input.applicationId, userId, { stage: input.stage });
  if (updated === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该投递记录');
  return { kind: 'UPDATED', id: updated.id, stage: updated.stage };
}

async function runCreateLearningTask(
  deps: ActExecutorDeps,
  userId: string,
  input: { actionPlanId: string; sourceStepId: string; content?: string | null },
): Promise<ActResultView> {
  const plan = await deps.actionPlans.findForUser(input.actionPlanId, userId);
  if (plan === null) throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');
  const step = plan.steps.find((s) => s.id === input.sourceStepId);
  if (!step) throw appError(ERROR_CODE.VALIDATION_FAILED, 'sourceStepId 不属于该行动计划');
  const outcome = await deps.learningTasks.create({
    userId,
    actionPlanId: input.actionPlanId,
    sourceStepId: input.sourceStepId,
    sourceStepTitle: step.title,
    sourceStepTargetRequirement: step.targetRequirement,
    content: input.content ?? null,
  });
  if (outcome.kind === 'ACTION_PLAN_NOT_FOUND') throw appError(ERROR_CODE.NOT_FOUND, '未找到该行动计划');
  if (outcome.kind === 'ARCHIVED_DUPLICATE') throw appError(ERROR_CODE.VALIDATION_FAILED, '该步骤的学习任务已归档');
  // ACTIVE_DUPLICATE：业务层幂等——返回既有任务（不重复创建）
  return {
    kind: outcome.kind === 'CREATED' ? 'CREATED' : 'REUSED_EXISTING',
    id: outcome.task.id,
    status: outcome.task.status,
  };
}

// 供 handler 使用的 Contract 元数据 re-export（避免 handler 直接 import 本文件之外）
export { ACT_TOOL_CONTRACTS as ACT_TOOL_CONTRACT_TABLE };
