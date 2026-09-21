/**
 * T6-1 —— CareerGoal 求职目标领域层（纯常量 + 纯校验，零 Prisma / 零 DB）。
 *
 * 定性（授权书 §十三）：CareerGoal 创建是**用户自著资源创建**，
 * 不是 AI Recommendation → Confirm → Fact；与 Fact Authority 零耦合；
 * 与 Agent 零耦合（Agent 不读/不写/不引用 CareerGoal）。
 */

/** status 封闭值域（Migration #15 `CareerGoal_status_check` 同源） */
export const CAREER_GOAL_STATUS = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  COMPLETED: 'COMPLETED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type CareerGoalStatus = (typeof CAREER_GOAL_STATUS)[keyof typeof CAREER_GOAL_STATUS];

export function isCareerGoalStatus(v: unknown): v is CareerGoalStatus {
  return typeof v === 'string' && (Object.values(CAREER_GOAL_STATUS) as string[]).includes(v);
}

export const CAREER_GOAL_STATUS_LABEL: Record<CareerGoalStatus, string> = {
  ACTIVE: '进行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  ARCHIVED: '已归档',
};

/** employmentType 封闭值域（Migration #15 `CareerGoal_employmentType_check` 同源） */
export const CAREER_GOAL_EMPLOYMENT_TYPE = {
  FULL_TIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME',
  INTERNSHIP: 'INTERNSHIP',
  CONTRACT: 'CONTRACT',
} as const;

export type CareerGoalEmploymentType =
  (typeof CAREER_GOAL_EMPLOYMENT_TYPE)[keyof typeof CAREER_GOAL_EMPLOYMENT_TYPE];

export function isCareerGoalEmploymentType(v: unknown): v is CareerGoalEmploymentType {
  return typeof v === 'string' && (Object.values(CAREER_GOAL_EMPLOYMENT_TYPE) as string[]).includes(v);
}

export const CAREER_GOAL_EMPLOYMENT_TYPE_LABEL: Record<CareerGoalEmploymentType, string> = {
  FULL_TIME: '全职',
  PART_TIME: '兼职',
  INTERNSHIP: '实习',
  CONTRACT: '合同制',
};

/**
 * 不变式（授权书 §五/§十一，Migration #15 `CareerGoal_current_active_check` 同源）：
 * `isCurrent = true` ⇒ `status = 'ACTIVE'`。
 * 仓储在「离开 ACTIVE」时于同一事务内清除 isCurrent；本函数用于渲染/校验兜底。
 */
export function isCurrentCompatible(status: string, isCurrent: boolean): boolean {
  return !isCurrent || status === CAREER_GOAL_STATUS.ACTIVE;
}

/** 创建输入长度约束（与 API zod 校验同口径，供 domain 级复用/测试） */
export const CAREER_GOAL_LIMITS = {
  nameMax: 80,
  positionMax: 80,
  locationMax: 80,
  jdIdsMax: 20,
  requestNoteMax: 0, // 占位：CareerGoal 无备注字段，防误扩
} as const;

export function validateCareerGoalTexts(input: {
  name: string;
  position: string;
  location?: string | null;
}): boolean {
  if (input.name.length < 1 || input.name.length > CAREER_GOAL_LIMITS.nameMax) return false;
  if (input.position.length < 1 || input.position.length > CAREER_GOAL_LIMITS.positionMax) return false;
  const loc = input.location;
  if (loc !== undefined && loc !== null && loc.length > CAREER_GOAL_LIMITS.locationMax) return false;
  return true;
}
