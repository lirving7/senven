/**
 * T6-2 · Application Tracker —— 领域类型与 stage 词表（与 Migration #16 CHECK 同源）。
 *
 * stage 最终集合（授权书 §二）：APPLIED / SCREENING / INTERVIEWING / OFFER / REJECTED / WITHDRAWN。
 * DRAFT / CLOSED 已删除；本版本无严格状态机 —— 任意合法 stage 可经 PATCH 修正为其他合法 stage。
 */

export const APPLICATION_STAGE = {
  APPLIED: 'APPLIED',
  SCREENING: 'SCREENING',
  INTERVIEWING: 'INTERVIEWING',
  OFFER: 'OFFER',
  REJECTED: 'REJECTED',
  WITHDRAWN: 'WITHDRAWN',
} as const;
export type ApplicationStageValue = (typeof APPLICATION_STAGE)[keyof typeof APPLICATION_STAGE];

export const APPLICATION_STAGE_LABEL: Record<ApplicationStageValue, string> = {
  APPLIED: '已投递',
  SCREENING: '简历筛选中',
  INTERVIEWING: '面试中',
  OFFER: 'Offer',
  REJECTED: '未通过',
  WITHDRAWN: '已撤回',
};

/** 新建时的默认状态：用户记录一条投递，语义上就是「已投递」 */
export const DEFAULT_STAGE: ApplicationStageValue = APPLICATION_STAGE.APPLIED;

export const APPLICATION_STAGES: readonly ApplicationStageValue[] = [
  APPLICATION_STAGE.APPLIED,
  APPLICATION_STAGE.SCREENING,
  APPLICATION_STAGE.INTERVIEWING,
  APPLICATION_STAGE.OFFER,
  APPLICATION_STAGE.REJECTED,
  APPLICATION_STAGE.WITHDRAWN,
];

export function isApplicationStage(v: unknown): v is ApplicationStageValue {
  return typeof v === 'string' && (APPLICATION_STAGES as readonly string[]).includes(v);
}

export type ApplicationRecord = {
  id: string;
  company: string;
  jdId: string | null;
  careerGoalId: string | null;
  resumeVersionId: string | null;
  position: string | null;
  appliedAt: Date;
  stage: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** 看板计数：与 Migration #16 CHECK 词表一一对应（closed 已删除，不得残留） */
export type ApplicationCounts = {
  total: number;
  applied: number;
  screening: number;
  interviewing: number;
  offer: number;
  rejected: number;
  withdrawn: number;
};

/** 列表视图（轻量） */
export type ApplicationView = {
  id: string;
  company: string;
  position: string | null;
  jdId: string | null;
  careerGoalId: string | null;
  resumeVersionId: string | null;
  appliedAt: string;
  stage: string;
  stageLabel: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

/** 详情视图：列表字段 + 关联资源摘要（不暴露其他用户资源） */
export type ApplicationDetailView = ApplicationView & {
  jdSummary: { title: string | null; company: string | null } | null;
  careerGoalSummary: { name: string; position: string; status: string } | null;
  resumeVersionSummary: { versionNo: number; jdId: string | null; createdAt: string } | null;
};

export function stageLabelOf(stage: string): string {
  return APPLICATION_STAGE_LABEL[stage as ApplicationStageValue] ?? '未知状态';
}

export function toView(record: ApplicationRecord): ApplicationView {
  return {
    id: record.id,
    company: record.company,
    position: record.position,
    jdId: record.jdId,
    careerGoalId: record.careerGoalId,
    resumeVersionId: record.resumeVersionId,
    appliedAt: record.appliedAt.toISOString(),
    stage: record.stage,
    stageLabel: stageLabelOf(record.stage),
    notes: record.notes,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** 详情视图组装：列表字段 + 关联资源摘要（摘要由调用方经 ownership 校验后取得） */
export function toDetailView(
  record: ApplicationRecord,
  summaries: {
    jdSummary: { title: string | null; company: string | null } | null;
    careerGoalSummary: { name: string; position: string; status: string } | null;
    resumeVersionSummary: { versionNo: number; jdId: string | null; createdAt: string } | null;
  },
): ApplicationDetailView {
  return {
    ...toView(record),
    jdSummary: summaries.jdSummary,
    careerGoalSummary: summaries.careerGoalSummary,
    resumeVersionSummary: summaries.resumeVersionSummary,
  };
}

export function countByStage(records: readonly ApplicationRecord[]): ApplicationCounts {  return {
    total: records.length,
    applied: records.filter((r) => r.stage === APPLICATION_STAGE.APPLIED).length,
    screening: records.filter((r) => r.stage === APPLICATION_STAGE.SCREENING).length,
    interviewing: records.filter((r) => r.stage === APPLICATION_STAGE.INTERVIEWING).length,
    offer: records.filter((r) => r.stage === APPLICATION_STAGE.OFFER).length,
    rejected: records.filter((r) => r.stage === APPLICATION_STAGE.REJECTED).length,
    withdrawn: records.filter((r) => r.stage === APPLICATION_STAGE.WITHDRAWN).length,
  };
}
