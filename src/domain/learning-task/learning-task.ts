/**
 * T3-A2-6 Phase 2 —— LearningTask 状态 / 领域契约（**单一来源**）
 *
 * 依据：`JobPilot_ADR_T3-A2-5_LearningTask.md`（D-5 status 模型、D-6 Archive 语义、§6 Status model）。
 *
 * 硬约束（不得违反）：
 *   - status 仅 `PLANNED` / `IN_PROGRESS` / `PAUSED` 三值，**不得出现** `DONE` / `COMPLETED`；
 *   - archive 与 status **正交**：`archivedAt` 非空表示已归档，**不**把 `ARCHIVED` 当作 status 值；
 *   - status **不参与**任何事实层派生（D-7 双状态隔离）；
 *   - `sourceStepId` 是**历史 provenance**（值保存，非 FK），`sourceStepTitle` / `sourceStepTargetRequirement`
 *     为创建时快照（regenerate 后保持不变）。
 *
 * 本模块纯函数 + 零依赖，供 handler / repository 共同引用。
 */

export const LEARNING_TASK_STATUS = ['PLANNED', 'IN_PROGRESS', 'PAUSED'] as const;
export type LearningTaskStatus = (typeof LEARNING_TASK_STATUS)[number];

/** 严格类型守卫：只接受三个合法常量之一（大小写敏感） */
export function isLearningTaskStatus(value: unknown): value is LearningTaskStatus {
  return typeof value === 'string' && (LEARNING_TASK_STATUS as readonly string[]).includes(value);
}

/**
 * 状态迁移判定（T3-A2-6 Phase 3 正式冻结契约，**取代** Phase 2 的「三态两两可达」）。
 *
 * 冻结规则（授权书 §二）：
 *   - 允许：
 *       PLANNED → IN_PROGRESS
 *       PLANNED → PAUSED
 *       IN_PROGRESS → PAUSED
 *       PAUSED → IN_PROGRESS
 *   - 禁止回退到 PLANNED：
 *       IN_PROGRESS → PLANNED  = FORBIDDEN（422）
 *       PAUSED → PLANNED       = FORBIDDEN（422）
 *   - 同值 = NOOP（200 no-op）：
 *       PLANNED → PLANNED、IN_PROGRESS → IN_PROGRESS、PAUSED → PAUSED
 *
 * 归档（archivedAt）是**正交维度**，不参与 status 迁移判断；
 * 已归档的 LearningTask 是否仍允许改 status，由 repository 层的归档闸门决定（见 repositories.ts）。
 */
export type LearningTaskTransition = 'ALLOWED' | 'NOOP' | 'FORBIDDEN';

export function evaluateLearningTaskTransition(
  from: LearningTaskStatus,
  to: LearningTaskStatus,
): LearningTaskTransition {
  if (from === to) return 'NOOP';
  // 禁止回退到 PLANNED（唯一被禁止的方向）
  if (to === 'PLANNED') return 'FORBIDDEN';
  // 其余方向（PLANNED→IN_PROGRESS/PAUSED、IN_PROGRESS→PAUSED、PAUSED→IN_PROGRESS）均允许
  return 'ALLOWED';
}

/**
 * 布尔封装：NOOP 与 ALLOWED 均视为「可接受」（不 422）；
 * 仅 FORBIDDEN 返回 false。供需要布尔判断的调用方使用。
 */
export function canTransitionLearningTaskStatus(
  from: LearningTaskStatus,
  to: LearningTaskStatus,
): boolean {
  return evaluateLearningTaskTransition(from, to) !== 'FORBIDDEN';
}

/**
 * 从 ActionStep 固化创建时快照（对齐 ProjectResult 的 snapshotFromStep 范式）。
 * sourceStepId 值保存，非 FK；regenerate 后允许悬空。
 */
export function learningTaskSnapshotFromStep(step: {
  id: string;
  title: string;
  targetRequirement?: string | null;
}): { sourceStepId: string; sourceStepTitle: string; sourceStepTargetRequirement: string | null } {
  return {
    sourceStepId: step.id,
    sourceStepTitle: step.title,
    sourceStepTargetRequirement: step.targetRequirement ?? null,
  };
}
